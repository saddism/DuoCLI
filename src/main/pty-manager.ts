import * as pty from 'node-pty';
import * as os from 'os';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { aiSummarize } from './ollama';

export interface PtySession {
  id: string;
  ptyProcess: pty.IPty;
  buffer: string;
  userInputs: string[];
  commandCount: number;
  title: string;
  titleLocked: boolean;
  titleGenerated: boolean;
  cwd: string;
  presetCommand: string;
  themeId: string;
}

interface PtyManagerEvents {
  onData: (id: string, data: string) => void;
  onTitleUpdate: (id: string, title: string) => void;
  onExit: (id: string) => void;
  onPasteInput?: (id: string, cwd: string) => void;
}

export class PtyManager {
  private sessions: Map<string, PtySession> = new Map();
  private nextId = 1;
  private events: PtyManagerEvents;

  constructor(events: PtyManagerEvents) {
    this.events = events;
  }

  create(cwd: string, presetCommand: string, themeId: string): PtySession {
    const id = `term-${this.nextId++}`;
    const shell = process.platform === 'win32'
      ? (process.env.COMSPEC || 'cmd.exe')
      : (process.env.SHELL || '/bin/zsh');

    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: { ...process.env } as { [key: string]: string },
    });

    const session: PtySession = {
      id,
      ptyProcess,
      buffer: '',
      userInputs: [],
      commandCount: 0,
      title: presetCommand ? `${presetCommand}:新会话` : '终端:新会话',
      titleLocked: false,
      titleGenerated: false,
      cwd,
      presetCommand,
      themeId,
    };

    ptyProcess.onData((data: string) => {
      session.buffer += data;
      // 限制buffer大小，避免内存膨胀
      if (session.buffer.length > 5000) {
        session.buffer = session.buffer.slice(-2500);
      }
      this.events.onData(id, data);
    });

    ptyProcess.onExit(() => {
      this.events.onExit(id);
      this.sessions.delete(id);
    });

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

    // 检测粘贴输入（语音输入法通过粘贴方式输入，一次性写入多个字符）
    if (data.length > 5 && data !== '\r') {
      const cleaned = data.replace(/[\r\n]/g, ' ').trim();
      if (cleaned.length > 0) {
        session.userInputs.push(cleaned);
        // 只保留最近20条
        if (session.userInputs.length > 20) {
          session.userInputs = session.userInputs.slice(-20);
        }
        // 触发粘贴输入事件，用于快照
        this.events.onPasteInput?.(id, session.cwd);
      }
    }

    // 检测回车键，计数命令
    if (data === '\r') {
      session.commandCount++;
      // 标题未成功生成时持续重试（前10次命令内）
      if (!session.titleGenerated && session.commandCount <= 10) {
        this.triggerSummarize(id);
      }
      // 每次执行命令时触发快照
      this.events.onPasteInput?.(id, session.cwd);
    }

    session.ptyProcess.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.ptyProcess.resize(cols, rows);
  }

  destroy(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
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

  getAllSessions(): PtySession[] {
    return Array.from(this.sessions.values());
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
    if (session.titleLocked) return;

    try {
      // 优先使用用户粘贴输入（语音输入法）来生成标题
      const source = session.userInputs.length > 0
        ? session.userInputs.join('\n')
        : session.buffer;
      const summary = await aiSummarize(source);
      const prefix = session.presetCommand || '终端';
      session.title = `${prefix}:${summary}`;
      session.titleGenerated = true;
      // 总结后清理
      session.buffer = session.buffer.slice(-500);
      session.userInputs = session.userInputs.slice(-5);
      this.events.onTitleUpdate(id, session.title);
    } catch {
      // 静默失败
    }
  }
}
