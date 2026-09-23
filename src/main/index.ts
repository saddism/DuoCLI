import { quickCommands } from './quick-commands';
import { app, BrowserWindow, ipcMain, dialog, clipboard, nativeImage, shell, globalShortcut } from 'electron';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { Notification } from 'electron';
import { PtyManager, getDisplayName } from './pty-manager';
import { getCliProvider, providerFromBaseUrl } from './cli-provider';
import { AIConfigManager } from './ai-config';
import { startRemoteServer, pushRawDataToRemote, sendRemotePush, addRemoteRecentCwd, syncRemoteRecentCwds, recordRemotePresetUsage, getCustomPresetEnv, updateRemoteAccessToken, generateAccessToken } from './remote-server';
import { CloudflaredManager } from './cloudflared-manager';
import { RemoteSyncHealth, RemoteSyncMonitor } from './remote-sync-monitor';
import {
  DEFAULT_TERMINAL_AUTO_RESPONSE_CONFIG,
  normalizeTerminalAutoResponseConfig,
  TerminalAutoResponseConfig,
} from './terminal-auto-response';
import { getAvailableBuiltinPresets, prewarmCliDetection } from './cli-detect';
import { ResumeCapture } from './session-resume';
import { ClosedSessionsManager, ContextHistoryEntry } from './closed-sessions';
import { AutoContinueManager } from './auto-continue-manager';
import { parseAndroidDevices, runAdb } from './android-devices';
import { humanizeAndroidImageError, prepareAdbScreenshot } from './android-screencap';
import { TerminalActivityTracker } from './terminal-activity-tracker';
import {
  appendNotifyTail,
  canNotifyAttention,
  classifyAttention,
  delayUntilNotify,
  NOTIFY_COOLDOWN_MS,
  stripAnsiForNotify,
  type AttentionKind,
} from './attention-notify';
import { TerminalTaskStore } from './terminal-task-store';
import { TerminalTaskScheduler } from './terminal-task-scheduler';
import type { TerminalTask } from './terminal-task-types';
import { requestTitleFromConfiguredAI, cleanGeneratedTitle } from './title-ai';
import { extractContextFromChunks } from './context-capture';
import { exportSessionContext, writeExportToFile } from './context-export';
import {
  listAppsForFile,
  openFileWithApp,
  openFileWithSystemDialog,
} from './open-with';

// macOS: 设置为普通应用模式，显示在 Dock 和 Command+Tab 切换器中
if (process.platform === 'darwin') {
  app.setActivationPolicy('regular');
}

// 文件监听器
let fileWatcher: fs.FSWatcher | null = null;
let watchingCwd: string | null = null;

import * as os from 'os';

const PASTE_IMAGE_DIR = path.join(os.tmpdir(), 'duocli-paste');

// 会话通知状态
const sessionLastInputAt: Map<string, number> = new Map();
const sessionArmedForNotify: Set<string> = new Set();
const sessionLastNotifyAt: Map<string, number> = new Map();
const sessionUserClosed: Set<string> = new Set();
const sessionRemoteViewing: Set<string> = new Set();
const pendingNotifyTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

const sessionOutputTail: Map<string, string> = new Map();
/** 用于累积上下文捕获的原始输出 */
const sessionContextBuffer: Map<string, string> = new Map();
const MAX_CONTEXT_BUFFER_CHARS = 2 * 1024 * 1024;

function appendSessionContext(id: string, data: string): void {
  if (!data) return;
  const previous = sessionContextBuffer.get(id) || '';
  const merged = previous + data;
  sessionContextBuffer.set(id, merged.length > MAX_CONTEXT_BUFFER_CHARS
    ? merged.slice(-MAX_CONTEXT_BUFFER_CHARS)
    : merged);
}

const DESKTOP_PREVIEW_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.log', '.json', '.jsonl', '.yaml', '.yml', '.toml',
  '.xml', '.csv', '.tsv', '.ini', '.conf', '.config', '.properties',
  '.js', '.jsx', '.ts', '.tsx', '.vue', '.css', '.scss', '.less', '.html', '.htm',
  '.py', '.pyw', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.cc', '.cpp', '.h',
  '.hpp', '.sh', '.bash', '.zsh', '.fish', '.sql', '.nvue', '.wxml', '.wxss',
]);
const DESKTOP_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};
const DESKTOP_MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

// ========== 已关闭会话持久化 ==========
let closedSessionsManager: ClosedSessionsManager;

function sessionUpdatedAt(session?: { updatedAt?: number; createdAt?: number; lastInputAt?: { desktop?: number; mobile?: number } } | null): number {
  if (!session) return Date.now();
  return Math.max(
    session.updatedAt || 0,
    session.createdAt || 0,
    session.lastInputAt?.desktop || 0,
    session.lastInputAt?.mobile || 0,
  ) || Date.now();
}

function addClosedSession(session: {
  title: string;
  cwd: string;
  presetCommand: string;
  resumeId: string;
  resumeCommand: string;
  resumeSource?: ResumeCapture['source'];
  contextHistory?: ContextHistoryEntry[];
  updatedAt?: number;
}): void {
  const saved = closedSessionsManager.add(session);
  safeSend('closed-sessions:update', saved);
}

function getPreferencePath(): string {
  return path.join(app.getPath('userData'), 'ai-preference.json');
}

const TERMINAL_AUTO_RESPONSE_FILE = path.join(app.getPath('userData'), 'terminal-auto-response.json');
let terminalAutoResponseConfig: TerminalAutoResponseConfig = loadTerminalAutoResponseConfig();

function loadTerminalAutoResponseConfig(): TerminalAutoResponseConfig {
  try {
    return normalizeTerminalAutoResponseConfig(JSON.parse(fs.readFileSync(TERMINAL_AUTO_RESPONSE_FILE, 'utf-8')));
  } catch {
    return normalizeTerminalAutoResponseConfig(DEFAULT_TERMINAL_AUTO_RESPONSE_CONFIG);
  }
}

function saveTerminalAutoResponseConfig(value: unknown): TerminalAutoResponseConfig {
  terminalAutoResponseConfig = normalizeTerminalAutoResponseConfig(value);
  fs.writeFileSync(TERMINAL_AUTO_RESPONSE_FILE, JSON.stringify(terminalAutoResponseConfig, null, 2));
  return terminalAutoResponseConfig;
}

interface AiPreferenceData {
  providerId: string | null;
  model: string | null;
  manualConfig?: { apiFormat: string; baseUrl: string; apiKey: string; model: string };
}

function saveAiPreference(providerId: string, model?: string): void {
  try {
    const existing = loadAiPreferenceData();
    const data = { providerId, model: model || existing.model || '' };
    fs.writeFileSync(getPreferencePath(), JSON.stringify(data));
    aiPreferenceCache = null;
  } catch { /* ignore */ }
}

function loadAiPreference(): string | null {
  return loadAiPreferenceData().providerId;
}

let aiPreferenceCache: AiPreferenceData | null = null;
function loadAiPreferenceData(): AiPreferenceData {
  if (aiPreferenceCache) return aiPreferenceCache;
  try {
    const data = JSON.parse(fs.readFileSync(getPreferencePath(), 'utf-8'));
    aiPreferenceCache = {
      providerId: data.providerId || null,
      model: data.model || null,
      manualConfig: data.manualConfig || undefined,
    };
  } catch {
    aiPreferenceCache = { providerId: null, model: null };
  }
  return aiPreferenceCache;
}

function invalidateAiPreferenceCache(): void {
  aiPreferenceCache = null;
}

// 编辑器偏好持久化
function getEditorPrefPath(): string {
  return path.join(app.getPath('userData'), 'editor-preference.json');
}

function saveEditorPreference(editorPath: string): void {
  try { fs.writeFileSync(getEditorPrefPath(), JSON.stringify({ editorPath })); } catch { /* ignore */ }
}

function loadEditorPreference(): string | null {
  try {
    const data = JSON.parse(fs.readFileSync(getEditorPrefPath(), 'utf-8'));
    return data.editorPath || null;
  } catch { return null; }
}

let mainWindow: BrowserWindow | null = null;
let ptyManager: PtyManager;
let isQuitting = false;
let quitConfirmed = false;
let quitDialogOpen = false;
let ignoreActivateUntil = 0;

/** LaunchAgent KeepAlive 守护：用户主动退出时写暂停标记，避免 Cmd+Q 后又被拉起。 */
const KEEP_ALIVE_LABEL = 'com.kaifeng.duocli-app';
const KEEP_ALIVE_DIR = path.join(os.homedir(), '.config', 'duocli-tunnel');
const KEEP_ALIVE_PAUSE_PATH = path.join(KEEP_ALIVE_DIR, 'app-keep.paused');
const KEEP_ALIVE_PLIST_PATH = path.join(
  os.homedir(),
  'Library',
  'LaunchAgents',
  `${KEEP_ALIVE_LABEL}.plist`,
);

function clearKeepAlivePause(): void {
  if (process.platform !== 'darwin') return;
  try {
    if (fs.existsSync(KEEP_ALIVE_PAUSE_PATH)) fs.unlinkSync(KEEP_ALIVE_PAUSE_PATH);
  } catch {
    // ignore
  }
}

/** Cmd+Q / 菜单退出：暂停守护，进程退出后再 bootout，防止 KeepAlive 立刻重开。 */
function pauseKeepAliveDaemon(): void {
  if (process.platform !== 'darwin') return;
  try {
    fs.mkdirSync(KEEP_ALIVE_DIR, { recursive: true });
    fs.writeFileSync(KEEP_ALIVE_PAUSE_PATH, `${new Date().toISOString()}\n`);
  } catch {
    // ignore
  }
  try {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (uid == null) return;
    const pid = process.pid;
    spawn(
      'bash',
      [
        '-c',
        `while kill -0 ${pid} 2>/dev/null; do sleep 0.2; done; ` +
          `launchctl bootout gui/${uid}/${KEEP_ALIVE_LABEL} >/dev/null 2>&1 || true`,
      ],
      { detached: true, stdio: 'ignore' },
    ).unref();
  } catch {
    // ignore
  }
}

/** 用户再次主动打开应用时恢复守护（若本机已安装对应 LaunchAgent）。 */
function resumeKeepAliveDaemon(): void {
  if (process.platform !== 'darwin') return;
  clearKeepAlivePause();
  if (!fs.existsSync(KEEP_ALIVE_PLIST_PATH)) return;
  try {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (uid == null) return;
    spawn('launchctl', ['bootstrap', `gui/${uid}`, KEEP_ALIVE_PLIST_PATH], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  } catch {
    // already loaded / unavailable — ignore
  }
}
const aiConfigManager = new AIConfigManager();
let cloudflaredManager: CloudflaredManager | null = null;
let cachedRemoteServerInfo: any = null;
let remoteServer: ReturnType<typeof startRemoteServer> | null = null;
let remoteSyncMonitor: RemoteSyncMonitor | null = null;
let remoteServerRestarting = false;
let autoContinueManager: AutoContinueManager | null = null;
let terminalActivityTracker: TerminalActivityTracker | null = null;
let terminalTaskScheduler: TerminalTaskScheduler | null = null;

function publishRemoteServerInfo(
  info: { lanUrl: string; token: string; port: number },
  tunnel?: ReturnType<CloudflaredManager['getStatus']>,
  health?: RemoteSyncHealth,
): void {
  const serverInfo = {
    ...info,
    publicUrl: tunnel?.url || undefined,
    tunnel,
    health,
  };
  cachedRemoteServerInfo = serverInfo;
  safeSend('remote:server-info', serverInfo);
  if (health) safeSend('remote:health-update', health);
}

function mergeRemoteHealthIntoCache(health: RemoteSyncHealth): void {
  if (!cachedRemoteServerInfo || !cloudflaredManager) {
    safeSend('remote:health-update', health);
    return;
  }
  const tunnel = cloudflaredManager.getStatus();
  cachedRemoteServerInfo = {
    ...cachedRemoteServerInfo,
    publicUrl: tunnel.url || undefined,
    tunnel,
    health,
  };
  safeSend('remote:health-update', health);
  safeSend('remote:server-info', cachedRemoteServerInfo);
}

function onRemoteServerStarted(info: { lanUrl: string; token: string; port: number }): void {
  remoteServerRestarting = false;
  const tunnel = cloudflaredManager?.ensureRunning();
  publishRemoteServerInfo(info, tunnel);
  void remoteSyncMonitor?.getHealth().then((health) => {
    publishRemoteServerInfo(info, cloudflaredManager?.getStatus() ?? tunnel, health);
  });
}

function restartRemoteAccessServer(): void {
  if (remoteServerRestarting) return;
  remoteServerRestarting = true;
  const resetTimer = setTimeout(() => {
    remoteServerRestarting = false;
  }, 15_000);
  remoteServer?.close();
  remoteServer = startRemoteServer(
    ptyManager,
    (sessionInfo) => safeSend('pty:remote-created', sessionInfo),
    (id) => safeSend('pty:exit', id),
    (info) => {
      clearTimeout(resetTimer);
      onRemoteServerStarted(info);
    },
    (session) => addClosedSession(session),
    closedSessionsManager,
    app.getPath('userData'), // 传入 userData 路径供上下文导出使用
    terminalTaskScheduler || undefined,
  );
}

function taskSessionInfo(session: ReturnType<PtyManager['create']>): Record<string, unknown> {
  const provider = getCliProvider(session.presetCommand);
  (session as any).provider = provider;
  return {
    id: session.id,
    title: session.title,
    themeId: session.themeId,
    cwd: session.cwd,
    displayName: getDisplayName(session.presetCommand),
    provider,
    cli: session.cliKind,
    resumeId: session.resumeId,
  };
}

async function waitForTaskTerminalReady(sessionId: string, presetCommand: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60_000) {
    const session = ptyManager.getSession(sessionId);
    if (!session) throw new Error('计划终端在启动过程中退出');
    if (!presetCommand) {
      if (Date.now() - startedAt >= 500) return;
    } else if (session.launchSentAt && Date.now() - Math.max(session.launchSentAt, session.updatedAt) >= 1500) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('终端启动超时，请手动确认后重试');
}

function setupTerminalTasks(): void {
  terminalActivityTracker = new TerminalActivityTracker(10_000);
  terminalActivityTracker.onChange(state => {
    const statuses = { ...((global as any).__sessionStatuses || {}) } as Record<string, string>;
    statuses[state.sessionId] = state.status === 'running' ? 'running' : 'idle';
    (global as any).__sessionStatuses = statuses;
    safeSend('session:activity-changed', state);
  });
  const store = new TerminalTaskStore(path.join(app.getPath('userData'), 'terminal-tasks.json'));
  terminalTaskScheduler = new TerminalTaskScheduler(store, terminalActivityTracker, {
    create: async (task: TerminalTask) => {
      const env = getCustomPresetEnv(task.presetCommand);
      const session = ptyManager.create(task.cwd, task.presetCommand, task.themeId, Object.keys(env).length ? env : undefined);
      try { recordRemotePresetUsage(task.presetCommand); } catch { /* ignore */ }
      const info = taskSessionInfo(session);
      safeSend('pty:task-created', info, task.id);
      await waitForTaskTerminalReady(session.id, task.presetCommand);
      return { sessionId: session.id };
    },
    submit: (sessionId, instruction, submissionId) => ptyManager.submit(sessionId, submissionId, instruction),
    cancel: async (sessionId) => { sessionUserClosed.add(sessionId); await ptyManager.close(sessionId); },
    hasSession: (sessionId) => Boolean(ptyManager.getSession(sessionId)),
    hasInputAutomation: (sessionId) => Boolean((autoContinueManager?.get(sessionId) as any)?.enabled),
  });
  terminalTaskScheduler.onChange(snapshot => safeSend('tasks:changed', snapshot));
  terminalTaskScheduler.start();
}

function openExternalHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(String(url || '').trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    void shell.openExternal(parsed.toString());
    return true;
  } catch {
    return false;
  }
}

function attachExternalLinkHandlers(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalHttpUrl(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url === win.webContents.getURL()) return;
    if (openExternalHttpUrl(url)) event.preventDefault();
  });
}

function loadAppIcon(): Electron.NativeImage | undefined {
  // macOS 打包后用 .icns，开发模式用 .png
  const candidates = [
    path.join(__dirname, '../../build/icon.png'),
    path.join(__dirname, '../../build/icon.icns'),
    path.join(app.getAppPath(), 'build', 'icon.png'),
    path.join(app.getAppPath(), 'build', 'icon.icns'),
  ];
  for (const iconPath of candidates) {
    try {
      if (!fs.existsSync(iconPath)) continue;
      const icon = nativeImage.createFromPath(iconPath);
      if (!icon.isEmpty()) return icon;
    } catch { /* next */ }
  }
  return undefined;
}

function createWindow(appIcon?: Electron.NativeImage): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    title: 'DuoCLI',
    icon: appIcon,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  attachExternalLinkHandlers(mainWindow);

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && (input.meta || input.control) && input.key.toLowerCase() === 'w') {
      event.preventDefault();
      mainWindow?.webContents.send('app:close-current-session');
    }
  });

  // 拦截 Command+R (macOS) 和 Ctrl+R (Windows/Linux) 防止刷新窗口
  const refreshKey = process.platform === 'darwin' ? 'Command+R' : 'Ctrl+R';
  globalShortcut.register(refreshKey, () => {
    // 不做任何操作，阻止默认刷新行为
  });

  // 关窗口只隐藏：进程留下给远程服务（9800 / Cloudflare）。
  // 真正退出走 Cmd+Q / 菜单退出。macOS 关最后一扇窗会误触发 activate，
  // 若这里直接 destroy，窗口会马上被再创建出来。
  const createdWindow = mainWindow;
  createdWindow.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    ignoreActivateUntil = Date.now() + 500;
    createdWindow.hide();
  });
  createdWindow.on('closed', () => {
    if (mainWindow === createdWindow) mainWindow = null;
  });
}

function safeSend(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    try {
      mainWindow.webContents.send(channel, ...args);
    } catch {
      // render frame disposed during GPU crash/restart
    }
  }
}

function isDesktopWindowFocused(): boolean {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused());
}

function clearPendingNotify(id: string): void {
  const timer = pendingNotifyTimers.get(id);
  if (timer) clearTimeout(timer);
  pendingNotifyTimers.delete(id);
}

function sendUserNotification(id: string, title: string, body: string, sound?: boolean): void {
  const attendingRemote = sessionRemoteViewing.has(id);
  const desktopFocused = isDesktopWindowFocused();
  // 正在看这个会话（手机）或 DuoCLI 窗口在前台时，不再弹系统通知。
  if (!attendingRemote && !desktopFocused) {
    sendRemotePush(title, body, id);
    if (sound !== false) playNotifySound();
    createDesktopNotification(title, body, id);
  }
  safeSend('notification', title, body, id);
}

// 创建桌面端系统通知（Electron Notification API）
function createDesktopNotification(title: string, body: string, sessionId?: string): void {
  if (!BrowserWindow.getAllWindows().length) return;
  
  const notification = new Notification({
    title: title,
    body: body,
    icon: path.join(__dirname, '../../build/icon.png'), // 使用应用图标
    silent: false, // 静音时会播放声音
    urgency: 'normal', // 正常优先级
  });
  
  notification.on('click', () => {
    // 点击通知时聚焦主窗口
    const window = BrowserWindow.getAllWindows()[0];
    if (window) {
      window.focus();
      window.show();
      if (sessionId) window.webContents.send('notification:open-session', sessionId);
    }
  });
  
  notification.show();
}

// 播放通知音效
function playNotifySound(): void {
  try {
    // Electron 环境下使用 AudioContext
    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    
    // 创建一个悦耳的完成音效（双音调）
    const now = audioCtx.currentTime;
    const oscillator1 = audioCtx.createOscillator();
    const gainNode1 = audioCtx.createGain();
    
    oscillator1.type = 'sine';
    oscillator1.frequency.setValueAtTime(880, now); // A5
    gainNode1.gain.setValueAtTime(0.3, now);
    gainNode1.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
    
    oscillator1.connect(gainNode1);
    gainNode1.connect(audioCtx.destination);
    
    oscillator1.start(now);
    oscillator1.stop(now + 0.1);
    
    // 第二个音调
    const oscillator2 = audioCtx.createOscillator();
    const gainNode2 = audioCtx.createGain();
    
    oscillator2.type = 'sine';
    oscillator2.frequency.setValueAtTime(1100, now + 0.1); // A#5
    gainNode2.gain.setValueAtTime(0.3, now + 0.1);
    gainNode2.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
    
    oscillator2.connect(gainNode2);
    gainNode2.connect(audioCtx.destination);
    
    oscillator2.start(now + 0.1);
    oscillator2.stop(now + 0.3);
    
  } catch (error) {
    console.warn('播放通知音效失败:', error);
  }
}

function notifyTitleFor(kind: AttentionKind): string {
  if (kind === 'decision') return '需要你决策';
  if (kind === 'done') return '任务已完成';
  return '会话等待输入';
}

function flushAttentionNotify(id: string, expectedKind: AttentionKind): void {
  pendingNotifyTimers.delete(id);
  const kind = classifyAttention(sessionOutputTail.get(id) || '');
  if (!kind) return;
  if (kind !== expectedKind && !(expectedKind !== 'decision' && kind === 'decision')) return;
  const now = Date.now();
  if (!canNotifyAttention({
    kind,
    armed: sessionArmedForNotify.has(id),
    now,
    lastInputAt: sessionLastInputAt.get(id) || 0,
    lastNotifyAt: sessionLastNotifyAt.get(id) || 0,
  })) return;
  const session = ptyManager.getSession(id);
  const title = session?.title || session?.presetCommand || '终端';
  sendUserNotification(id, notifyTitleFor(kind), title);
  sessionLastNotifyAt.set(id, now);
  sessionArmedForNotify.delete(id);
}

function maybeNotifyAttention(id: string, data: string): void {
  const plain = stripAnsiForNotify(data);
  if (!plain.trim()) return;

  const tail = appendNotifyTail(sessionOutputTail.get(id) || '', plain);
  sessionOutputTail.set(id, tail);

  const kind = classifyAttention(tail);
  clearPendingNotify(id);
  if (!kind) return;
  if (kind !== 'decision' && !sessionArmedForNotify.has(id)) return;

  const now = Date.now();
  if (now - (sessionLastNotifyAt.get(id) || 0) < NOTIFY_COOLDOWN_MS) return;

  const delay = delayUntilNotify(kind, now, sessionLastInputAt.get(id) || 0);
  const timer = setTimeout(() => flushAttentionNotify(id, kind), delay);
  timer.unref?.();
  pendingNotifyTimers.set(id, timer);
}

function setupPtyManager(): void {
  ptyManager = new PtyManager({
    onData: (id, data) => {
      safeSend('pty:data', id, data);
      terminalActivityTracker?.noteData(id, data);
      autoContinueManager?.observeOutput(id, data);
      
      // ===== 累积上下文输出用于捕获 =====
      appendSessionContext(id, data);
      
      maybeNotifyAttention(id, data);
    },
    onRawData: (id, data, sequence) => {
      pushRawDataToRemote(id, data, sequence);
      safeSend('pty:parsed', id, data, sequence);
    },
    onTitleUpdate: (id, title) => {
      safeSend('pty:title-update', id, title);
    },
    onExit: (id) => {
      terminalTaskScheduler?.sessionExited(id, sessionUserClosed.has(id));
      terminalActivityTracker?.remove(id);
      autoContinueManager?.remove(id);
      // 兜底：从 buffer 中提取 resume ID
      ptyManager.captureResumeFromBuffer(id);

      // 保存有 resume ID 的会话到已关闭列表
      const session = ptyManager.getSession(id);
      if (session?.resumeId) {
        addClosedSession({
          title: session.title,
          cwd: session.cwd,
          presetCommand: session.presetCommand,
          resumeId: session.resumeId,
          resumeCommand: session.resumeCommand || '',
          resumeSource: session.resumeSource || undefined,
          updatedAt: sessionUpdatedAt(session),
        });
      }

      // 用户主动关闭的会话不发通知
      if (!sessionUserClosed.has(id)) {
        const title = session?.title || '终端';
        sendUserNotification(id, '会话已结束', title);
        
        // 发送给前端渲染进程
        safeSend('pty:exit', id);
        safeSend('notification', '会话已结束', `${title} 已退出`);
      } else {
        // 用户主动关闭的会话，只发送 exit 事件
        safeSend('pty:exit', id);
      }
      sessionUserClosed.delete(id);
      sessionOutputTail.delete(id);
      sessionLastInputAt.delete(id);
      sessionArmedForNotify.delete(id);
      sessionLastNotifyAt.delete(id);
      sessionRemoteViewing.delete(id);
      clearPendingNotify(id);
      sessionContextBuffer.delete(id);
    },
    onPasteInput: (id, cwd) => {
      sessionLastInputAt.set(id, Date.now());
      sessionArmedForNotify.add(id);
      clearPendingNotify(id);
      autoContinueManager?.noteManualInput(id);
    },
  },
  () => loadAiPreferenceData().manualConfig || null,
  () => terminalAutoResponseConfig,
  );
}

function registerIPC(): void {
  // 设置窗口标题
  ipcMain.on('window:set-title', (_e, title: string) => {
    if (mainWindow) mainWindow.setTitle(title);
  });

  // 创建终端
  ipcMain.handle('pty:create', (_e, cwd: string, presetCommand: string, themeId: string, providerEnv?: Record<string, string>) => {
    const extra = providerEnv && typeof providerEnv === 'object' ? providerEnv : {};
    const env = { ...getCustomPresetEnv(presetCommand), ...extra };
    const session = ptyManager.create(
      cwd,
      presetCommand,
      themeId,
      Object.keys(env).length ? env : undefined,
    );
    // 统计失败不能连带让 ipcMain.handle reject：渲染端拿不到会话 id，PTY 就成了孤儿。
    try {
      recordRemotePresetUsage(presetCommand);
    } catch { /* ignore */ }
    const provider = providerEnv?.ANTHROPIC_BASE_URL
      ? (providerFromBaseUrl(providerEnv.ANTHROPIC_BASE_URL) || 'Custom')
      : getCliProvider(presetCommand);
    (session as any).provider = provider;
    return {
      id: session.id,
      title: session.title,
      themeId: session.themeId,
      cwd: session.cwd,
      displayName: getDisplayName(session.presetCommand),
      provider,
      cli: session.cliKind,
      resumeId: session.resumeId,
    };
  });

  ipcMain.handle('tasks:list', () => terminalTaskScheduler?.snapshot() || { revision: 0, tasks: [] });
  ipcMain.handle('tasks:create', (_e, input) => {
    if (!terminalTaskScheduler) throw new Error('计划任务服务尚未就绪');
    return terminalTaskScheduler.create(input);
  });
  ipcMain.handle('tasks:update', (_e, taskId: string, input) => {
    if (!terminalTaskScheduler) throw new Error('计划任务服务尚未就绪');
    return terminalTaskScheduler.update(String(taskId || ''), input);
  });
  ipcMain.handle('tasks:cancel', (_e, taskId: string) => {
    if (!terminalTaskScheduler) throw new Error('计划任务服务尚未就绪');
    return terminalTaskScheduler.cancel(String(taskId || ''));
  });
  ipcMain.handle('tasks:pause', (_e, taskId: string) => {
    if (!terminalTaskScheduler) throw new Error('计划任务服务尚未就绪');
    return terminalTaskScheduler.pause(String(taskId || ''));
  });
  ipcMain.handle('tasks:resume', (_e, taskId: string) => {
    if (!terminalTaskScheduler) throw new Error('计划任务服务尚未就绪');
    return terminalTaskScheduler.resume(String(taskId || ''));
  });
  ipcMain.handle('tasks:run-now', (_e, taskId: string) => {
    if (!terminalTaskScheduler) throw new Error('计划任务服务尚未就绪');
    return terminalTaskScheduler.runNow(String(taskId || ''));
  });
  ipcMain.handle('tasks:remove', (_e, taskId: string) => {
    if (!terminalTaskScheduler) throw new Error('计划任务服务尚未就绪');
    return terminalTaskScheduler.remove(String(taskId || ''));
  });
  ipcMain.handle('tasks:confirm-complete', (_e, taskId: string) => {
    if (!terminalTaskScheduler) throw new Error('计划任务服务尚未就绪');
    return terminalTaskScheduler.confirmComplete(String(taskId || ''));
  });

  ipcMain.handle('quick-commands:get', () => quickCommands.read());
  ipcMain.handle('quick-commands:update', (_e, operation) => quickCommands.update(operation));
  ipcMain.handle('pty:submit', (_e, id: string, submissionId: string, text: string) => {
    if (typeof text !== 'string' || text.length > 100000 || typeof submissionId !== 'string') throw new Error('无效消息');
    return ptyManager.submit(id, submissionId, text);
  });

  // 写入数据
  ipcMain.handle('pty:write', (_e, id: string, data: string) => {
    console.log(`[Main] pty:write 收到, id=${id}, data="${data}"`);
    ptyManager.write(id, data);
    return true;
  });

  // 调整大小
  ipcMain.handle('pty:resize', (_e, id: string, cols: number, rows: number) => {
    ptyManager.resize(id, cols, rows);
    return true;
  });

  ipcMain.handle('pty:snapshot', (_e, id: string, options?: { scrollback?: number }) => {
    return new Promise((resolve, reject) => {
      ptyManager.snapshot(id, snapshot => resolve(snapshot), options).catch(reject);
    });
  });

  ipcMain.handle('pty:history-before', (_e, id: string, query?: {
    beforeCursor?: string | null;
    limitRows?: number;
    requestId?: string;
    epoch?: number;
  }) => {
    return ptyManager.historyBefore(id, query || {});
  });

  ipcMain.handle('pty:history-meta', (_e, id: string) => {
    return ptyManager.historyMeta(id);
  });

  // 销毁终端
  ipcMain.handle('pty:destroy', async (_e, id: string) => {
    // Resolve provider metadata before kill. This is intentionally awaited so
    // Devin/OpenCode/Kimi/Kiro registries cannot race the PTY teardown.
    sessionUserClosed.add(id);
    const beforeClose = ptyManager.getSession(id);
    const capture = await ptyManager.close(id);
    
    // ===== 捕获对话历史用于跨 Agent 上下文转移 =====
    let contextHistory: ContextHistoryEntry[] | undefined;
    const buffer = sessionContextBuffer.get(id);
    if (buffer && buffer.length > 0) {
      try {
        const chunks = buffer.split('\n').filter(Boolean);
        const cliKind = beforeClose?.cliKind || 'unknown';
        const result = extractContextFromChunks(chunks, cliKind);
        if (result.hasContent) {
          contextHistory = result.history;
          console.log(`[ContextCapture] 会话 ${id} 捕获到 ${contextHistory.length} 条对话`);
        }
      } catch (err) {
        console.error('[ContextCapture] 提取失败:', err);
      } finally {
        sessionContextBuffer.delete(id);
      }
    }
    
    if (beforeClose?.resumeId) {
      addClosedSession({
        title: beforeClose.title,
        cwd: beforeClose.cwd,
        presetCommand: beforeClose.presetCommand,
        resumeId: beforeClose.resumeId,
        resumeCommand: beforeClose.resumeCommand || '',
        resumeSource: beforeClose.resumeSource || undefined,
        contextHistory,
        updatedAt: sessionUpdatedAt(beforeClose),
      });
    } else if (capture?.sessionId) {
      // `close` normally leaves the session object available until destroy;
      // retain a defensive branch for future PtyManager implementations.
      addClosedSession({
        title: '终端',
        cwd: beforeClose?.cwd || os.homedir(),
        presetCommand: beforeClose?.presetCommand || capture.cli,
        resumeId: capture.sessionId,
        resumeCommand: capture.resumeCommand,
        resumeSource: capture.source,
        contextHistory,
        updatedAt: sessionUpdatedAt(beforeClose),
      });
    }
    sessionOutputTail.delete(id);
    sessionLastInputAt.delete(id);
    sessionArmedForNotify.delete(id);
    sessionLastNotifyAt.delete(id);
    sessionRemoteViewing.delete(id);
    clearPendingNotify(id);
    sessionUserClosed.delete(id);
    return !!capture || !!beforeClose?.resumeId;
  });

  // 重命名终端
  ipcMain.on('pty:rename', (_e, id: string, title: string) => {
    ptyManager.rename(id, title);
  });

  // 重新用 AI 生成标题
  ipcMain.handle('pty:regenerate-title', async (_e, id: string) => {
    await ptyManager.regenerateTitle(id);
  });

  // 根据用户输入文本生成标题（计划任务名称等）
  ipcMain.handle('title:suggest-from-text', async (_e, text: string) => {
    const input = String(text || '').trim();
    if (!input) return '';
    const fallback = input.replace(/\s+/g, ' ').slice(0, 40);
    const config = loadAiPreferenceData().manualConfig || null;
    if (!config?.baseUrl || !config?.apiKey || !config?.model) return fallback;
    try {
      const prompt = [
        '你是终端会话标题生成助手。下面是用户准备发送给命令行工具的内容，',
        '请理解用户想做什么，生成一个简洁的中文标题（不超过 12 个字，不要标点、不要引号、不要解释）。',
        '',
        '用户输入：',
        input,
        '',
        '只返回标题本身。',
      ].join('\n');
      const title = await requestTitleFromConfiguredAI(config, prompt);
      return cleanGeneratedTitle(title).slice(0, 50) || fallback;
    } catch (err) {
      console.error('[Main] 标题建议失败:', err instanceof Error ? err.message : err);
      return fallback;
    }
  });

  // 获取所有会话信息
  ipcMain.handle('pty:sessions', () => {
    return ptyManager.getAllSessions().map((s) => ({
      id: s.id,
      title: s.title,
      themeId: s.themeId,
      cwd: s.cwd,
      displayName: getDisplayName(s.presetCommand),
      cli: s.cliKind,
      resumeId: s.resumeId,
    }));
  });

  // ========== 已关闭会话 IPC ==========
  ipcMain.handle('closed-sessions:list', () => closedSessionsManager.list());
  ipcMain.handle('closed-sessions:begin-restore', (_e, closedId: string) => {
    return closedSessionsManager.beginRestore(closedId);
  });
  ipcMain.handle('closed-sessions:cancel-restore', (_e, closedId: string) => {
    return closedSessionsManager.cancelRestore(closedId);
  });
  ipcMain.handle('closed-sessions:remove', (_e, id: string) => {
    return closedSessionsManager.remove(id);
  });
  ipcMain.handle('closed-sessions:clear', () => {
    return closedSessionsManager.clear();
  });
  ipcMain.handle('closed-sessions:confirm-restore', async (_e, closedId: string, sessionId: string) => {
    const ok = await closedSessionsManager.confirmRestore(closedId, sessionId, ptyManager);
    if (ok) closedSessionsManager.remove(closedId);
    return ok;
  });

  // 选择工作目录
  ipcMain.handle('dialog:select-folder', async (_e, currentPath?: string) => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      defaultPath: currentPath || os.homedir(),
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // 读取目录（左侧文件树）
  ipcMain.handle('file-tree:list-dir', (_e, dirPath: string) => {
    try {
      const abs = path.resolve(String(dirPath || ''));
      const st = fs.statSync(abs);
      if (!st.isDirectory()) return [];

      const names = fs.readdirSync(abs);
      const items = names
        .filter((name) => name !== '.DS_Store')
        .map((name) => {
          const fullPath = path.join(abs, name);
          let isDir = false;
          try { isDir = fs.statSync(fullPath).isDirectory(); } catch { /* ignore */ }
          return { name, path: fullPath, isDir };
        })
        .sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name, 'zh-CN');
        })
        .slice(0, 500);

      return items;
    } catch {
      return [];
    }
  });

  ipcMain.handle('remote:add-recent-cwd', (_e, cwd: string) => {
    try { addRemoteRecentCwd(cwd); } catch { /* ignore */ }
    return true;
  });

  ipcMain.handle('remote:sync-recent-cwds', (_e, cwds: string[]) => {
    try { syncRemoteRecentCwds(cwds); } catch { /* ignore */ }
    return true;
  });

  // ========== 剪贴板图片 IPC ==========

  ipcMain.handle('clipboard:save-image', async () => {
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;

    if (!fs.existsSync(PASTE_IMAGE_DIR)) {
      fs.mkdirSync(PASTE_IMAGE_DIR, { recursive: true });
    }

    const filename = `paste-${Date.now()}.png`;
    const filePath = path.join(PASTE_IMAGE_DIR, filename);
    fs.writeFileSync(filePath, img.toPNG());
    return filePath;
  });

  // ========== 剪贴板文件 IPC ==========
  ipcMain.handle('clipboard:get-file-path', async () => {
    // 尝试读取文件 URL
    const formats = clipboard.availableFormats();
    if (formats.includes('public.file-url')) {
      const buffer = clipboard.readBuffer('public.file-url');
      const url = buffer.toString('utf8');
      // file-url 格式: file://localhost/path/to/file 或 file:///path/to/file
      const match = url.match(/file:\/\/\/?(.+)$/);
      if (match && match[1]) {
        return decodeURIComponent(match[1]);
      }
    }
    return null;
  });

  // ========== 文件监听 IPC ==========

  // 常见源代码文件扩展名白名单
  const SOURCE_FILE_EXTENSIONS = [
    // TypeScript/JavaScript
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    // Vue/Uni-app
    '.vue', '.uvue', '.nvue',
    // JSON/YAML
    '.json', '.yaml', '.yml', '.toml',
    // Python
    '.py', '.pyw',
    // Java/Kotlin
    '.java', '.kt', '.kts',
    // Swift/Objective-C
    '.swift', '.m', '.h',
    // Go
    '.go',
    // Rust
    '.rs',
    // HTML/CSS
    '.html', '.htm', '.css', '.scss', '.sass', '.less',
    // Markdown/文档
    '.md', '.mdx', '.txt',
    // Shell
    '.sh', '.bash', '.zsh', '.fish',
    // SQL
    '.sql',
    // 其他常见源码
    '.xml', '.xaml', '.gradle', '.properties',
  ];

  function isSourceFile(filename: string): boolean {
    const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase();
    return SOURCE_FILE_EXTENSIONS.includes(ext);
  }

  ipcMain.handle('filewatcher:start', (_e, cwd: string) => {
    // 停掉旧的
    if (fileWatcher) {
      fileWatcher.close();
      fileWatcher = null;
    }
    watchingCwd = cwd;
    try {
      fileWatcher = fs.watch(cwd, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        // 忽略 .git 目录和隐藏文件
        if (filename.startsWith('.git/') || filename.startsWith('.git\\')) return;
        if (filename.startsWith('.')) return;
        // 忽略常见非源码目录
        if (filename.includes('node_modules')) return;
        if (filename.includes('dist/') || filename.includes('dist\\')) return;
        if (filename.includes('build/') || filename.includes('build\\')) return;
        if (filename.includes('out/') || filename.includes('out\\')) return;
        if (filename.includes('__pycache__')) return;
        if (filename.includes('.cache/') || filename.includes('.cache\\')) return;
        // 忽略编译产物和临时文件
        if (/\.(map|d\.ts|tsbuildinfo|pyc|o|a|dylib|so|class|tmp|temp|swp|swo|bak|log)$/i.test(filename)) return;
        if (/~$/.test(filename)) return;
        // 只显示源代码文件（白名单过滤）
        if (!isSourceFile(filename)) return;
        mainWindow?.webContents.send('filewatcher:change', filename, eventType);
      });
    } catch { /* 监听失败静默忽略 */ }
  });

  ipcMain.handle('filewatcher:stop', () => {
    if (fileWatcher) {
      fileWatcher.close();
      fileWatcher = null;
      watchingCwd = null;
    }
  });

  ipcMain.handle('filewatcher:open', async (_e, filePath: string) => {
    try {
      if (fs.statSync(filePath).isDirectory()) {
        await shell.openPath(filePath);
        return;
      }
    } catch { /* 不存在的源码路径仍交给编辑器处理 */ }

    if (!isSourceFile(filePath)) {
      await shell.openPath(filePath);
      return;
    }

    const editor = loadEditorPreference();
    if (editor) {
      if (process.platform === 'win32') {
        spawn(editor, [filePath], { detached: true, stdio: 'ignore' });
      } else if (process.platform === 'darwin') {
        spawn('open', ['-a', editor, filePath], { detached: true, stdio: 'ignore' });
      } else {
        spawn(editor, [filePath], { detached: true, stdio: 'ignore' });
      }
    } else {
      await shell.openPath(filePath);
    }
  });

  // ========== 桌面 Pane 文件预览 IPC ==========
  // 只允许读取当前 workspace 内的白名单文件，Renderer 不直接接触 fs。
  ipcMain.handle('file-preview:read', (_e, cwd: string, requestedPath: string) => {
    try {
      const cwdReal = fs.realpathSync(String(cwd || ''));
      const raw = String(requestedPath || '').trim().replace(/^['"`]|['"`]$/g, '');
      if (!raw) return { ok: false, error: '未指定文件' };
      const expanded = raw.startsWith('@/') || raw.startsWith('@')
        ? path.join(cwdReal, raw.replace(/^@\/?/, ''))
        : path.isAbsolute(raw) ? raw : path.resolve(cwdReal, raw);
      const filePath = fs.realpathSync(expanded);
      if (filePath !== cwdReal && !filePath.startsWith(cwdReal + path.sep)) {
        return { ok: false, error: '文件不在工作目录内' };
      }
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return { ok: false, error: '目标不是文件' };
      if (stat.size > DESKTOP_MAX_PREVIEW_BYTES) return { ok: false, error: '文件过大，无法预览' };
      const ext = path.extname(filePath).toLowerCase();
      const buffer = fs.readFileSync(filePath);
      if (DESKTOP_MEDIA_TYPES[ext]) {
        return {
          ok: true,
          kind: 'media',
          mediaType: DESKTOP_MEDIA_TYPES[ext],
          name: path.basename(filePath),
          path: filePath,
          dataUrl: `data:${DESKTOP_MEDIA_TYPES[ext]};base64,${buffer.toString('base64')}`,
          size: stat.size,
        };
      }
      const baseName = path.basename(filePath).toLowerCase();
      if (baseName === '.env' || baseName.startsWith('.env.')) {
        return { ok: false, error: '不支持预览环境变量文件' };
      }
      if (!DESKTOP_PREVIEW_EXTENSIONS.has(ext)) {
        return { ok: false, error: '不支持的文件类型' };
      }
      if (buffer.includes(0)) return { ok: false, error: '该文件不是文本文件' };
      return {
        ok: true,
        kind: 'text',
        name: path.basename(filePath),
        path: filePath,
        content: buffer.toString('utf8'),
        size: stat.size,
      };
    } catch (error: any) {
      return { ok: false, error: error?.message || '文件读取失败' };
    }
  });

  // ========== 桌面 Pane Android IPC ==========
  ipcMain.handle('android:list-devices', async () => {
    try {
      const output = await runAdb(['devices', '-l']);
      return { ok: true, devices: parseAndroidDevices(output.toString('utf8')) };
    } catch (error: any) {
      return { ok: false, error: error?.message || '获取设备失败', devices: [] };
    }
  });

  ipcMain.handle('android:screenshot', async (_e, deviceId?: string) => {
    try {
      const args = deviceId ? ['-s', String(deviceId), 'exec-out', 'screencap', '-p'] : ['exec-out', 'screencap', '-p'];
      const png = await prepareAdbScreenshot(await runAdb(args, { maxBuffer: 8 * 1024 * 1024 }));
      return { ok: true, dataUrl: `data:image/png;base64,${png.toString('base64')}` };
    } catch (error: any) {
      return { ok: false, error: humanizeAndroidImageError(error) || '截图失败' };
    }
  });

  ipcMain.handle('android:tap', async (_e, deviceId: string, x: number, y: number) => {
    try {
      const px = Number(x);
      const py = Number(y);
      if (!deviceId || !Number.isFinite(px) || !Number.isFinite(py)) return { ok: false, error: '无效的点击坐标' };
      await runAdb(['-s', String(deviceId), 'shell', 'input', 'tap', String(Math.round(px)), String(Math.round(py))]);
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: error?.message || '点击失败' };
    }
  });

  ipcMain.handle('android:swipe', async (_e, deviceId: string, x1: number, y1: number, x2: number, y2: number, duration = 300) => {
    try {
      const points = [x1, y1, x2, y2].map(Number);
      if (!deviceId || points.some((point) => !Number.isFinite(point))) return { ok: false, error: '无效的滑动坐标' };
      const ms = Math.max(100, Math.min(3000, Math.round(Number(duration) || 300)));
      await runAdb(['-s', String(deviceId), 'shell', 'input', 'swipe', ...points.map((point) => String(Math.round(point))), String(ms)]);
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: error?.message || '滑动失败' };
    }
  });

  ipcMain.handle('android:input-text', async (_e, deviceId: string, text: string) => {
    try {
      if (!deviceId || !String(text).trim()) return { ok: false, error: '请输入文字' };
      // adb input text uses %s for spaces; keep the value as one execFile arg
      // so shell metacharacters cannot escape into the host process.
      const encoded = String(text).replace(/%/g, '%25').replace(/ /g, '%s');
      await runAdb(['-s', String(deviceId), 'shell', 'input', 'text', encoded]);
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: error?.message || '输入失败' };
    }
  });

  ipcMain.handle('filewatcher:select-editor', async () => {
    if (!mainWindow) return null;
    let defaultPath: string;
    let filters: { name: string; extensions: string[] }[];
    if (process.platform === 'win32') {
      defaultPath = 'C:\\Program Files';
      filters = [{ name: '可执行文件', extensions: ['exe'] }];
    } else if (process.platform === 'darwin') {
      defaultPath = '/Applications';
      filters = [{ name: '应用程序', extensions: ['app'] }];
    } else {
      defaultPath = '/usr/bin';
      filters = [];
    }
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择编辑器',
      defaultPath,
      filters,
      properties: ['openFile'],
      message: '选择用于打开文件的编辑器',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const editorPath = result.filePaths[0];
    saveEditorPreference(editorPath);
    return editorPath;
  });

  ipcMain.handle('filewatcher:get-editor', () => {
    return loadEditorPreference();
  });

  ipcMain.handle('open-with:list', (_e, filePath: string) => listAppsForFile(String(filePath || '')));
  ipcMain.handle('open-with:app', (_e, filePath: string, appPath: string) =>
    openFileWithApp(String(filePath || ''), String(appPath || '')));
  ipcMain.handle('open-with:system-dialog', async (_e, filePath: string) => {
    const target = String(filePath || '');
    if (process.platform === 'linux') {
      if (!mainWindow) return;
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择应用程序',
        defaultPath: '/usr/bin',
        properties: ['openFile'],
      });
      if (result.canceled || !result.filePaths[0]) return;
      await openFileWithApp(target, result.filePaths[0]);
      return;
    }
    await openFileWithSystemDialog(target);
  });

  // 在 Finder 中打开目录
  ipcMain.handle('shell:open-folder', (_e, folderPath: string) => {
    shell.showItemInFolder(folderPath);
  });

  // 读取目录内容
  ipcMain.handle('fs:read-directory', async (_e, dirPath: string) => {
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      return entries.map(entry => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
      }));
    } catch (error) {
      console.error('读取目录失败:', error);
      return [];
    }
  });

  // 用默认应用打开文件
  ipcMain.handle('shell:open-file', (_e, filePath: string) => {
    shell.openPath(filePath);
  });

  // 打开外部链接（系统默认浏览器）
  ipcMain.handle('shell:open-url', (_e, url: string) => openExternalHttpUrl(url));

  // ========== AI 配置 IPC ==========

  // 直接应用手动配置（保存偏好，不再调用已移除的 AI 服务）
  ipcMain.handle('ai:apply-config', (_e, config: { apiFormat: string; baseUrl: string; apiKey: string; model: string }) => {
    try {
      fs.writeFileSync(getPreferencePath(), JSON.stringify({
        providerId: '__manual__',
        model: config.model,
        manualConfig: config,
      }));
      invalidateAiPreferenceCache();
    } catch { /* ignore */ }
    return true;
  });

  // 获取当前保存的配置
  ipcMain.handle('ai:get-current-config', () => {
    const pref = loadAiPreferenceData();
    if (pref.manualConfig) {
      return { ...pref.manualConfig, providerId: pref.providerId };
    }
    return null;
  });

  // ========== 终端容错自动回复配置 ==========
  ipcMain.handle('terminal-auto-response:get-config', () => terminalAutoResponseConfig);
  ipcMain.handle('terminal-auto-response:save-config', (_e, config: unknown) => {
    try {
      return saveTerminalAutoResponseConfig(config);
    } catch (error) {
      console.error('保存终端容错自动回复配置失败:', error);
      return terminalAutoResponseConfig;
    }
  });

  // 测试 AI 配置连通性
  ipcMain.handle('ai:test-config', async (_e, _config: { apiFormat: string; baseUrl: string; apiKey: string; model: string }) => {
    return { ok: false, error: 'AI 功能已移除' };
  });

  // 获取 CLI 实际使用的模型提供商
  ipcMain.handle('cli:get-provider', (_e, presetCommand: string) => {
    return getCliProvider(presetCommand);
  });

  ipcMain.handle('cli:available-builtins', () => {
    return getAvailableBuiltinPresets();
  });

  // ========== Claude 供应商配置 ==========
  const CLAUDE_PROVIDERS_PATH = path.join(app.getPath('userData'), 'claude-providers.json');

  // 自动从 ~/.claude/settings.json 检测 MiniMax 等自定义供应商
  function detectClaudeProvidersFromSettings(): any[] {
    const home = os.homedir();
    const settingsPath = path.join(home, '.claude', 'settings.json');
    const detected: any[] = [];

    try {
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        const env = settings.env || {};
        const baseUrl = env.ANTHROPIC_BASE_URL || '';
        const apiKey = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '';
        const model = env.ANTHROPIC_MODEL || env.ANTHROPIC_DEFAULT_SONNET_MODEL || '';

        // 如果有自定义 baseUrl 且不是默认的 Anthropic，则自动添加为供应商
        if (baseUrl && !baseUrl.includes('api.anthropic.com')) {
          let name = 'Custom';
          let id = 'custom';

          if (baseUrl.includes('minimaxi')) {
            name = 'MiniMax';
            id = 'minimax';
          } else if (baseUrl.includes('deepseek')) {
            name = 'DeepSeek';
            id = 'deepseek';
          } else if (baseUrl.includes('zhipu') || baseUrl.includes('bigmodel')) {
            name = 'GLM (智谱清言)';
            id = 'glm';
          } else if (baseUrl.includes('moonshot')) {
            name = 'Kimi (月之暗面)';
            id = 'kimi';
          } else if (baseUrl.includes('qwen') || baseUrl.includes('dashscope')) {
            name = 'QWEN (通义千问)';
            id = 'qwen';
          } else {
            // 从域名提取名称
            try {
              const url = new URL(baseUrl);
              const host = url.hostname.replace(/^(api|code)\./, '');
              name = host.split('.')[0].charAt(0).toUpperCase() + host.split('.')[0].slice(1);
              id = name.toLowerCase();
            } catch { /* ignore */ }
          }

          detected.push({
            id,
            name,
            baseUrl,
            apiKey,
            model: model || '',
          });
        }
      }
    } catch { /* ignore */ }

    return detected;
  }

  ipcMain.handle('claude-providers:list', () => {
    try {
      if (fs.existsSync(CLAUDE_PROVIDERS_PATH)) {
        const saved = JSON.parse(fs.readFileSync(CLAUDE_PROVIDERS_PATH, 'utf-8'));
        // 合并自动检测到的供应商（已保存的优先）
        const detected = detectClaudeProvidersFromSettings();
        const savedIds = new Set(saved.map((p: any) => p.id));

        // 添加未保存的检测到的供应商
        for (const p of detected) {
          if (!savedIds.has(p.id)) {
            saved.push(p);
          }
        }
        return saved;
      }
    } catch { /* ignore */ }
    // 没有保存的配置时，返回自动检测到的供应商
    return detectClaudeProvidersFromSettings();
  });

  ipcMain.handle('claude-providers:save', (_e, providers: any[]) => {
    fs.writeFileSync(CLAUDE_PROVIDERS_PATH, JSON.stringify(providers, null, 2), 'utf-8');
    return true;
  });

  // 渲染进程主动获取远程服务器信息（解决 IPC 消息早于渲染进程加载的竞态问题）
  ipcMain.handle('remote:get-server-info', () => cachedRemoteServerInfo);
  ipcMain.handle('remote:get-health', async () => remoteSyncMonitor?.getHealth() ?? null);
  ipcMain.handle('remote:retry-sync', async () => {
    const health = await remoteSyncMonitor?.retrySync(true) ?? null;
    if (health) mergeRemoteHealthIntoCache(health);
    return health;
  });
  ipcMain.handle('remote:set-token', (_e, nextToken: unknown) => {
    const result = updateRemoteAccessToken(String(nextToken ?? ''));
    if (!result.ok) return result;
    if (cachedRemoteServerInfo) {
      cachedRemoteServerInfo = { ...cachedRemoteServerInfo, token: result.token };
      safeSend('remote:server-info', cachedRemoteServerInfo);
    }
    return result;
  });
  ipcMain.handle('remote:generate-token', () => generateAccessToken());
  ipcMain.handle('remote:prepare-tunnel-config', () => {
    const result = cloudflaredManager?.prepareUserConfig()
      ?? { ok: false as const, error: '远程隧道未初始化' };
    if (result.ok && cachedRemoteServerInfo && cloudflaredManager) {
      const tunnel = cloudflaredManager.getStatus();
      cachedRemoteServerInfo = {
        ...cachedRemoteServerInfo,
        publicUrl: tunnel.url || undefined,
        tunnel,
      };
      safeSend('remote:server-info', cachedRemoteServerInfo);
    }
    return result;
  });

  // ========== 催工配置 IPC ==========
  // 配置与调度由 main 进程负责，renderer 只负责设置和展示；这样重载页面、隐藏窗口
  // 或渲染进程暂时崩溃时，计划仍然可以继续执行。
  ipcMain.handle('auto-continue:get-all', () => ({
    configs: autoContinueManager?.list() || {},
    persisted: autoContinueManager?.hasPersistedState() || false,
  }));
  ipcMain.on('auto-continue:sync', (_e, configs: unknown) => {
    if (!configs || typeof configs !== 'object') return;
    const safeConfigs = { ...(configs as Record<string, any>) };
    for (const [sessionId, config] of Object.entries(safeConfigs)) {
      if (config?.enabled && terminalTaskScheduler?.isManagedSessionActive(sessionId)) {
        safeConfigs[sessionId] = { ...config, enabled: false };
        safeSend('auto-continue:error', sessionId, '计划任务执行期间不能启用循环发送');
      }
    }
    autoContinueManager?.syncAll(safeConfigs);
  });

  // 兼容旧版 renderer：manager 尚未就绪时仍保留一次性的 IPC 中转。
  const autoContinuePendingGets = new Map<string, (config: any) => void>();
  ipcMain.on('auto-continue:config-reply', (_e, sessionId: string, config: any) => {
    const resolve = autoContinuePendingGets.get(sessionId);
    if (resolve) {
      autoContinuePendingGets.delete(sessionId);
      resolve(config);
    }
  });

  const getAutoContinueFromRenderer = (sessionId: string): Promise<any> => new Promise((resolve) => {
    autoContinuePendingGets.set(sessionId, resolve);
    safeSend('auto-continue:get', sessionId);
    setTimeout(() => {
      if (autoContinuePendingGets.has(sessionId)) {
        autoContinuePendingGets.delete(sessionId);
        resolve(null);
      }
    }, 2000);
  });

  (global as any).__getAutoContinueConfig = (sessionId: string): Promise<any> => {
    if (autoContinueManager) return Promise.resolve(autoContinueManager.get(sessionId));
    return getAutoContinueFromRenderer(sessionId);
  };

  (global as any).__setAutoContinueConfig = (sessionId: string, config: any): void => {
    if (config?.enabled && terminalTaskScheduler?.isManagedSessionActive(sessionId)) {
      safeSend('auto-continue:error', sessionId, '计划任务执行期间不能启用循环发送');
      return;
    }
    if (autoContinueManager) {
      const normalized = autoContinueManager.set(sessionId, config);
      safeSend('auto-continue:set', sessionId, normalized);
      return;
    }
    safeSend('auto-continue:set', sessionId, config);
  };

  // 供 remote-server 调用：读取会话状态（running/idle/inactive）
  // renderer 通过 IPC 同步状态到这里
  (global as any).__sessionStatuses = {} as Record<string, string>;
  ipcMain.on('session:sync-status', (_e, statuses: Record<string, string>) => {
    const current = { ...((global as any).__sessionStatuses || {}) } as Record<string, string>;
    for (const [id, status] of Object.entries(statuses || {})) {
      if (!(id in current)) current[id] = status;
      else if (status === 'inactive' && current[id] === 'idle') current[id] = 'inactive';
    }
    for (const id of Object.keys(current)) {
      if (!(id in (statuses || {})) && !ptyManager.getSession(id)) delete current[id];
    }
    (global as any).__sessionStatuses = current;
  });
  (global as any).__notifySessionRemoteView = (id: string, info: { viewed?: boolean; viewing?: boolean }) => {
    if (info?.viewing === true) sessionRemoteViewing.add(id);
    else if (info?.viewing === false) sessionRemoteViewing.delete(id);
    if (info?.viewed) {
      const statuses = { ...((global as any).__sessionStatuses || {}) } as Record<string, string>;
      if (statuses[id] === 'idle') {
        statuses[id] = 'inactive';
        (global as any).__sessionStatuses = statuses;
      }
    }
    safeSend('session:remote-view', id, info);
  };

}

app.whenReady().then(async () => {
  closedSessionsManager = new ClosedSessionsManager(app.getPath('userData'));
  closedSessionsManager.onUpdate((sessions) => safeSend('closed-sessions:update', sessions));
  closedSessionsManager.resetStaleRestores();
  closedSessionsManager.backfillUpdatedAtFromLocalSessions();

  setupPtyManager();
  setupTerminalTasks();
  autoContinueManager = new AutoContinueManager(
    ptyManager,
    path.join(app.getPath('userData'), 'auto-continue.json'),
  );

  // macOS Dock 图标 — 在窗口创建前设置
  const appIcon = loadAppIcon();
  if (appIcon) {
    if (process.platform === 'darwin' && app.dock) {
      app.dock.setIcon(appIcon);
    }
  }

  registerIPC();
  cloudflaredManager = new CloudflaredManager(path.join(__dirname, '../..'));
  // 用户主动打开应用：清掉 Cmd+Q 留下的暂停标记，并恢复 KeepAlive（若已安装）。
  resumeKeepAliveDaemon();
  createWindow(appIcon);

  remoteSyncMonitor = new RemoteSyncMonitor(
    cloudflaredManager,
    () => cachedRemoteServerInfo?.port ?? 9800,
    () => restartRemoteAccessServer(),
    (health) => mergeRemoteHealthIntoCache(health),
  );

  // 启动远程访问服务器（手机端）
  restartRemoteAccessServer();
  remoteSyncMonitor.start();

  // CLI 探测是同步的，趁启动空闲先把缓存填上，别留给第一个请求去扛
  prewarmCliDetection();

  // AI 配置已保存在偏好文件中，无需额外恢复

});

app.on('window-all-closed', () => {
  // 关窗口不退出进程：远程服务（9800）和 Cloudflare 源站依赖本进程常驻。
  // 真正退出请用 Cmd+Q / 菜单退出（走 before-quit 清理）。
});

app.on('activate', () => {
  if (isQuitting || Date.now() < ignoreActivateUntil) return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

function cleanupForQuit(): void {
  // 必须先于进程退出：否则 LaunchAgent KeepAlive 会马上再 exec Electron。
  pauseKeepAliveDaemon();
  globalShortcut.unregisterAll();
  autoContinueManager?.stop();
  autoContinueManager = null;
  for (const timer of pendingNotifyTimers.values()) clearTimeout(timer);
  pendingNotifyTimers.clear();
  terminalTaskScheduler?.stop();
  terminalTaskScheduler = null;
  terminalActivityTracker?.stop();
  terminalActivityTracker = null;
  remoteSyncMonitor?.stop();
  remoteSyncMonitor = null;
  remoteServer?.close();
  remoteServer = null;
  cloudflaredManager?.stopOwnedProcess();
}

app.on('before-quit', (event) => {
  if (quitConfirmed) {
    isQuitting = true;
    cleanupForQuit();
    return;
  }

  const sessions = ptyManager.getAllSessions();
  const queuedTasks = (terminalTaskScheduler?.snapshot().tasks || [])
    .filter(task => ['pending', 'paused', 'starting', 'running'].includes(task.status)).length;
  if (sessions.length === 0 && queuedTasks === 0) {
    quitConfirmed = true;
    isQuitting = true;
    cleanupForQuit();
    return;
  }

  event.preventDefault();
  if (quitDialogOpen) return;
  quitDialogOpen = true;

  const boxOptions: Electron.MessageBoxOptions = {
    type: 'warning',
    title: '退出 DuoCLI',
    message: `当前有 ${sessions.length} 个终端、${queuedTasks} 个待执行或执行中的计划任务`,
    detail: '退出后终端进程会被终止，计划任务会暂停，重新打开时再恢复等待。确定要退出吗？',
    buttons: ['取消', '退出'],
    defaultId: 0,
    cancelId: 0,
  };
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const prompt = parent
    ? dialog.showMessageBox(parent, boxOptions)
    : dialog.showMessageBox(boxOptions);

  prompt.then(({ response }) => {
    quitDialogOpen = false;
    if (response !== 1) return;
    quitConfirmed = true;
    isQuitting = true;
    app.quit();
  }).catch(() => {
    quitDialogOpen = false;
  });
});
