import { TerminalManager } from './terminal-manager';

interface AIProviderInfo {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  availableModels: string[];
  source: string;
  apiFormat: 'anthropic' | 'openai' | 'gemini' | 'ollama';
  status: 'pending' | 'ok' | 'fail';
  errorMsg?: string;
}

let selectedAiProviderId: string | null = null;

declare global {
  interface Window {
    duocli: {
      createPty: (cwd: string, presetCommand: string, themeId: string) => Promise<{ id: string; title: string; themeId: string }>;
      writePty: (id: string, data: string) => void;
      resizePty: (id: string, cols: number, rows: number) => void;
      destroyPty: (id: string) => void;
      renamePty: (id: string, title: string) => void;
      getSessions: () => Promise<Array<{ id: string; title: string; themeId: string }>>;
      selectFolder: (currentPath?: string) => Promise<string | null>;
      onPtyData: (cb: (id: string, data: string) => void) => void;
      onTitleUpdate: (cb: (id: string, title: string) => void) => void;
      onPtyExit: (cb: (id: string) => void) => void;
      // 快照 API
      snapshotCheckRepo: (cwd: string) => Promise<boolean>;
      snapshotCreate: (cwd: string, message?: string) => Promise<string | null>;
      snapshotList: (cwd: string) => Promise<Array<{ id: string; message: string; timestamp: number; fileCount: number }>>;
      snapshotFiles: (cwd: string, commitId: string) => Promise<Array<{ path: string; status: string }>>;
      snapshotRollback: (cwd: string, commitId: string, files: string[]) => Promise<void>;
      snapshotRollbackAll: (cwd: string, commitId: string) => Promise<{ total: number; changed: number; unchanged: number }>;
      snapshotRestoreTo: (cwd: string, commitId: string) => Promise<{ total: number; changed: number; unchanged: number; deleted: number; backupCommitId: string | null }>;
      snapshotFileDiff: (cwd: string, commitId: string, filePath: string) => Promise<string>;
      snapshotDiff: (cwd: string, commitId: string) => Promise<string>;
      snapshotSummarize: (cwd: string, commitId: string) => Promise<string>;
      onSnapshotCreated: (cb: (commitId: string) => void) => void;
      clipboardSaveImage: () => Promise<string | null>;
      // 文件监听 API
      filewatcherStart: (cwd: string) => Promise<void>;
      filewatcherStop: () => Promise<void>;
      filewatcherOpen: (filePath: string) => Promise<void>;
      filewatcherSelectEditor: () => Promise<string | null>;
      filewatcherGetEditor: () => Promise<string | null>;
      openFolder: (folderPath: string) => Promise<void>;
      openUrl: (url: string) => Promise<void>;
      onFileChange: (cb: (filename: string, eventType: string) => void) => void;
      // AI 配置 API
      aiScan: () => Promise<AIProviderInfo[]>;
      aiTestAll: () => Promise<AIProviderInfo[]>;
      aiGetProviders: () => Promise<AIProviderInfo[]>;
      aiSelect: (providerId: string) => Promise<boolean>;
      aiSetModel: (providerId: string, model: string) => Promise<boolean>;
      aiGetSelected: () => Promise<{ providerId: string | null; model: string | null }>;
    };
  }
}

// 状态
const savedCwd = localStorage.getItem('duocli_cwd') || '';
let currentCwd = savedCwd;
let lastPreset = localStorage.getItem('duocli_preset') || '';
const sessionTitles: Map<string, string> = new Map();
const sessionThemes: Map<string, string> = new Map();
const sessionUpdateTimes: Map<string, number> = new Map();
// 归档：终端进程仍在运行，只是从活跃列表隐藏
const archivedSessions: Map<string, { title: string; themeId: string; updateTime: number }> = new Map();

// DOM 元素
const cwdInput = document.getElementById('cwd-input') as HTMLInputElement;
const cwdBrowseBtn = document.getElementById('cwd-browse-btn')!;
const cwdOpenBtn = document.getElementById('cwd-open-btn')!;
const presetSelect = document.getElementById('preset-select') as HTMLSelectElement;
const themeSelect = document.getElementById('theme-select')!;
const themeDisplay = document.getElementById('theme-display')!;
const themeDropdown = document.getElementById('theme-dropdown')!;
const toolbarNewBtn = document.getElementById('toolbar-new-btn')!;
const terminalArea = document.getElementById('terminal-area')!;
const terminalContent = document.getElementById('terminal-content')!;
const emptyState = document.getElementById('empty-state')!;
const sessionList = document.getElementById('session-list')!;
const archivedHeader = document.getElementById('archived-header')!;
const archivedToggle = document.getElementById('archived-toggle')!;
const archivedList = document.getElementById('archived-list')!;
const archivedCount = document.getElementById('archived-count')!;

// 文件状态栏 DOM
const fileStatusbar = document.getElementById('file-statusbar')!;
const fileStatusbarFiles = document.getElementById('file-statusbar-files')!;

// 快照相关 DOM
const sidebarTabs = document.querySelectorAll('.sidebar-tab');
const tabSessions = document.getElementById('tab-sessions')!;
const tabSnapshots = document.getElementById('tab-snapshots')!;
const snapshotNotGit = document.getElementById('snapshot-not-git')!;
const snapshotActions = document.getElementById('snapshot-actions')!;
const snapshotCreateBtn = document.getElementById('snapshot-create-btn')!;
const snapshotListEl = document.getElementById('snapshot-list')!;

// 快照状态
let expandedSnapshotId: string | null = null;
// 已撤销/已还原的快照记录：snapId → '已撤销' | '已还原'
const revertedSnapshots: Map<string, string> = new Map();
// 当前快照列表缓存（用于还原标记）
let cachedSnapshots: Array<{ id: string; message: string; timestamp: number; fileCount: number }> = [];

// AI 配置相关 DOM
const tabAiConfig = document.getElementById('tab-ai-config')!;
const aiScanBtn = document.getElementById('ai-scan-btn')!;
const aiProviderList = document.getElementById('ai-provider-list')!;

// 文件监听状态（全局）
let globalRecentFiles: string[] = [];
const MAX_RECENT_FILES = 5;
let currentEditorName: string | null = null;

// 未读消息状态
const sessionUnread: Set<string> = new Set();
// 手动改过标题的会话（不再自动更新）
const sessionTitleLocked: Set<string> = new Set();

// 终端管理器
const termManager = new TerminalManager(terminalContent);

// 恢复上次的工作目录和预设命令
if (savedCwd) {
  cwdInput.value = savedCwd;
}
if (lastPreset) {
  presetSelect.value = lastPreset;
}

// 自定义配色下拉组件
const themeColorMap: Record<string, string> = {
  'vscode-dark': '#0078d4',
  'monokai': '#a6e22e',
  'dracula': '#bd93f9',
  'solarized-dark': '#268bd2',
  'one-dark': '#61afef',
  'nord': '#88c0d0',
};
let currentThemeId = localStorage.getItem('duocli_theme') || 'vscode-dark';

function setThemeValue(value: string): void {
  currentThemeId = value;
  localStorage.setItem('duocli_theme', value);
  const opt = themeDropdown.querySelector(`[data-value="${value}"]`);
  if (opt) {
    themeDisplay.innerHTML = opt.innerHTML;
  }
  themeDropdown.querySelectorAll('.custom-select-option').forEach((el) => {
    el.classList.toggle('selected', el.getAttribute('data-value') === value);
  });
}

themeDisplay.addEventListener('click', (e) => {
  e.stopPropagation();
  themeSelect.classList.toggle('open');
});

themeDropdown.addEventListener('click', (e) => {
  const target = (e.target as HTMLElement).closest('.custom-select-option') as HTMLElement | null;
  if (!target) return;
  const value = target.getAttribute('data-value');
  if (value) setThemeValue(value);
  themeSelect.classList.remove('open');
});

document.addEventListener('click', () => {
  themeSelect.classList.remove('open');
});

// 启动时恢复保存的配色
setThemeValue(currentThemeId);

// ========== 工具函数 ==========

function friendlyTime(ts: number): string {
  const now = Date.now();
  const diff = Math.floor((now - ts) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}天前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function updateEmptyState(): void {
  emptyState.style.display = termManager.hasInstances() ? 'none' : 'flex';
}

// 确认弹窗
function showConfirmDialog(title: string): Promise<'close' | 'archive' | 'cancel'> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog';
    dialog.innerHTML = `
      <h3>关闭终端</h3>
      <p>确定要关闭「${title}」吗？</p>
      <div class="confirm-buttons">
        <button class="btn-cancel">取消</button>
        <button class="btn-archive">归档</button>
        <button class="btn-close-confirm">关闭</button>
      </div>`;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    const cleanup = (r: 'close' | 'archive' | 'cancel') => { overlay.remove(); resolve(r); };
    dialog.querySelector('.btn-cancel')!.addEventListener('click', () => cleanup('cancel'));
    dialog.querySelector('.btn-archive')!.addEventListener('click', () => cleanup('archive'));
    dialog.querySelector('.btn-close-confirm')!.addEventListener('click', () => cleanup('close'));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup('cancel'); });
  });
}

// ========== 渲染 ==========

function startTitleEdit(id: string, titleSpan: HTMLElement): void {
  const current = sessionTitles.get(id) || '';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'session-title-input';
  input.value = current;
  titleSpan.replaceWith(input);
  input.focus();
  input.select();
  const commit = () => {
    const val = input.value.trim();
    if (val && val !== current) {
      sessionTitles.set(id, val);
      sessionTitleLocked.add(id);
      window.duocli.renamePty(id, val);
    }
    renderSessionList();
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.value = current; input.blur(); }
  });
}

function renderSessionList(): void {
  const activeId = termManager.getActiveId();
  sessionList.innerHTML = '';
  // 按创建顺序倒序排列（新建的在最上面）
  const sortedIds = Array.from(sessionTitles.keys()).reverse();
  for (const id of sortedIds) {
    const title = sessionTitles.get(id)!;
    const item = document.createElement('div');
    item.className = 'session-item' + (id === activeId ? ' active' : '');
    const dot = document.createElement('span');
    dot.className = 'session-color-dot';
    const lastUpdate = sessionUpdateTimes.get(id) || 0;
    const isRecentlyActive = (Date.now() - lastUpdate) < 60000;
    if (sessionUnread.has(id) || isRecentlyActive) {
      dot.style.backgroundColor = '#73c991';
    } else {
      dot.style.backgroundColor = '#555';
    }
    const titleSpan = document.createElement('span');
    titleSpan.className = 'session-title';
    titleSpan.textContent = title.charAt(0).toUpperCase() + title.slice(1);
    titleSpan.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startTitleEdit(id, titleSpan);
    });
    const timeSpan = document.createElement('span');
    timeSpan.className = 'session-time';
    timeSpan.textContent = friendlyTime(sessionUpdateTimes.get(id) || Date.now());
    const infoWrap = document.createElement('div');
    infoWrap.className = 'session-info';
    infoWrap.appendChild(titleSpan);
    infoWrap.appendChild(timeSpan);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'session-close';
    closeBtn.textContent = '\u00d7';
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); handleCloseClick(id); });
    item.addEventListener('click', () => switchSession(id));
    item.appendChild(dot);
    item.appendChild(infoWrap);
    item.appendChild(closeBtn);
    sessionList.appendChild(item);
  }
}

function renderArchivedList(): void {
  archivedList.innerHTML = '';
  archivedCount.textContent = String(archivedSessions.size);
  archivedSessions.forEach((info, id) => {
    const item = document.createElement('div');
    item.className = 'session-item archived';
    const dot = document.createElement('span');
    dot.className = 'session-color-dot';
    dot.style.backgroundColor = TerminalManager.getThemeDotColor(info.themeId);
    const titleSpan = document.createElement('span');
    titleSpan.className = 'session-title';
    titleSpan.textContent = info.title;
    const timeSpan = document.createElement('span');
    timeSpan.className = 'session-time';
    timeSpan.textContent = friendlyTime(info.updateTime);
    const infoWrap = document.createElement('div');
    infoWrap.className = 'session-info';
    infoWrap.appendChild(titleSpan);
    infoWrap.appendChild(timeSpan);
    // 恢复按钮
    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'session-restore';
    restoreBtn.textContent = '\u21A9';
    restoreBtn.title = '恢复';
    restoreBtn.addEventListener('click', (e) => { e.stopPropagation(); restoreSession(id); });
    // 彻底关闭按钮
    const closeBtn = document.createElement('button');
    closeBtn.className = 'session-close';
    closeBtn.textContent = '\u00d7';
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); destroySession(id); });
    item.addEventListener('click', () => { restoreSession(id); });
    item.appendChild(dot);
    item.appendChild(infoWrap);
    item.appendChild(restoreBtn);
    item.appendChild(closeBtn);
    archivedList.appendChild(item);
  });
}

// ========== 核心操作 ==========

async function createSession(): Promise<void> {
  if (!currentCwd) { alert('请先选择工作目录'); return; }
  const preset = presetSelect.value;
  const themeId = currentThemeId;
  lastPreset = preset;
  localStorage.setItem('duocli_preset', preset);
  const result = await window.duocli.createPty(currentCwd, preset, themeId);
  sessionTitles.set(result.id, result.title);
  sessionThemes.set(result.id, result.themeId);
  sessionUpdateTimes.set(result.id, Date.now());
  termManager.create(result.id, result.themeId, currentCwd, (data) => { window.duocli.writePty(result.id, data); });
  updateEmptyState();
  renderSessionList();
  setTimeout(() => {
    const dims = termManager.getActiveDimensions();
    if (dims) window.duocli.resizePty(result.id, dims.cols, dims.rows);
  }, 100);
}

function switchSession(id: string): void {
  termManager.switchTo(id);
  sessionUnread.delete(id);
  renderSessionList();
  renderFileStatusbar();
  const dims = termManager.getActiveDimensions();
  if (dims) window.duocli.resizePty(id, dims.cols, dims.rows);
}

// 点击 × 时弹确认
async function handleCloseClick(id: string): Promise<void> {
  const title = sessionTitles.get(id) || '终端';
  const action = await showConfirmDialog(title);
  if (action === 'cancel') return;
  if (action === 'archive') {
    archiveSession(id);
  } else {
    destroySession(id);
  }
}

// 归档：从活跃列表移到已归档，终端隐藏但进程不杀
function archiveSession(id: string): void {
  const title = sessionTitles.get(id) || '终端';
  const themeId = sessionThemes.get(id) || 'vscode-dark';
  const updateTime = sessionUpdateTimes.get(id) || Date.now();
  archivedSessions.set(id, { title, themeId, updateTime });
  sessionTitles.delete(id);
  sessionThemes.delete(id);
  sessionUpdateTimes.delete(id);
  // 隐藏终端但不销毁
  termManager.hide(id);
  updateEmptyState();
  renderSessionList();
  renderArchivedList();
}

// 从归档恢复到活跃列表
function restoreSession(id: string): void {
  const info = archivedSessions.get(id);
  if (!info) return;
  archivedSessions.delete(id);
  sessionTitles.set(id, info.title);
  sessionThemes.set(id, info.themeId);
  sessionUpdateTimes.set(id, info.updateTime);
  sessionUnread.delete(id);
  termManager.switchTo(id);
  updateEmptyState();
  renderSessionList();
  renderArchivedList();
  renderFileStatusbar();
  const dims = termManager.getActiveDimensions();
  if (dims) window.duocli.resizePty(id, dims.cols, dims.rows);
}

// 彻底关闭终端
function destroySession(id: string): void {
  window.duocli.destroyPty(id);
  sessionTitles.delete(id);
  sessionThemes.delete(id);
  sessionUpdateTimes.delete(id);
  archivedSessions.delete(id);
  sessionUnread.delete(id);
  sessionTitleLocked.delete(id);
  termManager.destroy(id);
  updateEmptyState();
  renderSessionList();
  renderArchivedList();
}

async function browseCwd(): Promise<void> {
  const folder = await window.duocli.selectFolder(currentCwd || undefined);
  if (folder) { currentCwd = folder; cwdInput.value = folder; localStorage.setItem('duocli_cwd', folder); startFileWatcher(folder); }
}

// ========== 文件监听 ==========

function startFileWatcher(cwd: string): void {
  globalRecentFiles = [];
  renderFileStatusbar();
  window.duocli.filewatcherStart(cwd);
}

// ========== AI 配置 ==========

async function refreshAiConfig(): Promise<void> {
  const saved = await window.duocli.aiGetSelected();
  if (saved?.providerId) selectedAiProviderId = saved.providerId;
  const providers = await window.duocli.aiGetProviders();
  if (providers.length === 0) {
    aiProviderList.innerHTML = '<div class="snapshot-notice">点击「扫描并测试」发现可用 AI 服务</div>';
  } else {
    renderAiProviders(providers);
  }
}

async function handleAiScan(): Promise<void> {
  aiScanBtn.textContent = '扫描中...';
  (aiScanBtn as HTMLButtonElement).disabled = true;
  try {
    const providers = await window.duocli.aiScan();
    renderAiProviders(providers);
    if (providers.length > 0) {
      aiScanBtn.textContent = '测试中...';
      const tested = await window.duocli.aiTestAll();
      renderAiProviders(tested);
    }
  } catch {
    aiProviderList.innerHTML = '<div class="snapshot-notice">扫描失败</div>';
  }
  aiScanBtn.textContent = '扫描并测试';
  (aiScanBtn as HTMLButtonElement).disabled = false;
}

async function handleAiSelect(providerId: string): Promise<void> {
  const ok = await window.duocli.aiSelect(providerId);
  if (ok) {
    selectedAiProviderId = providerId;
    const providers = await window.duocli.aiGetProviders();
    renderAiProviders(providers);
  }
}

async function handleAiSetModel(providerId: string, model: string): Promise<void> {
  await window.duocli.aiSetModel(providerId, model);
  const providers = await window.duocli.aiGetProviders();
  renderAiProviders(providers);
}

function renderAiProviders(providers: AIProviderInfo[]): void {
  aiProviderList.innerHTML = '';
  if (providers.length === 0) {
    aiProviderList.innerHTML = '<div class="snapshot-notice">未发现 AI 服务配置</div>';
    return;
  }
  for (const p of providers) {
    const item = document.createElement('div');
    item.className = 'ai-provider-item' + (p.id === selectedAiProviderId ? ' ai-selected' : '');

    // 状态指示灯
    const statusDot = document.createElement('span');
    statusDot.className = `ai-status-dot ai-status-${p.status}`;

    // 信息区
    const info = document.createElement('div');
    info.className = 'ai-provider-info';

    const nameRow = document.createElement('div');
    nameRow.className = 'ai-provider-name';
    nameRow.textContent = p.name;

    const detailRow = document.createElement('div');
    detailRow.className = 'ai-provider-detail';
    detailRow.textContent = `${p.model} | ${p.apiFormat} | ${p.apiKey}`;

    const sourceRow = document.createElement('div');
    sourceRow.className = 'ai-provider-source';
    sourceRow.textContent = `来源: ${p.source}`;

    info.appendChild(nameRow);
    info.appendChild(detailRow);
    info.appendChild(sourceRow);

    if (p.status === 'fail' && p.errorMsg) {
      const errRow = document.createElement('div');
      errRow.className = 'ai-provider-error';
      errRow.textContent = p.errorMsg;
      info.appendChild(errRow);
    }

    // 选中的 provider 显示模型下拉框
    if (p.id === selectedAiProviderId && p.availableModels && p.availableModels.length > 1) {
      const modelRow = document.createElement('div');
      modelRow.className = 'ai-model-row';
      const modelLabel = document.createElement('span');
      modelLabel.className = 'ai-model-label';
      modelLabel.textContent = '模型:';
      const modelSelect = document.createElement('select');
      modelSelect.className = 'ai-model-select';
      for (const m of p.availableModels) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        if (m === p.model) opt.selected = true;
        modelSelect.appendChild(opt);
      }
      modelSelect.addEventListener('change', () => {
        handleAiSetModel(p.id, modelSelect.value);
      });
      modelRow.appendChild(modelLabel);
      modelRow.appendChild(modelSelect);
      info.appendChild(modelRow);
    }

    // 选择按钮（仅测试通过的可选）
    const selectBtn = document.createElement('button');
    selectBtn.className = 'ai-select-btn';
    if (p.id === selectedAiProviderId) {
      selectBtn.textContent = '已选';
      selectBtn.disabled = true;
    } else if (p.status === 'ok') {
      selectBtn.textContent = '选择';
      selectBtn.addEventListener('click', () => handleAiSelect(p.id));
    } else {
      selectBtn.textContent = '选择';
      selectBtn.disabled = true;
    }

    item.appendChild(statusDot);
    item.appendChild(info);
    item.appendChild(selectBtn);
    aiProviderList.appendChild(item);
  }
}

// ========== 快照功能 ==========

function switchTab(tabName: string): void {
  sidebarTabs.forEach((tab) => {
    tab.classList.toggle('active', tab.getAttribute('data-tab') === tabName);
  });
  tabSessions.classList.toggle('active', tabName === 'sessions');
  tabSnapshots.classList.toggle('active', tabName === 'snapshots');
  tabAiConfig.classList.toggle('active', tabName === 'ai-config');
  if (tabName === 'snapshots') refreshSnapshots();
  if (tabName === 'ai-config') refreshAiConfig();
}

async function refreshSnapshots(): Promise<void> {
  if (!currentCwd) {
    snapshotNotGit.style.display = 'block';
    snapshotNotGit.textContent = '请先选择工作目录';
    snapshotActions.style.display = 'none';
    snapshotListEl.innerHTML = '';
    return;
  }
  const isRepo = await window.duocli.snapshotCheckRepo(currentCwd);
  snapshotNotGit.style.display = isRepo ? 'none' : 'block';
  snapshotActions.style.display = isRepo ? 'block' : 'none';
  if (!isRepo) {
    snapshotListEl.innerHTML = '';
    return;
  }
  const snapshots = await window.duocli.snapshotList(currentCwd);
  renderSnapshotList(snapshots);
}

function snapshotTimeStr(ts: number): string {
  return friendlyTime(ts * 1000);
}

function renderSnapshotList(snapshots: Array<{ id: string; message: string; timestamp: number; fileCount: number }>): void {
  cachedSnapshots = snapshots;
  snapshotListEl.innerHTML = '';
  if (snapshots.length === 0) {
    snapshotListEl.innerHTML = '<div class="snapshot-notice">暂无快照</div>';
    return;
  }
  for (const snap of snapshots) {
    const item = document.createElement('div');
    const revertLabel = revertedSnapshots.get(snap.id);
    item.className = 'snapshot-item' + (snap.id === expandedSnapshotId ? ' expanded' : '') + (revertLabel ? ' reverted' : '');

    const header = document.createElement('div');
    header.className = 'snapshot-header';

    const time = document.createElement('span');
    time.className = 'snapshot-time';
    time.textContent = snapshotTimeStr(snap.timestamp);

    // 已撤销/已还原标签
    if (revertLabel) {
      const badge = document.createElement('span');
      badge.className = 'snapshot-reverted-badge';
      badge.textContent = revertLabel;
      header.appendChild(time);
      header.appendChild(badge);
    } else {
      header.appendChild(time);
    }

    const count = document.createElement('span');
    count.className = 'snapshot-file-count';
    count.textContent = `${snap.fileCount} 文件`;

    header.appendChild(count);

    const msg = document.createElement('div');
    msg.className = 'snapshot-msg';
    msg.textContent = snap.message;

    const filesDiv = document.createElement('div');
    filesDiv.className = 'snapshot-files';

    item.appendChild(header);
    item.appendChild(msg);
    item.appendChild(filesDiv);

    // 点击展开/收起
    header.addEventListener('click', () => toggleSnapshotExpand(snap.id, item, filesDiv));

    // 如果已展开，加载文件列表
    if (snap.id === expandedSnapshotId) {
      loadSnapshotFiles(snap.id, filesDiv);
    }

    snapshotListEl.appendChild(item);
  }
}

function toggleSnapshotExpand(snapId: string, item: HTMLElement, filesDiv: HTMLElement): void {
  if (expandedSnapshotId === snapId) {
    expandedSnapshotId = null;
    item.classList.remove('expanded');
    filesDiv.innerHTML = '';
  } else {
    // 收起之前展开的
    const prev = snapshotListEl.querySelector('.snapshot-item.expanded');
    if (prev) {
      prev.classList.remove('expanded');
      const prevFiles = prev.querySelector('.snapshot-files');
      if (prevFiles) prevFiles.innerHTML = '';
    }
    expandedSnapshotId = snapId;
    item.classList.add('expanded');
    loadSnapshotFiles(snapId, filesDiv);
  }
}

async function loadSnapshotFiles(snapId: string, container: HTMLElement): Promise<void> {
  if (!currentCwd) return;
  container.innerHTML = '<div class="snapshot-notice">加载中...</div>';
  const files = await window.duocli.snapshotFiles(currentCwd, snapId);
  container.innerHTML = '';

  if (files.length === 0) {
    container.innerHTML = '<div class="snapshot-notice">无文件变更</div>';
    return;
  }

  // AI 总结区域
  const summaryDiv = document.createElement('div');
  summaryDiv.className = 'snapshot-summary';
  summaryDiv.textContent = '正在生成总结...';
  container.appendChild(summaryDiv);
  loadSnapshotSummary(snapId, summaryDiv);

  for (const f of files) {
    const wrapper = document.createElement('div');
    wrapper.className = 'snapshot-file-wrapper';

    const row = document.createElement('div');
    row.className = 'snapshot-file-item';

    const status = document.createElement('span');
    status.className = `snapshot-file-status ${f.status}`;
    status.textContent = f.status;

    const pathSpan = document.createElement('span');
    pathSpan.className = 'snapshot-file-path';
    pathSpan.textContent = f.path;
    pathSpan.title = '点击查看 diff';

    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'snapshot-file-restore';
    restoreBtn.textContent = '恢复';
    restoreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleRollbackFile(snapId, f.path, restoreBtn);
    });

    row.appendChild(status);
    row.appendChild(pathSpan);
    row.appendChild(restoreBtn);

    const diffBlock = document.createElement('pre');
    diffBlock.className = 'snapshot-diff-block';
    diffBlock.style.display = 'none';

    // 点击文件行展开/收起 diff
    row.addEventListener('click', () => {
      toggleFileDiff(snapId, f.path, diffBlock, row);
    });

    wrapper.appendChild(row);
    wrapper.appendChild(diffBlock);
    container.appendChild(wrapper);
  }

  // 操作按钮区域
  const actionsDiv = document.createElement('div');
  actionsDiv.className = 'snapshot-actions-group';

  // 撤销本次变更按钮
  const rollbackAllBtn = document.createElement('button');
  rollbackAllBtn.className = 'snapshot-rollback-all';
  rollbackAllBtn.textContent = `撤销本次变更 (${files.length} 个文件)`;
  rollbackAllBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    handleRollbackAll(snapId);
  });

  // 还原到此时刻按钮
  const restoreToBtn = document.createElement('button');
  restoreToBtn.className = 'snapshot-restore-to';
  restoreToBtn.textContent = '还原到此时刻';
  restoreToBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    handleRestoreTo(snapId);
  });

  // 说明文字
  const hintDiv = document.createElement('div');
  hintDiv.className = 'snapshot-actions-hint';
  hintDiv.innerHTML = '<b>撤销本次变更</b>：只回滚这次快照记录的变更文件<br><b>还原到此时刻</b>：把整个项目恢复到这个快照那一刻的完整状态';

  actionsDiv.appendChild(rollbackAllBtn);
  actionsDiv.appendChild(restoreToBtn);
  actionsDiv.appendChild(hintDiv);
  container.appendChild(actionsDiv);
}

// 展开/收起单个文件的 diff
async function toggleFileDiff(snapId: string, filePath: string, diffBlock: HTMLElement, row: HTMLElement): Promise<void> {
  if (diffBlock.style.display === 'block') {
    diffBlock.style.display = 'none';
    row.classList.remove('diff-expanded');
    return;
  }
  if (!currentCwd) return;
  diffBlock.textContent = '加载中...';
  diffBlock.style.display = 'block';
  row.classList.add('diff-expanded');
  try {
    const diff = await window.duocli.snapshotFileDiff(currentCwd, snapId, filePath);
    renderDiffBlock(diffBlock, diff);
  } catch {
    diffBlock.textContent = '(无法获取 diff)';
  }
}

// 渲染 diff 内容（带颜色高亮）
function renderDiffBlock(container: HTMLElement, diff: string): void {
  container.innerHTML = '';
  const lines = diff.split('\n');
  for (const line of lines) {
    const lineEl = document.createElement('div');
    lineEl.className = 'diff-line';
    if (line.startsWith('+') && !line.startsWith('+++')) {
      lineEl.classList.add('diff-add');
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      lineEl.classList.add('diff-del');
    } else if (line.startsWith('@@')) {
      lineEl.classList.add('diff-hunk');
    }
    lineEl.textContent = line;
    container.appendChild(lineEl);
  }
}

// AI 总结快照修改内容
async function loadSnapshotSummary(snapId: string, summaryDiv: HTMLElement): Promise<void> {
  if (!currentCwd) return;
  try {
    const summary = await window.duocli.snapshotSummarize(currentCwd, snapId);
    summaryDiv.textContent = summary;
  } catch {
    summaryDiv.textContent = '(总结生成失败)';
  }
}

async function handleRollbackFile(snapId: string, filePath: string, btn: HTMLElement): Promise<void> {
  if (!currentCwd) return;
  const confirmed = confirm(`确定要恢复文件「${filePath}」到此快照的版本吗？\n当前文件内容将被覆盖。`);
  if (!confirmed) return;
  btn.textContent = '...';
  try {
    await window.duocli.snapshotRollback(currentCwd, snapId, [filePath]);
    btn.textContent = '已恢复';
    setTimeout(() => { btn.textContent = '恢复'; }, 1500);
  } catch {
    btn.textContent = '失败';
    setTimeout(() => { btn.textContent = '恢复'; }, 1500);
  }
}

async function handleRollbackAll(snapId: string): Promise<void> {
  if (!currentCwd) return;
  const confirmed = confirm('确定要回滚所有文件到此快照的版本吗？\n当前工作目录中对应的文件都将被覆盖，此操作不可撤销。');
  if (!confirmed) return;
  try {
    const result = await window.duocli.snapshotRollbackAll(currentCwd, snapId);
    if (result.changed > 0) {
      alert(`已回滚 ${result.total} 个文件（${result.changed} 个已恢复，${result.unchanged} 个无需变更）`);
    } else {
      alert(`${result.total} 个文件内容与回滚目标一致，无需变更`);
    }
    revertedSnapshots.set(snapId, '已撤销');
    await refreshSnapshots();
  } catch {
    alert('回滚失败');
  }
}

async function handleRestoreTo(snapId: string): Promise<void> {
  if (!currentCwd) return;
  const confirmed = confirm('确定要把整个项目还原到此快照的完整状态吗？\n\n这会：\n• 恢复所有文件到快照时的内容\n• 删除快照中不存在的文件\n• 操作前会自动创建备份快照');
  if (!confirmed) return;
  try {
    const result = await window.duocli.snapshotRestoreTo(currentCwd, snapId);
    let msg = `还原完成：共 ${result.total} 个文件`;
    msg += `\n• ${result.changed} 个已恢复`;
    msg += `\n• ${result.unchanged} 个无需变更`;
    if (result.deleted > 0) {
      msg += `\n• ${result.deleted} 个多余文件已删除`;
    }
    if (result.backupCommitId) {
      msg += '\n\n已自动创建还原前备份快照';
    }
    alert(msg);
    // 标记该快照及其上方所有快照为"已还原"
    let found = false;
    for (let i = cachedSnapshots.length - 1; i >= 0; i--) {
      if (cachedSnapshots[i].id === snapId) found = true;
      if (found) revertedSnapshots.set(cachedSnapshots[i].id, '已还原');
    }
    await refreshSnapshots();
  } catch {
    alert('还原失败');
  }
}

// ========== 事件绑定 ==========

cwdBrowseBtn.addEventListener('click', browseCwd);
cwdOpenBtn.addEventListener('click', () => { if (currentCwd) window.duocli.openFolder(currentCwd); });
cwdInput.addEventListener('change', () => { const v = cwdInput.value.trim(); if (v) { currentCwd = v; localStorage.setItem('duocli_cwd', v); startFileWatcher(v); } });
cwdInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') cwdInput.blur(); });
toolbarNewBtn.addEventListener('click', () => { createSession(); });

// Tab 切换
sidebarTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const tabName = tab.getAttribute('data-tab');
    if (tabName) switchTab(tabName);
  });
});

// 手动创建快照
snapshotCreateBtn.addEventListener('click', async () => {
  if (!currentCwd) return;
  snapshotCreateBtn.textContent = '创建中...';
  (snapshotCreateBtn as HTMLButtonElement).disabled = true;
  try {
    await window.duocli.snapshotCreate(currentCwd, '手动快照');
    await refreshSnapshots();
  } catch { /* ignore */ }
  snapshotCreateBtn.textContent = '手动创建快照';
  (snapshotCreateBtn as HTMLButtonElement).disabled = false;
});

// AI 配置按钮
aiScanBtn.addEventListener('click', () => handleAiScan());

// 已归档折叠/展开
archivedHeader.addEventListener('click', () => {
  archivedList.classList.toggle('collapsed');
  archivedToggle.classList.toggle('expanded');
});

// ========== IPC 监听 ==========

window.duocli.onPtyData((id, data) => {
  termManager.write(id, data);
  if (sessionTitles.has(id)) {
    sessionUpdateTimes.set(id, Date.now());
  }
  if (archivedSessions.has(id)) {
    archivedSessions.get(id)!.updateTime = Date.now();
  }
  // 非活跃会话收到数据 → 标记未读
  const activeId = termManager.getActiveId();
  if (id !== activeId && (sessionTitles.has(id) || archivedSessions.has(id))) {
    if (!sessionUnread.has(id)) {
      sessionUnread.add(id);
      renderSessionList();
    }
  }
});

window.duocli.onTitleUpdate((id, title) => {
  if (sessionTitleLocked.has(id)) return;
  if (sessionTitles.has(id)) {
    sessionTitles.set(id, title);
    sessionUpdateTimes.set(id, Date.now());
    renderSessionList();
  }
  if (archivedSessions.has(id)) {
    const info = archivedSessions.get(id)!;
    info.title = title;
    info.updateTime = Date.now();
    renderArchivedList();
  }
});

window.duocli.onPtyExit((id) => {
  sessionTitles.delete(id);
  sessionThemes.delete(id);
  sessionUpdateTimes.delete(id);
  archivedSessions.delete(id);
  sessionUnread.delete(id);
  sessionTitleLocked.delete(id);
  termManager.destroy(id);
  updateEmptyState();
  renderSessionList();
  renderArchivedList();
});

// 监听快照自动创建事件
window.duocli.onSnapshotCreated(() => {
  // 如果当前在快照 Tab，自动刷新列表
  if (tabSnapshots.classList.contains('active')) {
    refreshSnapshots();
  }
});

// 监听文件变化（归到当前活跃会话）
window.duocli.onFileChange((filename) => {
  const idx = globalRecentFiles.indexOf(filename);
  if (idx !== -1) globalRecentFiles.splice(idx, 1);
  globalRecentFiles.unshift(filename);
  if (globalRecentFiles.length > MAX_RECENT_FILES) {
    globalRecentFiles.length = MAX_RECENT_FILES;
  }
  renderFileStatusbar();
});

// 右键状态栏 → 切换编辑器
fileStatusbar.addEventListener('contextmenu', async (e) => {
  e.preventDefault();
  await selectEditor();
});

async function selectEditor(): Promise<void> {
  const editorPath = await window.duocli.filewatcherSelectEditor();
  if (editorPath) {
    currentEditorName = editorPath.split(/[/\\]/).pop()?.replace(/\.(app|exe)$/, '') || editorPath;
    updateEditorStatusbar();
  }
}

function updateEditorStatusbar(): void {
  const icon = document.getElementById('file-statusbar-icon')!;
  if (currentEditorName) {
    icon.title = `编辑器: ${currentEditorName}（右键更换）`;
  } else {
    icon.title = '点击选择编辑器';
  }
}

function renderFileStatusbar(): void {
  fileStatusbarFiles.innerHTML = '';
  const files = globalRecentFiles;
  if (files.length === 0) {
    const placeholder = document.createElement('span');
    placeholder.className = 'file-statusbar-placeholder';
    placeholder.textContent = '等待文件变化...';
    fileStatusbarFiles.appendChild(placeholder);
    return;
  }
  for (const filePath of files) {
    const item = document.createElement('span');
    item.className = 'file-statusbar-item';
    item.textContent = filePath;
    item.title = filePath;
    item.addEventListener('click', async () => {
      if (!currentCwd) return;
      if (!currentEditorName) {
        await selectEditor();
        if (!currentEditorName) return;
      }
      window.duocli.filewatcherOpen(currentCwd + '/' + filePath);
    });
    fileStatusbarFiles.appendChild(item);
  }
}

// 启动时如果已有工作目录，开始监听
if (currentCwd) {
  startFileWatcher(currentCwd);
}

// 启动时加载已保存的编辑器偏好
window.duocli.filewatcherGetEditor().then((editorPath) => {
  if (editorPath) {
    currentEditorName = editorPath.split(/[/\\]/).pop()?.replace(/\.(app|exe)$/, '') || editorPath;
    updateEditorStatusbar();
  }
});

// 每60秒刷新时间显示
setInterval(() => {
  if (sessionTitles.size > 0) renderSessionList();
  if (archivedSessions.size > 0) renderArchivedList();
}, 60000);

// ========== 版权信息交互 ==========

// GitHub 链接
document.getElementById('footer-github')!.addEventListener('click', (e) => {
  e.preventDefault();
  window.duocli.openUrl('https://github.com/saddism/DuoCLI');
});

// 点击提示文字弹出二维码
document.querySelector('.footer-tip')!.addEventListener('click', () => {
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'qrcode-dialog';
  dialog.innerHTML = `
    <img src="qrcode.jpg" class="qrcode-img" />
    <div class="qrcode-text">扫码关注「壮哥的壮」</div>
    <div class="qrcode-sub">心中默念"大壮好大"，祈祷 +1</div>
  `;
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  dialog.addEventListener('click', () => overlay.remove());
});
