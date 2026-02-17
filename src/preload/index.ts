import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('duocli', {
  // 设置窗口标题
  setWindowTitle: (title: string) => ipcRenderer.send('window:set-title', title),

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
    ipcRenderer.send('pty:destroy', id),

  // 重命名终端
  renamePty: (id: string, title: string) =>
    ipcRenderer.send('pty:rename', id, title),

  // 获取所有会话
  getSessions: () => ipcRenderer.invoke('pty:sessions'),

  // 选择文件夹
  selectFolder: (currentPath?: string) => ipcRenderer.invoke('dialog:select-folder', currentPath),
  // 读取目录树（用于左侧文件树）
  fileTreeListDir: (dirPath: string) => ipcRenderer.invoke('file-tree:list-dir', dirPath),
  // 同步最近目录到手机端远程服务
  remoteAddRecentCwd: (cwd: string) => ipcRenderer.invoke('remote:add-recent-cwd', cwd),

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
  onRemoteServerInfo: (cb: (info: { lanUrl: string; token: string; port: number }) => void) =>
    ipcRenderer.on('remote:server-info', (_e, info) => cb(info)),

  // 快照 API
  snapshotCheckRepo: (cwd: string) => ipcRenderer.invoke('snapshot:check-repo', cwd),
  snapshotCreate: (cwd: string, message?: string) => ipcRenderer.invoke('snapshot:create', cwd, message),
  snapshotList: (cwd: string) => ipcRenderer.invoke('snapshot:list', cwd),
  snapshotFiles: (cwd: string, commitId: string) => ipcRenderer.invoke('snapshot:files', cwd, commitId),
  snapshotRollback: (cwd: string, commitId: string, files: string[]) => ipcRenderer.invoke('snapshot:rollback', cwd, commitId, files),
  snapshotRollbackAll: (cwd: string, commitId: string) => ipcRenderer.invoke('snapshot:rollback-all', cwd, commitId),
  snapshotFileDiff: (cwd: string, commitId: string, filePath: string) => ipcRenderer.invoke('snapshot:file-diff', cwd, commitId, filePath),
  snapshotDiff: (cwd: string, commitId: string) => ipcRenderer.invoke('snapshot:diff', cwd, commitId),
  snapshotRestoreTo: (cwd: string, commitId: string) => ipcRenderer.invoke('snapshot:restore-to', cwd, commitId),
  snapshotSummarize: (cwd: string, commitId: string) => ipcRenderer.invoke('snapshot:summarize', cwd, commitId),
  onSnapshotCreated: (cb: (commitId: string) => void) =>
    ipcRenderer.on('snapshot:created', (_e, commitId) => cb(commitId)),

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

  // 打开外部链接
  openUrl: (url: string) => ipcRenderer.invoke('shell:open-url', url),

  // AI 配置 API
  aiScan: () => ipcRenderer.invoke('ai:scan'),
  aiTestAll: () => ipcRenderer.invoke('ai:test-all'),
  aiGetProviders: () => ipcRenderer.invoke('ai:get-providers'),
  aiSelect: (providerId: string) => ipcRenderer.invoke('ai:select', providerId),
  aiSetModel: (providerId: string, model: string) => ipcRenderer.invoke('ai:set-model', providerId, model),
  aiGetSelected: () => ipcRenderer.invoke('ai:get-selected'),
  // 获取 CLI 实际使用的模型提供商
  getCliProvider: (presetCommand: string) => ipcRenderer.invoke('cli:get-provider', presetCommand),

  // Claude 供应商配置
  claudeProvidersList: () => ipcRenderer.invoke('claude-providers:list'),
  claudeProvidersSave: (providers: any[]) => ipcRenderer.invoke('claude-providers:save', providers),

  // 会话历史 API
  sessionHistoryInit: (sessionId: string, title: string) => ipcRenderer.invoke('session-history:init', sessionId, title),
  sessionHistoryAppend: (sessionId: string, data: string) => ipcRenderer.send('session-history:append', sessionId, data),
  sessionHistoryFlush: (sessionId: string) => ipcRenderer.invoke('session-history:flush', sessionId),
  sessionHistoryFinish: (sessionId: string) => ipcRenderer.invoke('session-history:finish', sessionId),
  sessionHistoryRename: (sessionId: string, newTitle: string) => ipcRenderer.invoke('session-history:rename', sessionId, newTitle),
  sessionHistoryList: () => ipcRenderer.invoke('session-history:list'),
  sessionHistoryRead: (filename: string) => ipcRenderer.invoke('session-history:read', filename),
  sessionHistoryDelete: (filename: string) => ipcRenderer.invoke('session-history:delete', filename),
  sessionHistorySummarize: (filename: string) => ipcRenderer.invoke('session-history:summarize', filename),

  // 会话状态同步：renderer → main（供手机端读取）
  syncSessionStatus: (statuses: Record<string, string>) =>
    ipcRenderer.send('session:sync-status', statuses),

  // 催工配置：供 main 进程从 renderer 读写
  onGetAutoContinueConfig: (cb: (sessionId: string) => void) =>
    ipcRenderer.on('auto-continue:get', (_e, sessionId) => cb(sessionId)),
  sendAutoContinueConfig: (sessionId: string, config: any) =>
    ipcRenderer.send('auto-continue:config-reply', sessionId, config),
  onSetAutoContinueConfig: (cb: (sessionId: string, config: any) => void) =>
    ipcRenderer.on('auto-continue:set', (_e, sessionId, config) => cb(sessionId, config)),
});
