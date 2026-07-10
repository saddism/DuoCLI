import * as pty from 'node-pty';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync, spawn } from 'child_process';
import { requestTitleFromConfiguredAI, cleanGeneratedTitle, TitleAIConfig } from './title-ai';

export interface PtySession {
  id: string;
  ptyProcess: pty.IPty;
  buffer: string;
  rawBuffer: string;          // 完整 ANSI 输出，用于远程终端回放
  userInputs: string[];
  commandCount: number;
  title: string;
  titleLocked: boolean;
  titleGenerated: boolean;
  // —— 「智能起名」用户输入行缓冲（只用用户敲下的内容起名，绝不掺 CLI 输出）——
  currentLine: string;            // 当前正在输入、尚未回车的行缓冲
  accumulatedInputs: string[];    // 已发送的各段用户输入（起名唯一料源）
  titleSegmentCount: number;      // 已触发起名的段数（回车计数，封顶 TITLE_SEGMENT_CAP）
  summarizeScheduled: boolean;
  summarizeTimer: NodeJS.Timeout | null;
  cwd: string;
  presetCommand: string;
  themeId: string;
  provider: string | null;    // 实际使用的模型提供商 (如 MiniMax, GLM 等)
  createdAt: number;          // 创建时间戳
  resumeId: string | null;    // 捕获的 resume session ID (UUID)
  resumeCommand: string | null; // 完整 resume 命令 (如 "claude --resume xxx")
  autoRetryCooldown: number;    // 自动重试冷却截止时间戳
  prevData: string;              // 上一个 PTY 分片，与当前分片合并检测 rate limit
  retryTimer: NodeJS.Timeout | null;  // 自动重试 / 切号延迟定时器
  disposables: pty.IDisposable[];
  switchAttempts: number;        // 本轮自动切号已尝试次数
  lastAutoSwitchAt: number;      // 上次自动切号时间戳
  rateLimitRetryCount: number;   // 连续 rate limit 重试"继续"次数（成功后重置）
  lastRateLimitAt: number;       // 上次检测到 rate limit 的时间戳（用于判断连续性）
}

interface PtyManagerEvents {
  onData: (id: string, data: string) => void;
  onTitleUpdate: (id: string, title: string) => void;
  onExit: (id: string) => void;
  onPasteInput?: (id: string, cwd: string) => void;
  onRawData?: (id: string, data: string) => void;
  onAutoSwitchStatus?: (id: string, status: string, detail?: string) => void;
}

export type TitleAIConfigProvider = () => TitleAIConfig | null;

// 命令 → 友好显示名称映射
const PRESET_DISPLAY_NAMES: Record<string, string> = {
  'claude --dangerously-skip-permissions': 'Claude全自动',
  'codex --full-auto': 'Codex全自动',
  'codex -c sandbox_mode="danger-full-access" -c approval="never" -c network="enabled"': 'Codex全自动',
  'devin --permission-mode bypass': 'Devin全自动',
  'opencode': 'OpenCode',
  'kiro-cli chat --trust-all-tools': 'Kiro全自动',
};

// 终端会话标题「智能起名」：起名材料累加到第 N 段（用户每次回车发送算一段）后锁定，不再自动改名
const TITLE_SEGMENT_CAP = 3;

/**
 * 把用户击键的原始字节流解析成「行缓冲」状态，供起名使用（旁路观察，绝不影响命令转发）。
 * 只采集用户真正敲下的可见输入：可打印字符累积、退格按字符删尾、回车分段；
 * 方向键/功能键/ESC 序列/控制键一律忽略。
 * 返回：更新后的行缓冲、本次新完成的所有段、以及本次是否有可见输入。
 */
function processUserInputData(currentLine: string, data: string): {
  line: string;
  segments: string[];
  hadInput: boolean;
} {
  let line = currentLine;
  const segments: string[] = [];
  let hadInput = false;

  // 逐字符处理，让批量粘贴、IME 确认和普通击键遵循同一套回车/ESC 规则。
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    const code = data.charCodeAt(i);

    if (ch === '\r' || ch === '\n') {
      const trimmed = line.trim();
      if (trimmed.length > 0) segments.push(trimmed);
      line = '';
    } else if (code === 0x7f || code === 0x08) {
      // 退格 DEL/BS：按字符删尾（Array.from 防止切坏多字节中文）
      const chars = Array.from(line);
      chars.pop();
      line = chars.join('');
    } else if (code === 0x1b) {
      // ESC 序列（方向键/功能键/粘贴标记等）：吞掉整个序列，避免残留 [A 之类污染缓冲
      i = skipEscapeSequence(data, i);
    } else if (code >= 0x20) {
      line += ch;
      hadInput = true;
    }
    // 其它控制字符（0x00-0x1f，Ctrl/Tab 等）忽略
  }

  return { line, segments, hadInput };
}

/**
 * 从 ESC 序列起始位置 i，返回该序列最后一个字节的位置（含），供循环跳过整个序列。
 * 覆盖 CSI(ESC [)、OSC(ESC ])、SS3(ESC O) 与单字符 ESC 序列。
 */
function skipEscapeSequence(data: string, i: number): number {
  // data[i] === 0x1b (ESC)
  if (i + 1 >= data.length) return i;  // 孤立 ESC
  const next = data.charCodeAt(i + 1);

  if (next === 0x5b) {
    // CSI: ESC [ params(0x30-0x3f) intermed(0x20-0x2f) final(0x40-0x7e)
    let j = i + 2;
    while (j < data.length) {
      const c = data.charCodeAt(j);
      if (c >= 0x40 && c <= 0x7e) return j;        // final byte
      if (c >= 0x20 && c <= 0x3f) { j++; continue; }
      return j;                                    // 异常字节，停止
    }
    return data.length - 1;
  }
  if (next === 0x5d) {
    // OSC: ESC ] ... BEL(0x07) 或 ST(ESC \)
    let j = i + 2;
    while (j < data.length) {
      if (data.charCodeAt(j) === 0x07) return j;
      if (data.charCodeAt(j) === 0x1b && j + 1 < data.length && data.charCodeAt(j + 1) === 0x5c) return j + 1;
      j++;
    }
    return data.length - 1;
  }
  if (next === 0x4f) {
    // SS3: ESC O <final>
    return Math.min(i + 2, data.length - 1);
  }
  // 单字符 ESC 序列：ESC <byte>
  return i + 1;
}

function stripTerminalControlSequences(text: string): string {
  return text
    // OSC: ESC ] ... BEL / ESC \
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    // CSI: ESC [ ... final-byte
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // DCS/PM/APC/SOS: ESC P/^/_/X ... ESC \
    .replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, '')
    // Single-character ESC sequences.
    .replace(/\x1b[@-_]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

// 各 CLI 的 resume 命令格式不同，逐一匹配
// 返回完整恢复命令和会话 ID，无匹配返回 null
function parseResumeCommand(text: string): { command: string; sessionId: string } | null {
  const patterns: Array<{ re: RegExp; build: (m: RegExpMatchArray) => string }> = [
    // Cursor Agent: "agent --resume=<uuid>"
    { re: /\b(agent)\s+--resume=([\w-]+)/i, build: m => `${m[1]} --resume=${m[2]}` },
    // Claude Code: "claude --resume <uuid>" —— id 必须是 UUID，
    // 否则会把 Claude 自己打印的提示文案（如 "claude --resume to ..."）误抓成会话 id
    { re: /\b(claude)\s+--resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i, build: m => `${m[1]} --resume ${m[2]}` },
    // Kiro: "kiro-cli --resume-id <uuid>"
    { re: /\b(kiro[\w-]*)\s+--resume-id\s+([\w-]+)/i, build: m => `${m[1]} --resume-id ${m[2]}` },
    // Codex: "codex resume <id>"
    { re: /\b(codex)\s+resume\s+([\w-]+)/i, build: m => `${m[1]} resume ${m[2]}` },
    // OpenCode: "opencode -s <ses_id>"
    { re: /\b(opencode)\s+-s\s+(\w+)/i, build: m => `${m[1]} -s ${m[2]}` },
    // Devin: "devin -r <session_name>"
    { re: /\b(devin)\s+-r\s+([\w-]+)/i, build: m => `${m[1]} -r ${m[2]}` },
  ];

  for (const { re, build } of patterns) {
    const match = text.match(re);
    if (match) {
      return { command: build(match), sessionId: match[2] };
    }
  }
  return null;
}

// 读取 Devin 可用账号数（用于限制自动切号轮次）
function getDevinAccountCount(): number {
  try {
    const accountsPath = path.join(os.homedir(), '.session-sync-manager', 'accounts.json');
    if (fs.existsSync(accountsPath)) {
      const data = JSON.parse(fs.readFileSync(accountsPath, 'utf-8'));
      return (data.accounts || []).filter((a: any) => a.enabled !== false).length || 1;
    }
  } catch { /* ignore */ }
  return 1;
}

// Devin 设备指纹旋转（防止跨账号限流关联）
const DEVIN_INSTALLATION_ID_PATHS = [
  path.join(os.homedir(), '.local', 'share', 'devin', 'cli', 'installation_id'),
  path.join(os.homedir(), '.local', 'share', 'devin', 'cli-next', 'installation_id'),
];

// Windsurf Electron 设备 ID（Devin 二进制会读取 Windsurf 配置路径）
const WINDSURF_MACHINEID_PATHS = [
  path.join(os.homedir(), 'Library', 'Application Support', 'Windsurf', 'machineid'),
  path.join(os.homedir(), 'Library', 'Application Support', 'Windsurf - Next', 'machineid'),
];

export function rotateDevinInstallationId(): void {
  const newId = crypto.randomUUID().toUpperCase();

  // 1) Devin CLI installation_id
  for (const p of DEVIN_INSTALLATION_ID_PATHS) {
    try {
      if (fs.existsSync(p)) {
        fs.writeFileSync(p, newId);
        console.log(`[PTY] Rotated installation_id: ${p} → ${newId}`);
      } else {
        const dir = path.dirname(p);
        if (fs.existsSync(dir)) {
          fs.writeFileSync(p, newId);
          console.log(`[PTY] Created installation_id: ${p} → ${newId}`);
        }
      }
    } catch (e) {
      console.warn(`[PTY] Failed to rotate installation_id ${p}:`, (e as Error).message);
    }
  }

  // 2) Windsurf machineid（用不同的 UUID，避免两个 ID 相同引发关联）
  const newMachineId = crypto.randomUUID().toUpperCase();
  for (const p of WINDSURF_MACHINEID_PATHS) {
    try {
      if (fs.existsSync(p)) {
        fs.writeFileSync(p, newMachineId);
        console.log(`[PTY] Rotated machineid: ${p} → ${newMachineId}`);
      }
    } catch (e) {
      console.warn(`[PTY] Failed to rotate machineid ${p}:`, (e as Error).message);
    }
  }
}

// 解析 session-sync 的绝对路径（避免 Dock 启动时 PATH 缺失导致 ENOENT）
const sessionSyncPath = (() => {
  try {
    const syncSymlink = path.join(os.homedir(), '.local', 'bin', 'session-sync');
    if (fs.existsSync(syncSymlink)) return fs.realpathSync(syncSymlink);
  } catch { /* ignore */ }
  return 'session-sync'; // fallback to PATH lookup
})();

export function getDisplayName(presetCommand: string): string {
  return PRESET_DISPLAY_NAMES[presetCommand] || presetCommand || '终端';
}

export class PtyManager {
  private sessions: Map<string, PtySession> = new Map();
  private nextId = 1;
  private events: PtyManagerEvents;
  private getTitleAIConfig?: TitleAIConfigProvider;

  constructor(events: PtyManagerEvents, getTitleAIConfig?: TitleAIConfigProvider) {
    this.events = events;
    this.getTitleAIConfig = getTitleAIConfig;
  }

  create(cwd: string, presetCommand: string, themeId: string, envOverrides?: Record<string, string>): PtySession {
    const id = `term-${this.nextId++}`;
    const shell = process.platform === 'win32'
      ? (process.env.COMSPEC || 'cmd.exe')
      : (process.env.SHELL || '/bin/zsh');

    // 先复制 process.env，过滤掉 undefined 值，然后应用覆盖（空字符串用于清除）
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    if (envOverrides) {
      for (const [key, value] of Object.entries(envOverrides)) {
        if (value === '') {
          // 空字符串表示清除该变量
          delete env[key];
        } else {
          env[key] = value;
        }
      }
      // 调试日志
      console.log('[PtyManager] 设置的环境变量:', JSON.stringify(envOverrides));
    }

    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env,
    });

    const session: PtySession = {
      id,
      ptyProcess,
      buffer: '',
      rawBuffer: '',
      userInputs: [],
      commandCount: 0,
      title: '新会话',
      titleLocked: false,
      titleGenerated: false,
      currentLine: '',
      accumulatedInputs: [],
      titleSegmentCount: 0,
      summarizeScheduled: false,
      summarizeTimer: null,
      cwd,
      presetCommand,
      themeId,
      provider: null,
      createdAt: Date.now(),
      resumeId: null,
      resumeCommand: null,
      autoRetryCooldown: 0,
      prevData: '',
      retryTimer: null,
      switchAttempts: 0,
      lastAutoSwitchAt: 0,
      rateLimitRetryCount: 0,
      lastRateLimitAt: 0,
      disposables: [],
    };

    session.disposables.push(ptyProcess.onData((data: string) => {
      session.buffer += data;
      // 限制buffer大小，避免内存膨胀
      if (session.buffer.length > 5000) {
        session.buffer = session.buffer.slice(-2500);
      }
      // rawBuffer 用于远程终端回放（弱网下 replay 体积直接决定首屏速度，
      // 上限 128KB：足够覆盖几屏可视内容 + 适量回滚，再多也很难真的滚到）
      session.rawBuffer += data;
      if (session.rawBuffer.length > 131072) {
        // 直接 slice 可能把 ANSI 转义序列切成两半（半截 ESC），
        // replay 时 xterm 收到残缺序列会把后续可见字符当成参数吃掉 → spinner 撕裂多行。
        // 把切点往后推到下一个 ESC 字节，保证从一个完整序列开头处恢复。
        let cut = session.rawBuffer.length - 131072;
        const nextEsc = session.rawBuffer.indexOf('\x1b', cut);
        if (nextEsc !== -1 && nextEsc - cut < 4096) cut = nextEsc;
        session.rawBuffer = session.rawBuffer.slice(cut);
      }

      // 拦截 OSC 0/1/2 窗口/图标标题序列：ESC ] 0;<title> BEL  或 ESC ] 0;<title> ESC \
      // 仅在用户未配置 AI 时使用 — 配了 AI 就让 AI 起标题，OSC 仅作兜底
      // 注意：OSC 标题可能是 shell 启动时自动设置的（如当前目录），不算用户意图
      //       所以不设 titleGenerated，让后续 AI 生成可以覆盖
      const titleCfg = this.getTitleAIConfig?.();
      const aiConfigured = !!(titleCfg?.baseUrl && titleCfg.apiKey && titleCfg.model);
      if (!aiConfigured) {
        const oscMatch = data.match(/\x1b\][012];([^\x07\x1b]*)(?:\x07|\x1b\\)/);
        if (oscMatch && oscMatch[1]) {
          const oscTitle = oscMatch[1].trim();
          if (oscTitle && oscTitle.length >= 2 && oscTitle.length <= 80
              && !session.titleLocked) {
            session.title = oscTitle.length > 40 ? oscTitle.slice(0, 40) + '…' : oscTitle;
            // 不设 titleGenerated — OSC 可能只是 shell 启动信息，等用户有输入后再确认
            this.events.onTitleUpdate(id, session.title);
          }
        }
      }

      // 实时捕获各 CLI 的 resume 命令（格式各异）
      if (!session.resumeId) {
        const stripped = stripTerminalControlSequences(data);
        const result = parseResumeCommand(stripped);
        if (result) {
          session.resumeId = result.sessionId;
          session.resumeCommand = result.command;
        }
      }

      // Devin 终端专属：自动重试与切号
      // 仅对 devin presetCommand 生效，其他终端不触发
      if (session.presetCommand.startsWith('devin')) {
        const combinedLower = (session.prevData + data).toLowerCase();
        session.prevData = data;

        // 检测 rate limit 相关错误（涵盖硬限流和软限流）
        // 典型特征: "Permission denied: Reached overall message rate limit"
        const isRateLimit = combinedLower.includes('rate limit')
          || combinedLower.includes('quota exhausted')
          || combinedLower.includes('usage is exhausted');

        // 严格匹配：连续出现 rate limit 错误的判定阈值
        const RATE_LIMIT_RETRY_MAX = 3;       // 发"继续"最多尝试次数
        const RATE_LIMIT_WINDOW = 15000;      // 窗口期：15 秒内的连续 rate limit 才算一轮

        if (isRateLimit) {
          session.prevData = '';
          const now = Date.now();

          // 防止 PTY 分片导致的重复触发：如果已有 retryTimer 在跑，跳过本次
          if (session.retryTimer) return;

          // 超出窗口期则重新计数（上一次 rate limit 已久，不算连续）
          if (now - session.lastRateLimitAt > RATE_LIMIT_WINDOW) {
            session.rateLimitRetryCount = 0;
          }
          session.lastRateLimitAt = now;
          session.rateLimitRetryCount++;

          const maxAccounts = getDevinAccountCount();

          if (session.rateLimitRetryCount <= RATE_LIMIT_RETRY_MAX) {
            // 阶段 1: 在 session 内发"继续"尝试恢复
            console.log(`[PTY] 检测到 rate limit (${session.rateLimitRetryCount}/${RATE_LIMIT_RETRY_MAX})，${session.rateLimitRetryCount < RATE_LIMIT_RETRY_MAX ? '5' : 8} 秒后发"继续" (session: ${id})`);
            session.retryTimer = setTimeout(() => {
              session.retryTimer = null;
              if (!this.sessions.has(id)) return;
              ptyProcess.write('继续\r');
              console.log(`[PTY] 已发送"继续" (${session.rateLimitRetryCount}/${RATE_LIMIT_RETRY_MAX}) (session: ${id})`);
            }, session.rateLimitRetryCount < RATE_LIMIT_RETRY_MAX ? 5000 : 8000);
          } else if (session.switchAttempts >= maxAccounts) {
            // 阶段 3: 所有账号都试过了，放弃
            const errMsg = `\n⚠️ [DuoCLI] 全部 ${maxAccounts} 个账号已耗尽，请稍后再试\n`;
            ptyProcess.write(errMsg);
            this.events.onAutoSwitchStatus?.(id, 'exhausted', `全部 ${maxAccounts} 个号已耗尽`);
            console.log(`[PTY] 全部 ${maxAccounts} 个账号已耗尽 (session: ${id})`);
            session.switchAttempts = 0;
            session.rateLimitRetryCount = 0;
            session.autoRetryCooldown = now + 60000;
          } else if (now > session.autoRetryCooldown) {
            // 阶段 2: 连续多次"继续"无效，走换号流程
            session.switchAttempts++;
            session.rateLimitRetryCount = 0;
            session.lastAutoSwitchAt = now;
            session.autoRetryCooldown = now + 30000;

            this.events.onAutoSwitchStatus?.(id, 'switching', `换号中 (${session.switchAttempts}/${maxAccounts})`);
            console.log(`[PTY] 连续 ${RATE_LIMIT_RETRY_MAX} 次 rate limit 未恢复，执行换号 ${session.switchAttempts}/${maxAccounts} (session: ${id})`);

            // 1) 优雅退出当前 Devin
            ptyProcess.write('/exit\r');

            // 2) 等 3 秒让 Devin 完全退出，再执行 session-sync go（切号 + 启动新 Devin）
            session.retryTimer = setTimeout(() => {
              session.retryTimer = null;
              if (!this.sessions.has(id)) return;
              session.buffer = '';
              session.rawBuffer = '';
              session.prevData = '';
              rotateDevinInstallationId();
              ptyProcess.write('session-sync go\r');
              this.events.onAutoSwitchStatus?.(id, 'switched', `已切换 (${session.switchAttempts}/${maxAccounts})`);
              console.log(`[PTY] 已发送 session-sync go (session: ${id})`);

              session.autoRetryCooldown = 0;
              // 15 秒后如果没再触发 rate limit，重置计数
              session.retryTimer = setTimeout(() => {
                session.retryTimer = null;
                if (this.sessions.has(id)) {
                  session.switchAttempts = 0;
                  this.events.onAutoSwitchStatus?.(id, 'idle');
                }
              }, 15000);
            }, 3000);
          }
        }
        // 非 rate limit 的普通警告 → 8 秒后发"继续"
        else if (combinedLower.includes('⚠') || combinedLower.includes('something went wrong')) {
          session.prevData = '';
          if (Date.now() > session.autoRetryCooldown) {
            console.log(`[PTY] 检测到 ⚠ 警告，8 秒后发送"继续" (session: ${id})`);
            session.autoRetryCooldown = Date.now() + 10000;
            session.retryTimer = setTimeout(() => {
              session.retryTimer = null;
              if (!this.sessions.has(id)) return;
              ptyProcess.write('继续\r');
              session.autoRetryCooldown = 0;
            }, 8000);
          }
        }
      } else {
        session.prevData = data;
      }

      this.events.onData(id, data);
      this.events.onRawData?.(id, data);
    }));

    session.disposables.push(ptyProcess.onExit(() => {
      this.events.onExit(id);
      this.sessions.delete(id);
    }));

    this.sessions.set(id, session);

    // 如果有预设命令，延迟发送
    if (presetCommand) {
      setTimeout(() => {
        ptyProcess.write(presetCommand + '\r');
      }, 300);
    }

    return session;
  }

  write(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session) return;

    // 用户手动输入 → 重置自动切号计数（用户接管了）
    session.switchAttempts = 0;

    // 「智能起名」：旁路观察用户击键，维护行缓冲（绝不影响下面的命令转发）
    const parsed = processUserInputData(session.currentLine, data);
    session.currentLine = parsed.line;

    // 每检测到一次回车分段 → 累加进 accumulatedInputs，并在封顶前安排起名（覆盖式更新）
    if (parsed.segments.length > 0) {
      session.accumulatedInputs.push(...parsed.segments);
      if (!session.titleGenerated && !session.titleLocked
          && session.titleSegmentCount < TITLE_SEGMENT_CAP) {
        session.titleSegmentCount = Math.min(TITLE_SEGMENT_CAP, session.titleSegmentCount + parsed.segments.length);
        // 防抖 800ms：合并连续回车，最后一次为准
        if (session.summarizeTimer) {
          clearTimeout(session.summarizeTimer);
        }
        session.summarizeScheduled = true;
        session.summarizeTimer = setTimeout(() => {
          session.summarizeTimer = null;
          void this.triggerSummarize(id);
        }, 800);
      }
    }

    // 用户有可见输入（逐字/粘贴）或回车 → 通知功能 arm（index.ts 消费 onPasteInput）
    if (parsed.hadInput || parsed.segments.length > 0 || data === '\r') {
      this.events.onPasteInput?.(id, session.cwd);
    }

    // C1 硬约束：对所有输入照常转发给 CLI，起名逻辑是纯旁路
    session.ptyProcess.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (!session) return;
    // 过滤无效尺寸，node-pty resize(0,0) 会抛异常
    if (cols > 0 && rows > 0) {
      session.ptyProcess.resize(cols, rows);
    }
  }

  destroy(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.summarizeTimer) {
      clearTimeout(session.summarizeTimer);
      session.summarizeTimer = null;
    }
    if (session.retryTimer) {
      clearTimeout(session.retryTimer);
      session.retryTimer = null;
    }
    session.disposables.forEach(d => d.dispose());
    session.disposables = [];
    session.ptyProcess.kill();
    this.sessions.delete(id);
  }

  getSession(id: string): PtySession | undefined {
    return this.sessions.get(id);
  }

  rename(id: string, title: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.title = title;
    session.titleLocked = true;
    this.events.onTitleUpdate(id, title);
  }

  /**
   * 强制重新用 AI 生成标题。用户右键"重新生成标题"调用。
   * 会清掉 lock/generated 标记，再走一次 AI；失败则保持原标题。
   */
  async regenerateTitle(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    session.titleLocked = false;
    session.titleGenerated = false;
    session.summarizeScheduled = false;
    await this.triggerSummarize(id);
  }

  getAllSessions(): PtySession[] {
    return Array.from(this.sessions.values())
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * 从 buffer 中提取 resume 命令（关闭前的兜底，处理 resume 输出跨 chunk 的情况）
   */
  captureResumeFromBuffer(id: string): void {
    const session = this.sessions.get(id);
    if (!session || session.resumeId) return;
    const stripped = stripTerminalControlSequences(session.buffer);
    const result = parseResumeCommand(stripped);
    if (result) {
      session.resumeId = result.sessionId;
      session.resumeCommand = result.command;
      return;
    }
    // 不从 ~/.claude/projects 猜测“最新”会话：同一工作目录可同时运行多个 Claude，
    // 无法证明文件属于当前 PTY 时宁可不保存恢复记录，也不能恢复到错误会话。
  }

  getCwd(id: string): string {
    const session = this.sessions.get(id);
    if (!session) return os.homedir();
    try {
      const pid = session.ptyProcess.pid;
      let dir = '';
      if (process.platform === 'win32') {
        // Windows 无法可靠获取子进程 cwd，直接 fallback
      } else if (process.platform === 'linux') {
        try {
          dir = fs.readlinkSync(`/proc/${pid}/cwd`);
        } catch { /* ignore */ }
      } else {
        // macOS
        const result = execSync(`lsof -p ${pid} -Fn 2>/dev/null | grep '^n/' | head -1`, {
          encoding: 'utf-8',
          timeout: 2000,
        });
        dir = result.trim().replace(/^n/, '');
      }
      if (dir) return dir;
    } catch {
      // 忽略错误
    }
    return session.cwd;
  }

  private async triggerSummarize(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.titleLocked || session.titleGenerated) return;

    // 起名唯一料源：用户先后发送的各段输入。绝不掺 CLI 输出 / 终端输出。
    const inputs = session.accumulatedInputs;
    if (inputs.length === 0) {
      session.summarizeScheduled = false;
      return;
    }
    const inputsText = inputs.join('\n');
    // 是否已达封顶段：达到后本次起名即锁死，后续不再自动改名
    const atCap = session.titleSegmentCount >= TITLE_SEGMENT_CAP
               || inputs.length >= TITLE_SEGMENT_CAP;

    const config = this.getTitleAIConfig?.();
    if (config?.baseUrl && config.apiKey && config.model) {
      try {
        const prompt = [
          '你是终端会话标题生成助手。下面是用户先后输入并发送给命令行工具的内容，',
          '请理解用户想做什么，生成一个简洁的中文标题（不超过 12 个字，不要标点、不要引号、不要解释）。',
          '',
          '用户输入：',
          inputsText,
          '',
          '只返回标题本身。',
        ].join('\n');
        const title = await requestTitleFromConfiguredAI(config, prompt);
        const latest = this.sessions.get(id);
        if (latest && !latest.titleLocked && title) {
          latest.title = cleanGeneratedTitle(title).slice(0, 50);
          // 封顶才锁死；未封顶则保持 false，允许后续段覆盖更新（R4 累加覆盖）
          latest.titleGenerated = atCap;
          latest.summarizeScheduled = false;
          this.events.onTitleUpdate(id, latest.title);
          return;
        }
      } catch (err) {
        console.error('[PtyManager] AI 标题生成失败，走兜底:', err instanceof Error ? err.message : err);
      }
    }

    // 兜底：用累积用户输入截断当标题（不再用 buffer / 终端输出）
    const latest = this.sessions.get(id);
    if (!latest || latest.titleLocked || latest.titleGenerated) return;
    latest.summarizeScheduled = false;
    const fallback = inputsText.replace(/\n/g, ' ').trim();
    if (!fallback) return;
    latest.title = fallback.length > 40 ? fallback.slice(0, 40) + '…' : fallback;
    latest.titleGenerated = atCap;
    this.events.onTitleUpdate(id, latest.title);
  }
}
