import { app, BrowserWindow, ipcMain, dialog, clipboard, nativeImage, shell } from 'electron';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { PtyManager, getDisplayName } from './pty-manager';
import { SnapshotManager } from './snapshot-manager';
import { AIConfigManager } from './ai-config';
import { setAIConfig, aiDiffSummary, aiSummarize, aiSessionSummarize } from './ollama';

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

let mainWindow: BrowserWindow | null = null;
let ptyManager: PtyManager;
const snapshotManager = new SnapshotManager();
const aiConfigManager = new AIConfigManager();

function createWindow(): void {
  const iconPath = path.join(__dirname, '../../build/icon.png');
  // macOS Dock 图标需要通过 dock.setIcon 设置（BrowserWindow.icon 在 macOS 上不影响 Dock）
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(iconPath);
  }
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    title: 'DuoCLI',
    icon: iconPath,
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

function setupPtyManager(): void {
  ptyManager = new PtyManager({
    onData: (id, data) => {
      mainWindow?.webContents.send('pty:data', id, data);
    },
    onTitleUpdate: (id, title) => {
      mainWindow?.webContents.send('pty:title-update', id, title);
    },
    onExit: (id) => {
      mainWindow?.webContents.send('pty:exit', id);
    },
    onPasteInput: (id, cwd) => {
      snapshotManager.createSnapshot(cwd, '快照中...').then(async (commitId) => {
        if (commitId) {
          mainWindow?.webContents.send('snapshot:created', commitId);
          // 异步用 AI 生成快照标题
          try {
            const diff = await snapshotManager.getSnapshotDiff(cwd, commitId);
            if (diff) {
              const summary = await aiDiffSummary(diff);
              if (summary) {
                await snapshotManager.updateMessage(cwd, commitId, summary);
                mainWindow?.webContents.send('snapshot:created', commitId);
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
  ipcMain.handle('pty:create', (_e, cwd: string, presetCommand: string, themeId: string) => {
    const session = ptyManager.create(cwd, presetCommand, themeId);
    return {
      id: session.id,
      title: session.title,
      themeId: session.themeId,
      cwd: session.cwd,
      displayName: getDisplayName(session.presetCommand),
    };
  });

  // 写入数据
  ipcMain.on('pty:write', (_e, id: string, data: string) => {
    ptyManager.write(id, data);
  });

  // 调整大小
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => {
    ptyManager.resize(id, cols, rows);
  });

  // 销毁终端
  ipcMain.on('pty:destroy', (_e, id: string) => {
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

  // ========== 文件监听 IPC ==========

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
