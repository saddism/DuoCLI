import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('duocli', {
  // 创建终端
  createPty: (cwd: string, presetCommand: string, themeId: string) =>
    ipcRenderer.invoke('pty:create', cwd, presetCommand, themeId),

  // 写入数据
  writePty: (id: string, data: string) =>
    ipcRenderer.send('pty:write', id, data),

  // 调整大小
  resizePty: (id: string, cols: number, rows: number) =>
    ipcRenderer.send('pty:resize', id, cols, rows),

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

  // 监听事件
  onPtyData: (cb: (id: string, data: string) => void) =>
    ipcRenderer.on('pty:data', (_e, id, data) => cb(id, data)),

  onTitleUpdate: (cb: (id: string, title: string) => void) =>
    ipcRenderer.on('pty:title-update', (_e, id, title) => cb(id, title)),

  onPtyExit: (cb: (id: string) => void) =>
    ipcRenderer.on('pty:exit', (_e, id) => cb(id)),

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

  // 打开外部链接
  openUrl: (url: string) => ipcRenderer.invoke('shell:open-url', url),

  // AI 配置 API
  aiScan: () => ipcRenderer.invoke('ai:scan'),
  aiTestAll: () => ipcRenderer.invoke('ai:test-all'),
  aiGetProviders: () => ipcRenderer.invoke('ai:get-providers'),
  aiSelect: (providerId: string) => ipcRenderer.invoke('ai:select', providerId),
  aiSetModel: (providerId: string, model: string) => ipcRenderer.invoke('ai:set-model', providerId, model),
  aiGetSelected: () => ipcRenderer.invoke('ai:get-selected'),
});
