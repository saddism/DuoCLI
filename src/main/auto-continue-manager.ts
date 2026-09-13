import fs from 'fs';
import path from 'path';
import type { PtyManager } from './pty-manager';

export interface AutoContinueConfigRecord {
  enabled: boolean;
  messages: string[];
  intervalMs: number;
  commandIntervalMs: number;
  autoAgree: boolean;
  autoAgreeDelaySec: number;
  sendDelaySec: number;
  maxLoops: number;
  initialDelayMs: number;
  loopCount: number;
  nextRunAt: number;
  sending?: boolean;
}

const DEFAULT_CONFIG: AutoContinueConfigRecord = {
  enabled: false,
  messages: ['继续'],
  intervalMs: 10 * 60 * 1000,
  commandIntervalMs: 2000,
  autoAgree: true,
  autoAgreeDelaySec: 5,
  sendDelaySec: 2,
  maxLoops: -1,
  initialDelayMs: 0,
  loopCount: 0,
  nextRunAt: 0,
};

function finiteNumber(value: unknown, fallback: number, min = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

function normalizeConfig(value: unknown, now = Date.now()): AutoContinueConfigRecord {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const messages = Array.isArray(source.messages)
    ? source.messages.map(item => String(item || '').trim()).filter(Boolean).slice(0, 64)
    : (source.message ? [String(source.message).trim()] : DEFAULT_CONFIG.messages);
  const maxLoopsValue = Number(source.maxLoops);
  const maxLoops = Number.isFinite(maxLoopsValue) && (maxLoopsValue === -1 || maxLoopsValue > 0)
    ? Math.floor(maxLoopsValue)
    : DEFAULT_CONFIG.maxLoops;
  const nextRunAt = Number(source.nextRunAt);
  return {
    enabled: source.enabled === true,
    messages: messages.length ? messages : [...DEFAULT_CONFIG.messages],
    intervalMs: finiteNumber(source.intervalMs, DEFAULT_CONFIG.intervalMs, 60_000),
    commandIntervalMs: finiteNumber(source.commandIntervalMs, DEFAULT_CONFIG.commandIntervalMs),
    autoAgree: source.autoAgree !== false,
    autoAgreeDelaySec: finiteNumber(source.autoAgreeDelaySec, DEFAULT_CONFIG.autoAgreeDelaySec),
    sendDelaySec: finiteNumber(source.sendDelaySec, DEFAULT_CONFIG.sendDelaySec),
    maxLoops,
    initialDelayMs: finiteNumber(source.initialDelayMs, DEFAULT_CONFIG.initialDelayMs),
    loopCount: Math.max(0, Math.floor(finiteNumber(source.loopCount, 0))),
    nextRunAt: Number.isFinite(nextRunAt) && nextRunAt > 0 ? nextRunAt : now + finiteNumber(source.initialDelayMs, 0),
    sending: false,
  };
}

export class AutoContinueManager {
  private readonly configs = new Map<string, AutoContinueConfigRecord>();
  private readonly runVersions = new Map<string, number>();
  private readonly runTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly promptTails = new Map<string, string>();
  private readonly agreeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly tickTimer: ReturnType<typeof setInterval>;
  private loadedFromDisk = false;

  constructor(private readonly ptyManager: PtyManager, private readonly filePath: string) {
    this.load();
    this.tickTimer = setInterval(() => this.tick(), 1000);
  }

  stop(): void {
    clearInterval(this.tickTimer);
    for (const timer of this.runTimers.values()) clearTimeout(timer);
    for (const timer of this.agreeTimers.values()) clearTimeout(timer);
    this.runTimers.clear();
    this.agreeTimers.clear();
    this.promptTails.clear();
  }

  get(sessionId: string): Record<string, unknown> | null {
    const config = this.configs.get(sessionId);
    return config ? this.serialize(config) : null;
  }

  list(): Record<string, Record<string, unknown>> {
    const result: Record<string, Record<string, unknown>> = {};
    for (const [sessionId, config] of this.configs) {
      result[sessionId] = this.serialize(config);
    }
    return result;
  }

  hasPersistedState(): boolean {
    return this.loadedFromDisk;
  }

  set(sessionId: string, value: unknown): Record<string, unknown> {
    const config = normalizeConfig(value);
    config.loopCount = 0;
    config.nextRunAt = Date.now() + config.initialDelayMs;
    this.cancelRun(sessionId);
    this.configs.set(sessionId, config);
    this.persist();
    return this.serialize(config);
  }

  syncAll(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const records = value as Record<string, unknown>;
    const known = new Set(Object.keys(records));
    for (const id of this.configs.keys()) {
      if (!known.has(id)) this.remove(id, false);
    }
    for (const [id, config] of Object.entries(records)) {
      const normalized = normalizeConfig(config);
      this.cancelRun(id);
      this.configs.set(id, normalized);
    }
    this.persist();
  }

  remove(sessionId: string, persist = true): void {
    this.cancelRun(sessionId);
    this.configs.delete(sessionId);
    if (persist) this.persist();
  }

  noteManualInput(sessionId: string): void {
    const config = this.configs.get(sessionId);
    if (!config?.enabled || config.sending || config.loopCount <= 0) return;
    config.nextRunAt = Date.now() + config.intervalMs;
    this.persist();
  }

  observeOutput(sessionId: string, data: string): void {
    const config = this.configs.get(sessionId);
    if (!config?.enabled || !config.autoAgree || !data) return;
    const plain = data
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '');
    const tail = ((this.promptTails.get(sessionId) || '') + plain).slice(-1200);
    this.promptTails.set(sessionId, tail);
    if (!/Do you want to .*\?/.test(tail) || this.agreeTimers.has(sessionId)) return;
    const optionCount = (tail.match(/^\s+\d+\.\s/gm) || []).length;
    if (optionCount === 0) return;
    const choice = optionCount >= 3 ? '2' : '1';
    this.promptTails.delete(sessionId);
    const delayMs = Math.min(120_000, config.autoAgreeDelaySec * 1000);
    const timer = setTimeout(() => {
      this.agreeTimers.delete(sessionId);
      if (this.configs.get(sessionId) !== config
        || !config.enabled
        || !config.autoAgree
        || !this.ptyManager.getSession(sessionId)) return;
      void this.ptyManager.submit(sessionId, 'auto-agree-' + Date.now(), choice)
        .catch(error => console.warn('[AutoContinue] 自动确认失败:', error));
    }, Math.max(0, delayMs));
    this.agreeTimers.set(sessionId, timer);
  }

  private serialize(config: AutoContinueConfigRecord): Record<string, unknown> {
    return { ...config, sending: false };
  }

  private load(): void {
    try {
      this.loadedFromDisk = fs.existsSync(this.filePath);
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object') return;
      for (const [id, value] of Object.entries(parsed)) this.configs.set(id, normalizeConfig(value));
    } catch { /* first run or a corrupt optional file */ }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const serializable: Record<string, Record<string, unknown>> = {};
      for (const [id, config] of this.configs) serializable[id] = this.serialize(config);
      const temp = this.filePath + '.' + process.pid + '.tmp';
      fs.writeFileSync(temp, JSON.stringify(serializable, null, 2), 'utf8');
      fs.renameSync(temp, this.filePath);
      this.loadedFromDisk = true;
    } catch (error) {
      console.error('[AutoContinue] 配置写入失败:', error);
    }
  }

  private cancelRun(sessionId: string): void {
    this.runVersions.set(sessionId, (this.runVersions.get(sessionId) || 0) + 1);
    const timer = this.runTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.runTimers.delete(sessionId);
    const agreeTimer = this.agreeTimers.get(sessionId);
    if (agreeTimer) clearTimeout(agreeTimer);
    this.agreeTimers.delete(sessionId);
    this.promptTails.delete(sessionId);
    const config = this.configs.get(sessionId);
    if (config) config.sending = false;
  }

  private tick(): void {
    const now = Date.now();
    for (const [sessionId, config] of this.configs) {
      if (!config.enabled || config.sending || now < config.nextRunAt) continue;
      if (!this.ptyManager.getSession(sessionId)) {
        config.enabled = false;
        this.persist();
        continue;
      }
      void this.run(sessionId, config);
    }
  }

  private async run(sessionId: string, config: AutoContinueConfigRecord): Promise<void> {
    if (config.sending || !config.enabled) return;
    const runVersion = (this.runVersions.get(sessionId) || 0) + 1;
    this.runVersions.set(sessionId, runVersion);
    config.sending = true;
    config.loopCount += 1;
    config.nextRunAt = Date.now() + config.intervalMs;
    const stopAfterCycle = config.maxLoops > 0 && config.loopCount >= config.maxLoops;
    this.persist();

    try {
      for (let index = 0; index < config.messages.length; index += 1) {
        if (!this.isCurrent(sessionId, config, runVersion)) return;
        await this.ptyManager.submit(
          sessionId,
          'auto-continue-' + Date.now() + '-' + index,
          config.messages[index],
          config.sendDelaySec * 1000,
        );
        if (index + 1 < config.messages.length) await this.delay(config.commandIntervalMs);
      }
    } catch (error) {
      console.warn('[AutoContinue] 会话 ' + sessionId + ' 执行失败:', error);
    } finally {
      if (this.runVersions.get(sessionId) !== runVersion) return;
      config.sending = false;
      if (stopAfterCycle) config.enabled = false;
      config.nextRunAt = Date.now() + config.intervalMs;
      this.persist();
    }
  }

  private isCurrent(sessionId: string, config: AutoContinueConfigRecord, runVersion: number): boolean {
    return this.configs.get(sessionId) === config
      && this.runVersions.get(sessionId) === runVersion
      && config.enabled
      && !!this.ptyManager.getSession(sessionId);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
  }
}
