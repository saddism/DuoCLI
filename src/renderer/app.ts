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
      setWindowTitle: (title: string) => void;
      createPty: (cwd: string, presetCommand: string, themeId: string) => Promise<{ id: string; title: string; themeId: string; cwd: string; displayName: string }>;
      writePty: (id: string, data: string) => void;
      resizePty: (id: string, cols: number, rows: number) => void;
      destroyPty: (id: string) => void;
      renamePty: (id: string, title: string) => void;
      getSessions: () => Promise<Array<{ id: string; title: string; themeId: string; cwd: string; displayName: string }>>;
      selectFolder: (currentPath?: string) => Promise<string | null>;
      onPtyData: (cb: (id: string, data: string) => void) => void;
      onTitleUpdate: (cb: (id: string, title: string) => void) => void;
      onPtyExit: (cb: (id: string) => void) => void;
      onRemoteCreated: (cb: (sessionInfo: { id: string; title: string; themeId: string; cwd: string; displayName: string }) => void) => void;
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
      // 会话历史 API
      sessionHistoryInit: (sessionId: string, title: string) => Promise<string>;
      sessionHistoryAppend: (sessionId: string, data: string) => void;
      sessionHistoryFlush: (sessionId: string) => Promise<void>;
      sessionHistoryFinish: (sessionId: string) => Promise<void>;
      sessionHistoryRename: (sessionId: string, newTitle: string) => Promise<void>;
      sessionHistoryList: () => Promise<Array<{ filename: string; size: number; mtime: number }>>;
      sessionHistoryRead: (filename: string) => Promise<string>;
      sessionHistoryDelete: (filename: string) => Promise<void>;
      sessionHistorySummarize: (filename: string) => Promise<string>;
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
// 会话工作目录
const sessionCwds: Map<string, string> = new Map();
// 会话显示名称（如 Claude全自动、Codex 等）
const sessionDisplayNames: Map<string, string> = new Map();
// 归档：终端进程仍在运行，只是从活跃列表隐藏
const archivedSessions: Map<string, { title: string; themeId: string; updateTime: number; cwd: string; displayName: string }> = new Map();

// ========== 自定义预设 ==========

interface CustomPreset {
  id: string;
  name: string;
  command: string;
  autoFlag: string;
}

const CUSTOM_PRESETS_KEY = 'duocli_custom_presets';
let customPresetNextId = 1;

function getCustomPresets(): CustomPreset[] {
  try { return JSON.parse(localStorage.getItem(CUSTOM_PRESETS_KEY) || '[]'); } catch { return []; }
}

function saveCustomPresets(list: CustomPreset[]): void {
  localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(list));
}

// 内置 option 的 HTML（从 index.html 中提取，作为 renderPresetSelect 的基础）
const BUILTIN_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '空终端' },
  { value: 'claude', label: 'Claude' },
  { value: 'claude --dangerously-skip-permissions', label: 'Claude (全自动)' },
  { value: 'codex', label: 'Codex' },
  { value: 'codex --full-auto', label: 'Codex (全自动)' },
  { value: 'kimi', label: 'Kimi' },
  { value: 'kimi --yolo', label: 'Kimi (全自动)' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'agent', label: 'Cursor (agent)' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'gemini --yolo', label: 'Gemini (全自动)' },
];

function renderPresetSelect(): void {
  const prev = presetSelect.value;
  presetSelect.innerHTML = '';

  // 内置选项
  for (const opt of BUILTIN_OPTIONS) {
    const el = document.createElement('option');
    el.value = opt.value;
    el.textContent = opt.label;
    presetSelect.appendChild(el);
  }

  // 自定义预设
  const customs = getCustomPresets();
  if (customs.length > 0) {
    const sep = document.createElement('option');
    sep.disabled = true;
    sep.textContent = '── 自定义 ──';
    presetSelect.appendChild(sep);

    for (const p of customs) {
      const el = document.createElement('option');
      el.value = p.command;
      el.textContent = p.name;
      presetSelect.appendChild(el);

      if (p.autoFlag) {
        const autoEl = document.createElement('option');
        autoEl.value = p.command + ' ' + p.autoFlag;
        autoEl.textContent = p.name + ' (全自动)';
        presetSelect.appendChild(autoEl);
      }
    }
  }

  // 恢复之前的选中值
  presetSelect.value = prev;
  // 如果之前的值不存在了，回退到空终端
  if (presetSelect.selectedIndex === -1) presetSelect.value = '';
}

function showPresetDialog(preset?: CustomPreset): Promise<CustomPreset | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog';

    const isEdit = !!preset;
    dialog.innerHTML = `
      <h3>${isEdit ? '编辑' : '新建'}自定义 CLI 预设</h3>
      <div class="preset-form">
        <div class="preset-form-field">
          <label>名称</label>
          <input type="text" id="preset-name-input" placeholder="如 Aider、Cursor 等" value="${preset?.name || ''}" />
        </div>
        <div class="preset-form-field">
          <label>命令</label>
          <input type="text" id="preset-cmd-input" placeholder="如 aider、cursor 等" value="${preset?.command || ''}" />
        </div>
        <div class="preset-form-field">
          <label>全自动参数（可选）</label>
          <input type="text" id="preset-auto-input" placeholder="如 --yes、--yolo 等，留空表示无全自动模式" value="${preset?.autoFlag || ''}" />
        </div>
      </div>
      <div class="confirm-buttons" style="margin-top:16px">
        <button class="btn-cancel">取消</button>
        <button class="btn-close-confirm" style="background:var(--accent)">保存</button>
      </div>`;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const nameInput = dialog.querySelector('#preset-name-input') as HTMLInputElement;
    const cmdInput = dialog.querySelector('#preset-cmd-input') as HTMLInputElement;
    const autoInput = dialog.querySelector('#preset-auto-input') as HTMLInputElement;

    nameInput.focus();

    const cleanup = (result: CustomPreset | null) => { overlay.remove(); resolve(result); };

    dialog.querySelector('.btn-cancel')!.addEventListener('click', () => cleanup(null));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(null); });

    dialog.querySelector('.btn-close-confirm')!.addEventListener('click', () => {
      const name = nameInput.value.trim();
      const command = cmdInput.value.trim();
      if (!name || !command) {
        nameInput.style.borderColor = name ? '' : 'var(--danger)';
        cmdInput.style.borderColor = command ? '' : 'var(--danger)';
        return;
      }
      const id = preset?.id || `custom-${customPresetNextId++}`;
      cleanup({ id, name, command, autoFlag: autoInput.value.trim() });
    });

    // Enter 键保存
    const handleEnter = (e: KeyboardEvent) => {
      if (e.key === 'Enter') dialog.querySelector<HTMLButtonElement>('.btn-close-confirm')!.click();
      if (e.key === 'Escape') cleanup(null);
    };
    nameInput.addEventListener('keydown', handleEnter);
    cmdInput.addEventListener('keydown', handleEnter);
    autoInput.addEventListener('keydown', handleEnter);
  });
}

function showPresetManageDialog(): void {
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'confirm-dialog';
  dialog.style.minWidth = '360px';

  function render() {
    const customs = getCustomPresets();
    dialog.innerHTML = `<h3>管理自定义预设</h3>`;

    const listEl = document.createElement('div');
    listEl.className = 'preset-manage-list';

    if (customs.length === 0) {
      listEl.innerHTML = '<div class="preset-manage-empty">暂无自定义预设，点击工具栏 "+" 按钮新建</div>';
    } else {
      for (const p of customs) {
        const item = document.createElement('div');
        item.className = 'preset-manage-item';

        const info = document.createElement('div');
        info.className = 'preset-manage-item-info';
        const nameEl = document.createElement('div');
        nameEl.className = 'preset-manage-item-name';
        nameEl.textContent = p.name;
        const cmdEl = document.createElement('div');
        cmdEl.className = 'preset-manage-item-cmd';
        cmdEl.textContent = p.command + (p.autoFlag ? ` (全自动: ${p.autoFlag})` : '');
        info.appendChild(nameEl);
        info.appendChild(cmdEl);

        const actions = document.createElement('div');
        actions.className = 'preset-manage-item-actions';

        const editBtn = document.createElement('button');
        editBtn.textContent = '编辑';
        editBtn.addEventListener('click', async () => {
          const edited = await showPresetDialog(p);
          if (edited) {
            const list = getCustomPresets();
            const idx = list.findIndex(x => x.id === p.id);
            if (idx !== -1) { list[idx] = edited; saveCustomPresets(list); }
            renderPresetSelect();
            render();
          }
        });

        const delBtn = document.createElement('button');
        delBtn.className = 'danger';
        delBtn.textContent = '删除';
        delBtn.addEventListener('click', () => {
          const list = getCustomPresets().filter(x => x.id !== p.id);
          saveCustomPresets(list);
          renderPresetSelect();
          render();
        });

        actions.appendChild(editBtn);
        actions.appendChild(delBtn);
        item.appendChild(info);
        item.appendChild(actions);
        listEl.appendChild(item);
      }
    }

    dialog.appendChild(listEl);

    const btns = document.createElement('div');
    btns.className = 'confirm-buttons';
    btns.style.marginTop = '16px';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn-cancel';
    closeBtn.textContent = '关闭';
    closeBtn.addEventListener('click', () => overlay.remove());
    btns.appendChild(closeBtn);
    dialog.appendChild(btns);
  }

  render();
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// 初始化自定义预设 ID 计数器
(function initCustomPresetId() {
  const customs = getCustomPresets();
  for (const p of customs) {
    const m = p.id.match(/^custom-(\d+)$/);
    if (m) customPresetNextId = Math.max(customPresetNextId, parseInt(m[1]) + 1);
  }
})();

// 最近工作目录
const RECENT_CWD_KEY = 'duocli_recent_cwds';
const MAX_RECENT_CWDS = 8;

function getRecentCwds(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_CWD_KEY) || '[]'); } catch { return []; }
}

function addRecentCwd(cwd: string): void {
  const list = getRecentCwds().filter(p => p !== cwd);
  list.unshift(cwd);
  if (list.length > MAX_RECENT_CWDS) list.length = MAX_RECENT_CWDS;
  localStorage.setItem(RECENT_CWD_KEY, JSON.stringify(list));
}

// DOM 元素
const cwdInput = document.getElementById('cwd-input') as HTMLInputElement;
const cwdBrowseBtn = document.getElementById('cwd-browse-btn')!;
const cwdOpenBtn = document.getElementById('cwd-open-btn')!;
const cwdRecentBtn = document.getElementById('cwd-recent-btn')!;
const cwdRecentDropdown = document.getElementById('cwd-recent-dropdown')!;
const presetSelect = document.getElementById('preset-select') as HTMLSelectElement;
const presetAddBtn = document.getElementById('preset-add-btn')!;
const presetManageBtn = document.getElementById('preset-manage-btn')!;
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
const sessionTitleText = document.getElementById('session-title-text')!;

// 历史对话 DOM
const historyHeader = document.getElementById('history-header')!;
const historyToggle = document.getElementById('history-toggle')!;
const historyList = document.getElementById('history-list')!;
const historyCount = document.getElementById('history-count')!;

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

// 未读消息状态（绿点：AI 完成工作，等待输入）
const sessionUnread: Set<string> = new Set();
// 工作中状态（黄点：AI 正在输出）
const sessionBusy: Set<string> = new Set();
// 未读延迟计时器（静默超时检测）
const unreadTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
// 最近收到的数据缓冲（用于提示符检测）
const recentDataBuffer: Map<string, string> = new Map();
// 手动改过标题的会话（不再自动更新）
const sessionTitleLocked: Set<string> = new Set();
// 置顶会话
const pinnedSessions: Set<string> = new Set();

// 会话历史 buffer 刷盘
const historyFlushTimers: Map<string, ReturnType<typeof setInterval>> = new Map();

// 终端管理器
const termManager = new TerminalManager(terminalContent, (id, cols, rows) => {
  window.duocli.resizePty(id, cols, rows);
});

// 恢复上次的工作目录和预设命令
if (savedCwd) {
  cwdInput.value = savedCwd;
}
// 初始化 preset select（含自定义预设），然后恢复上次选中
renderPresetSelect();
if (lastPreset) {
  presetSelect.value = lastPreset;
}

// 自定义配色下拉组件
const themeColorMap: Record<string, string> = {
  'auto': '',
  'vscode-dark': '#0078d4',
  'monokai': '#a6e22e',
  'dracula': '#bd93f9',
  'solarized-dark': '#268bd2',
  'one-dark': '#61afef',
  'nord': '#88c0d0',
};
let currentThemeId = 'auto';

function setThemeValue(value: string): void {
  currentThemeId = value;
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

// ========== CLI 标签颜色 ==========

// 已知 CLI → 固定颜色（文字色, 背景色）
const CLI_TAG_COLORS: Record<string, [string, string]> = {
  'Claude':       ['#d4a574', '#3d2e1e'],
  'Claude全自动':  ['#e5a100', '#3d3010'],
  'Codex':        ['#73c991', '#1e3328'],
  'Codex全自动':   ['#56d4a0', '#1a3d2e'],
  'Kimi':         ['#c678dd', '#2e1e3d'],
  'Kimi全自动':    ['#d19ae8', '#33204a'],
  'OpenCode':     ['#61afef', '#1e2e3d'],
  'Cursor':       ['#56b6c2', '#1e3338'],
  'Gemini':       ['#82aaff', '#1e2540'],
  'Gemini全自动':  ['#99bbff', '#222d4a'],
};

function getCliTagColors(displayName: string): [string, string] {
  // 精确匹配
  if (CLI_TAG_COLORS[displayName]) return CLI_TAG_COLORS[displayName];
  // 前缀匹配（自定义预设的"全自动"变体）
  for (const key of Object.keys(CLI_TAG_COLORS)) {
    if (displayName.startsWith(key)) return CLI_TAG_COLORS[key];
  }
  // 未知 CLI：用 hash 从色板中选一个
  let h = 0;
  for (let i = 0; i < displayName.length; i++) {
    h = ((h << 5) - h + displayName.charCodeAt(i)) | 0;
  }
  const palette: Array<[string, string]> = [
    ['#e06c75', '#3d1e22'], ['#e5c07b', '#3d3520'], ['#98c379', '#253320'],
    ['#f78c6c', '#3d2518'], ['#c792ea', '#2e1e3d'], ['#ff5370', '#3d1825'],
  ];
  return palette[Math.abs(h) % palette.length];
}

// ========== 路径自动颜色 ==========

// 高区分度色板（12 色，HSL 均匀分布，饱和度高）
const PATH_COLORS = [
  '#e06c75', '#e5c07b', '#98c379', '#56b6c2',
  '#61afef', '#c678dd', '#f78c6c', '#d19a66',
  '#7ec699', '#82aaff', '#c792ea', '#ff5370',
];

function cwdToColor(cwd: string): string {
  if (!cwd) return PATH_COLORS[0];
  let hash = 0;
  for (let i = 0; i < cwd.length; i++) {
    hash = ((hash << 5) - hash + cwd.charCodeAt(i)) | 0;
  }
  return PATH_COLORS[Math.abs(hash) % PATH_COLORS.length];
}

// 取路径最后一段作为项目名
function cwdShortName(cwd: string): string {
  if (!cwd) return '未知项目';
  const parts = cwd.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || cwd;
}

// 自动配色：根据 cwd 映射到一个实际主题，尽量让不同项目分配到不同主题
const AUTO_THEME_LIST = ['vscode-dark', 'monokai', 'dracula', 'solarized-dark', 'one-dark', 'nord'];
const autoThemeCache: Map<string, string> = new Map(); // cwd → themeId

function cwdHash(cwd: string): number {
  let h = 0;
  for (let i = 0; i < cwd.length; i++) {
    h = ((h << 5) - h + cwd.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function cwdToThemeId(cwd: string): string {
  if (!cwd) return AUTO_THEME_LIST[0];
  const cached = autoThemeCache.get(cwd);
  if (cached) return cached;

  // 已被占用的主题
  const usedThemes = new Set(autoThemeCache.values());
  // 优先选未被占用的主题
  const available = AUTO_THEME_LIST.filter(t => !usedThemes.has(t));
  const hash = cwdHash(cwd);
  let theme: string;
  if (available.length > 0) {
    theme = available[hash % available.length];
  } else {
    theme = AUTO_THEME_LIST[hash % AUTO_THEME_LIST.length];
  }
  autoThemeCache.set(cwd, theme);
  return theme;
}

// 解析实际 themeId：auto 时根据 cwd 决定
function resolveThemeId(themeId: string, cwd: string): string {
  return themeId === 'auto' ? cwdToThemeId(cwd) : themeId;
}

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

function updateSessionTitleBar(): void {
  const activeId = termManager.getActiveId();
  if (activeId) {
    const cwd = sessionCwds.get(activeId) || '';
    // 左上角标题条：显示当前终端工作目录
    sessionTitleText.textContent = cwd || 'DuoCLI';
    sessionTitleText.title = cwd || '';
    // macOS 系统窗口标题：保留完整信息
    const title = sessionTitles.get(activeId) || '';
    const displayName = sessionDisplayNames.get(activeId) || '';
    const parts = ['DuoCLI'];
    if (displayName) parts.push(displayName);
    if (title && title !== '新会话') parts.push(title);
    window.duocli.setWindowTitle(parts.join('-'));
  } else {
    sessionTitleText.textContent = '';
    sessionTitleText.title = '';
    window.duocli.setWindowTitle('DuoCLI');
  }
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
  let committed = false;
  const commit = () => {
    if (committed) return;
    committed = true;
    const val = input.value.trim();
    if (val && val !== current) {
      sessionTitles.set(id, val);
      sessionTitleLocked.add(id);
      window.duocli.renamePty(id, val);
      window.duocli.sessionHistoryRename(id, val);
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

  // pinned 优先，再按创建顺序倒序
  const allIds = Array.from(sessionTitles.keys()).reverse();
  const sortedIds = [
    ...allIds.filter(id => pinnedSessions.has(id)),
    ...allIds.filter(id => !pinnedSessions.has(id)),
  ];

  // 按 cwd 分组（保持排序顺序）
  const groups: Map<string, string[]> = new Map();
  for (const id of sortedIds) {
    const cwd = sessionCwds.get(id) || '';
    if (!groups.has(cwd)) groups.set(cwd, []);
    groups.get(cwd)!.push(id);
  }

  for (const [cwd, ids] of groups) {
    const color = cwdToColor(cwd);

    // 分组头
    const groupHeader = document.createElement('div');
    groupHeader.className = 'session-group-header';
    groupHeader.style.borderLeftColor = color;
    const groupName = document.createElement('span');
    groupName.className = 'session-group-name';
    groupName.textContent = cwdShortName(cwd);
    groupName.title = cwd;
    const groupCount = document.createElement('span');
    groupCount.className = 'session-group-count';
    groupCount.textContent = String(ids.length);
    groupHeader.appendChild(groupName);
    groupHeader.appendChild(groupCount);
    sessionList.appendChild(groupHeader);

    // 该组下的会话
    for (const id of ids) {
      const title = sessionTitles.get(id)!;
      const isPinned = pinnedSessions.has(id);
      const item = document.createElement('div');
      item.className = 'session-item' + (id === activeId ? ' active' : '') + (isPinned ? ' pinned' : '');
      // 路径颜色通过 CSS 变量传递，避免内联样式覆盖 active 背景
      item.style.setProperty('--group-color', color + '12');

      const dot = document.createElement('span');
      dot.className = 'session-color-dot';
      if (sessionUnread.has(id)) {
        dot.style.backgroundColor = '#73c991';
      } else if (sessionBusy.has(id)) {
        dot.style.backgroundColor = '#e5a100';
      } else {
        dot.style.backgroundColor = '#666';
      }

      const pinBtn = document.createElement('button');
      pinBtn.className = 'session-pin' + (isPinned ? ' pinned' : '');
      pinBtn.textContent = '\u{1F4CC}';
      pinBtn.title = isPinned ? '取消置顶' : '置顶';
      pinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (pinnedSessions.has(id)) pinnedSessions.delete(id);
        else pinnedSessions.add(id);
        renderSessionList();
      });

      const titleSpan = document.createElement('span');
      titleSpan.className = 'session-title';
      titleSpan.textContent = title;
      titleSpan.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startTitleEdit(id, titleSpan);
      });

      const metaRow = document.createElement('div');
      metaRow.className = 'session-meta-row';
      const timeSpan = document.createElement('span');
      timeSpan.className = 'session-time';
      timeSpan.textContent = friendlyTime(sessionUpdateTimes.get(id) || Date.now());
      metaRow.appendChild(timeSpan);
      const displayName = sessionDisplayNames.get(id);
      if (displayName) {
        const nameSpan = document.createElement('span');
        nameSpan.className = 'session-display-name';
        nameSpan.textContent = displayName;
        const [tagColor, tagBg] = getCliTagColors(displayName);
        nameSpan.style.setProperty('--cli-tag-color', tagColor);
        nameSpan.style.setProperty('--cli-tag-bg', tagBg);
        metaRow.appendChild(nameSpan);
      }

      const infoWrap = document.createElement('div');
      infoWrap.className = 'session-info';
      infoWrap.appendChild(titleSpan);
      infoWrap.appendChild(metaRow);

      const closeBtn = document.createElement('button');
      closeBtn.className = 'session-close';
      closeBtn.textContent = '\u00d7';
      closeBtn.addEventListener('click', (e) => { e.stopPropagation(); handleCloseClick(id); });

      item.addEventListener('click', () => switchSession(id));
      item.appendChild(dot);
      item.appendChild(pinBtn);
      item.appendChild(infoWrap);
      item.appendChild(closeBtn);
      sessionList.appendChild(item);
    }
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
  const themeId = resolveThemeId(currentThemeId, currentCwd);
  lastPreset = preset;
  localStorage.setItem('duocli_preset', preset);
  const result = await window.duocli.createPty(currentCwd, preset, themeId);
  sessionTitles.set(result.id, result.title);
  sessionThemes.set(result.id, result.themeId);
  sessionUpdateTimes.set(result.id, Date.now());
  sessionCwds.set(result.id, result.cwd);
  sessionDisplayNames.set(result.id, result.displayName);
  // 自定义预设：用用户定义的名称覆盖后端 fallback
  const customPreset = getCustomPresets().find(p =>
    preset === p.command || (p.autoFlag && preset === p.command + ' ' + p.autoFlag)
  );
  if (customPreset) {
    const isAuto = customPreset.autoFlag && preset === customPreset.command + ' ' + customPreset.autoFlag;
    const displayName = isAuto ? customPreset.name + '全自动' : customPreset.name;
    sessionDisplayNames.set(result.id, displayName);
  }
  // 初始化会话历史记录
  window.duocli.sessionHistoryInit(result.id, result.title);
  const flushTimer = setInterval(() => {
    window.duocli.sessionHistoryFlush(result.id);
  }, 2000);
  historyFlushTimers.set(result.id, flushTimer);
  termManager.create(result.id, result.themeId, currentCwd, (data) => { window.duocli.writePty(result.id, data); });
  updateEmptyState();
  renderSessionList();
  updateSessionTitleBar();
  setTimeout(() => {
    const dims = termManager.getActiveDimensions();
    if (dims) window.duocli.resizePty(result.id, dims.cols, dims.rows);
  }, 100);
}

function switchSession(id: string): void {
  const prev = termManager.getActiveId();
  termManager.switchTo(id);
  // 只清除"等待输入"（绿点），不清除"工作中"（黄点）
  // 用户查看了就不算未读，但工作中状态应由数据流驱动
  const hadUnread = sessionUnread.delete(id);
  // 切换到不同会话才重渲染列表，避免重建 DOM 导致 dblclick 无法触发
  if (prev !== id || hadUnread) renderSessionList();
  updateSessionTitleBar();
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
  const cwd = sessionCwds.get(id) || '';
  const displayName = sessionDisplayNames.get(id) || '';
  archivedSessions.set(id, { title, themeId, updateTime, cwd, displayName });
  sessionTitles.delete(id);
  sessionThemes.delete(id);
  sessionUpdateTimes.delete(id);
  sessionCwds.delete(id);
  sessionDisplayNames.delete(id);
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
  if (info.cwd) sessionCwds.set(id, info.cwd);
  if (info.displayName) sessionDisplayNames.set(id, info.displayName);
  sessionUnread.delete(id);
  sessionBusy.delete(id);
  clearTimeout(unreadTimers.get(id));
  unreadTimers.delete(id);
  recentDataBuffer.delete(id);
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
  // 结束会话历史记录
  const flushTimer = historyFlushTimers.get(id);
  if (flushTimer) { clearInterval(flushTimer); historyFlushTimers.delete(id); }
  window.duocli.sessionHistoryFinish(id);
  window.duocli.destroyPty(id);
  sessionTitles.delete(id);
  sessionThemes.delete(id);
  sessionUpdateTimes.delete(id);
  archivedSessions.delete(id);
  sessionUnread.delete(id);
  sessionBusy.delete(id);
  clearTimeout(unreadTimers.get(id));
  unreadTimers.delete(id);
  recentDataBuffer.delete(id);
  sessionTitleLocked.delete(id);
  pinnedSessions.delete(id);
  sessionCwds.delete(id);
  sessionDisplayNames.delete(id);
  termManager.destroy(id);
  updateEmptyState();
  renderSessionList();
  renderArchivedList();
  updateSessionTitleBar();
  // 刷新历史对话列表
  if (!historyList.classList.contains('collapsed')) refreshHistory();
}

async function browseCwd(): Promise<void> {
  const folder = await window.duocli.selectFolder(currentCwd || undefined);
  if (folder) { currentCwd = folder; cwdInput.value = folder; localStorage.setItem('duocli_cwd', folder); addRecentCwd(folder); startFileWatcher(folder); }
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

// ========== 历史对话 ==========

async function refreshHistory(): Promise<void> {
  const items = await window.duocli.sessionHistoryList();
  historyCount.textContent = String(items.length);
  historyList.innerHTML = '';
  if (items.length === 0) {
    historyList.innerHTML = '<div class="snapshot-notice">暂无历史对话</div>';
    return;
  }
  for (const item of items) {
    const title = item.filename.replace(/_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.txt$/, '').replace(/_/g, ' ');
    const el = document.createElement('div');
    el.className = 'history-item';

    const titleEl = document.createElement('div');
    titleEl.className = 'history-item-title';
    titleEl.textContent = title;

    const metaEl = document.createElement('div');
    metaEl.className = 'history-item-meta';
    const sizeKB = (item.size / 1024).toFixed(1);
    metaEl.textContent = `${friendlyTime(item.mtime)} · ${sizeKB} KB`;

    const actionsEl = document.createElement('div');
    actionsEl.className = 'history-item-actions';

    const viewBtn = document.createElement('button');
    viewBtn.className = 'history-action-btn';
    viewBtn.textContent = '查看全文';
    viewBtn.addEventListener('click', (e) => { e.stopPropagation(); showHistoryDialog(item.filename, title); });

    const copyBtn = document.createElement('button');
    copyBtn.className = 'history-action-btn';
    copyBtn.textContent = '复制';
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const content = await window.duocli.sessionHistoryRead(item.filename);
      navigator.clipboard.writeText(content);
      copyBtn.textContent = '已复制';
      setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'history-action-btn danger';
    delBtn.textContent = '删除';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.duocli.sessionHistoryDelete(item.filename);
      refreshHistory();
    });

    actionsEl.appendChild(viewBtn);
    actionsEl.appendChild(copyBtn);
    actionsEl.appendChild(delBtn);
    el.appendChild(titleEl);
    el.appendChild(metaEl);
    el.appendChild(actionsEl);

    el.addEventListener('click', () => showHistoryDialog(item.filename, title));
    historyList.appendChild(el);
  }
}

async function showHistoryDialog(filename: string, title: string): Promise<void> {
  const content = await window.duocli.sessionHistoryRead(filename);
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'history-dialog';

  // 头部
  const header = document.createElement('div');
  header.className = 'history-dialog-header';
  const titleEl = document.createElement('span');
  titleEl.className = 'history-dialog-title';
  titleEl.textContent = title;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'history-dialog-close';
  closeBtn.textContent = '\u00d7';
  closeBtn.addEventListener('click', () => overlay.remove());
  header.appendChild(titleEl);
  header.appendChild(closeBtn);

  // 总结区域（初始隐藏）
  const summaryBox = document.createElement('div');
  summaryBox.className = 'history-summary-box';
  summaryBox.style.display = 'none';

  // 操作按钮
  const actions = document.createElement('div');
  actions.className = 'history-dialog-actions';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'toolbar-btn';
  copyBtn.textContent = '复制全文';
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(content);
    copyBtn.textContent = '已复制';
    setTimeout(() => { copyBtn.textContent = '复制全文'; }, 1500);
  });

  const summarizeBtn = document.createElement('button');
  summarizeBtn.className = 'toolbar-btn';
  summarizeBtn.style.background = '#e5a100';
  summarizeBtn.textContent = 'AI 总结';
  summarizeBtn.addEventListener('click', async () => {
    summaryBox.style.display = 'block';
    summaryBox.textContent = '正在生成总结...';
    summarizeBtn.textContent = '总结中...';
    (summarizeBtn as HTMLButtonElement).disabled = true;
    try {
      const summary = await window.duocli.sessionHistorySummarize(filename);
      summaryBox.textContent = summary || '(无法生成总结)';
    } catch {
      summaryBox.textContent = '(总结生成失败)';
    }
    summarizeBtn.textContent = 'AI 总结';
    (summarizeBtn as HTMLButtonElement).disabled = false;
  });

  actions.appendChild(copyBtn);
  actions.appendChild(summarizeBtn);

  // 内容区域
  const contentEl = document.createElement('div');
  contentEl.className = 'history-dialog-content';
  contentEl.textContent = content;

  dialog.appendChild(header);
  dialog.appendChild(summaryBox);
  dialog.appendChild(actions);
  dialog.appendChild(contentEl);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
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

// 最近工作目录下拉
function renderRecentCwdDropdown(): void {
  cwdRecentDropdown.innerHTML = '';
  const list = getRecentCwds();
  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'cwd-recent-empty';
    empty.textContent = '暂无最近目录';
    cwdRecentDropdown.appendChild(empty);
    return;
  }
  for (const path of list) {
    const item = document.createElement('div');
    item.className = 'cwd-recent-item';
    item.textContent = path;
    item.title = path;
    item.addEventListener('click', () => {
      currentCwd = path;
      cwdInput.value = path;
      localStorage.setItem('duocli_cwd', path);
      addRecentCwd(path);
      startFileWatcher(path);
      cwdRecentDropdown.classList.remove('open');
    });
    cwdRecentDropdown.appendChild(item);
  }
}

cwdRecentBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const isOpen = cwdRecentDropdown.classList.contains('open');
  if (isOpen) {
    cwdRecentDropdown.classList.remove('open');
  } else {
    renderRecentCwdDropdown();
    cwdRecentDropdown.classList.add('open');
  }
});

document.addEventListener('click', () => {
  cwdRecentDropdown.classList.remove('open');
});
cwdRecentDropdown.addEventListener('click', (e) => { e.stopPropagation(); });
cwdInput.addEventListener('change', () => { const v = cwdInput.value.trim(); if (v) { currentCwd = v; localStorage.setItem('duocli_cwd', v); addRecentCwd(v); startFileWatcher(v); } });
cwdInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') cwdInput.blur(); });
toolbarNewBtn.addEventListener('click', () => { createSession(); });

// 自定义预设按钮
presetAddBtn.addEventListener('click', async () => {
  const result = await showPresetDialog();
  if (result) {
    const list = getCustomPresets();
    list.push(result);
    saveCustomPresets(list);
    renderPresetSelect();
    // 自动选中新建的预设
    presetSelect.value = result.command;
  }
});

presetManageBtn.addEventListener('click', () => {
  showPresetManageDialog();
});

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

// 历史对话折叠/展开
historyHeader.addEventListener('click', () => {
  const wasCollapsed = historyList.classList.contains('collapsed');
  historyList.classList.toggle('collapsed');
  historyToggle.classList.toggle('expanded');
  if (wasCollapsed) refreshHistory();
});

// ========== IPC 监听 ==========

window.duocli.onPtyData((id, data) => {
  termManager.write(id, data);
  // 追加到会话历史 buffer
  window.duocli.sessionHistoryAppend(id, data);
  if (sessionTitles.has(id)) {
    sessionUpdateTimes.set(id, Date.now());
  }
  if (archivedSessions.has(id)) {
    archivedSessions.get(id)!.updateTime = Date.now();
  }
  // 所有会话都追踪状态（工作中/等待输入），确保切换查看后状态不丢失
  const activeId = termManager.getActiveId();
  if (sessionTitles.has(id) || archivedSessions.has(id)) {
    // 标记为工作中（黄点）
    if (!sessionUnread.has(id) && !sessionBusy.has(id)) {
      sessionBusy.add(id);
      if (id !== activeId) renderSessionList();
    }

    // 累积最近数据用于提示符检测（保留最后 500 字符）
    const prev = recentDataBuffer.get(id) || '';
    recentDataBuffer.set(id, (prev + data).slice(-500));

    // 去掉 ANSI 转义后检测 AI CLI 提示符
    const plain = recentDataBuffer.get(id)!.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
    const hasPrompt = /[❯›\$>]\s*$/.test(plain.trimEnd());

    if (hasPrompt) {
      // 检测到提示符 → 从工作中转为等待输入（黄→绿）
      clearTimeout(unreadTimers.get(id));
      unreadTimers.delete(id);
      recentDataBuffer.delete(id);
      sessionBusy.delete(id);
      // 当前活跃会话不标绿点（用户正在看着）
      if (id !== activeId && !sessionUnread.has(id)) {
        sessionUnread.add(id);
      }
      if (id !== activeId) renderSessionList();
    } else {
      // 未检测到提示符 → 重置静默计时器（5 秒无新数据后转为等待输入）
      clearTimeout(unreadTimers.get(id));
      unreadTimers.set(id, setTimeout(() => {
        unreadTimers.delete(id);
        recentDataBuffer.delete(id);
        sessionBusy.delete(id);
        const currentActiveId = termManager.getActiveId();
        if (id !== currentActiveId && !sessionUnread.has(id)) {
          sessionUnread.add(id);
        }
        renderSessionList();
      }, 5000));
    }
  }
});

window.duocli.onTitleUpdate((id, title) => {
  if (sessionTitleLocked.has(id)) return;
  if (sessionTitles.has(id)) {
    sessionTitles.set(id, title);
    sessionUpdateTimes.set(id, Date.now());
    renderSessionList();
    updateSessionTitleBar();
    // 同步重命名历史文件
    window.duocli.sessionHistoryRename(id, title);
  }
  if (archivedSessions.has(id)) {
    const info = archivedSessions.get(id)!;
    info.title = title;
    info.updateTime = Date.now();
    renderArchivedList();
  }
});

window.duocli.onPtyExit((id) => {
  // 结束会话历史记录
  const flushTimer = historyFlushTimers.get(id);
  if (flushTimer) { clearInterval(flushTimer); historyFlushTimers.delete(id); }
  window.duocli.sessionHistoryFinish(id);
  sessionTitles.delete(id);
  sessionThemes.delete(id);
  sessionUpdateTimes.delete(id);
  archivedSessions.delete(id);
  sessionUnread.delete(id);
  sessionBusy.delete(id);
  clearTimeout(unreadTimers.get(id));
  unreadTimers.delete(id);
  recentDataBuffer.delete(id);
  sessionTitleLocked.delete(id);
  pinnedSessions.delete(id);
  sessionCwds.delete(id);
  sessionDisplayNames.delete(id);
  termManager.destroy(id);
  updateEmptyState();
  renderSessionList();
  renderArchivedList();
  updateSessionTitleBar();
  if (!historyList.classList.contains('collapsed')) refreshHistory();
});

// 手机端远程创建了会话，桌面端同步显示
window.duocli.onRemoteCreated((info) => {
  sessionTitles.set(info.id, info.title);
  sessionThemes.set(info.id, info.themeId);
  sessionUpdateTimes.set(info.id, Date.now());
  sessionCwds.set(info.id, info.cwd);
  sessionDisplayNames.set(info.id, info.displayName);
  // 初始化会话历史
  window.duocli.sessionHistoryInit(info.id, info.title);
  const flushTimer = setInterval(() => {
    window.duocli.sessionHistoryFlush(info.id);
  }, 2000);
  historyFlushTimers.set(info.id, flushTimer);
  // 创建 xterm 实例（桌面端也能看到和操作）
  termManager.create(info.id, info.themeId, info.cwd, (data) => { window.duocli.writePty(info.id, data); });
  updateEmptyState();
  renderSessionList();
  updateSessionTitleBar();
  setTimeout(() => {
    const dims = termManager.getActiveDimensions();
    if (dims) window.duocli.resizePty(info.id, dims.cols, dims.rows);
  }, 100);
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
