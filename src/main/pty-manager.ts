import * as pty from 'node-pty';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { requestTitleFromConfiguredAI, cleanGeneratedTitle, TitleAIConfig } from './title-ai';
import { TerminalState, TerminalSnapshot } from './terminal-state';
import {
  findNewAutoResponseRule,
  TerminalAutoResponseConfig,
} from './terminal-auto-response';
import {
  CliKind,
  ResumeCapture,
  buildResumeCommand,
  createCursorSessionId,
  identifyCli,
  parseResumeCommandLine,
  parseResumeOutput,
  preassignSessionId,
  resolveSessionId,
} from './session-resume';
import { buildLaunchWrite, normalizePresetEnv } from './preset-env';
import { stripLeadingEnvAssignments } from './dsh-host';

export interface PtySession {
  id: string;
  ptyProcess: pty.IPty;
  buffer: string;
  rawBuffer: string;          // 完整 ANSI 输出，用于远程终端回放
  lastSequence: number;       // rawBuffer 对应的终端解析序号
  terminalState: TerminalState;
  submissions: Map<string, { text: string; result: Promise<void>; settled: boolean }>;
  submitQueue: Promise<void>;
  userInputs: string[];
  commandCount: number;
  title: string;
  titleLocked: boolean;
  titleGenerated: boolean;
  // —— 「智能起名」用户输入行缓冲（只用用户敲下的内容起名，绝不掺 CLI 输出）——
  currentLine: string;            // 当前正在输入、尚未回车的行缓冲
  accumulatedInputs: string[];    // 已发送的各段用户输入（起名唯一料源）
  titleSegmentCount: number;      // 已触发起名的段数（回车计数，封顶 TITLE_SEGMENT_CAP）
  titleInputRevision: number;     // 每次提交指令递增，用于丢弃过期的异步起名结果
  summarizeScheduled: boolean;
  summarizeTimer: NodeJS.Timeout | null;
  cwd: string;
  presetCommand: string;
  launchCommand: string;           // preset plus a provider-specific preassigned id
  cliKind: CliKind;
  themeId: string;
  provider: string | null;    // 实际使用的模型提供商 (如 MiniMax, GLM 等)
  createdAt: number;          // 创建时间戳
  resumeId: string | null;    // 捕获的 resume session ID (UUID)
  resumeCommand: string | null; // 完整 resume 命令 (如 "claude --resume xxx")
  resumeSource: ResumeCapture['source'] | null;
  closing: boolean;
  closePromise?: Promise<ResumeCapture | null>;
  launchSentAt: number | null;
  launchCommandEchoed: boolean;
  launchEchoBuffer: string;
  launchPreExecSeen: boolean;
  launchOutput: string;
  launchReturnedToShell: boolean;
  launchTimer: NodeJS.Timeout | null;
  disposables: pty.IDisposable[];
  autoResponseTail: string;      // 已处理输出的短尾，仅用于跨 PTY 分片匹配
  autoResponseLastTriggeredAt: Map<string, number>;
  autoResponseTimers: Set<NodeJS.Timeout>;
  // —— pty 尺寸归属：桌面和手机共用一个 pty，尺寸跟着最后在输入的那一端走。
  // 每次 SIGWINCH 都会让 TUI 全量重绘并在滚动区留下残帧，两端抢尺寸会刷屏。——
  currentCols: number;
  currentRows: number;
  sizeBySource: Record<PtyInputSource, { cols: number; rows: number } | null>;
  sizeOwner: PtyInputSource | null;
  lastInputAt: Record<PtyInputSource, number>;
}

export type PtyInputSource = 'desktop' | 'mobile';

interface PtyManagerEvents {
  onData: (id: string, data: string) => void;
  onTitleUpdate: (id: string, title: string) => void;
  onExit: (id: string) => void;
  onPasteInput?: (id: string, cwd: string) => void;
  onRawData?: (id: string, data: string, sequence: number) => void;
  onResize?: (id: string, cols: number, rows: number) => void;
}

export type TitleAIConfigProvider = () => TitleAIConfig | null;
export type TerminalAutoResponseConfigProvider = () => TerminalAutoResponseConfig;

/**
 * Build the environment inherited by a PTY. Cursor Agent sets this marker
 * while running its own child agents so their credentials stay in memory;
 * forwarding it into DuoCLI would make an interactive Cursor CLI forget its
 * login as soon as each PTY exits.
 */
export function buildPtyEnvironment(
  cliKind: CliKind,
  envOverrides?: Record<string, string>,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) env[key] = value;
  }
  if (envOverrides) {
    for (const [key, value] of Object.entries(envOverrides)) {
      if (value === '') delete env[key];
      else env[key] = value;
    }
  }
  if (cliKind === 'cursor' && env.AGENT_CLI_CREDENTIAL_STORE?.toLowerCase() === 'memory') {
    delete env.AGENT_CLI_CREDENTIAL_STORE;
  }
  return env;
}

// 命令 → 友好显示名称映射（精确匹配，优先于启发式推断）
const PRESET_DISPLAY_NAMES: Record<string, string> = {
  'claude --dangerously-skip-permissions': 'Claude全自动',
  'codex --full-auto': 'Codex全自动',
  'codex -c sandbox_mode="danger-full-access" -c approval="never" -c network="enabled"': 'Codex全自动',
  'devin --permission-mode bypass': 'Devin全自动',
  'kimi --auto': 'Kimi全自动',
  'gemini --yolo': 'Gemini全自动',
  'qodercli --dangerously-skip-permissions': 'Qoder全自动',
  'qoder --dangerously-skip-permissions': 'Qoder全自动',
  'qoder chat --dangerously-skip-permissions': 'Qoder全自动',
  'qodercn --dangerously-skip-permissions': 'QoderCN全自动',
  'opencode': 'OpenCode',
  'kiro-cli chat --trust-all-tools': 'Kiro全自动',
  'agent --force --approve-mcps': 'Cursor全自动',
  'agy --dangerously-skip-permissions': 'Antigravity全自动',
  'dsh-tui': 'DSH',
};

const CLI_BASE_DISPLAY_NAMES: Record<CliKind, string> = {
  claude: 'Claude',
  codex: 'Codex',
  devin: 'Devin',
  kimi: 'Kimi',
  gemini: 'Gemini',
  qoder: 'Qoder',
  qodercn: 'QoderCN',
  opencode: 'OpenCode',
  kiro: 'Kiro',
  cursor: 'Cursor',
  agy: 'Antigravity',
  dsh: 'DSH',
  unknown: '',
};

function isAutoPresetCommand(presetCommand: string, cli: CliKind): boolean {
  switch (cli) {
    case 'claude':
      return /--dangerously-skip-permissions/.test(presetCommand);
    case 'codex':
      return /--full-auto/.test(presetCommand)
        || /sandbox_mode=["']danger-full-access["']/.test(presetCommand)
        || /approval=["']never["']/.test(presetCommand);
    case 'devin':
      return /--permission-mode\s+bypass/.test(presetCommand);
    case 'kimi':
      return /--auto\b/.test(presetCommand);
    case 'gemini':
      return /--yolo/.test(presetCommand);
    case 'qoder':
    case 'qodercn':
      return /--dangerously-skip-permissions/.test(presetCommand)
        || /--permission-mode\s+bypass_permissions/.test(presetCommand)
        || /--yolo\b/.test(presetCommand);
    case 'kiro':
      return /--trust-all-tools/.test(presetCommand);
    case 'cursor':
      return /--force/.test(presetCommand) && /--approve-mcps/.test(presetCommand);
    case 'agy':
      return /--dangerously-skip-permissions/.test(presetCommand);
    default:
      return false;
  }
}

// 终端会话标题「智能起名」：起名材料累加到第 N 段（用户每次回车发送算一段）后锁定，不再自动改名
const TITLE_SEGMENT_CAP = 3;
const AUTO_RESPONSE_TAIL_LENGTH = 512;

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

export function getDisplayName(presetCommand: string): string {
  if (!presetCommand) return '终端';
  const exact = PRESET_DISPLAY_NAMES[presetCommand];
  if (exact) return exact;

  const cli = identifyCli(presetCommand);
  const base = CLI_BASE_DISPLAY_NAMES[cli];
  if (!base) return '终端';

  return isAutoPresetCommand(presetCommand, cli) ? `${base}全自动` : base;
}

export class PtyManager {
  private sessions: Map<string, PtySession> = new Map();
  private nextId = 1;
  private events: PtyManagerEvents;
  private getTitleAIConfig?: TitleAIConfigProvider;
  private getTerminalAutoResponseConfig?: TerminalAutoResponseConfigProvider;
  private remoteSubscriberCheck: ((id: string) => boolean) | null = null;

  constructor(
    events: PtyManagerEvents,
    getTitleAIConfig?: TitleAIConfigProvider,
    getTerminalAutoResponseConfig?: TerminalAutoResponseConfigProvider,
  ) {
    this.events = events;
    this.getTitleAIConfig = getTitleAIConfig;
    this.getTerminalAutoResponseConfig = getTerminalAutoResponseConfig;
  }

  /** 远程浏览器订阅某会话时，桌面 pane 尺寸不应再驱动共享 PTY。 */
  setRemoteSubscriberCheck(check: (id: string) => boolean): void {
    this.remoteSubscriberCheck = check;
  }

  create(cwd: string, presetCommand: string, themeId: string, envOverrides?: Record<string, string>): PtySession {
    const id = `term-${this.nextId++}`;
    const cliKind = identifyCli(presetCommand);
    let launchCommand = presetCommand;
    let initialResume: ResumeCapture | null = parseResumeCommandLine(presetCommand);

    // Allocate IDs before launching the CLIs that support it. This makes a
    // forced PTY close recoverable even when the CLI never gets a chance to
    // print its usual “to resume” hint.
    if (!initialResume && cliKind === 'cursor') {
      const cursorId = createCursorSessionId(cwd);
      if (cursorId) {
        launchCommand = buildResumeCommand(presetCommand, cursorId);
        initialResume = {
          cli: cliKind,
          sessionId: cursorId,
          resumeCommand: buildResumeCommand(presetCommand, cursorId),
          source: 'preassigned',
        };
      }
    } else if (!initialResume && (cliKind === 'claude' || cliKind === 'gemini' || cliKind === 'qoder' || cliKind === 'qodercn')) {
      const preassigned = preassignSessionId(presetCommand, crypto.randomUUID());
      launchCommand = preassigned.command;
      initialResume = preassigned.capture;
    }
    if (cliKind === 'dsh') {
      // 新版 dsh-tui 是 DSH profile 插件，自己 boot harness，不要再塞 DSH_URL / HTTP 启动器。
      launchCommand = stripLeadingEnvAssignments(launchCommand);
    }
    const shell = process.platform === 'win32'
      ? (process.env.COMSPEC || 'cmd.exe')
      : (process.env.SHELL || '/bin/zsh');

    const env = buildPtyEnvironment(cliKind, envOverrides ? normalizePresetEnv(envOverrides) : undefined);
    if (envOverrides) {
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
      lastSequence: 0,
      terminalState: new TerminalState(),
      submissions: new Map(),
      submitQueue: Promise.resolve(),
      userInputs: [],
      commandCount: 0,
      title: '新会话',
      titleLocked: false,
      titleGenerated: false,
      currentLine: '',
      accumulatedInputs: [],
      titleSegmentCount: 0,
      titleInputRevision: 0,
      summarizeScheduled: false,
      summarizeTimer: null,
      cwd,
      presetCommand,
      launchCommand,
      cliKind,
      themeId,
      provider: null,
      createdAt: Date.now(),
      resumeId: initialResume?.sessionId || null,
      resumeCommand: initialResume?.resumeCommand || null,
      resumeSource: initialResume?.source || null,
      closing: false,
      launchSentAt: null,
      launchCommandEchoed: false,
      launchEchoBuffer: '',
      launchPreExecSeen: false,
      launchOutput: '',
      launchReturnedToShell: false,
      launchTimer: null,
      autoResponseTail: '',
      autoResponseLastTriggeredAt: new Map(),
      autoResponseTimers: new Set(),
      currentCols: 80,
      currentRows: 24,
      sizeBySource: { desktop: null, mobile: null },
      sizeOwner: 'desktop',
      lastInputAt: { desktop: 0, mobile: 0 },
      disposables: [],
    };

    session.disposables.push(ptyProcess.onData((data: string) => {
      session.buffer += data;
      // 限制buffer大小，避免内存膨胀
      if (session.buffer.length > 5000) {
        session.buffer = session.buffer.slice(-2500);
      }
      if (session.launchCommand && session.launchSentAt !== null) {
        let postEchoData = data;
        if (!session.launchCommandEchoed && session.resumeId) {
          const directIndex = data.indexOf(session.resumeId);
          session.launchEchoBuffer = (session.launchEchoBuffer + data).slice(-Math.max(512, session.resumeId.length * 2));
          if (directIndex >= 0) {
            session.launchCommandEchoed = true;
            session.launchOutput = '';
            session.launchReturnedToShell = false;
            postEchoData = data.slice(directIndex + session.resumeId.length);
          } else if (session.launchEchoBuffer.includes(session.resumeId)) {
            session.launchCommandEchoed = true;
            session.launchOutput = '';
            session.launchReturnedToShell = false;
          }
        }
        if (session.launchCommandEchoed) {
          session.launchOutput += postEchoData;
          if (session.launchOutput.length > 8000) session.launchOutput = session.launchOutput.slice(-4000);
          const preExecIndex = postEchoData.indexOf('\x1b]697;PreExec\x07');
          if (preExecIndex >= 0) session.launchPreExecSeen = true;
          // Shell integration emits this OSC marker after PreExec when the
          // command has returned to the prompt. Initial prompt markers can be
          // delayed until after the PTY write, so ignore them before PreExec.
          const promptMatch = /\x1b\]697;(?:StartPrompt|EndPrompt)\x07/.exec(postEchoData);
          if (promptMatch && session.launchPreExecSeen
              && (preExecIndex < 0 || promptMatch.index > preExecIndex)) {
            session.launchReturnedToShell = true;
          }
        }
      }
      this.maybeAutoRespondToTerminalOutput(session, data);

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
        // Parse the rolling buffer, not only this PTY chunk: CLIs frequently
        // wrap the resume command at the terminal width or split it across
        // node-pty data events.
        const result = parseResumeOutput(session.buffer, session.presetCommand);
        if (result) {
          session.resumeId = result.sessionId;
          session.resumeCommand = result.resumeCommand;
          session.resumeSource = result.source;
        }
      }

      this.events.onData(id, data);
      session.terminalState.write(data, sequence => {
        // Only publish raw history after the same bytes have been parsed by
        // TerminalState. This keeps rawBuffer and lastSequence aligned when
        // a reconnect races with a burst of PTY output.
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
        session.lastSequence = sequence;
        this.events.onRawData?.(id, data, sequence);
      });
    }));

    session.disposables.push(ptyProcess.onExit(() => {
      // Keep the session in the map while the provider registry is queried;
      // the main-process onExit callback needs the resolved metadata before
      // the object is removed.
      const finalize = async () => {
        if (session.launchTimer) {
          clearTimeout(session.launchTimer);
          session.launchTimer = null;
        }
        session.terminalState.dispose();
        this.clearAutoResponseTimers(session);
        this.captureResumeFromBuffer(id);
        if (!session.resumeId) {
          const resolved = resolveSessionId(session.cliKind, session.cwd, session.createdAt, session.presetCommand, session.ptyProcess.pid);
          if (resolved) {
            session.resumeId = resolved.sessionId;
            session.resumeCommand = resolved.resumeCommand;
            session.resumeSource = resolved.source;
          }
        }
        this.events.onExit(id);
        this.sessions.delete(id);
      };
      void finalize();
    }));

    this.sessions.set(id, session);

    // 如果有预设命令，延迟发送
    if (launchCommand) {
      session.launchTimer = setTimeout(() => {
        session.launchTimer = null;
        // A close can happen during the 300ms shell-start window. Do not
        // inject a command into a session that is already being torn down.
        if (this.sessions.get(id) !== session || session.closing) return;
        session.launchSentAt = Date.now();
        session.launchCommandEchoed = false;
        session.launchEchoBuffer = '';
        session.launchPreExecSeen = false;
        session.launchOutput = '';
        session.launchReturnedToShell = false;
        ptyProcess.write(buildLaunchWrite(launchCommand, envOverrides));
      }, 300);
    }

    return session;
  }

  write(id: string, data: string, source: PtyInputSource = 'desktop'): void {
    const session = this.sessions.get(id);
    if (!session || session.closing) return;
    // 终端能力/光标报告不是用户输入，不能触发尺寸接管或取消任务。
    if (/^(?:\x1b\[[?>]?[\d;:]*c|\x1b\[\d+n|\x1b\[\??\d+;\d+R|\x1b\[\?[\d;]+\$y|\x1b\](?:10|11|12);[^\x07\x1b]*(?:\x07|\x1b\\))+$/.test(data)) {
      if (session.sizeOwner === source) session.ptyProcess.write(data);
      return;
    }

    session.lastInputAt[source] = Date.now();
    if (session.sizeOwner !== source) {
      session.sizeOwner = source;
      // 接管终端的那一端立刻拿回自己上次 fit 出的尺寸
      const own = session.sizeBySource[source];
      if (own && (own.cols !== session.currentCols || own.rows !== session.currentRows)) {
        this.applyResize(session, own.cols, own.rows);
      }
    }

    // 用户主动输入表示接管终端，取消尚未发送的容错回复。
    this.clearAutoResponseTimers(session);

    // 「智能起名」：旁路观察用户击键，维护行缓冲（绝不影响下面的命令转发）
    const parsed = processUserInputData(session.currentLine, data);
    session.currentLine = parsed.line;

    // 每检测到一次回车分段 → 累加进 accumulatedInputs，并在封顶前安排起名（覆盖式更新）
    if (parsed.segments.length > 0) {
      session.accumulatedInputs.push(...parsed.segments);
      session.titleInputRevision++;
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
          void this.triggerSummarize(id, session.titleInputRevision);
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

  submit(id: string, submissionId: string, text: string, enterDelayMs = 50): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || session.closing) return Promise.reject(new Error('会话已结束'));
    const existing = session.submissions.get(submissionId);
    if (existing) return existing.text === text ? existing.result : Promise.reject(new Error('提交编号重复'));
    const result = session.submitQueue.then(async () => {
      if (this.sessions.get(id) !== session) throw new Error('会话已结束');
      let bracketed = false;
      await session.terminalState.snapshot(() => { bracketed = session.terminalState.terminal.modes.bracketedPasteMode; });
      const normalized = text.replace(/\r\n?/g, '\n');
      this.write(id, bracketed ? `\x1b[200~${normalized}\x1b[201~` : normalized, 'mobile');
      // TUI 输入状态需要完成一次更新；回车不能与粘贴被识别成同一次 paste。
      await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(120_000, enterDelayMs))));
      if (this.sessions.get(id) !== session) throw new Error('会话已结束');
      this.write(id, '\r', 'mobile');
    });
    session.submitQueue = result.catch(() => {});
    const entry = { text, result, settled: false };
    session.submissions.set(submissionId, entry);
    const prune = () => {
      entry.settled = true;
      for (const [key, value] of session.submissions) {
        if (session.submissions.size <= 256) break;
        // Never evict an in-flight ID: an HTTP retry may still be on its way.
        if (value.settled) session.submissions.delete(key);
      }
    };
    void result.then(prune, prune);
    return result;
  }

  snapshot(id: string, consume: (snapshot: TerminalSnapshot) => void): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || session.closing) return Promise.reject(new Error('会话已结束'));
    return session.terminalState.snapshot(consume);
  }

  resize(id: string, cols: number, rows: number, source: PtyInputSource = 'desktop', force = false): void {
    const session = this.sessions.get(id);
    if (!session || session.closing) return;
    // 过滤无效尺寸，node-pty resize(0,0) 会抛异常
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1 || cols > 1000 || rows > 1000) return;

    session.sizeBySource[source] = { cols, rows };

    // 浏览器端已订阅时，桌面分屏只影响本地 xterm 显示，不改共享 PTY 几何。
    if (source === 'desktop' && this.remoteSubscriberCheck?.(id)) {
      return;
    }

    // 另一端正在使用时不抢尺寸：每次 resize 都会让 TUI 重绘并在滚动区留下残帧。
    // force 用于手机端刚打开会话的首次 resize，属于显式接管。
    if (!force && session.sizeOwner && session.sizeOwner !== source) {
      return;
    }

    session.sizeOwner = source;
    // force = 对端刚打开会话，等同于一次活跃接管，先盖上时间戳防止立刻被抢回
    if (force) session.lastInputAt[source] = Date.now();
    if (cols === session.currentCols && rows === session.currentRows) return;
    this.applyResize(session, cols, rows);
  }

  private applyResize(session: PtySession, cols: number, rows: number): void {
    session.currentCols = cols;
    session.currentRows = rows;
    session.ptyProcess.resize(cols, rows);
    session.terminalState.resize(cols, rows, () => this.events.onResize?.(session.id, cols, rows));
  }

  /**
   * Resolve and persist provider metadata before killing a PTY. The old
   * renderer fire-and-forget destroy path could kill the shell before a CLI
   * emitted its resume hint; this handshake closes that race.
   */
  async close(id: string): Promise<ResumeCapture | null> {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.closePromise) return session.closePromise;
    session.closing = true;
    session.closePromise = (async () => {
      this.captureResumeFromBuffer(id);
      if (!session.resumeId) {
        const resolved = resolveSessionId(session.cliKind, session.cwd, session.createdAt, session.presetCommand, session.ptyProcess.pid);
        if (resolved) {
          session.resumeId = resolved.sessionId;
          session.resumeCommand = resolved.resumeCommand;
          session.resumeSource = resolved.source;
        }
      }
      const result = session.resumeId && session.resumeCommand
        ? {
            cli: session.cliKind,
            sessionId: session.resumeId,
            resumeCommand: session.resumeCommand,
            source: session.resumeSource || 'output',
          } as ResumeCapture
        : null;
      this.destroy(id);
      return result;
    })();
    return session.closePromise;
  }

  destroy(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.closing = true;
    if (session.launchTimer) {
      clearTimeout(session.launchTimer);
      session.launchTimer = null;
    }
    session.terminalState.dispose();
    if (session.summarizeTimer) {
      clearTimeout(session.summarizeTimer);
      session.summarizeTimer = null;
    }
    this.clearAutoResponseTimers(session);
    session.disposables.forEach(d => d.dispose());
    session.disposables = [];
    session.ptyProcess.kill();
    this.sessions.delete(id);
  }

  getSession(id: string): PtySession | undefined {
    return this.sessions.get(id);
  }

  getLaunchStatus(id: string): { sentAt: number | null; commandEchoed: boolean; output: string; returnedToShell: boolean } | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    return {
      sentAt: session.launchSentAt,
      commandEchoed: session.launchCommandEchoed,
      output: session.launchOutput,
      returnedToShell: session.launchReturnedToShell,
    };
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
    session.titleInputRevision++;
    session.summarizeScheduled = false;
    if (session.summarizeTimer) {
      clearTimeout(session.summarizeTimer);
      session.summarizeTimer = null;
    }
    await this.triggerSummarize(id, session.titleInputRevision);
  }

  getAllSessions(): PtySession[] {
    return Array.from(this.sessions.values())
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  private maybeAutoRespondToTerminalOutput(session: PtySession, data: string): void {
    const config = this.getTerminalAutoResponseConfig?.();
    const newText = stripTerminalControlSequences(data);
    const previousTail = session.autoResponseTail;
    session.autoResponseTail = (previousTail + newText).slice(-AUTO_RESPONSE_TAIL_LENGTH);
    if (!config?.enabled || config.rules.length === 0 || !newText) return;

    const rule = findNewAutoResponseRule(previousTail, newText, config.rules);
    if (!rule) return;

    const key = rule.keyword.toLocaleLowerCase();
    const now = Date.now();
    const cooldownMs = config.cooldownSeconds * 1000;
    const lastTriggeredAt = session.autoResponseLastTriggeredAt.get(key) || 0;
    if (now - lastTriggeredAt < cooldownMs) return;
    session.autoResponseLastTriggeredAt.set(key, now);

    const delayMs = config.delaySeconds * 1000;
    console.log(`[PTY] 容错规则命中: "${rule.keyword}"，${config.delaySeconds} 秒后发送 "${rule.response}" (session: ${session.id})`);
    const timer = setTimeout(() => {
      session.autoResponseTimers.delete(timer);
      if (this.sessions.get(session.id) !== session) return;
      session.ptyProcess.write(`${rule.response}\r`);
      console.log(`[PTY] 容错自动回复已发送 (session: ${session.id})`);
    }, delayMs);
    session.autoResponseTimers.add(timer);
  }

  private clearAutoResponseTimers(session: PtySession): void {
    for (const timer of session.autoResponseTimers) clearTimeout(timer);
    session.autoResponseTimers.clear();
  }

  /**
   * 从 buffer 中提取 resume 命令（关闭前的兜底，处理 resume 输出跨 chunk 的情况）
   */
  captureResumeFromBuffer(id: string): void {
    const session = this.sessions.get(id);
    if (!session || session.resumeId) return;
    const result = parseResumeOutput(session.buffer || '', session.presetCommand || '');
    if (result) {
      session.resumeId = result.sessionId;
      session.resumeCommand = result.resumeCommand;
      session.resumeSource = result.source;
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

  private async triggerSummarize(id: string, expectedRevision?: number): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.titleLocked || session.titleGenerated) return;

    const revision = session.titleInputRevision;
    if (expectedRevision !== undefined && expectedRevision !== revision) return;

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
        if (latest && !latest.titleLocked && !latest.titleGenerated
            && latest.titleInputRevision === revision && title) {
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
    if (!latest || latest.titleLocked || latest.titleGenerated
        || latest.titleInputRevision !== revision) return;
    latest.summarizeScheduled = false;
    const fallback = inputsText.replace(/\n/g, ' ').trim();
    if (!fallback) return;
    latest.title = fallback.length > 40 ? fallback.slice(0, 40) + '…' : fallback;
    latest.titleGenerated = atCap;
    this.events.onTitleUpdate(id, latest.title);
  }
}
