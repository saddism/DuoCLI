import { app, BrowserWindow, ipcMain, dialog, clipboard, nativeImage, shell, globalShortcut } from 'electron';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { PtyManager, getDisplayName } from './pty-manager';
import { AIConfigManager } from './ai-config';
import { startRemoteServer, pushRawDataToRemote, sendRemotePush, addRemoteRecentCwd } from './remote-server';
import { CloudflaredManager } from './cloudflared-manager';
import { RemoteSyncHealth, RemoteSyncMonitor } from './remote-sync-monitor';
import {
  DEFAULT_TERMINAL_AUTO_RESPONSE_CONFIG,
  normalizeTerminalAutoResponseConfig,
  TerminalAutoResponseConfig,
} from './terminal-auto-response';
import { getAvailableBuiltinPresets } from './cli-detect';
import { buildResumeCommand, evaluateRestoreProgress, identifyCli, isResumeCommandCompatible, ResumeCapture } from './session-resume';
import { parseAndroidDevices, runAdb } from './android-devices';

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

const NOTIFY_COOLDOWN_MS = 15_000;
const WAITING_INPUT_DELAY_MS = 8_000;
const IMESSAGE_TARGET = (process.env.DUOCLI_IMESSAGE_TO || '').trim();
const IMESSAGE_SERVICE = ((process.env.DUOCLI_IMESSAGE_SERVICE || 'iMessage').trim().toLowerCase() === 'sms')
  ? 'SMS'
  : 'iMessage';

const sessionOutputTail: Map<string, string> = new Map();

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
interface ClosedSession {
  id: string;
  title: string;
  cwd: string;
  presetCommand: string;
  resumeId: string;
  resumeCommand: string;
  displayName: string;
  closedAt: number;
  cli?: string;
  resumeSource?: ResumeCapture['source'];
  state?: 'closed' | 'restoring';
  restoreStartedAt?: number;
}
const CLOSED_SESSIONS_FILE = path.join(app.getPath('userData'), 'closed-sessions.json');
const MAX_CLOSED_SESSIONS = 20;

function loadClosedSessions(options?: { resetRestoring?: boolean }): ClosedSession[] {
  try {
    const raw = fs.readFileSync(CLOSED_SESSIONS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Migrate records written by older DuoCLI versions whose resume command
    // was blank (or relied on the invalid generic “preset --resume” fallback).
    return parsed.map((value: any) => {
      const session = value as ClosedSession;
      if (session.resumeId && (!isResumeCommandCompatible(session.presetCommand || '', session.resumeCommand || '') || (session.resumeCommand || '').includes('undefined') || /[\r\n]/.test(session.resumeCommand || ''))) {
        const command = buildResumeCommand(session.presetCommand || '', session.resumeId);
        // Unknown CLIs are intentionally left non-restorable rather than
        // carrying forward the old generic “preset --resume” guess.
        session.resumeCommand = command;
      }
      session.cli = session.cli || identifyCli(session.presetCommand || '');
      if (options?.resetRestoring) {
        // Only on app startup: clear stale restoring flags from a crashed run.
        session.state = 'closed';
        delete session.restoreStartedAt;
      } else {
        session.state = session.state || 'closed';
      }
      return session;
    }).filter((session: ClosedSession) => !!session.resumeId);
  } catch { return []; }
}

function resetStaleClosedSessionRestores(): void {
  const list = loadClosedSessions({ resetRestoring: true });
  saveClosedSessions(list);
}

function saveClosedSessions(sessions: ClosedSession[]): ClosedSession[] {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const filtered = sessions.filter(s => s.closedAt > cutoff).slice(-MAX_CLOSED_SESSIONS);
  const serialized = JSON.stringify(filtered, null, 2);
  try {
    fs.mkdirSync(path.dirname(CLOSED_SESSIONS_FILE), { recursive: true });
    const temp = `${CLOSED_SESSIONS_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(temp, serialized);
    fs.renameSync(temp, CLOSED_SESSIONS_FILE);
  } catch {
    // Keep the old direct-write fallback for unusual read-only/userData setups.
    try { fs.writeFileSync(CLOSED_SESSIONS_FILE, serialized); } catch { /* ignore */ }
  }
  return filtered;
}

function addClosedSession(session: { title: string; cwd: string; presetCommand: string; resumeId: string; resumeCommand: string; resumeSource?: ResumeCapture['source'] }): void {
  const list = loadClosedSessions();
  const cli = identifyCli(session.presetCommand);
  const duplicateIndex = list.findIndex(item => item.resumeId === session.resumeId && (item.cli || identifyCli(item.presetCommand)) === cli);
  const entry: ClosedSession = {
    id: duplicateIndex >= 0 ? list[duplicateIndex].id : `closed-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    title: session.title,
    cwd: session.cwd,
    presetCommand: session.presetCommand,
    resumeId: session.resumeId,
    resumeCommand: session.resumeCommand || buildResumeCommand(session.presetCommand, session.resumeId),
    displayName: getDisplayName(session.presetCommand),
    closedAt: Date.now(),
    cli,
    resumeSource: session.resumeSource,
    state: 'closed',
  };
  if (duplicateIndex >= 0) list[duplicateIndex] = entry;
  else list.push(entry);
  const saved = saveClosedSessions(list);
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

// ========== CLI 模型提供商检测 ==========

// 根据 preset 命令获取实际使用的模型提供商
function getCliProvider(presetCommand: string): string | null {
  const home = os.homedir();

  // 判断是哪个 CLI
  if (presetCommand.startsWith('claude')) {
    // 读取 Claude 配置
    const settingsPath = path.join(home, '.claude', 'settings.json');
    try {
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        const env = settings.env || {};
        const baseUrl = env.ANTHROPIC_BASE_URL || '';

        // 根据 baseUrl 判断模型提供商
        if (baseUrl.includes('minimaxi')) return 'MiniMax';
        if (baseUrl.includes('deepseek')) return 'DeepSeek';
        if (baseUrl.includes('zhipu') || baseUrl.includes('bigmodel')) return 'GLM';
        if (baseUrl.includes('cloudflare')) return 'Cloudflare';
        if (baseUrl.includes('anthropic') || !baseUrl) return 'Anthropic';

        // 如果有自定义 baseUrl，尝试提取域名
        if (baseUrl) {
          try {
            const url = new URL(baseUrl);
            return url.hostname.replace(/^api\./, '').split('.')[0].toUpperCase();
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }

    // 尝试从 shell 环境变量读取
    try {
      const rcFiles = [path.join(home, '.zshrc'), path.join(home, '.bashrc')];
      for (const rcFile of rcFiles) {
        if (!fs.existsSync(rcFile)) continue;
        const content = fs.readFileSync(rcFile, 'utf-8');
        const vars = parseShellExports(content);
        const baseUrl = vars.get('ANTHROPIC_BASE_URL') || '';
        if (baseUrl.includes('minimaxi')) return 'MiniMax';
        if (baseUrl.includes('deepseek')) return 'DeepSeek';
        if (baseUrl.includes('zhipu') || baseUrl.includes('bigmodel')) return 'GLM';
      }
    } catch { /* ignore */ }

    return 'Anthropic';
  }

  if (presetCommand.startsWith('codex')) {
    // Codex 使用 OpenAI 兼容 API
    return 'OpenAI';
  }

  if (presetCommand.startsWith('kimi')) {
    // Kimi 使用月之暗面 API
    return 'Moonshot';
  }

  if (presetCommand.startsWith('gemini')) {
    return 'Google';
  }

  if (presetCommand.startsWith('opencode')) {
    // OpenCode 可能使用多种后端
    const cfgPath = path.join(home, '.config', 'opencode', 'opencode.json');
    try {
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        const provider = cfg.provider || {};
        if (provider.anthropic) return 'Anthropic';
        if (provider.openai) return 'OpenAI';
        if (provider.google) return 'Google';
      }
    } catch { /* ignore */ }
    return 'OpenCode';
  }

  if (presetCommand.startsWith('qoder')) {
    return 'Qoder';
  }

  if (presetCommand.startsWith('devin')) {
    return 'Devin';
  }

  if (presetCommand.startsWith('kiro-cli')) {
    return 'Kiro';
  }

  if (presetCommand.startsWith('agent') || presetCommand.includes('cursor')) {
    // Cursor agent
    return 'Cursor';
  }

  if (presetCommand.startsWith('agy')) {
    return 'Antigravity';
  }

  // 默认返回空
  return null;
}

// 解析 shell 导出语句
function parseShellExports(content: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^export\s+([A-Z_][A-Z0-9_]*)=["']?([^"'\n]+?)["']?\s*$/);
    if (match) {
      vars.set(match[1], match[2]);
    }
  }
  return vars;
}

let mainWindow: BrowserWindow | null = null;
let ptyManager: PtyManager;
const aiConfigManager = new AIConfigManager();
let cloudflaredManager: CloudflaredManager | null = null;
let cachedRemoteServerInfo: any = null;
let remoteServer: ReturnType<typeof startRemoteServer> | null = null;
let remoteSyncMonitor: RemoteSyncMonitor | null = null;
let remoteServerRestarting = false;

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
  );
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
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

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

  // 关闭窗口时，如果有活跃终端则弹确认
  mainWindow.on('close', (e) => {
    const sessions = ptyManager.getAllSessions();
    if (sessions.length === 0 || !mainWindow) return;
    e.preventDefault();
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '关闭 DuoCLI',
      message: `当前有 ${sessions.length} 个终端正在运行`,
      detail: '关闭应用后所有终端进程都会被终止，确定要关闭吗？',
      buttons: ['取消', '关闭'],
      defaultId: 0,
      cancelId: 0,
    }).then(({ response }) => {
      if (response === 1) {
        mainWindow?.removeAllListeners('close');
        mainWindow?.close();
      }
    });
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

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '');
}

function appleScriptQuote(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`;
}

function sendIMessageNotification(message: string): void {
  if (process.platform !== 'darwin' || !IMESSAGE_TARGET) return;
  const scriptLines = [
    'tell application "Messages"',
    `set targetService to 1st service whose service type = ${IMESSAGE_SERVICE}`,
    `set targetBuddy to buddy ${appleScriptQuote(IMESSAGE_TARGET)} of targetService`,
    `send ${appleScriptQuote(message)} to targetBuddy`,
    'end tell',
  ];
  const args = scriptLines.flatMap((line) => ['-e', line]);
  const p = spawn('osascript', args, { stdio: 'ignore', detached: true });
  p.on('error', () => { /* ignore */ });
  p.unref();
}

function sendUserNotification(id: string, title: string, body: string): void {
  sendRemotePush(title, body, id);
  sendIMessageNotification(`[DuoCLI] ${title}：${body}`);
}

function maybeNotifyAttention(id: string, data: string): void {
  const now = Date.now();
  const lastNotify = sessionLastNotifyAt.get(id) || 0;
  if (now - lastNotify < NOTIFY_COOLDOWN_MS) return;

  const plain = stripAnsi(data);
  if (!plain) return;

  const tail = ((sessionOutputTail.get(id) || '') + plain).slice(-1200);
  sessionOutputTail.set(id, tail);

  const promptLike = /(?:^|\n)\s*(?:[$#>❯›▷➜]|(?:\[[^\]]+\]))\s*$/.test(tail);
  const cliWorking = /\w+…\s*\(/.test(tail);
  const hasPrompt = promptLike && !cliWorking;
  const needDecision = /(是否|请选择|请确认|需要你|输入\s*(?:y|n|yes|no)|\[(?:y\/n|yes\/no)\]|continue\?|press enter|按回车|确认继续)/i.test(tail);
  const taskDone = /(任务已完成|已完成|完成了|done\b|completed\b|finished\b|all set\b|success(?:fully)?\b)/i.test(tail);
  const lastInputAt = sessionLastInputAt.get(id) || 0;
  const waitedLongEnough = now - lastInputAt >= WAITING_INPUT_DELAY_MS;

  const session = ptyManager.getSession(id);
  const title = session?.title || session?.presetCommand || '终端';

  if (hasPrompt && needDecision) {
    sendUserNotification(id, '需要你决策', title);
    sessionLastNotifyAt.set(id, now);
    sessionArmedForNotify.delete(id);
    return;
  }

  if (!sessionArmedForNotify.has(id) || !hasPrompt || !waitedLongEnough) return;

  if (taskDone) {
    sendUserNotification(id, '任务已完成', title);
  } else {
    sendUserNotification(id, '会话等待输入', title);
  }
  sessionLastNotifyAt.set(id, now);
  sessionArmedForNotify.delete(id);
}

function setupPtyManager(): void {
  ptyManager = new PtyManager({
    onData: (id, data) => {
      safeSend('pty:data', id, data);
      maybeNotifyAttention(id, data);
    },
    onRawData: (id, data, sequence) => {
      pushRawDataToRemote(id, data, sequence);
    },
    onTitleUpdate: (id, title) => {
      safeSend('pty:title-update', id, title);
    },
    onExit: (id) => {
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
        });
      }

      // 用户主动关闭的会话不发通知
      if (!sessionUserClosed.has(id)) {
        const title = session?.title || '终端';
        sendUserNotification(id, '会话已结束', title);
      }
      sessionUserClosed.delete(id);
      sessionOutputTail.delete(id);
      sessionLastInputAt.delete(id);
      sessionArmedForNotify.delete(id);
      sessionLastNotifyAt.delete(id);

      safeSend('pty:exit', id);
    },
    onPasteInput: (id, cwd) => {
      sessionLastInputAt.set(id, Date.now());
      sessionArmedForNotify.add(id);
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
    const session = ptyManager.create(cwd, presetCommand, themeId, providerEnv);
    // 如果有 providerEnv，根据 baseUrl 推断 provider 名称
    let provider: string | null = null;
    if (providerEnv && providerEnv.ANTHROPIC_BASE_URL) {
      const baseUrl = providerEnv.ANTHROPIC_BASE_URL;
      if (baseUrl.includes('minimaxi')) provider = 'MiniMax';
      else if (baseUrl.includes('deepseek')) provider = 'DeepSeek';
      else if (baseUrl.includes('zhipu') || baseUrl.includes('bigmodel')) provider = 'GLM';
      else if (baseUrl.includes('anthropic') && !baseUrl.includes('minimaxi')) provider = 'Anthropic';
      else {
        // 尝试从域名提取
        try {
          const url = new URL(baseUrl);
          provider = url.hostname.replace(/^(api|code)\./, '').split('.')[0];
          // 首字母大写
          provider = provider.charAt(0).toUpperCase() + provider.slice(1);
        } catch { provider = 'Custom'; }
      }
    } else {
      provider = getCliProvider(presetCommand);
    }
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

  // 销毁终端
  ipcMain.handle('pty:destroy', async (_e, id: string) => {
    // Resolve provider metadata before kill. This is intentionally awaited so
    // Devin/OpenCode/Kimi/Kiro registries cannot race the PTY teardown.
    sessionUserClosed.add(id);
    const beforeClose = ptyManager.getSession(id);
    const capture = await ptyManager.close(id);
    if (beforeClose?.resumeId) {
      addClosedSession({
        title: beforeClose.title,
        cwd: beforeClose.cwd,
        presetCommand: beforeClose.presetCommand,
        resumeId: beforeClose.resumeId,
        resumeCommand: beforeClose.resumeCommand || '',
        resumeSource: beforeClose.resumeSource || undefined,
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
      });
    }
    sessionOutputTail.delete(id);
    sessionLastInputAt.delete(id);
    sessionArmedForNotify.delete(id);
    sessionLastNotifyAt.delete(id);
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
  ipcMain.handle('closed-sessions:list', () => loadClosedSessions());
  ipcMain.handle('closed-sessions:begin-restore', (_e, closedId: string) => {
    const restoreList = loadClosedSessions();
    const closed = restoreList.find(item => item.id === closedId);
    // Claim before creating a PTY so duplicate clicks cannot launch another
    // provider process for the same closed record.
    if (!closed || closed.state === 'restoring') return false;
    closed.state = 'restoring';
    closed.restoreStartedAt = Date.now();
    const saved = saveClosedSessions(restoreList);
    safeSend('closed-sessions:update', saved);
    return saved.some(item => item.id === closedId && item.state === 'restoring');
  });
  ipcMain.handle('closed-sessions:cancel-restore', (_e, closedId: string) => {
    const restoreList = loadClosedSessions();
    const closed = restoreList.find(item => item.id === closedId);
    if (!closed || closed.state !== 'restoring') return false;
    closed.state = 'closed';
    delete closed.restoreStartedAt;
    const saved = saveClosedSessions(restoreList);
    safeSend('closed-sessions:update', saved);
    return true;
  });
  ipcMain.handle('closed-sessions:remove', (_e, id: string) => {
    const sessions = loadClosedSessions().filter(s => s.id !== id);
    saveClosedSessions(sessions);
    return sessions;
  });
  ipcMain.handle('closed-sessions:clear', () => {
    saveClosedSessions([]);
    return [];
  });
  ipcMain.handle('closed-sessions:confirm-restore', async (_e, closedId: string, sessionId: string) => {
    const restoreList = loadClosedSessions();
    const closed = restoreList.find(item => item.id === closedId);
    if (!closed || closed.state !== 'restoring') return false;
    const markRestoreFailed = (): void => {
      const current = loadClosedSessions();
      const remaining = current.map(item => item.id === closedId ? { ...item, state: 'closed' as const, restoreStartedAt: undefined } : item);
      saveClosedSessions(remaining);
      safeSend('closed-sessions:update', remaining);
    };
    const failRestore = (): false => {
      // Keep the PTY alive so the user can read provider errors in the pane.
      markRestoreFailed();
      return false;
    };
    // Watch for an explicit provider error after the command echo. Do not treat
    // “any output after 300ms” as success, and do not kill a slow CLI on timeout.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const session = ptyManager.getSession(sessionId);
      if (!session) {
        markRestoreFailed();
        return false;
      }
      if (session.resumeId && closed.resumeId && session.resumeId !== closed.resumeId) {
        return failRestore();
      }
      const verdict = evaluateRestoreProgress(ptyManager.getLaunchStatus(sessionId), Date.now());
      if (verdict === 'failure') return failRestore();
      if (verdict === 'success') return true;
      await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
    }
    // A live PTY is not proof that the provider accepted the resume command.
    // Keep the closed record available for another attempt and leave the pane
    // open so the user can inspect a slow or failed provider launch.
    return failRestore();
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
      const png = await runAdb(args, { maxBuffer: 8 * 1024 * 1024 });
      return { ok: true, dataUrl: `data:image/png;base64,${png.toString('base64')}` };
    } catch (error: any) {
      return { ok: false, error: error?.message || '截图失败' };
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

  // 打开外部链接
  ipcMain.handle('shell:open-url', (_e, url: string) => {
    shell.openExternal(url);
  });

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

  // ========== 催工配置中转 IPC ==========
  // main 进程作为中转：remote-server API → renderer 的 sessionAutoContinue

  // 存放 pending 的 get 请求回调
  const autoContinuePendingGets = new Map<string, (config: any) => void>();

  // renderer 回复配置
  ipcMain.on('auto-continue:config-reply', (_e, sessionId: string, config: any) => {
    const resolve = autoContinuePendingGets.get(sessionId);
    if (resolve) {
      autoContinuePendingGets.delete(sessionId);
      resolve(config);
    }
  });

  // 供 remote-server 调用：读取催工配置
  (global as any).__getAutoContinueConfig = (sessionId: string): Promise<any> => {
    return new Promise((resolve) => {
      autoContinuePendingGets.set(sessionId, resolve);
      safeSend('auto-continue:get', sessionId);
      // 超时兜底
      setTimeout(() => {
        if (autoContinuePendingGets.has(sessionId)) {
          autoContinuePendingGets.delete(sessionId);
          resolve(null);
        }
      }, 2000);
    });
  };

  // 供 remote-server 调用：写入催工配置
  (global as any).__setAutoContinueConfig = (sessionId: string, config: any): void => {
    safeSend('auto-continue:set', sessionId, config);
  };

  // 供 remote-server 调用：读取会话状态（busy/unread/idle）
  // renderer 通过 IPC 同步状态到这里
  (global as any).__sessionStatuses = {} as Record<string, string>;
  ipcMain.on('session:sync-status', (_e, statuses: Record<string, string>) => {
    (global as any).__sessionStatuses = statuses;
  });

}

app.whenReady().then(async () => {
  setupPtyManager();
  resetStaleClosedSessionRestores();

  // macOS Dock 图标 — 在窗口创建前设置
  const appIcon = loadAppIcon();
  if (appIcon) {
    if (process.platform === 'darwin' && app.dock) {
      app.dock.setIcon(appIcon);
    }
  }

  registerIPC();
  cloudflaredManager = new CloudflaredManager(path.join(__dirname, '../..'));
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

  // AI 配置已保存在偏好文件中，无需额外恢复

});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', async () => {
  globalShortcut.unregisterAll();
  remoteSyncMonitor?.stop();
  remoteSyncMonitor = null;
  remoteServer?.close();
  remoteServer = null;
  cloudflaredManager?.stopOwnedProcess();
});
