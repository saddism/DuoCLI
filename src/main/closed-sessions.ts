import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getDisplayName, PtyManager } from './pty-manager';
import {
  buildResumeCommand,
  evaluateRestoreProgress,
  identifyCli,
  isResumeCommandCompatible,
  ResumeCapture,
} from './session-resume';

/** 跨 Agent 上下文转移的对话历史记录 */
export interface ContextHistoryEntry {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: number;
}

export interface ClosedSession {
  id: string;
  title: string;
  cwd: string;
  presetCommand: string;
  resumeId: string;
  resumeCommand: string;
  displayName: string;
  closedAt: number;
  /** 会话最后活动时间；列表按这个从新到旧排，而不是按点击关闭的时间 */
  updatedAt?: number;
  cli?: string;
  resumeSource?: ResumeCapture['source'];
  state?: 'closed' | 'restoring';
  restoreStartedAt?: number;
  
  // ===== 新增：跨 Agent 上下文转移功能 =====
  /** 简单的对话历史（Q&A 对） */
  contextHistory?: ContextHistoryEntry[];
  /** 导出的上下文文件路径（供手机端访问） */
  exportPath?: string;
}

const MAX_CLOSED_SESSIONS = 20;

export function closedSessionUpdatedAt(session: {
  updatedAt?: number;
  closedAt?: number;
  contextHistory?: ContextHistoryEntry[];
}): number {
  const updated = Number(session.updatedAt);
  if (Number.isFinite(updated) && updated > 0) return updated;
  const history = session.contextHistory;
  if (Array.isArray(history)) {
    for (let i = history.length - 1; i >= 0; i--) {
      const ts = Number(history[i]?.timestamp);
      if (Number.isFinite(ts) && ts > 0) return ts;
    }
  }
  const closed = Number(session.closedAt);
  return Number.isFinite(closed) ? closed : 0;
}

export function sortClosedSessionsByUpdatedAt<T extends {
  updatedAt?: number;
  closedAt?: number;
  contextHistory?: ContextHistoryEntry[];
}>(sessions: T[]): T[] {
  return [...sessions].sort((a, b) => closedSessionUpdatedAt(b) - closedSessionUpdatedAt(a));
}

function collectResumeFileMtimes(root: string, wanted: Set<string>): Map<string, number> {
  const found = new Map<string, number>();
  if (!wanted.size) return found;
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return;
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      const full = path.join(dir, name);
      let stat: fs.Stats;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      for (const id of wanted) {
        if (!name.includes(id)) continue;
        const prev = found.get(id) || 0;
        if (stat.mtimeMs > prev) found.set(id, Math.round(stat.mtimeMs));
      }
    }
  };
  walk(root, 0);
  return found;
}

export class ClosedSessionsManager {
  private filePath: string;
  private listeners = new Set<(sessions: ClosedSession[]) => void>();
  /** 解析后的原始条目；SSE 每 2s 会读一次，不能每次都同步读盘 */
  private cached: ClosedSession[] | null = null;
  private displayNameResolver: ((presetCommand: string) => string) | null = null;

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, 'closed-sessions.json');
  }

  /** 自定义预设的名字只存在于远程配置里，注入后才能给落盘条目写上正确的显示名 */
  setDisplayNameResolver(resolver: (presetCommand: string) => string): void {
    this.displayNameResolver = resolver;
  }

  onUpdate(listener: (sessions: ClosedSession[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(sessions: ClosedSession[]): void {
    for (const listener of this.listeners) {
      try { listener(sessions); } catch { /* ignore */ }
    }
  }

  private read(): ClosedSession[] {
    if (this.cached) return this.cached;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      this.cached = Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      // 文件不存在是正常的“还没有记录”。损坏则必须留下备份：
      // 否则下一次 save 会把整份可恢复会话账本静默清空。
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[ClosedSessions] 记录文件损坏，已备份后重置:', err);
        try { fs.renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`); } catch { /* ignore */ }
      }
      this.cached = [];
    }
    return this.cached;
  }

  list(options?: { resetRestoring?: boolean }): ClosedSession[] {
    const mapped = this.read().map((value: any) => {
      const session = { ...value } as ClosedSession;
      if (session.resumeId && (
        !isResumeCommandCompatible(session.presetCommand || '', session.resumeCommand || '')
        || (session.resumeCommand || '').includes('undefined')
        || /[\r\n]/.test(session.resumeCommand || '')
      )) {
        session.resumeCommand = buildResumeCommand(session.presetCommand || '', session.resumeId);
      }
      session.cli = session.cli || identifyCli(session.presetCommand || '');
      if (options?.resetRestoring) {
        session.state = 'closed';
        delete session.restoreStartedAt;
      } else {
        session.state = session.state || 'closed';
      }
      return session;
    }).filter((session: ClosedSession) => !!session.resumeId);
    return sortClosedSessionsByUpdatedAt(mapped);
  }

  resetStaleRestores(): ClosedSession[] {
    const list = this.list({ resetRestoring: true });
    return this.save(list);
  }

  /** 旧记录只有关闭时间。启动时按本地 CLI 会话文件的最后写入时间补上 updatedAt，已有字段的不改。 */
  backfillUpdatedAtFromLocalSessions(sessionRoot = path.join(os.homedir(), '.codex', 'sessions')): ClosedSession[] {
    const sessions = this.list();
    const missing = sessions.filter(session => !session.updatedAt && session.resumeId);
    if (!missing.length) return sessions;
    const wanted = new Set(missing.map(session => session.resumeId));
    const found = collectResumeFileMtimes(sessionRoot, wanted);
    let changed = false;
    for (const session of sessions) {
      if (session.updatedAt) continue;
      const mtime = found.get(session.resumeId);
      if (mtime) {
        session.updatedAt = mtime;
        changed = true;
      }
    }
    return changed ? this.save(sessions) : sessions;
  }

  private save(sessions: ClosedSession[]): ClosedSession[] {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const filtered = sortClosedSessionsByUpdatedAt(
      sessions.filter(s => s.closedAt > cutoff)
    ).slice(0, MAX_CLOSED_SESSIONS);
    const serialized = JSON.stringify(filtered, null, 2);
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(temp, serialized);
      fs.renameSync(temp, this.filePath);
      this.cached = filtered;
    } catch {
      try {
        fs.writeFileSync(this.filePath, serialized);
        this.cached = filtered;
      } catch (err) {
        console.error('[ClosedSessions] 记录写入失败:', err);
      }
    }
    this.notify(filtered);
    return filtered;
  }

  add(session: {
    title: string;
    cwd: string;
    presetCommand: string;
    resumeId: string;
    resumeCommand: string;
    resumeSource?: ResumeCapture['source'];
    updatedAt?: number;
  }): ClosedSession[] {
    const list = this.list();
    const cli = identifyCli(session.presetCommand);
    const duplicateIndex = list.findIndex(item =>
      item.resumeId === session.resumeId && (item.cli || identifyCli(item.presetCommand)) === cli,
    );
    const updatedAt = Number(session.updatedAt);
    const entry: ClosedSession = {
      id: duplicateIndex >= 0
        ? list[duplicateIndex].id
        : `closed-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title: session.title,
      cwd: session.cwd,
      presetCommand: session.presetCommand,
      resumeId: session.resumeId,
      resumeCommand: session.resumeCommand || buildResumeCommand(session.presetCommand, session.resumeId),
      displayName: this.displayNameResolver?.(session.presetCommand) || getDisplayName(session.presetCommand),
      closedAt: Date.now(),
      updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : Date.now(),
      cli,
      resumeSource: session.resumeSource,
      state: 'closed',
    };
    if (duplicateIndex >= 0) list[duplicateIndex] = entry;
    else list.push(entry);
    return this.save(list);
  }

  remove(id: string): ClosedSession[] {
    return this.save(this.list().filter(s => s.id !== id));
  }

  clear(): ClosedSession[] {
    return this.save([]);
  }

  beginRestore(closedId: string): boolean {
    const restoreList = this.list();
    const closed = restoreList.find(item => item.id === closedId);
    if (!closed || closed.state === 'restoring') return false;
    closed.state = 'restoring';
    closed.restoreStartedAt = Date.now();
    const saved = this.save(restoreList);
    return saved.some(item => item.id === closedId && item.state === 'restoring');
  }

  /** 恢复流程中断时把条目退回“已关闭”；主动取消和确认失败共用这一条路径 */
  cancelRestore(closedId: string): boolean {
    const restoreList = this.list();
    const closed = restoreList.find(item => item.id === closedId);
    if (!closed || closed.state !== 'restoring') return false;
    closed.state = 'closed';
    delete closed.restoreStartedAt;
    this.save(restoreList);
    return true;
  }

  async confirmRestore(closedId: string, sessionId: string, ptyManager: PtyManager): Promise<boolean> {
    const restoreList = this.list();
    const closed = restoreList.find(item => item.id === closedId);
    if (!closed || closed.state !== 'restoring') return false;

    const failRestore = (): false => {
      this.cancelRestore(closedId);
      return false;
    };

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const session = ptyManager.getSession(sessionId);
      if (!session) return failRestore();
      if (session.resumeId && closed.resumeId && session.resumeId !== closed.resumeId) {
        return failRestore();
      }
      const verdict = evaluateRestoreProgress(ptyManager.getLaunchStatus(sessionId), Date.now());
      if (verdict === 'failure') return failRestore();
      if (verdict === 'success') return true;
      await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
    }
    return failRestore();
  }
}
