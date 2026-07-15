import { app, BrowserWindow, ipcMain, dialog, clipboard, nativeImage, shell, globalShortcut } from 'electron';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { PtyManager, getDisplayName, rotateDevinInstallationId } from './pty-manager';
import { AIConfigManager } from './ai-config';
import { startRemoteServer, pushRawDataToRemote, sendRemotePush, addRemoteRecentCwd } from './remote-server';
import { CloudflaredManager } from './cloudflared-manager';
import { ChatSessionManager } from './chat-session-manager';
import { WindsurfProxyManager } from './windsurf-proxy-manager';

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
}
const CLOSED_SESSIONS_FILE = path.join(app.getPath('userData'), 'closed-sessions.json');
const MAX_CLOSED_SESSIONS = 20;

function loadClosedSessions(): ClosedSession[] {
  try {
    const raw = fs.readFileSync(CLOSED_SESSIONS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch { return []; }
}

function saveClosedSessions(sessions: ClosedSession[]): ClosedSession[] {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const filtered = sessions.filter(s => s.closedAt > cutoff).slice(-MAX_CLOSED_SESSIONS);
  fs.writeFileSync(CLOSED_SESSIONS_FILE, JSON.stringify(filtered, null, 2));
  return filtered;
}

function addClosedSession(session: { title: string; cwd: string; presetCommand: string; resumeId: string; resumeCommand: string }): void {
  const list = loadClosedSessions();
  list.push({
    id: `closed-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    title: session.title,
    cwd: session.cwd,
    presetCommand: session.presetCommand,
    resumeId: session.resumeId,
    resumeCommand: session.resumeCommand,
    displayName: getDisplayName(session.presetCommand),
    closedAt: Date.now(),
  });
  const saved = saveClosedSessions(list);
  safeSend('closed-sessions:update', saved);
}

// ========== 已关闭 Chat 会话持久化 ==========
interface ClosedChatSession {
  id: string;
  title: string;
  model: string;
  workspace: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string; timestamp: number }>;
  closedAt: number;
}
const CLOSED_CHAT_SESSIONS_FILE = path.join(app.getPath('userData'), 'closed-chat-sessions.json');
const MAX_CLOSED_CHAT_SESSIONS = 20;

function loadClosedChatSessions(): ClosedChatSession[] {
  try {
    const raw = fs.readFileSync(CLOSED_CHAT_SESSIONS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch { return []; }
}

function saveClosedChatSessions(sessions: ClosedChatSession[]): ClosedChatSession[] {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const filtered = sessions.filter(s => s.closedAt > cutoff).slice(-MAX_CLOSED_CHAT_SESSIONS);
  fs.writeFileSync(CLOSED_CHAT_SESSIONS_FILE, JSON.stringify(filtered, null, 2));
  return filtered;
}

function addClosedChatSession(session: { title: string; model: string; workspace: string; messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string; timestamp: number }> }): void {
  const list = loadClosedChatSessions();
  list.push({
    id: `closed-chat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    title: session.title,
    model: session.model,
    workspace: session.workspace,
    messages: session.messages,
    closedAt: Date.now(),
  });
  const saved = saveClosedChatSessions(list);
  safeSend('closed-chat-sessions:update', saved);
}

function getPreferencePath(): string {
  return path.join(app.getPath('userData'), 'ai-preference.json');
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
let chatSessionManager: ChatSessionManager | null = null;
let windsurfProxyManager: WindsurfProxyManager | null = null;
let cachedRemoteServerInfo: any = null;

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
    if ((input.meta || input.control) && input.key.toLowerCase() === 'w') {
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
    onRawData: (id, data) => {
      pushRawDataToRemote(id, data);
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
    onAutoSwitchStatus: (id, status, detail) => {
      safeSend('pty:auto-switch-status', id, status, detail);
    },
  }, () => loadAiPreferenceData().manualConfig || null);
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
  ipcMain.on('pty:destroy', (_e, id: string) => {
    // 兜底：从 buffer 提取 resume ID，保存到已关闭列表
    ptyManager.captureResumeFromBuffer(id);
    const session = ptyManager.getSession(id);
    if (session?.resumeId) {
      addClosedSession({
        title: session.title,
        cwd: session.cwd,
        presetCommand: session.presetCommand,
        resumeId: session.resumeId,
        resumeCommand: session.resumeCommand || '',
      });
    }

    sessionUserClosed.add(id);
    ptyManager.destroy(id);
    sessionOutputTail.delete(id);
    sessionLastInputAt.delete(id);
    sessionArmedForNotify.delete(id);
    sessionLastNotifyAt.delete(id);
    sessionUserClosed.delete(id);
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
    }));
  });

  // ========== 已关闭会话 IPC ==========
  ipcMain.handle('closed-sessions:list', () => loadClosedSessions());
  ipcMain.handle('closed-sessions:remove', (_e, id: string) => {
    const sessions = loadClosedSessions().filter(s => s.id !== id);
    saveClosedSessions(sessions);
    return sessions;
  });
  ipcMain.handle('closed-sessions:clear', () => {
    saveClosedSessions([]);
    return [];
  });

  // ========== 已关闭 Chat 会话 IPC ==========
  ipcMain.handle('closed-chat:list', () => loadClosedChatSessions());
  ipcMain.handle('closed-chat:remove', (_e, id: string) => {
    const sessions = loadClosedChatSessions().filter(s => s.id !== id);
    const saved = saveClosedChatSessions(sessions);
    return saved;
  });
  ipcMain.handle('closed-chat:clear', () => {
    saveClosedChatSessions([]);
    return [];
  });
  ipcMain.handle('chat:restore', (_e, closedId: string) => {
    if (!chatSessionManager) return null;
    const list = loadClosedChatSessions();
    const closed = list.find(s => s.id === closedId);
    if (!closed) return null;
    const session = chatSessionManager.restore(closed.workspace, closed.model, closed.messages, closed.title);
    // 从已关闭列表中移除
    const remaining = list.filter(s => s.id !== closedId);
    saveClosedChatSessions(remaining);
    return { id: session.id, title: session.title, model: session.model, workspace: session.workspace, createdAt: session.createdAt };
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

  // 测试 AI 配置连通性
  ipcMain.handle('ai:test-config', async (_e, _config: { apiFormat: string; baseUrl: string; apiKey: string; model: string }) => {
    return { ok: false, error: 'AI 功能已移除' };
  });

  // 获取 CLI 实际使用的模型提供商
  ipcMain.handle('cli:get-provider', (_e, presetCommand: string) => {
    return getCliProvider(presetCommand);
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

  // ========== Devin 账号管理 ==========
  const DEVIN_ACCOUNTS_PATH = path.join(os.homedir(), '.session-sync-manager', 'accounts.json');
  const authCliPath = (() => {
    try {
      const syncPath = path.join(os.homedir(), '.local', 'bin', 'session-sync');
      const resolved = fs.realpathSync(syncPath);
      return path.join(path.dirname(resolved), 'auth-cli.mjs');
    } catch { return null; }
  })();

  function runAuthCli(args: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      if (!authCliPath) { resolve({ code: 1, stdout: '', stderr: 'auth-cli.mjs 未找到' }); return; }
      const child = spawn('node', [authCliPath, ...args], { stdio: 'pipe' });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
      child.on('error', (err) => resolve({ code: 1, stdout: '', stderr: err.message }));
      if (stdin !== undefined) {
        child.stdin.write(stdin);
        child.stdin.end();
      }
    });
  }

  ipcMain.handle('devin-accounts:list', () => {
    try {
      if (fs.existsSync(DEVIN_ACCOUNTS_PATH)) {
        return JSON.parse(fs.readFileSync(DEVIN_ACCOUNTS_PATH, 'utf-8'));
      }
    } catch { /* ignore */ }
    return { accounts: [], currentIndex: 0 };
  });

  ipcMain.handle('devin-accounts:add', async (_e, email: string, password: string) => {
    const { code, stderr } = await runAuthCli(['add', email, password]);
    return { ok: code === 0, error: code !== 0 ? stderr.trim() : undefined };
  });

  ipcMain.handle('devin-accounts:add-batch', async (_e, text: string) => {
    const { code, stderr } = await runAuthCli(['add', '--batch'], text);
    // auth-cli.mjs 的 add --batch 把统计信息输出到 stderr
    return { ok: code === 0, output: stderr.trim(), error: code !== 0 ? stderr.trim() : undefined };
  });

  ipcMain.handle('devin-accounts:remove', async (_e, email: string) => {
    const { code, stderr } = await runAuthCli(['remove', email]);
    return { ok: code === 0, error: code !== 0 ? stderr.trim() : undefined };
  });

  ipcMain.handle('devin-accounts:switch', async (_e, opts: { email?: string; next?: boolean }) => {
    // next 为 true 或不传 email 时，auth-cli.mjs 默认执行轮转切到下一个账号
    const args = opts.email ? ['switch', '--force', opts.email] : ['switch'];
    const { code, stdout, stderr } = await runAuthCli([...args, '--json']);
    // auth-cli.mjs 内部也会旋转 installation_id，这里作为兜底再旋转一次
    rotateDevinInstallationId();
    if (code !== 0) return { ok: false, error: stderr.trim() };
    // 重新读取更新后的账号状态
    try {
      const updated = JSON.parse(fs.readFileSync(DEVIN_ACCOUNTS_PATH, 'utf-8'));
      const cur = updated.accounts[updated.currentIndex];
      return { ok: true, email: cur?.email, quota: cur?.quota };
    } catch {
      return { ok: true };
    }
  });

  ipcMain.handle('devin-accounts:quota', async () => {
    const { code, stdout, stderr } = await runAuthCli(['quota', '--json']);
    if (code !== 0) return { ok: false, error: stderr.trim() };
    try {
      return { ok: true, ...JSON.parse(stdout.trim()) };
    } catch {
      return { ok: false, error: '解析失败' };
    }
  });

  ipcMain.handle('devin-accounts:quota-all', async () => {
    const { code, stdout, stderr } = await runAuthCli(['quota', '--all', '--json']);
    if (code !== 0) return { ok: false, error: stderr.trim() };
    try {
      const results = JSON.parse(stdout.trim());
      return { ok: true, results };
    } catch {
      return { ok: false, error: '解析失败' };
    }
  });

  ipcMain.handle('devin-accounts:quota-one', async (_e, email: string) => {
    const { code, stdout, stderr } = await runAuthCli(['quota', '--email', email, '--json']);
    if (code !== 0) return { ok: false, error: stderr.trim() };
    try {
      return { ok: true, ...JSON.parse(stdout.trim()) };
    } catch {
      return { ok: false, error: '解析失败' };
    }
  });

  ipcMain.handle('devin-accounts:rotate-device', () => {
    rotateDevinInstallationId();
    return { ok: true };
  });

  // 渲染进程主动获取远程服务器信息（解决 IPC 消息早于渲染进程加载的竞态问题）
  ipcMain.handle('remote:get-server-info', () => cachedRemoteServerInfo);

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

  // ========== Chat Session IPC ==========

  ipcMain.handle('chat:create', (_e, opts: { workspace: string; model?: string }) => {
    if (!chatSessionManager) return null;
    const session = chatSessionManager.create(opts.workspace, opts.model);
    return { id: session.id, title: session.title, model: session.model, workspace: session.workspace, createdAt: session.createdAt };
  });

  ipcMain.handle('chat:send', (_e, sessionId: string, content: string) => {
    if (!chatSessionManager) return;
    chatSessionManager.sendMessage(sessionId, content).catch(() => {});
  });

  ipcMain.handle('chat:list', () => {
    if (!chatSessionManager) return [];
    return chatSessionManager.getAllSessions().map(s => ({
      id: s.id,
      title: s.title,
      model: s.model,
      workspace: s.workspace,
      createdAt: s.createdAt,
      messageCount: s.messages.length,
    }));
  });

  ipcMain.handle('chat:messages', (_e, sessionId: string) => {
    if (!chatSessionManager) return [];
    return chatSessionManager.getSession(sessionId)?.messages || [];
  });

  ipcMain.handle('chat:destroy', (_e, sessionId: string) => {
    // 保存到已关闭列表后再销毁
    const session = chatSessionManager?.getSession(sessionId);
    if (session && session.messages.length > 0) {
      addClosedChatSession({
        title: session.title,
        model: session.model,
        workspace: session.workspace,
        messages: session.messages,
      });
    }
    chatSessionManager?.destroy(sessionId);
    return true;
  });

  ipcMain.handle('chat:abort', (_e, sessionId: string) => {
    chatSessionManager?.abortStream(sessionId);
    return true;
  });

  ipcMain.handle('chat:rename', (_e, sessionId: string, title: string) => {
    chatSessionManager?.rename(sessionId, title);
    return true;
  });

  ipcMain.handle('chat:health', async () => {
    if (!chatSessionManager) return { ok: false, error: 'Chat manager not ready' };
    const health = await chatSessionManager.healthCheck();
    return {
      ...health,
      autoManaged: windsurfProxyManager?.isAvailable() ?? false,
      proxyDir: windsurfProxyManager?.getProxyDir() ?? null,
    };
  });

  ipcMain.handle('chat:proxy-start', async () => {
    if (!windsurfProxyManager) return { ok: false, error: 'Proxy manager not available' };
    return windsurfProxyManager.start();
  });

  ipcMain.handle('chat:models', async () => {
    if (!chatSessionManager) return [];
    return chatSessionManager.listModels();
  });
}

app.whenReady().then(async () => {
  setupPtyManager();

  // macOS Dock 图标 — 在窗口创建前设置
  const appIcon = loadAppIcon();
  if (appIcon) {
    if (process.platform === 'darwin' && app.dock) {
      app.dock.setIcon(appIcon);
    }
  }

  // 自动启动 Windsurf 代理
  windsurfProxyManager = new WindsurfProxyManager((running, error) => {
    if (running) {
      console.log('[Main] Windsurf proxy is ready');
    } else {
      console.log('[Main] Windsurf proxy down:', error || 'unknown');
    }
  });
  if (windsurfProxyManager.isAvailable()) {
    console.log('[Main] Auto-starting Windsurf proxy...');
    windsurfProxyManager.start().then((result) => {
      console.log('[Main] Windsurf proxy start result:', result.ok ? 'OK' : result.error);
    });
  } else {
    console.log('[Main] Windsurf proxy directory not found, chat features will be unavailable');
  }

  // 挂到 global 上供 remote-server 和 chat-session-manager 使用
  (global as any).__windsurfProxyManager = windsurfProxyManager;

  // 初始化 Chat Session Manager
  chatSessionManager = new ChatSessionManager({
    onDelta: (sessionId, text) => {
      safeSend('chat:delta', sessionId, text);
    },
    onDone: (sessionId, content) => {
      safeSend('chat:done', sessionId, content);
    },
    onError: (sessionId, error) => {
      safeSend('chat:error', sessionId, error);
    },
    onTitleUpdate: (sessionId, title) => {
      safeSend('chat:title-update', sessionId, title);
    },
  }, () => loadAiPreferenceData().manualConfig || null);

  // 挂到 global 上供 remote-server 使用
  (global as any).__chatSessionManager = chatSessionManager;

  registerIPC();
  cloudflaredManager = new CloudflaredManager(path.join(__dirname, '../..'));
  createWindow(appIcon);

  // 启动远程访问服务器（手机端）
  startRemoteServer(ptyManager, (sessionInfo) => {
    // 手机端创建了会话，通知桌面端 renderer 刷新
    safeSend('pty:remote-created', sessionInfo);
  }, (id) => {
    // 手机端销毁了会话，通知桌面端 renderer
    safeSend('pty:exit', id);
  }, (info) => {
    // 服务器启动后，把连接信息发送给渲染进程显示
    const tunnel = cloudflaredManager?.start();
    const serverInfo = {
      ...info,
      publicUrl: tunnel?.url || undefined,
      tunnel,
    };
    cachedRemoteServerInfo = serverInfo;
    safeSend('remote:server-info', serverInfo);
  });

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
  cloudflaredManager?.stopOwnedProcess();
  windsurfProxyManager?.destroy();
});
