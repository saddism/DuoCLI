import { contextBridge, ipcRenderer } from 'electron';

export type RemoteSyncStatus = 'healthy' | 'lan-only' | 'degraded' | 'retrying' | 'error';

export interface RemoteSyncHealthPayload {
  status: RemoteSyncStatus;
  localOk: boolean;
  tunnelRunning: boolean;
  publicOk: boolean;
  publicUrl?: string;
  message: string;
  lastCheckedAt: number;
}

export interface RemoteServerInfoPayload {
  lanUrl: string;
  token: string;
  port: number;
  publicUrl?: string;
  tunnel?: { installed?: boolean; running: boolean; url: string; message?: string };
  health?: RemoteSyncHealthPayload;
}

contextBridge.exposeInMainWorld('duocli', {
  getQuickCommands: () => ipcRenderer.invoke('quick-commands:get'),
  updateQuickCommands: (operation: { action: string; command?: string; commands?: string[] }) => ipcRenderer.invoke('quick-commands:update', operation),
  submitPty: (id: string, submissionId: string, text: string) => ipcRenderer.invoke('pty:submit', id, submissionId, text),

  // 设置窗口标题
  setWindowTitle: (title: string) => ipcRenderer.send('window:set-title', title),
  onCloseCurrentSession: (cb: () => void) =>
    ipcRenderer.on('app:close-current-session', () => cb()),

  // 创建终端
  createPty: (cwd: string, presetCommand: string, themeId: string, providerEnv?: Record<string, string>) =>
    ipcRenderer.invoke('pty:create', cwd, presetCommand, themeId, providerEnv),

  // 写入数据 (改成 invoke 等待完成)
  writePty: (id: string, data: string) =>
    ipcRenderer.invoke('pty:write', id, data),

  // 调整大小 (改成 invoke 等待完成)
  resizePty: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke('pty:resize', id, cols, rows),

  // 销毁终端
  destroyPty: (id: string) =>
    ipcRenderer.invoke('pty:destroy', id),

  // 重命名终端
  renamePty: (id: string, title: string) =>
    ipcRenderer.send('pty:rename', id, title),

  // 重新用 AI 生成标题
  regenerateTitle: (id: string) =>
    ipcRenderer.invoke('pty:regenerate-title', id),

  // 获取所有会话
  getSessions: () => ipcRenderer.invoke('pty:sessions'),

  // 选择文件夹
  selectFolder: (currentPath?: string) => ipcRenderer.invoke('dialog:select-folder', currentPath),
  // 读取目录树（用于左侧文件树）
  fileTreeListDir: (dirPath: string) => ipcRenderer.invoke('file-tree:list-dir', dirPath),
  // 同步最近目录到手机端远程服务
  remoteAddRecentCwd: (cwd: string) => ipcRenderer.invoke('remote:add-recent-cwd', cwd),
  remoteSyncRecentCwds: (cwds: string[]) => ipcRenderer.invoke('remote:sync-recent-cwds', cwds),

  // 监听事件
  onPtyData: (cb: (id: string, data: string) => void) =>
    ipcRenderer.on('pty:data', (_e, id, data) => cb(id, data)),

  onTitleUpdate: (cb: (id: string, title: string) => void) =>
    ipcRenderer.on('pty:title-update', (_e, id, title) => cb(id, title)),

  onPtyExit: (cb: (id: string) => void) =>
    ipcRenderer.on('pty:exit', (_e, id) => cb(id)),

  onRemoteCreated: (cb: (sessionInfo: any) => void) =>
    ipcRenderer.on('pty:remote-created', (_e, info) => cb(info)),

  // 远程服务器连接信息
  onRemoteServerInfo: (cb: (info: RemoteServerInfoPayload) => void) =>
    ipcRenderer.on('remote:server-info', (_e, info) => cb(info)),
  onRemoteHealthUpdate: (cb: (health: RemoteSyncHealthPayload) => void) =>
    ipcRenderer.on('remote:health-update', (_e, health) => cb(health)),
  // 渲染进程主动获取远程服务器信息（解决竞态问题）
  getRemoteServerInfo: () => ipcRenderer.invoke('remote:get-server-info'),
  getRemoteHealth: () => ipcRenderer.invoke('remote:get-health'),
  retryRemoteSync: () => ipcRenderer.invoke('remote:retry-sync'),
  setRemoteToken: (token: string) => ipcRenderer.invoke('remote:set-token', token) as Promise<
    { ok: true; token: string } | { ok: false; error: string }
  >,
  generateRemoteToken: () => ipcRenderer.invoke('remote:generate-token') as Promise<string>,

  // 剪贴板图片
  clipboardSaveImage: () => ipcRenderer.invoke('clipboard:save-image'),
  // 剪贴板文件路径
  clipboardGetFilePath: () => ipcRenderer.invoke('clipboard:get-file-path'),

  // 文件监听
  filewatcherStart: (cwd: string) => ipcRenderer.invoke('filewatcher:start', cwd),
  filewatcherStop: () => ipcRenderer.invoke('filewatcher:stop'),
  filewatcherOpen: (filePath: string) => ipcRenderer.invoke('filewatcher:open', filePath),
  filewatcherSelectEditor: () => ipcRenderer.invoke('filewatcher:select-editor'),
  filewatcherGetEditor: () => ipcRenderer.invoke('filewatcher:get-editor'),
  onFileChange: (cb: (filename: string, eventType: string) => void) =>
    ipcRenderer.on('filewatcher:change', (_e, filename, eventType) => cb(filename, eventType)),

  // 在 Finder 中打开目录
  openFolder: (folderPath: string) => ipcRenderer.invoke('shell:open-folder', folderPath),

  // 读取目录内容
  readDirectory: (dirPath: string) => ipcRenderer.invoke('fs:read-directory', dirPath),

  // 用默认应用打开文件
  openFile: (filePath: string) => ipcRenderer.invoke('shell:open-file', filePath),
  // 桌面 Pane 只读文件预览
  readFilePreview: (cwd: string, filePath: string) => ipcRenderer.invoke('file-preview:read', cwd, filePath),

  // 桌面 Android Pane
  androidListDevices: () => ipcRenderer.invoke('android:list-devices'),
  androidScreenshot: (deviceId?: string) => ipcRenderer.invoke('android:screenshot', deviceId),
  androidTap: (deviceId: string, x: number, y: number) => ipcRenderer.invoke('android:tap', deviceId, x, y),
  androidSwipe: (deviceId: string, x1: number, y1: number, x2: number, y2: number, duration?: number) => ipcRenderer.invoke('android:swipe', deviceId, x1, y1, x2, y2, duration),
  androidInputText: (deviceId: string, text: string) => ipcRenderer.invoke('android:input-text', deviceId, text),

  // 打开外部链接
  openUrl: (url: string) => ipcRenderer.invoke('shell:open-url', url),

  // AI 配置 API
  aiApplyConfig: (config: { apiFormat: string; baseUrl: string; apiKey: string; model: string }) => ipcRenderer.invoke('ai:apply-config', config),
  aiTestConfig: (config: { apiFormat: string; baseUrl: string; apiKey: string; model: string }) => ipcRenderer.invoke('ai:test-config', config),
  aiGetCurrentConfig: () => ipcRenderer.invoke('ai:get-current-config'),
  terminalAutoResponseGetConfig: () => ipcRenderer.invoke('terminal-auto-response:get-config'),
  terminalAutoResponseSaveConfig: (config: any) => ipcRenderer.invoke('terminal-auto-response:save-config', config),
  // 获取 CLI 实际使用的模型提供商
  getCliProvider: (presetCommand: string) => ipcRenderer.invoke('cli:get-provider', presetCommand),
  // 本机可用的内置预制 CLI（不存在的会过滤掉）
  getAvailableBuiltinPresets: () => ipcRenderer.invoke('cli:available-builtins'),

  // Claude 供应商配置
  claudeProvidersList: () => ipcRenderer.invoke('claude-providers:list'),
  claudeProvidersSave: (providers: any[]) => ipcRenderer.invoke('claude-providers:save', providers),

  // 会话状态同步：renderer → main（供手机端读取）
  syncSessionStatus: (statuses: Record<string, string>) =>
    ipcRenderer.send('session:sync-status', statuses),

  // 催工配置：供 main 进程从 renderer 读写
  autoContinueManaged: true,
  getAutoContinueConfigs: () => ipcRenderer.invoke('auto-continue:get-all') as Promise<{
    configs: Record<string, any>;
    persisted: boolean;
  }>,
  syncAutoContinueConfigs: (configs: Record<string, any>) =>
    ipcRenderer.send('auto-continue:sync', configs),
  onGetAutoContinueConfig: (cb: (sessionId: string) => void) =>
    ipcRenderer.on('auto-continue:get', (_e, sessionId) => cb(sessionId)),
  sendAutoContinueConfig: (sessionId: string, config: any) =>
    ipcRenderer.send('auto-continue:config-reply', sessionId, config),
  onSetAutoContinueConfig: (cb: (sessionId: string, config: any) => void) =>
    ipcRenderer.on('auto-continue:set', (_e, sessionId, config) => cb(sessionId, config)),

  // ========== 已关闭会话 ==========
  closedSessionsList: () => ipcRenderer.invoke('closed-sessions:list'),
  closedSessionsBeginRestore: (id: string) => ipcRenderer.invoke('closed-sessions:begin-restore', id),
  closedSessionsCancelRestore: (id: string) => ipcRenderer.invoke('closed-sessions:cancel-restore', id),
  closedSessionsRemove: (id: string) => ipcRenderer.invoke('closed-sessions:remove', id),
  closedSessionsClear: () => ipcRenderer.invoke('closed-sessions:clear'),
  closedSessionsConfirmRestore: (closedId: string, sessionId: string) =>
    ipcRenderer.invoke('closed-sessions:confirm-restore', closedId, sessionId),
  onClosedSessionsUpdate: (cb: (sessions: Array<{ id: string; title: string; cwd: string; presetCommand: string; resumeId: string; resumeCommand: string; displayName: string; closedAt: number; contextHistory?: Array<{ role: 'user' | 'assistant'; content: string; timestamp?: number }>; exportPath?: string }>) => void) =>
    ipcRenderer.on('closed-sessions:update', (_e, sessions) => cb(sessions)),

  // ========== 上下文导出功能 ==========
  exportContextToExportDirectory: (sessionId: string, targetAgent?: string) => ipcRenderer.invoke('context-export:export', sessionId, targetAgent),
  listExportedContexts: () => ipcRenderer.invoke('context-export:list'),
  openExportedContextFile: (filePath: string) => ipcRenderer.invoke('context-export:open-file', filePath),
  
  // ========== 通知功能 ==========
  onNotification: (cb: (title: string, body: string, sessionId?: string) => void) =>
    ipcRenderer.on('notification', (_e, title, body, sessionId) => cb(title, body, sessionId)),
  onNotificationOpen: (cb: (sessionId: string) => void) =>
    ipcRenderer.on('notification:open-session', (_e, sessionId) => cb(sessionId)),
});
