import { app, BrowserWindow, ipcMain, dialog, clipboard, nativeImage, shell } from 'electron';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { PtyManager, getDisplayName } from './pty-manager';
import { SnapshotManager } from './snapshot-manager';
import { AIConfigManager } from './ai-config';
import { setAIConfig, aiDiffSummary, aiSummarize, aiSessionSummarize } from './ollama';
import { startRemoteServer, pushRawDataToRemote, sendRemotePush, addRemoteRecentCwd } from './remote-server';

// macOS: 去掉 Dock 图标和启动终端窗口，以辅助应用模式运行
if (process.platform === 'darwin') {
  app.setActivationPolicy('accessory');
}

// 文件监听器
let fileWatcher: fs.FSWatcher | null = null;
let watchingCwd: string | null = null;

import * as os from 'os';

const PASTE_IMAGE_DIR = path.join(os.tmpdir(), 'duocli-paste');

// 会话历史目录
const SESSION_HISTORY_DIR = path.join(app.getPath('userData'), 'session-history');
const MAX_HISTORY_FILES = 50;
// 内存 buffer：sessionId → 待写入数据
const historyBuffers: Map<string, string> = new Map();
// sessionId → 文件路径映射
const historyFilePaths: Map<string, string> = new Map();
const sessionOutputTail: Map<string, string> = new Map();
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

function ensureHistoryDir(): void {
  if (!fs.existsSync(SESSION_HISTORY_DIR)) {
    fs.mkdirSync(SESSION_HISTORY_DIR, { recursive: true });
  }
}

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').substring(0, 80);
}

function cleanupOldHistory(): void {
  try {
    const files = fs.readdirSync(SESSION_HISTORY_DIR)
      .filter(f => f.endsWith('.txt'))
      .map(f => ({ name: f, time: fs.statSync(path.join(SESSION_HISTORY_DIR, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
    if (files.length > MAX_HISTORY_FILES) {
      for (const f of files.slice(MAX_HISTORY_FILES)) {
        fs.unlinkSync(path.join(SESSION_HISTORY_DIR, f.name));
      }
    }
  } catch { /* ignore */ }
}

// AI 偏好持久化
function getPreferencePath(): string {
  return path.join(app.getPath('userData'), 'ai-preference.json');
}

function saveAiPreference(providerId: string, model?: string): void {
  try {
    const existing = loadAiPreferenceData();
    const data = { providerId, model: model || existing.model || '' };
    fs.writeFileSync(getPreferencePath(), JSON.stringify(data));
  } catch { /* ignore */ }
}

function loadAiPreference(): string | null {
  return loadAiPreferenceData().providerId;
}

function loadAiPreferenceData(): { providerId: string | null; model: string | null } {
  try {
    const data = JSON.parse(fs.readFileSync(getPreferencePath(), 'utf-8'));
    return { providerId: data.providerId || null, model: data.model || null };
  } catch { return { providerId: null, model: null }; }
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
const snapshotManager = new SnapshotManager();
const aiConfigManager = new AIConfigManager();

function createWindow(): void {
  // 项目路径含中文/特殊字符时 nativeImage.createFromPath 可能失败，
  // 先复制图标到临时目录再加载；优先用 png（兼容性更好）
  const os = require('os');
  const iconCandidates = [
    path.join(__dirname, '../../build/icon.png'),
    path.join(__dirname, '../../build/icon.icns'),
    path.join(__dirname, '../../icon.png'),
  ];
  let appIcon: Electron.NativeImage | undefined;
  for (const iconPath of iconCandidates) {
    try {
      if (!fs.existsSync(iconPath)) continue;
      const tmpIcon = path.join(os.tmpdir(), 'duocli-icon' + path.extname(iconPath));
      fs.copyFileSync(iconPath, tmpIcon);
      const icon = nativeImage.createFromPath(tmpIcon);
      if (!icon.isEmpty()) {
        appIcon = icon;
        break;
      }
    } catch (_e) {
      // 继续尝试下一个候选
    }
  }
  if (appIcon && process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(appIcon);
  }
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
    mainWindow.webContents.send(channel, ...args);
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
      // 用户主动关闭的会话不发通知
      if (!sessionUserClosed.has(id)) {
        const session = ptyManager.getSession(id);
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
      snapshotManager.createSnapshot(cwd, '快照中...').then(async (commitId) => {
        if (commitId) {
          safeSend('snapshot:created', commitId);
          // 异步用 AI 生成快照标题
          try {
            const diff = await snapshotManager.getSnapshotDiff(cwd, commitId);
            if (diff) {
              const summary = await aiDiffSummary(diff);
              if (summary) {
                await snapshotManager.updateMessage(cwd, commitId, summary);
                safeSend('snapshot:created', commitId);
              }
            }
          } catch { /* 静默失败 */ }
        }
      }).catch(() => { /* 静默失败 */ });
    },
  });
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
    sessionUserClosed.add(id);
    ptyManager.destroy(id);
  });

  // 重命名终端
  ipcMain.on('pty:rename', (_e, id: string, title: string) => {
    ptyManager.rename(id, title);
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

  // ========== 快照 IPC ==========

  ipcMain.handle('snapshot:check-repo', async (_e, cwd: string) => {
    return snapshotManager.isGitRepo(cwd);
  });

  ipcMain.handle('snapshot:create', async (_e, cwd: string, message?: string) => {
    return snapshotManager.createSnapshot(cwd, message);
  });

  ipcMain.handle('snapshot:list', async (_e, cwd: string) => {
    return snapshotManager.listSnapshots(cwd);
  });

  ipcMain.handle('snapshot:files', async (_e, cwd: string, commitId: string) => {
    return snapshotManager.getSnapshotFiles(cwd, commitId);
  });

  ipcMain.handle('snapshot:rollback', async (_e, cwd: string, commitId: string, files: string[]) => {
    await snapshotManager.rollbackFiles(cwd, commitId, files);
  });

  ipcMain.handle('snapshot:rollback-all', async (_e, cwd: string, commitId: string) => {
    return snapshotManager.rollbackAll(cwd, commitId);
  });

  ipcMain.handle('snapshot:file-diff', async (_e, cwd: string, commitId: string, filePath: string) => {
    return snapshotManager.getFileDiff(cwd, commitId, filePath);
  });

  ipcMain.handle('snapshot:diff', async (_e, cwd: string, commitId: string) => {
    return snapshotManager.getSnapshotDiff(cwd, commitId);
  });

  ipcMain.handle('snapshot:restore-to', async (_e, cwd: string, commitId: string) => {
    return snapshotManager.restoreToSnapshot(cwd, commitId);
  });

  ipcMain.handle('snapshot:summarize', async (_e, cwd: string, commitId: string) => {
    const diff = await snapshotManager.getSnapshotDiff(cwd, commitId);
    if (!diff) return '无变更内容';
    return aiDiffSummary(diff);
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

  ipcMain.handle('ai:scan', async () => {
    const providers = await aiConfigManager.scan();
    return providers.map(p => ({
      ...p,
      apiKey: AIConfigManager.maskKey(p.apiKey),
    }));
  });

  ipcMain.handle('ai:test-all', async () => {
    const providers = await aiConfigManager.testAll();
    return providers.map(p => ({
      ...p,
      apiKey: AIConfigManager.maskKey(p.apiKey),
    }));
  });

  ipcMain.handle('ai:get-providers', () => {
    return aiConfigManager.getProviders().map(p => ({
      ...p,
      apiKey: AIConfigManager.maskKey(p.apiKey),
    }));
  });

  ipcMain.handle('ai:select', (_e, providerId: string) => {
    const providers = aiConfigManager.getProviders();
    const selected = providers.find(p => p.id === providerId);
    if (selected && selected.status === 'ok') {
      // 恢复之前保存的模型选择
      const pref = loadAiPreferenceData();
      if (pref.providerId === providerId && pref.model && selected.availableModels.includes(pref.model)) {
        selected.model = pref.model;
      }
      setAIConfig({
        apiFormat: selected.apiFormat,
        baseUrl: selected.baseUrl,
        apiKey: selected.apiKey,
        model: selected.model,
      });
      saveAiPreference(providerId, selected.model);
      return true;
    }
    return false;
  });

  ipcMain.handle('ai:set-model', (_e, providerId: string, model: string) => {
    const providers = aiConfigManager.getProviders();
    const selected = providers.find(p => p.id === providerId);
    if (selected && selected.availableModels.includes(model)) {
      selected.model = model;
      setAIConfig({
        apiFormat: selected.apiFormat,
        baseUrl: selected.baseUrl,
        apiKey: selected.apiKey,
        model,
      });
      saveAiPreference(providerId, model);
      return true;
    }
    return false;
  });

  ipcMain.handle('ai:get-selected', () => {
    return loadAiPreferenceData();
  });

  // 获取 CLI 实际使用的模型提供商
  ipcMain.handle('cli:get-provider', (_e, presetCommand: string) => {
    return getCliProvider(presetCommand);
  });

  // ========== Claude 供应商配置 ==========
  const CLAUDE_PROVIDERS_PATH = path.join(app.getPath('userData'), 'claude-providers.json');

  ipcMain.handle('claude-providers:list', () => {
    try {
      if (fs.existsSync(CLAUDE_PROVIDERS_PATH)) {
        return JSON.parse(fs.readFileSync(CLAUDE_PROVIDERS_PATH, 'utf-8'));
      }
    } catch { /* ignore */ }
    return [];
  });

  ipcMain.handle('claude-providers:save', (_e, providers: any[]) => {
    fs.writeFileSync(CLAUDE_PROVIDERS_PATH, JSON.stringify(providers, null, 2), 'utf-8');
    return true;
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

  // ========== 会话历史 IPC ==========

  ipcMain.handle('session-history:init', (_e, sessionId: string, title: string) => {
    ensureHistoryDir();
    const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const safeName = sanitizeFilename(title);
    const filename = `${safeName}_${ts}.txt`;
    const filePath = path.join(SESSION_HISTORY_DIR, filename);
    historyFilePaths.set(sessionId, filePath);
    historyBuffers.set(sessionId, '');
    return filename;
  });

  ipcMain.on('session-history:append', (_e, sessionId: string, data: string) => {
    // 剥离 ANSI 转义序列，保存干净文本
    const clean = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
    const existing = historyBuffers.get(sessionId) || '';
    historyBuffers.set(sessionId, existing + clean);
  });

  ipcMain.handle('session-history:flush', (_e, sessionId: string) => {
    const buf = historyBuffers.get(sessionId);
    const filePath = historyFilePaths.get(sessionId);
    if (!buf || !filePath) return;
    try {
      fs.appendFileSync(filePath, buf);
      historyBuffers.set(sessionId, '');
    } catch { /* ignore */ }
  });

  ipcMain.handle('session-history:finish', (_e, sessionId: string) => {
    const buf = historyBuffers.get(sessionId);
    const filePath = historyFilePaths.get(sessionId);
    if (buf && filePath) {
      try { fs.appendFileSync(filePath, buf); } catch { /* ignore */ }
    }
    historyBuffers.delete(sessionId);
    historyFilePaths.delete(sessionId);
    cleanupOldHistory();
  });

  ipcMain.handle('session-history:rename', (_e, sessionId: string, newTitle: string) => {
    const oldPath = historyFilePaths.get(sessionId);
    if (!oldPath || !fs.existsSync(oldPath)) return;
    const oldName = path.basename(oldPath);
    const tsPart = oldName.substring(oldName.lastIndexOf('_'));
    const safeName = sanitizeFilename(newTitle);
    const newFilename = `${safeName}${tsPart}`;
    const newPath = path.join(SESSION_HISTORY_DIR, newFilename);
    try {
      fs.renameSync(oldPath, newPath);
      historyFilePaths.set(sessionId, newPath);
    } catch { /* ignore */ }
  });

  ipcMain.handle('session-history:list', () => {
    ensureHistoryDir();
    try {
      return fs.readdirSync(SESSION_HISTORY_DIR)
        .filter(f => f.endsWith('.txt'))
        .map(f => {
          const stat = fs.statSync(path.join(SESSION_HISTORY_DIR, f));
          return { filename: f, size: stat.size, mtime: stat.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch { return []; }
  });

  ipcMain.handle('session-history:read', (_e, filename: string) => {
    const filePath = path.join(SESSION_HISTORY_DIR, filename);
    try { return fs.readFileSync(filePath, 'utf-8'); } catch { return ''; }
  });

  ipcMain.handle('session-history:delete', (_e, filename: string) => {
    const filePath = path.join(SESSION_HISTORY_DIR, filename);
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
  });

  ipcMain.handle('session-history:summarize', async (_e, filename: string) => {
    const filePath = path.join(SESSION_HISTORY_DIR, filename);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      if (!raw.trim()) return '(空会话)';
      const summary = await aiSessionSummarize(raw);
      return summary || '(无法生成总结)';
    } catch { return '(读取失败)'; }
  });
}

app.whenReady().then(async () => {
  setupPtyManager();
  registerIPC();
  createWindow();

  // 启动远程访问服务器（手机端）
  startRemoteServer(ptyManager, (sessionInfo) => {
    // 手机端创建了会话，通知桌面端 renderer 刷新
    safeSend('pty:remote-created', sessionInfo);
  }, (id) => {
    // 手机端销毁了会话，通知桌面端 renderer
    safeSend('pty:exit', id);
  }, (info) => {
    // 服务器启动后，把连接信息发送给渲染进程显示
    safeSend('remote:server-info', info);
  });

  // 自动扫描并选择 AI 服务
  try {
    await aiConfigManager.scan();
    await aiConfigManager.testAll();
    const providers = aiConfigManager.getProviders();
    const pref = loadAiPreferenceData();
    const savedId = pref.providerId;
    // 优先用上次保存的选择
    const preferred = savedId ? providers.find(p => p.id === savedId && p.status === 'ok') : null;
    const ok = preferred || providers.find(p => p.status === 'ok');
    if (ok) {
      // 恢复保存的模型
      if (pref.model && ok.availableModels.includes(pref.model)) {
        ok.model = pref.model;
      }
      setAIConfig({
        apiFormat: ok.apiFormat,
        baseUrl: ok.baseUrl,
        apiKey: ok.apiKey,
        model: ok.model,
      });
      saveAiPreference(ok.id, ok.model);
    }
  } catch { /* 静默失败，不影响启动 */ }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
