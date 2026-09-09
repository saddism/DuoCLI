// DuoCLI Mobile PWA - 客户端逻辑 (xterm.js + WebSocket)

const API = location.origin;

// 从 URL 参数读取 token（支持带 token 直接访问）
const urlParams = new URLSearchParams(location.search);
const urlToken = urlParams.get('token');
if (urlToken) {
  localStorage.setItem('duocli_token', urlToken);
  // 清除 URL 参数，避免暴露 token
  history.replaceState({}, '', location.pathname);
}
let token = localStorage.getItem('duocli_token') || '';
let currentSessionId = null;
let terminalOpenRequest = 0;
let sseSource = null;
// 详情页与“项目文件”页各有一棵独立的树。状态收进一个对象后，
// 就不必再靠比较 cache 的身份来判断当前是哪棵树（那种写法在缓存命中分支上很容易漏掉 root）。
function createFileTreeState() {
  return { rootPath: '', expandedDirs: new Set(), cache: new Map(), requestRef: { id: 0 } };
}

function resetFileTreeState(tree) {
  tree.rootPath = '';
  tree.expandedDirs.clear();
  tree.cache.clear();
}

const mobileFileTree = createFileTreeState();
const fileBrowseTree = createFileTreeState();
let fileBrowseFilter = 'all';
let filePreviewReturnPage = 'detail-page';
let mobileFilePreviewRequest = 0;
let currentDevicePanel = 'device';
let devicePanelReturnPage = 'main-page';
let activeSessionsCache = [];
let closedSessions = [];
let closedSessionsCollapsed = false;
const restoringClosedSessionIds = new Set();

// xterm.js 相关
let term = null;
let fitAddon = null;
let ws = null;
let wsHeartbeat = null;
let wsReconnectTimer = null;
let wsReconnectAttempt = 0;
let wsConnectTimeoutTimer = null;
let wsLastPongAt = 0;
let wsReplayRetryTimer = null;
let wsReplayRetryCount = 0;
let terminalInputReady = false;
let composerSubmission = null;
let copyToastTimer = null;
let isUserScrolling = false;
let terminalTouchActive = false;
let terminalScrollInteractionRevision = 0;
let terminalOutputWriteCount = 0;
let terminalWriteQueue = Promise.resolve();
let terminalSequence = -1;
let pendingRecreateViewport = null;
// 不同 xterm 版本的滚动回调可能在同步代码之后触发，
// 用布尔标志会被竞态误判。改用时间戳窗口标记程序化滚动。
let programmaticScrollUntil = 0;
let sseReconnectTimer = null;
let sseReconnectAttempt = 0;
const WEAK_NETWORK_STORAGE_KEY = 'duocli_weak_network_mode';
const MOBILE_LAST_CWD_KEY = 'duocli_mobile_last_cwd';
const MOBILE_LAST_PRESET_KEY = 'duocli_mobile_last_preset';
let weakNetworkMode = localStorage.getItem(WEAK_NETWORK_STORAGE_KEY) === '1';
const terminalScrollHelpers = globalThis.DuoTerminalScrollHelpers || {
  isAtBottom(viewportY, baseY) { return viewportY >= baseY; },
  shouldFollowOutput(wasAtBottom, touchActive, startInteraction, currentInteraction) {
    return wasAtBottom && !touchActive && startInteraction === currentInteraction;
  },
};
const spinnerInterceptor = globalThis.DuoSpinnerInterceptor || {
  intercept(data) { return typeof data === 'string' && data.length ? data : null; },
};
const terminalContentHelpers = globalThis.DuoTerminalContentHelpers;

// ========== 循环（自动继续）==========
// 手机端只做 UI，实际配置存在桌面端，通过 API 读写

// ========== 工具函数 ==========

function $(id) { return document.getElementById(id); }

const UI_ICON_PATHS = {
  alert: '<path d="M12 3 2.7 20h18.6L12 3z"></path><path d="M12 9v5"></path><path d="M12 17h.01"></path>',
  archive: '<path d="M4 7h16v13H4z"></path><path d="M3 4h18v3H3z"></path><path d="M9 11h6"></path>',
  audio: '<path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle>',
  'chevron-down': '<polyline points="6 9 12 15 18 9"></polyline>',
  'chevron-right': '<polyline points="9 18 15 12 9 6"></polyline>',
  cloud: '<path d="M17.5 19H8a5 5 0 1 1 1.2-9.85A6 6 0 0 1 20 11a4 4 0 0 1-2.5 8z"></path>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline>',
  folder: '<path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2h6.5A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z"></path>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><path d="m21 15-5-5L5 21"></path>',
  pin: '<path d="m15 4 5 5-3 1-3.5 3.5.5 3.5-1.5 1.5-2.5-2.5L7 20l-1-1 4-4.5L7.5 12 9 10.5l3.5.5L16 7.5 15 4z"></path>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line>',
  refresh: '<path d="M23 4v6h-6"></path><path d="M1 20v-6h6"></path><path d="M3.5 9A9 9 0 0 1 18.8 5.2L23 10M1 14l4.2 4.8A9 9 0 0 0 20.5 15"></path>',
  restore: '<polyline points="1 4 1 10 7 10"></polyline><path d="M3.5 15A9 9 0 1 0 2 10"></path>',
  trash: '<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14H5V6m3 0V3h8v3"></path><line x1="10" y1="10" x2="10" y2="17"></line><line x1="14" y1="10" x2="14" y2="17"></line>',
  video: '<rect x="3" y="5" width="13" height="14" rx="2"></rect><polygon points="16 10 21 7 21 17 16 14"></polygon>',
  wifi: '<path d="M5 12.55a11 11 0 0 1 14.08 0"></path><path d="M8.5 16.05a6 6 0 0 1 7 0"></path><path d="M12 19.5h.01"></path>',
  x: '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>',
};

function iconSvg(name, size = 16) {
  return `<svg class="ui-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${UI_ICON_PATHS[name] || UI_ICON_PATHS.file}</svg>`;
}

function setIcon(element, name, size = 16) {
  if (element) element.innerHTML = iconSvg(name, size);
}

function setIconLabel(element, name, label, size = 14) {
  if (!element) return;
  element.innerHTML = `${iconSvg(name, size)}<span>${escapeHtml(label)}</span>`;
}

function getNetworkProfile() {
  if (weakNetworkMode) {
    return {
      wsConnectTimeoutMs: 18000,
      wsPingIntervalMs: 20000,
      wsStaleTimeoutMs: 90000,
      wsRetryBaseMs: 2000,
      wsRetryMaxMs: 45000,
      sseRetryBaseMs: 4000,
      sseRetryMaxMs: 45000,
    };
  }
  return {
    wsConnectTimeoutMs: 8000,
    wsPingIntervalMs: 15000,
    wsStaleTimeoutMs: 45000,
    wsRetryBaseMs: 1000,
    wsRetryMaxMs: 15000,
    sseRetryBaseMs: 2000,
    sseRetryMaxMs: 15000,
  };
}

function setWeakNetworkMode(enabled) {
  weakNetworkMode = enabled;
  localStorage.setItem(WEAK_NETWORK_STORAGE_KEY, weakNetworkMode ? '1' : '0');
}

function ensureWeakNetworkPrompt() {
  const existed = $('weak-network-prompt');
  if (existed) return existed;
  const container = $('terminal-container');
  if (!container) return null;

  const prompt = document.createElement('div');
  prompt.id = 'weak-network-prompt';
  prompt.className = 'weak-network-prompt';
  prompt.style.display = 'none';
  prompt.innerHTML = `
    <div id="weak-network-prompt-text" class="weak-network-prompt-text"></div>
    <div class="weak-network-prompt-actions">
      <button id="weak-network-prompt-btn" class="weak-network-prompt-btn" type="button"></button>
    </div>
  `;

  const btn = prompt.querySelector('#weak-network-prompt-btn');
  btn.addEventListener('click', () => {
    if (!weakNetworkMode) {
      setWeakNetworkMode(true);
      showCopyToast('已切到弱网模式，正在重连');
      if (currentSessionId && $('detail-page').classList.contains('active')) {
        connectWebSocket(currentSessionId);
      }
      if ($('main-page').classList.contains('active') && token) {
        startSSE();
      }
    }
    hideWeakNetworkPrompt();
  });

  container.appendChild(prompt);
  return prompt;
}

function showWeakNetworkPrompt(message) {
  if (!$('detail-page').classList.contains('active')) return;
  const prompt = ensureWeakNetworkPrompt();
  if (!prompt) return;
  const textEl = prompt.querySelector('#weak-network-prompt-text');
  const btn = prompt.querySelector('#weak-network-prompt-btn');
  if (!textEl || !btn) return;

  textEl.textContent = message;
  if (weakNetworkMode) {
    btn.textContent = '已在弱网模式';
    btn.setAttribute('disabled', 'disabled');
  } else {
    btn.textContent = '切到弱网模式';
    btn.removeAttribute('disabled');
  }
  prompt.style.display = 'flex';
}

function hideWeakNetworkPrompt() {
  const prompt = $('weak-network-prompt');
  if (prompt) prompt.style.display = 'none';
}

// 截断长路径，优先显示最右侧目录名，如 /a/b/c/d → …/c/d
function shortenPath(p, maxLen = 30) {
  if (p.length <= maxLen) return p;
  const parts = p.split('/').filter(Boolean);
  let result = parts[parts.length - 1] || p;
  for (let i = parts.length - 2; i >= 0; i--) {
    const next = parts[i] + '/' + result;
    if (next.length + 1 > maxLen) break; // +1 for leading …/
    result = next;
  }
  return '…/' + result;
}

// CLI 标签配色来自 cli-tag-colors.js，桌面端用的是同一份
const { getCliTagColors } = globalThis.DuoCliTagColors || {
  getCliTagColors: () => ['#94a3b8', '#1e293b'],
};

// CLI Logo 来自 cli-logos.js，桌面端用的也是同一份
const { getLogoUrl, getDefaultLogoUrl, hasLogo } = globalThis.DuoCliLogos || {
  getLogoUrl: () => '',
  getDefaultLogoUrl: () => '',
  hasLogo: () => false,
};

function hideTerminalLoading() {
  const el = $('terminal-loading');
  if (el && !el.classList.contains('hidden')) {
    el.classList.add('hidden');
  }
}

function showTerminalLoading() {
  const el = $('terminal-loading');
  if (el) el.classList.remove('hidden');
}

function isTerminalInputReady() {
  return terminalInputReady
    && navigator.onLine !== false
    && !!ws
    && ws.readyState === WebSocket.OPEN;
}

function updateComposerAvailability() {
  const sendButton = $('send-btn');
  const input = $('msg-input');
  const ready = isTerminalInputReady();
  const disabled = !ready || !!composerSubmission;

  if (sendButton) {
    sendButton.disabled = disabled;
    sendButton.setAttribute('aria-disabled', String(disabled));
    sendButton.title = ready ? '发送' : '终端连接中，请稍候';
    sendButton.dataset.terminalReady = String(ready);
  }
  // 保留输入框可编辑，让用户可以先写好消息；只拦截发送动作。
  if (input) {
    input.placeholder = ready ? '输入终端消息或命令...' : '终端连接中，请稍候...';
    input.dataset.terminalReady = String(ready);
  }
}

function setTerminalInputReady(ready) {
  terminalInputReady = ready === true;
  updateComposerAvailability();
}

function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  // 全局超时：避免弱网下 fetch 永远 pending 卡住整个 UI
  // 默认 12s，弱网模式 25s；调用方可通过 opts.timeout 覆盖（0 = 无超时）
  const timeoutMs = opts.timeout != null
    ? opts.timeout
    : (weakNetworkMode ? 25000 : 12000);
  let signal = opts.signal;
  let timer = null;
  if (timeoutMs > 0 && !signal) {
    const ctrl = new AbortController();
    signal = ctrl.signal;
    timer = setTimeout(() => ctrl.abort(), timeoutMs);
  }
  const cleanup = () => { if (timer) { clearTimeout(timer); timer = null; } };
  return fetch(`${API}${path}`, { ...opts, headers, signal })
    .then(async r => {
      cleanup();
      if (r.status === 401) { logout(); throw new Error('未授权'); }
      let data = {};
      try {
        data = await r.json();
      } catch {
        data = {};
      }
      if (!r.ok) {
        const message = data && typeof data.error === 'string' && data.error.trim()
          ? data.error.trim()
          : `请求失败 (${r.status})`;
        throw new Error(message);
      }
      return data;
    })
    .catch((err) => {
      cleanup();
      if (err && err.name === 'AbortError') {
        const e = new Error('请求超时，请检查网络');
        e.code = 'TIMEOUT';
        throw e;
      }
      throw err;
    });
}

function isComputerPointer() {
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

function supportsLandscapePanels() {
  return isComputerPointer() || window.matchMedia('(orientation: landscape)').matches;
}

function syncLandscapePanelButtons() {
  const sessionsOpen = $('main-page').classList.contains('landscape-drawer-open');
  const deviceOpen = $('device-page').classList.contains('landscape-drawer-open');
  document.querySelectorAll('.landscape-sessions-toggle').forEach(button => {
    button.setAttribute('aria-expanded', String(sessionsOpen));
    button.title = sessionsOpen ? '收起会话侧栏' : '展开会话侧栏';
  });
  document.querySelectorAll('.landscape-device-toggle').forEach(button => {
    button.setAttribute('aria-expanded', String(deviceOpen));
    button.title = deviceOpen ? '收起手机侧栏' : '展开手机侧栏';
  });
}

function scheduleLandscapeWorkspaceResize() {
  if (!$('detail-page').classList.contains('active')) return;
  requestAnimationFrame(scheduleTerminalResize);
  setTimeout(scheduleTerminalResize, 180);
}

function closeLandscapePanels() {
  $('main-page').classList.remove('landscape-drawer-open');
  $('device-page').classList.remove('landscape-drawer-open');
  document.body.classList.remove('landscape-sessions-open', 'landscape-device-open');
  syncLandscapePanelButtons();
  scheduleLandscapeWorkspaceResize();
}

async function toggleLandscapeSessionsPanel() {
  if (!supportsLandscapePanels()) return;
  const opening = !$('main-page').classList.contains('landscape-drawer-open');
  $('main-page').classList.toggle('landscape-drawer-open', opening);
  document.body.classList.toggle('landscape-sessions-open', opening);
  syncLandscapePanelButtons();
  scheduleLandscapeWorkspaceResize();
  if (opening) {
    await refreshSessions();
    if ($('main-page').classList.contains('landscape-drawer-open') && !sseSource) startSSE();
  }
}

async function toggleLandscapeDevicePanel() {
  if (!supportsLandscapePanels()) return;
  const opening = !$('device-page').classList.contains('landscape-drawer-open')
    && $('fullscreen-overlay')?.style.display === 'none';
  if (!opening) {
    $('fullscreen-overlay').style.display = 'none';
    $('device-page').classList.remove('landscape-drawer-open');
    document.body.classList.remove('landscape-device-open');
    stopAndroidMirror();
    syncLandscapePanelButtons();
    scheduleLandscapeWorkspaceResize();
    return;
  }
  await showPhoneControl();
}

function setDevicePanel(panel) {
  const allowed = ['device', 'files', 'preview'];
  currentDevicePanel = allowed.includes(panel) ? panel : 'device';
  document.querySelectorAll('.device-panel-tab').forEach((button) => {
    const selected = button.dataset.devicePanel === currentDevicePanel;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
  });
  document.querySelectorAll('.device-panel-view').forEach((view) => {
    const selected = view.id === `device-panel-${currentDevicePanel}`;
    view.classList.toggle('active', selected);
    view.hidden = !selected;
  });
  if (currentDevicePanel === 'files') void renderMobileFileTree();
}

function openDevicePanel(panel = 'device') {
  setDevicePanel(panel);
  if ($('detail-page').classList.contains('active') && supportsLandscapePanels()) {
    $('device-page').classList.add('landscape-drawer-open');
    document.body.classList.add('landscape-device-open');
    syncLandscapePanelButtons();
    scheduleLandscapeWorkspaceResize();
  } else {
    devicePanelReturnPage = $('detail-page').classList.contains('active') ? 'detail-page' : 'main-page';
    showPage('device-page');
  }
}

function showPage(id) {
  if (id === 'main-page' || id === 'login-page') stopAndroidMirror();
  if (id !== 'detail-page') closeLandscapePanels();
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  $(id).classList.add('active');
  if (id !== 'detail-page') {
    hideWeakNetworkPrompt();
  }
}

function formatTime(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function escapeHtml(s) {
  return escHtml(String(s || ''));
}

async function copyTextToClipboard(text) {
  const value = String(text || '');
  if (!value) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {}

  // iOS Safari 兜底
  const ta = document.createElement('textarea');
  ta.value = value;
  ta.setAttribute('readonly', 'readonly');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, ta.value.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {}
  document.body.removeChild(ta);
  return ok;
}

function showCopyToast(text) {
  let toast = $('copy-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'copy-toast';
    toast.className = 'copy-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.classList.add('show');
  if (copyToastTimer) clearTimeout(copyToastTimer);
  copyToastTimer = setTimeout(() => {
    toast.classList.remove('show');
  }, 1200);
}

// ========== 催工核心逻辑（通过 API 读写桌面端配置）==========

async function getAutoContinueConfig(sessionId) {
  try {
    return await api(`/api/sessions/${sessionId}/auto-continue`);
  } catch {
    return null;
  }
}

async function saveAutoContinueConfig(sessionId, config) {
  try {
    await api(`/api/sessions/${sessionId}/auto-continue`, {
      method: 'PUT',
      body: JSON.stringify(config),
    });
  } catch (e) {
    console.error('[AutoContinue] 保存失败', e);
  }
}

async function toggleAutoContinue(sessionId, enabled) {
  const config = await getAutoContinueConfig(sessionId) || {};
  config.enabled = enabled;
  await saveAutoContinueConfig(sessionId, config);
  updateDetailAutoContinueUI(config);
}

async function showAutoContinueConfigModal(sessionId) {
  const config = await getAutoContinueConfig(sessionId) || {};
  const modal = $('auto-continue-modal');
  // 兼容旧版 message → messages
  const msgs = Array.isArray(config.messages) ? config.messages : (config.message ? [config.message] : ['继续']);
  $('ac-message').value = msgs.join('\n');
  $('ac-interval').value = String(Math.round((config.intervalMs || 600000) / 60000));
  $('ac-initial-delay').value = String(Math.round((config.initialDelayMs || 0) / 60000));
  $('ac-cmd-interval').value = String(Math.round((config.commandIntervalMs || 2000) / 1000));
  $('ac-send-delay').value = String(config.sendDelaySec ?? 2);
  $('ac-max-loops').value = String(config.maxLoops ?? -1);
  $('ac-auto-agree').checked = config.autoAgree !== false;
  $('ac-agree-delay').value = String(config.autoAgreeDelaySec ?? 5);
  $('ac-agree-delay-row').style.display = $('ac-auto-agree').checked ? '' : 'none';

  // 根据当前状态设置按钮
  if (config.enabled) {
    $('ac-save').textContent = '保存';
    $('ac-stop').style.display = '';
  } else {
    $('ac-save').textContent = '保存并开启';
    $('ac-stop').style.display = 'none';
  }

  modal.classList.add('active');
}

function updateDetailAutoContinueUI(config) {
  const label = $('detail-ac-label');
  if (label) {
    const enabled = config && config.enabled;
    label.textContent = '设';
    label.className = 'ac-label' + (enabled ? ' enabled' : '');
    label.title = enabled ? '计划已开启，点击设置' : '计划设置';
  }
}

function quotePathForShell(filePath) {
  const value = String(filePath || '');
  if (/^[a-zA-Z]:\\/.test(value)) return `"${value.replace(/"/g, '\\"')}"`;
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function insertPathToTerminal(filePath) {
  if (!currentSessionId || !isTerminalInputReady()) {
    showCopyToast('终端连接中，请稍候再发送');
    return;
  }
  sendInputWithHexEnter(`${quotePathForShell(filePath)} `);
}

function showMobileContextMenu(clientX, clientY, items) {
  document.querySelectorAll('.mobile-context-menu').forEach((node) => node.remove());
  const menu = document.createElement('div');
  menu.className = 'mobile-context-menu';
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'mobile-context-item';
    row.textContent = item.label;
    row.addEventListener('click', () => {
      menu.remove();
      item.action();
    });
    menu.appendChild(row);
  }
  menu.style.left = `${Math.min(clientX, window.innerWidth - 180)}px`;
  menu.style.top = `${Math.min(clientY, window.innerHeight - items.length * 44 - 12)}px`;
  document.body.appendChild(menu);
  const dismiss = (event) => {
    if (!menu.contains(event.target)) {
      menu.remove();
      document.removeEventListener('pointerdown', dismiss, true);
    }
  };
  setTimeout(() => document.addEventListener('pointerdown', dismiss, true), 0);
}

function showMobileFileTreeMenu(event, item) {
  event.preventDefault();
  event.stopPropagation();
  const items = [
    {
      label: '复制绝对路径',
      action: async () => {
        const ok = await copyTextToClipboard(item.path);
        showCopyToast(ok ? '已复制路径' : '复制失败');
      },
    },
    {
      label: '插入路径到终端',
      action: () => insertPathToTerminal(item.path),
    },
  ];
  if (!item.isDir) {
    items.push({
      label: '预览文件',
      action: () => openFilePreview(item.path),
    });
  }
  showMobileContextMenu(event.clientX, event.clientY, items);
}

// 用户只要离开最后一行就视为正在回看，避免新输出抢走阅读位置。
function isAtBottom() {
  if (!term) return true;
  const buf = term.buffer.active;
  return terminalScrollHelpers.isAtBottom(buf.viewportY, buf.baseY);
}

function markUserScrolling() {
  if (!term) return;
  terminalScrollInteractionRevision++;
  isUserScrolling = !isAtBottom();
  if (!isUserScrolling) setTerminalUnreadOutput(false);
}

function ensureTerminalScrollButton() {
  const container = $('terminal-container');
  if (!container || container.querySelector('#terminal-scroll-bottom-btn')) return;
  const button = document.createElement('button');
  button.id = 'terminal-scroll-bottom-btn';
  button.type = 'button';
  button.hidden = true;
  button.title = '跳到最新输出';
  button.setAttribute('aria-label', '跳到最新输出');
  setIcon(button, 'chevron-down', 16);
  button.addEventListener('click', scrollTerminalToBottom);
  container.appendChild(button);
}

function setTerminalUnreadOutput(hasUnread) {
  const button = $('terminal-scroll-bottom-btn');
  if (button) button.hidden = !hasUnread;
}

let scrollToBottomRaf = 0;
/** 即时跳到底部（无平滑动画），用于 replay 回话与高频输出跟尾。 */
function jumpTerminalToLatest() {
  if (!term) return;
  isUserScrolling = false;
  resetScrollAccum();
  setTerminalUnreadOutput(false);
  programmaticScrollUntil = Date.now() + 50;
  // xterm 的公开 Terminal.scrollToBottom() 不接收参数，传入 false 也会被
  // 丢掉；启用平滑滚动时它会沿着整个 scrollback 播放动画。内核方法的
  // 第二个参数才是“立即滚动”，同时把选项固定为 0 兼容不同 xterm 版本。
  try {
    if (term.options && term.options.smoothScrollDuration !== 0) {
      term.options.smoothScrollDuration = 0;
    }
  } catch {}
  const core = term._core;
  if (core && typeof core.scrollToBottom === 'function') core.scrollToBottom(true);
  else term.scrollToBottom();
}

function scrollTerminalToBottom() {
  if (!term) return;
  isUserScrolling = false;
  resetScrollAccum();
  setTerminalUnreadOutput(false);
  if (term.buffer.active.viewportY === term.buffer.active.baseY) return;
  // 高频输出时 writeTerminalOutput 每次 write 回调都可能调到这里。
  // 用 rAF 把同一帧内的多次调用合并成一次，滚动本身保持瞬时跳转。
  if (scrollToBottomRaf) return;
  const activeTerm = term;
  const interaction = terminalScrollInteractionRevision;
  scrollToBottomRaf = requestAnimationFrame(() => {
    scrollToBottomRaf = 0;
    if (term !== activeTerm || terminalTouchActive || isUserScrolling || interaction !== terminalScrollInteractionRevision) return;
    jumpTerminalToLatest();
  });
}

function resetTerminalScrollState() {
  isUserScrolling = false;
  terminalTouchActive = false;
  terminalScrollInteractionRevision = 0;
  terminalOutputWriteCount = 0;
  terminalWriteQueue = Promise.resolve();
  terminalSequence = -1;
  pendingRecreateViewport = null;
  programmaticScrollUntil = 0;
  if (scrollToBottomRaf) {
    cancelAnimationFrame(scrollToBottomRaf);
    scrollToBottomRaf = 0;
  }
  resetScrollAccum();
  setTerminalUnreadOutput(false);
}

function writeTerminalOutput(data, wasAtBottom = !isUserScrolling) {
  if (!term) return;
  const activeTerm = term;
  const startInteraction = terminalScrollInteractionRevision;
  terminalWriteQueue = terminalWriteQueue.then(() => new Promise(resolve => {
    if (term !== activeTerm) { resolve(); return; }
    terminalOutputWriteCount++;
    activeTerm.write(data, () => {
      if (term === activeTerm) {
        terminalOutputWriteCount--;
        if (terminalScrollHelpers.shouldFollowOutput(wasAtBottom, terminalTouchActive,
            startInteraction, terminalScrollInteractionRevision)) {
          scrollTerminalToBottom();
        } else if (!isAtBottom()) setTerminalUnreadOutput(true);
        scheduleMobileLinkHighlights();
      }
      resolve();
    });
  }));
}

function restoreTerminalSnapshot(msg) {
  const activeTerm = term;
  const hasReplayBody = Boolean((msg.data || '').length);
  if (hasReplayBody) showTerminalLoading();
  terminalWriteQueue = terminalWriteQueue.then(() => new Promise(resolve => {
    if (term !== activeTerm) { resolve(); return; }
    const recreateViewport = pendingRecreateViewport;
    const follow = recreateViewport == null && !isUserScrolling;
    const viewport = recreateViewport ?? activeTerm.buffer.active.viewportY;
    const revision = terminalScrollInteractionRevision;
    terminalOutputWriteCount++;
    activeTerm.reset();
    // A resize-triggered snapshot is the acknowledgement of this browser's
    // requested PTY geometry. Initial/reconnect replays may contain the
    // desktop pane size, so only apply dimensions when the server marks the
    // snapshot as preserving the remote viewport.
    if (msg.preserveViewport && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)
        && msg.cols >= 2 && msg.rows > 0) {
      activeTerm.resize(msg.cols, msg.rows);
    }
    activeTerm.write(msg.data || '', () => {
      if (term === activeTerm) {
        terminalOutputWriteCount--;
        if (revision === terminalScrollInteractionRevision && !terminalTouchActive) {
          if (follow) jumpTerminalToLatest();
          else {
            activeTerm.scrollToLine(Math.min(viewport, activeTerm.buffer.active.baseY));
            isUserScrolling = true;
            setTerminalUnreadOutput(!isAtBottom());
          }
          if (recreateViewport != null) pendingRecreateViewport = null;
        }
        scheduleMobileLinkHighlights();
        if (msg.preserveViewport && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)
            && msg.cols >= 2 && msg.rows > 0) {
          // The replay confirms the remote viewport we just requested. Keep
          // that geometry while the terminal parses the snapshot; fitting
          // here would immediately undo the acknowledgement on narrow views.
          lastSentCols = msg.cols;
          lastSentRows = msg.rows;
        } else {
          syncTerminalToViewport();
        }
        if (hasReplayBody) hideTerminalLoading();
      }
      resolve();
    });
  }));
}

// replay 里的 cols/rows 来自桌面 pane，不能用来驱动浏览器 xterm。
// 浏览器始终按自身 viewport fit，再通过 resize 消息声明 PTY 尺寸。
function syncTerminalToViewport() {
  if (!fitAddon || !term) return;
  const container = $('terminal-container');
  if (!container || container.clientWidth < 1 || container.clientHeight < 1) return;
  try { fitAddon.fit(); } catch {}
  lastTerminalSize = `${container.clientWidth}x${container.clientHeight}`;
  handleResize();
  scheduleTerminalSelectHandlesUpdate();
}

function applyTerminalSnapshotGeometry(msg) {
  if (msg?.preserveViewport && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)
      && msg.cols >= 2 && msg.rows > 0 && term
      && (term.cols !== msg.cols || term.rows !== msg.rows)) {
    term.resize(msg.cols, msg.rows);
    lastSentCols = msg.cols;
    lastSentRows = msg.rows;
    return;
  }
  if (msg?.preserveViewport && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)
      && msg.cols >= 2 && msg.rows > 0) {
    lastSentCols = msg.cols;
    lastSentRows = msg.rows;
    return;
  }
  syncTerminalToViewport();
}

// 触摸滚动：本版 xterm 用 SmoothScrollableElement（虚拟滚动条），
// 直接写 viewport.scrollTop 无效，必须走官方 term.scrollLines()。
// 用像素累积把手指位移换算成整行滚动，保证顺滑。
let _scrollAccum = 0;
function resetScrollAccum() { _scrollAccum = 0; }
function terminalRowHeight() {
  const vp = document.querySelector('#terminal-container .xterm-viewport');
  if (vp && term && term.rows > 0) return vp.clientHeight / term.rows;
  return 18;
}
function scrollTerminalByPixels(deltaY) {
  if (!term) return false;
  _scrollAccum += deltaY;
  const rh = terminalRowHeight();
  const lines = Math.trunc(_scrollAccum / rh);
  if (lines === 0) return false;
  _scrollAccum -= lines * rh;
  const before = term.buffer.active.viewportY;
  term.scrollLines(lines);
  const moved = term.buffer.active.viewportY !== before;
  if (moved) markUserScrolling();
  return moved;
}

let terminalResizeObserver = null;
let terminalResizeFrame = null;
let terminalTouchCleanup = null;
let lastTerminalSize = '';
let keyboardVisible = false;
let lastSentCols = 0;
let lastSentRows = 0;
let resizeSendTimer = null;
function scheduleTerminalResize() {
  if (terminalResizeFrame !== null) return;
  terminalResizeFrame = requestAnimationFrame(() => {
    terminalResizeFrame = null;
    const container = $('terminal-container');
    if (!term || !fitAddon || !container || container.clientWidth < 1 || container.clientHeight < 1) return;
    const size = `${container.clientWidth}x${container.clientHeight}`;
    if (size === lastTerminalSize) return;
    syncTerminalToViewport();
  });
}

function resetMobileKeyboardLayout() {
  const detailPage = $('detail-page');
  if (!detailPage || !detailPage.classList.contains('active')) return;
  const inputArea = $('input-area');
  const shortcutBar = $('shortcut-bar');
  keyboardVisible = false;
  detailPage.style.top = '';
  detailPage.style.bottom = '';
  detailPage.style.height = '';
  if (inputArea) inputArea.style.paddingBottom = '';
  if (shortcutBar) shortcutBar.style.paddingBottom = '';
}

function scheduleDelayedTerminalResize() {
  lastTerminalSize = '';
  scheduleTerminalResize();
  [120, 320, 520].forEach(delay => {
    setTimeout(() => {
      lastTerminalSize = '';
      scheduleTerminalResize();
    }, delay);
  });
}

// .xterm 自带内边距，文字网格原点必须取 .xterm-rows，不能拿容器矩形当第 0 行第 0 列。
function getTerminalCellMetrics() {
  if (!term || !term.cols || !term.rows) return null;
  const container = $('terminal-container');
  const rows = container?.querySelector('.xterm-rows');
  if (!rows) return null;
  const rect = rows.getBoundingClientRect();
  const rowHeight = rect.height > 0
    ? rect.height / term.rows
    : (rows.firstElementChild?.getBoundingClientRect().height || 0);
  if (!rect.width || !rowHeight) return null;
  const containerRect = container.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    originX: rect.left - containerRect.left,
    originY: rect.top - containerRect.top,
    colWidth: rect.width / term.cols,
    rowHeight,
  };
}

function getBufferLineIndexByTouchY(clientY) {
  const metrics = getTerminalCellMetrics();
  if (!metrics) return -1;
  const visualRow = Math.min(term.rows - 1, Math.max(0, Math.floor((clientY - metrics.top) / metrics.rowHeight)));
  const buffer = term.buffer.active;
  return Math.min(Math.max(0, buffer.viewportY + visualRow), Math.max(0, buffer.length - 1));
}

function getBufferCellWidth(row, col) {
  const line = term?.buffer.active.getLine(row);
  return line?.getCell(col)?.getWidth?.() || 1;
}

function getCellFromTouch(clientX, clientY) {
  const metrics = getTerminalCellMetrics();
  if (!metrics) return null;
  const row = getBufferLineIndexByTouchY(clientY);
  if (row < 0) return null;
  let col = Math.min(
    term.cols - 1,
    Math.max(0, Math.floor((clientX - metrics.left) / metrics.colWidth)),
  );
  // 中文/emoji 占两格，落在续格上会把字符切一半，退到字符起点。
  while (col > 0 && getBufferCellWidth(row, col) === 0) col--;
  return { row, col };
}

function selectTerminalRange(start, end) {
  if (!term || !start || !end) return;
  const startOffset = start.row * term.cols + start.col;
  const endOffset = end.row * term.cols + end.col;
  let s = start;
  let e = end;
  if (startOffset > endOffset) [s, e] = [end, start];
  const length = (e.row - s.row) * term.cols + (e.col - s.col) + getBufferCellWidth(e.row, e.col);
  if (length > 0) term.select(s.col, s.row, length);
}

/** 长按选中手指下的词；返回选区两端，便于松手前继续拖动扩选。 */
function selectWordAtCell(cell) {
  if (!term || !terminalContentHelpers || !cell) return null;
  const logical = terminalContentHelpers.readLogicalLine(term.buffer.active, cell.row);
  const range = terminalContentHelpers.wordRangeAt(logical, cell);
  if (!range) return null;
  const start = { row: range.start.line, col: range.start.cell };
  const end = { row: range.end.line, col: range.end.cell };
  selectTerminalRange(start, end);
  return { start, end };
}

function getSelectionCells() {
  if (!term || !term.hasSelection()) return null;
  const position = term.getSelectionPosition();
  if (!position) return null;
  let endRow = position.end.y;
  let endCol = position.end.x - 1;
  if (endCol < 0) { endRow--; endCol = term.cols - 1; }
  if (endRow < 0) return null;
  const clamp = col => Math.max(0, Math.min(col, term.cols - 1));
  return { start: { row: position.start.y, col: clamp(position.start.x) }, end: { row: endRow, col: clamp(endCol) } };
}

function ensureTerminalSelectHandles() {
  const container = $('terminal-container');
  if (!container || container.querySelector('.terminal-select-handle')) return;
  for (const which of ['start', 'end']) {
    const handle = document.createElement('div');
    handle.className = 'terminal-select-handle';
    handle.dataset.handle = which;
    handle.hidden = true;
    container.appendChild(handle);
  }
}

function updateTerminalSelectHandles() {
  const container = $('terminal-container');
  if (!container) return;
  const handles = container.querySelectorAll('.terminal-select-handle');
  if (!handles.length) return;
  const cells = getSelectionCells();
  const metrics = cells ? getTerminalCellMetrics() : null;
  if (!cells || !metrics) {
    handles.forEach(handle => { handle.hidden = true; });
    return;
  }
  const viewportY = term.buffer.active.viewportY;
  handles.forEach(handle => {
    const isStart = handle.dataset.handle === 'start';
    const cell = isStart ? cells.start : cells.end;
    const visualRow = cell.row - viewportY;
    // 端点滚出可视区后手柄没意义，藏起来；复制按钮仍然可用。
    if (visualRow < 0 || visualRow >= term.rows) { handle.hidden = true; return; }
    const colEdge = isStart ? cell.col : cell.col + getBufferCellWidth(cell.row, cell.col);
    handle.style.left = `${metrics.originX + colEdge * metrics.colWidth}px`;
    handle.style.top = `${metrics.originY + (visualRow + 0.5) * metrics.rowHeight}px`;
    handle.hidden = false;
  });
}

let selectHandlesRaf = 0;
function scheduleTerminalSelectHandlesUpdate() {
  if (selectHandlesRaf) return;
  selectHandlesRaf = requestAnimationFrame(() => {
    selectHandlesRaf = 0;
    updateTerminalSelectHandles();
  });
}

function ensureTerminalCopyButton() {
  const container = $('terminal-container');
  if (!container || container.querySelector('#terminal-copy-selection-btn')) return;
  const button = document.createElement('button');
  button.id = 'terminal-copy-selection-btn';
  button.type = 'button';
  button.hidden = true;
  button.textContent = '复制';
  button.title = '复制选中内容';
  button.setAttribute('aria-label', '复制选中内容');
  button.addEventListener('click', async () => {
    const text = getUnwrappedSelection();
    if (!text) {
      updateTerminalCopyButton();
      return;
    }
    const ok = await copyTextToClipboard(text);
    showCopyToast(ok ? '已复制到剪贴板' : '复制失败');
    term?.clearSelection();
    updateTerminalCopyButton();
  });
  container.appendChild(button);
}

function updateTerminalCopyButton() {
  const button = $('terminal-copy-selection-btn');
  if (!button) return;
  button.hidden = !(term && term.hasSelection());
}

function getUnwrappedSelection() {
  if (!term || !term.hasSelection()) return '';
  const selPos = term.getSelectionPosition();
  if (!selPos) return term.getSelection().trim();
  if (!terminalContentHelpers) return term.getSelection().trim();
  return terminalContentHelpers.getSelectionText(term.buffer.active, selPos);
}

// ========== 登录 ==========

function logout() {
  token = '';
  localStorage.removeItem('duocli_token');
  terminalOpenRequest++;
  currentSessionId = null;
  stopSSE();
  closeTerminal();
  LanSwitcher.stop();
  showPage('login-page');
}

// ============================================================
// 网络模式切换：CF Tunnel ⇄ LAN 直连
// 背景：HTTPS 页面无法在浏览器侧探测 HTTP LAN（iOS Safari Mixed Content
// 把所有子资源请求要么拦截要么强制升级到 HTTPS，<img>/<iframe>/fetch 全堵）。
// 所以放弃自动探针，改成顶部常驻按钮：
//   - CF 模式（HTTPS）：按钮显示"🟡 切局域网"，点击 → 拿 /api/lan-info →
//     选 IP（上次成功优先；否则 192.168 > 10 > 172）→ location.replace 跳过去。
//     跳过去打不开是用户自己的事（不在家就别点）。
//   - LAN 模式（HTTP + 私有 IP）：按钮显示"🟢 局域网"，点击 → 跳回 CF。
//     另外 5 秒一次 fetch /ping.png 自检，连续两次不通自动跳回 CF（HTTP→HTTP
//     不受 Mixed Content 限制，这里用 fetch 比 <img> 更准）。
// ============================================================
const LanSwitcher = (() => {
  const PROBE_INTERVAL_LAN_MS = 5 * 1000;
  const PROBE_TIMEOUT_MS = 2000;
  const STORAGE_CLOUD_URL = 'duocli_cloud_url';   // 上次的 CF 入口（origin）
  const STORAGE_LAST_LAN_IP = 'duocli_last_lan_ip'; // 上次成功用过的 LAN IP

  let probeTimer = null;

  function isPrivateIp(host) {
    return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  }

  function isLocalHostname(host) {
    return host === 'localhost' || host.endsWith('.local');
  }

  function isLanMode() {
    const host = location.hostname.toLowerCase();
    return location.protocol === 'http:' && (isPrivateIp(host) || isLocalHostname(host));
  }

  function isCfMode() {
    return location.protocol === 'https:';
  }

  // 多 IP 选优：上次成功的 > 192.168 > 10 > 172 > 其它
  function pickBestIp(ips) {
    if (!ips || !ips.length) return null;
    const last = localStorage.getItem(STORAGE_LAST_LAN_IP);
    if (last && ips.includes(last)) return last;
    const score = ip => {
      if (ip.startsWith('192.168.')) return 3;
      if (ip.startsWith('10.')) return 2;
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 1;
      return 0;
    };
    return [...ips].sort((a, b) => score(b) - score(a))[0];
  }

  // LAN 自检：HTTP 页面 fetch HTTP 不受 Mixed Content 限制
  async function probeLanSelf() {
    const url = `${location.origin}/ping.png?_=${Date.now()}`;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
      clearTimeout(t);
      return res.ok;
    } catch {
      return false;
    }
  }

  async function probeLanMode() {
    if (await probeLanSelf()) return;
    await new Promise(r => setTimeout(r, 1000));
    if (await probeLanSelf()) return;
    switchToCloud(true);
  }

  // CF → LAN：用户主动点
  async function switchToLan() {
    if (!token) return;
    let info;
    try {
      info = await api('/api/lan-info');
    } catch {
      showCopyToast('拿不到局域网信息（token 失效？）');
      return;
    }
    const ip = pickBestIp(info && info.lanIps);
    if (!ip) {
      showCopyToast('电脑暂无可用局域网 IP');
      return;
    }
    const port = info.port || 9800;
    localStorage.setItem(STORAGE_CLOUD_URL, location.origin);
    localStorage.setItem(STORAGE_LAST_LAN_IP, ip);
    showCopyToast(`已切到局域网 ${ip}:${port}`);
    setTimeout(() => location.replace(`http://${ip}:${port}/?token=${encodeURIComponent(token)}`), 200);
  }

  // LAN → CF：用户点 或 自检失败（需曾通过公网入口访问过，才会写入 STORAGE_CLOUD_URL）
  function switchToCloud(auto) {
    const cloudUrl = localStorage.getItem(STORAGE_CLOUD_URL);
    if (!cloudUrl) {
      if (!auto) showCopyToast('暂无云端地址，请先用公网链接打开一次');
      return;
    }
    showCopyToast(auto ? '局域网失联，回到云端…' : '切到云端…');
    setTimeout(() => location.replace(`${cloudUrl}/?token=${encodeURIComponent(token)}`), 200);
  }

  function updateButton() {
    const btn = $('net-mode-btn');
    if (!btn) return;
    if (!token) { btn.style.display = 'none'; return; }
    btn.style.display = 'inline-flex';
    if (isLanMode()) {
      setIconLabel(btn, 'wifi', '局域网', 13);
      btn.title = '当前局域网直连，点击切回云端';
      btn.className = 'net-mode-btn lan';
      btn.onclick = () => switchToCloud(false);
    } else if (isCfMode()) {
      setIconLabel(btn, 'cloud', '切局域网', 13);
      btn.title = '在家时点击切到局域网直连，更快';
      btn.className = 'net-mode-btn cf';
      btn.onclick = switchToLan;
    } else {
      btn.style.display = 'none';
    }
  }

  function start() {
    stop();
    updateButton();
    if (!token) return;
    if (isLanMode()) {
      setTimeout(probeLanMode, 1000);
      probeTimer = setInterval(probeLanMode, PROBE_INTERVAL_LAN_MS);
    }
  }

  function stop() {
    if (probeTimer) {
      clearInterval(probeTimer);
      probeTimer = null;
    }
  }

  return { start, stop, switchToLan, switchToCloud, isLanMode, isCfMode };
})();

$('login-btn').onclick = async () => {
  const t = $('token-input').value.trim();
  if (!t) return;
  try {
    const res = await fetch(`${API}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: t }),
    });
    const data = await res.json();
    if (data.ok) {
      token = t;
      localStorage.setItem('duocli_token', t);
      $('login-error').textContent = '';
      enterMain();
    } else {
      $('login-error').textContent = 'Token 错误';
    }
  } catch (e) {
    $('login-error').textContent = '连接失败: ' + e.message;
  }
};

$('token-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('login-btn').click();
});

// ========== 设备页 ==========

let remoteTapEnabled = true;
let screenshotObjectUrl = null;
let androidMirror = null;
let androidJpeg = null;
let androidMirrorDevice = '';
let androidMirrorLastError = '';
let androidFallbackTimer = null;
let androidFallbackGeneration = 0;
const androidMediaSessions = new Map();
const androidMediaSessionPromises = new Map();
const androidMediaSessionGenerations = new Map();

function mirrorSurfaceSize(surface) {
  return (globalThis.DuoAndroidPointerHelpers?.surfaceContentSize || function (value) {
    return { width: value?.width || 0, height: value?.height || 0 };
  })(surface);
}

// The H.264 mirror and the JPEG/screenshot fallback paint the same surfaces but
// speak different coordinate spaces: scrcpy control messages use the encoded
// video size, while ADB injection and downscaled JPEGs use the physical device
// size. Keep their metadata in separate dataset namespaces and always read the
// one belonging to the transport that currently owns the surface; mixing them
// silently maps every touch into the wrong space.
function geometrySourceForSurface(surface) {
  if (surface instanceof HTMLCanvasElement && androidMirror?.isReady() && androidMirror.hasFrame) return 'mirror';
  return 'fallback';
}

function readSurfaceGeometry(surface, source) {
  return {
    deviceWidth: Number(surface.dataset[`${source}DeviceWidth`]) || 0,
    deviceHeight: Number(surface.dataset[`${source}DeviceHeight`]) || 0,
    latest: Number(surface.dataset[`${source}LatestGeometry`]) || 0,
    presented: Number(surface.dataset[`${source}PresentedGeometry`]) || 0,
  };
}

function writeSurfaceGeometry(surface, source, geometry) {
  if (geometry.deviceWidth) surface.dataset[`${source}DeviceWidth`] = String(geometry.deviceWidth);
  if (geometry.deviceHeight) surface.dataset[`${source}DeviceHeight`] = String(geometry.deviceHeight);
  if (geometry.latest) surface.dataset[`${source}LatestGeometry`] = String(geometry.latest);
  if (geometry.presented) surface.dataset[`${source}PresentedGeometry`] = String(geometry.presented);
}

function imgToDevice(surface, clientX, clientY) {
  const { width, height } = mirrorSurfaceSize(surface);
  const geometry = readSurfaceGeometry(surface, geometrySourceForSurface(surface));
  const physical = readSurfaceGeometry(surface, 'fallback');
  const options = {
    clientX,
    clientY,
    rect: surface.getBoundingClientRect(),
    contentWidth: width,
    contentHeight: height,
    fillsCssBox: surface instanceof HTMLCanvasElement,
    deviceWidth: geometry.deviceWidth || width,
    deviceHeight: geometry.deviceHeight || height,
    latestGeometry: geometry.latest,
    presentedGeometry: geometry.presented,
    physicalWidth: physical.deviceWidth,
    physicalHeight: physical.deviceHeight,
  };
  const helpers = globalThis.DuoAndroidPointerHelpers;
  if (typeof helpers?.mapClientPointToDevice === 'function') {
    return helpers.mapClientPointToDevice(options);
  }
  const rect = options.rect;
  if (!rect.width || !rect.height || !width || !height) return null;
  const displayed = options.fillsCssBox
    ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    : (() => {
      const scale = Math.min(rect.width / width, rect.height / height);
      return {
        left: rect.left + (rect.width - width * scale) / 2,
        top: rect.top + (rect.height - height * scale) / 2,
        width: width * scale,
        height: height * scale,
      };
    })();
  if (clientX < displayed.left || clientX > displayed.left + displayed.width
    || clientY < displayed.top || clientY > displayed.top + displayed.height) return null;
  if (options.latestGeometry && options.presentedGeometry
    && options.presentedGeometry !== options.latestGeometry) return null;
  const relativeX = (clientX - displayed.left) / displayed.width;
  const relativeY = (clientY - displayed.top) / displayed.height;
  const x = Math.max(0, Math.min(options.deviceWidth - 1, Math.round(relativeX * (options.deviceWidth - 1))));
  const y = Math.max(0, Math.min(options.deviceHeight - 1, Math.round(relativeY * (options.deviceHeight - 1))));
  const hasPhysical = options.physicalWidth > 1 && options.physicalHeight > 1;
  return {
    x,
    y,
    deviceX: hasPhysical ? Math.max(0, Math.min(options.physicalWidth - 1, Math.round(relativeX * (options.physicalWidth - 1)))) : x,
    deviceY: hasPhysical ? Math.max(0, Math.min(options.physicalHeight - 1, Math.round(relativeY * (options.physicalHeight - 1)))) : y,
  };
}

function fitAndroidSurface(surface, parent) {
  if (!surface || !parent || surface.hidden || surface.style.display === 'none') return;
  const { width, height } = mirrorSurfaceSize(surface);
  const contain = globalThis.DuoAndroidPointerHelpers?.containCssSize
    || function (availW, availH, contentW, contentH) {
      if (!availW || !availH || !contentW || !contentH) return { width: 0, height: 0 };
      const scale = Math.min(availW / contentW, availH / contentH);
      return { width: Math.max(1, Math.floor(contentW * scale)), height: Math.max(1, Math.floor(contentH * scale)) };
    };
  const size = contain(parent.clientWidth, parent.clientHeight, width, height);
  if (!size.width || !size.height) return;
  surface.style.width = `${size.width}px`;
  surface.style.height = `${size.height}px`;
  surface.style.maxWidth = '100%';
  surface.style.maxHeight = '100%';
}

function fitAndroidSurfaces() {
  const previewParent = $('device-preview-wrap');
  const fullscreenParent = $('fullscreen-screen') || $('fullscreen-overlay');
  fitAndroidSurface($('device-video'), previewParent);
  fitAndroidSurface($('device-preview'), previewParent);
  if ($('fullscreen-overlay')?.style.display !== 'none') {
    fitAndroidSurface($('fullscreen-video'), fullscreenParent);
    fitAndroidSurface($('fullscreen-preview'), fullscreenParent);
  }
}

function setAndroidVideoVisible(visible) {
  const video = $('device-video');
  const fullscreenVideo = $('fullscreen-video');
  const preview = $('device-preview');
  const fullscreenPreview = $('fullscreen-preview');
  if (video) video.hidden = !visible;
  if (preview) preview.style.display = visible ? 'none' : (preview.src ? 'block' : 'none');
  if (fullscreenVideo) fullscreenVideo.hidden = !visible;
  if (fullscreenPreview) fullscreenPreview.style.display = visible ? 'none' : (fullscreenPreview.src ? 'block' : 'none');
  const empty = $('device-preview-empty');
  if (empty) empty.style.display = visible || preview?.src ? 'none' : 'block';
  requestAnimationFrame(fitAndroidSurfaces);
}

function startAndroidFallback() {
  if (androidFallbackTimer) return;
  const fallbackDevice = androidMirrorDevice || $('device-select')?.value || '';
  if (typeof globalThis.DuoAndroidJpegClient === 'function' && fallbackDevice) {
    if (!androidJpeg) {
      androidJpeg = new globalThis.DuoAndroidJpegClient({
        getToken: () => token,
        getTicket: requestAndroidMediaTicket,
        onStatus: (message) => {
          if (message.status === 'error') setDeviceHint(`${message.error || '兼容画面暂不可用'}，正在重试`, false);
          else if (message.status === 'disconnected') setDeviceHint('兼容画面连接中断，正在恢复…', false);
        },
        onMeta: (meta) => {
          for (const id of ['device-video', 'fullscreen-video']) {
            const surface = $(id);
            if (!surface) continue;
            writeSurfaceGeometry(surface, 'fallback', {
              deviceWidth: meta.width,
              deviceHeight: meta.height,
              latest: meta.geometryVersion,
            });
          }
        },
        onFrame: (meta) => {
          for (const id of ['device-video', 'fullscreen-video']) {
            const surface = $(id);
            if (!surface) continue;
            writeSurfaceGeometry(surface, 'fallback', {
              deviceWidth: meta?.width,
              deviceHeight: meta?.height,
              latest: meta?.geometryVersion,
              presented: meta?.geometryVersion,
            });
          }
          setAndroidVideoVisible(true);
          stopAndroidFallback();
          setDeviceHint('兼容画面可操控（JPEG）', false);
          requestAnimationFrame(fitAndroidSurfaces);
        },
        onError: (error) => {
          if (error?.code === 'DECODE_FAILED') setDeviceHint('兼容画面解码失败，正在切换截图', false);
        },
      });
      androidJpeg.attachCanvas($('device-video'));
      androidJpeg.attachCanvas($('fullscreen-video'));
    }
    if (!androidJpeg.isReady() && androidJpeg.deviceId !== fallbackDevice) androidJpeg.connect(fallbackDevice, { fps: 8, quality: 72, scale: 0.75 });
    else if (!androidJpeg.isReady() && !androidJpeg.shouldReconnect) androidJpeg.connect(fallbackDevice, { fps: 8, quality: 72, scale: 0.75 });
  }
  const generation = ++androidFallbackGeneration;
  setAndroidVideoVisible(false);
  const tick = async () => {
    if (!androidFallbackTimer || generation !== androidFallbackGeneration) return;
    await refreshAndroidScreenshot(60, 0.55, true);
    if (androidFallbackTimer && generation === androidFallbackGeneration) {
      // Schedule from completion, so slow ADB calls can never pile up.
      androidFallbackTimer = setTimeout(tick, 450);
    }
  };
  androidFallbackTimer = setTimeout(tick, 0);
}

function stopAndroidFallback() {
  if (androidFallbackTimer) clearTimeout(androidFallbackTimer);
  androidFallbackTimer = null;
  androidFallbackGeneration++;
}

async function requestAndroidMediaTicket(deviceId, purpose = 'video') {
  const id = String(deviceId || '').trim();
  if (!id) throw new Error('请先选择 Android 设备');
  const key = id;
  const generation = Number(androidMediaSessionGenerations.get(key) || 0);
  const existing = androidMediaSessions.get(key);
  const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  if (existing && existing.expiresAt > Date.now() + 5000) {
    const response = await fetch(`${API}/api/android/sessions/${encodeURIComponent(existing.sessionId)}/socket-tickets`, {
      method: 'POST', headers, body: JSON.stringify({ subscriptionId: existing.subscriptionId, purpose }),
    });
    if (response.ok) {
      const data = await response.json();
      return data?.ticket || '';
    }
    androidMediaSessions.delete(key);
  }
  const inFlight = androidMediaSessionPromises.get(key);
  if (inFlight) {
    const session = await inFlight;
    const response = await fetch(`${API}/api/android/sessions/${encodeURIComponent(session.sessionId)}/socket-tickets`, {
      method: 'POST', headers, body: JSON.stringify({ subscriptionId: session.subscriptionId, purpose }),
    });
    if (!response.ok) throw new Error(`Android socket ticket 获取失败 (${response.status})`);
    const data = await response.json();
    return data?.ticket || '';
  }
  const create = (async () => {
    const response = await fetch(`${API}/api/android/sessions`, {
      method: 'POST', headers,
      body: JSON.stringify({
        deviceId: id,
        videoPreference: 'balanced',
        clientCapabilities: {
          secureContext: Boolean(globalThis.isSecureContext),
          webCodecs: typeof globalThis.VideoDecoder === 'function',
          webRtc: typeof globalThis.RTCPeerConnection === 'function',
          requestVideoFrameCallback: typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype,
        },
      }),
    });
    if (!response.ok) throw new Error(`Android 会话创建失败 (${response.status})`);
    const data = await response.json();
    const session = {
      sessionId: data.sessionId,
      clientId: typeof data.clientId === 'string' ? data.clientId : '',
      subscriptionId: data.subscriptionId,
      expiresAt: Number(data.expiresAt) || Date.now() + 30 * 60 * 1000,
    };
    if (!session.sessionId || !session.subscriptionId) throw new Error('Android 会话响应无效');
    // The device can change while the POST is in flight. Dispose the newly
    // created server lease instead of retaining an unreachable subscription.
    if (Number(androidMediaSessionGenerations.get(key) || 0) !== generation) {
      await fetch(`${API}/api/android/sessions/${encodeURIComponent(session.sessionId)}/unsubscribe`, {
        method: 'POST', headers, body: JSON.stringify({ subscriptionId: session.subscriptionId }),
      }).catch(() => {});
      throw new Error('Android 设备会话已切换');
    }
    androidMediaSessions.set(key, session);
    return session;
  })();
  androidMediaSessionPromises.set(key, create);
  try {
    const session = await create;
    const ticket = session && (await fetch(`${API}/api/android/sessions/${encodeURIComponent(session.sessionId)}/socket-tickets`, {
      method: 'POST', headers, body: JSON.stringify({ subscriptionId: session.subscriptionId, purpose }),
    }));
    if (!ticket?.ok) throw new Error(`Android socket ticket 获取失败 (${ticket?.status || 0})`);
    const data = await ticket.json();
    return data?.ticket || '';
  } finally {
    androidMediaSessionPromises.delete(key);
  }
}

function releaseAndroidMediaSession(deviceId) {
  const id = String(deviceId || '').trim();
  if (!id) return;
  androidMediaSessionGenerations.set(id, Number(androidMediaSessionGenerations.get(id) || 0) + 1);
  const session = androidMediaSessions.get(id);
  if (!session) return;
  androidMediaSessions.delete(id);
  void fetch(`${API}/api/android/sessions/${encodeURIComponent(session.sessionId)}/unsubscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ subscriptionId: session.subscriptionId }),
  }).catch(() => {});
}

function ensureAndroidMirror() {
  if (androidMirror || typeof globalThis.DuoAndroidMirrorClient !== 'function') return androidMirror;
  androidMirror = new globalThis.DuoAndroidMirrorClient({
    getToken: () => token,
    getTicket: requestAndroidMediaTicket,
    protocolVersion: 2,
    onStatus: (message) => {
      setAndroidStreamStatus(message.status);
      if (message.error) androidMirrorLastError = String(message.error);
      if (message.status === 'ready') androidMirrorLastError = '';
      if (message.status === 'starting') setDeviceHint('正在建立 Android 实时镜像…', false);
      else if (message.status === 'ready') {
        setDeviceHint('Android 实时镜像已连接', false);
        if (!androidMirror?.isController) androidMirror?.claimControl?.(true);
      } else if (message.status === 'error') {
        const detail = androidMirrorLastError || '实时镜像不可用';
        setDeviceHint(`${detail}，已切换截图回退（可全屏操控）`, false);
        startAndroidFallback();
      } else if (message.status === 'disconnected') {
        const detail = androidMirrorLastError ? `${androidMirrorLastError}，` : '';
        setDeviceHint(`${detail}实时镜像重连中…`, false);
        startAndroidFallback();
      } else if (message.status === 'control-owner' && message.controller === false) {
        setDeviceHint('设备正在由其他客户端控制，点此全屏可抢占', false);
      } else if (message.status === 'control-owner' && message.controller === true) {
        setDeviceHint('Android 实时镜像已连接', false);
      }
    },
    onMeta: (meta) => {
      for (const id of ['device-video', 'fullscreen-video']) {
        const surface = $(id);
        if (!surface) continue;
        writeSurfaceGeometry(surface, 'mirror', {
          deviceWidth: meta?.width,
          deviceHeight: meta?.height,
          latest: meta?.geometryVersion,
        });
      }
      if (androidMirror?.hasFrame) setAndroidVideoVisible(true);
      requestAnimationFrame(fitAndroidSurfaces);
    },
    onFrame: (meta) => {
      for (const id of ['device-video', 'fullscreen-video']) {
        const surface = $(id);
        if (!surface) continue;
        writeSurfaceGeometry(surface, 'mirror', {
          deviceWidth: meta?.width,
          deviceHeight: meta?.height,
          latest: meta?.geometryVersion,
          presented: meta?.geometryVersion,
        });
      }
      setAndroidVideoVisible(true);
      if (androidJpeg) { androidJpeg.close(); androidJpeg = null; }
      stopAndroidFallback();
      requestAnimationFrame(fitAndroidSurfaces);
    },
    onAck: (message) => {
      if (message?.ok === false && message.error) setDeviceHint(message.error, false);
    },
    onError: (error) => {
      const code = error?.code || '';
      const text = code === 'INSECURE_CONTEXT'
        ? '当前页面未使用 HTTPS，已切换兼容画面'
        : code === 'AUTH_EXPIRED'
          ? '视频授权已过期，正在重新连接'
        : code === 'WEBCODECS_UNAVAILABLE'
          ? '当前浏览器没有可用视频解码器，已切换兼容画面'
          : code === 'MEDIA_CONGESTED'
            ? '视频网络拥塞，正在恢复画面'
            : '实时视频暂时不可用，正在切换兼容画面';
      setDeviceHint(text, false);
      startAndroidFallback();
    },
  });
  androidMirror.attachCanvas($('device-video'));
  androidMirror.attachCanvas($('fullscreen-video'));
  return androidMirror;
}

function startAndroidMirror(deviceId) {
  const id = String(deviceId || '').trim();
  if (!id) return;
  if (androidMirrorDevice && androidMirrorDevice !== id) {
    // Invalidate the previous device's screenshot/JPEG work before starting a
    // new subscription. A slow ADB response or a late JPEG decode must never
    // paint the old phone after the selector has moved on.
    stopAndroidFallback();
    androidScreenshotRequestId++;
    androidScreenshotController?.abort();
    androidScreenshotController = null;
    if (androidJpeg) androidJpeg.close();
    androidJpeg = null;
    releaseAndroidMediaSession(androidMirrorDevice);
  }
  androidMirrorDevice = id;
  const mirror = ensureAndroidMirror();
  if (!mirror) {
    startAndroidFallback();
    return;
  }
  setAndroidVideoVisible(false);
  setAndroidStreamStatus('starting');
  mirror.connect(id);
}

function stopAndroidMirror() {
  const previousDevice = androidMirrorDevice;
  androidMirrorDevice = '';
  androidMirrorLastError = '';
  stopAndroidFallback();
  androidScreenshotRequestId++;
  androidScreenshotController?.abort();
  androidScreenshotController = null;
  if (androidMirror) androidMirror.close();
  if (androidJpeg) androidJpeg.close();
  androidJpeg = null;
  releaseAndroidMediaSession(previousDevice);
  setAndroidVideoVisible(false);
  setAndroidStreamStatus('stopped');
}

function legacyAndroidGesture(deviceId, start, end) {
  if (!deviceId || !start || !end) return;
  // ADB injects physical device pixels, which differ from the scrcpy control
  // space whenever a live mirror owns the surface.
  const from = { x: start.deviceX ?? start.x, y: start.deviceY ?? start.y };
  const to = { x: end.deviceX ?? end.x, y: end.deviceY ?? end.y };
  const moved = Math.hypot(to.x - from.x, to.y - from.y);
  const session = androidMediaSessions.get(String(deviceId));
  const controlEpoch = androidMirrorDevice === String(deviceId) && Number.isSafeInteger(androidMirror?.controlEpoch)
    ? androidMirror.controlEpoch
    : undefined;
  const lease = {
    ...(session?.clientId ? { clientId: session.clientId } : {}),
    ...(controlEpoch !== undefined ? { controlEpoch } : {}),
  };
  const body = moved >= 12
    ? { deviceId, x1: from.x, y1: from.y, x2: to.x, y2: to.y, duration: 300, ...lease }
    : { deviceId, x: to.x, y: to.y, ...lease };
  const endpoint = moved >= 12 ? '/api/android/swipe' : '/api/android/tap';
  fetch(`${API}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }).then(async (res) => {
    if (res.ok) return;
    const payload = await res.json().catch(() => ({}));
    setDeviceHint(payload?.error || `操控失败（HTTP ${res.status}）`);
  }).catch(() => setDeviceHint('操控失败：无法连接桌面端'));
}

// Keep a gesture on the live control channel once its pointer went down there.
// Falling back to the HTTP/ADB path after a control lease change can be rejected
// by the server, and sending only DOWN without a matching UP leaves Android in a
// pressed state so the next gesture appears to do nothing.
function sendLiveAndroidGesture(start, end, pointerId) {
  if (!androidMirror?.isReady() || !androidMirror.isController || androidMirror.geometryVersion <= 0) return false;
  const moved = Math.hypot(end.x - start.x, end.y - start.y);
  if (moved < 12) {
    return androidMirror.sendInput({ type: 'tap', pointerId, x: end.x, y: end.y, pressure: 1 }) != null;
  }
  const down = androidMirror.sendInput({ type: 'touch', action: 'down', pointerId, x: start.x, y: start.y, pressure: 1 });
  if (down == null) return false;
  const move = androidMirror.sendInput({ type: 'touch', action: 'move', pointerId, x: end.x, y: end.y, pressure: 1 });
  const up = move == null ? null : androidMirror.sendInput({ type: 'touch', action: 'up', pointerId, x: end.x, y: end.y, pressure: 0 });
    if (up == null) {
    // If the queue accepted DOWN but a later write failed, try to release it
    // immediately. The server also cleans active pointers on lease/socket loss.
    if (androidMirror.isReady()) {
      (androidMirror.sendEmergencyInput || androidMirror.sendInput).call(androidMirror, { type: 'touch', action: 'cancel', pointerId, x: end.x, y: end.y, pressure: 0 });
    }
    return false;
  }
  return true;
}

function bindAndroidPointerSurface(surface, alwaysControl) {
  if (!surface || surface.dataset.androidPointerBound) return;
  surface.dataset.androidPointerBound = '1';
  surface.style.touchAction = 'none';
  const active = new Map();
  const pendingMoves = new Map();
  let moveFrame = 0;
  const flushMoves = () => {
    moveFrame = 0;
    for (const [pointerId, value] of pendingMoves) {
      pendingMoves.delete(pointerId);
      const state = active.get(pointerId);
      // A screenshot/fallback gesture may span the moment the live socket
      // becomes ready. Do not inject a lone MOVE into scrcpy without the
      // matching DOWN; the gesture remains on the legacy path instead.
      if (state?.sentDown && androidMirror?.isReady() && androidMirror.isController) androidMirror.sendInput({
        type: 'touch', action: 'move', pointerId, x: value.x, y: value.y, pressure: 1,
      });
    }
  };
  const scheduleMoveFlush = () => {
    if (!moveFrame) moveFrame = requestAnimationFrame(flushMoves);
  };
  surface.addEventListener('pointerdown', (event) => {
    // A ready socket can still be waiting for its first decoded frame while a
    // JPEG/ADB fallback is the surface the user is actually touching. Keep that
    // gesture on the fallback until the live canvas has a presented frame;
    // otherwise physical fallback coordinates are sent as encoded live ones.
    const mirrorReady = androidMirror?.isReady() && androidMirror.hasFrame
      && surface instanceof HTMLCanvasElement;
    const canControl = alwaysControl || remoteTapEnabled || !mirrorReady;
    if (!canControl || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const deviceId = androidMirrorDevice || $('device-select')?.value;
    const point = imgToDevice(surface, event.clientX, event.clientY);
    if (!deviceId || !point) return;
    event.preventDefault();
    if (mirrorReady && !androidMirror.isController) {
      androidMirror.claimControl?.(true);
      setDeviceHint('正在申请 Android 控制权…', false);
    }
    const sentDown = mirrorReady && androidMirror.isController && androidMirror.geometryVersion > 0
      && androidMirror.sendInput({ type: 'touch', action: 'down', pointerId: event.pointerId, x: point.x, y: point.y, pressure: 1 }) != null;
    active.set(event.pointerId, {
      deviceId,
      start: point,
      last: point,
      sentDown,
      transport: mirrorReady ? 'mirror' : 'legacy',
    });
    surface.setPointerCapture?.(event.pointerId);
  });
  surface.addEventListener('pointermove', (event) => {
    const state = active.get(event.pointerId);
    if (!state) return;
    const point = imgToDevice(surface, event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    state.last = point;
    pendingMoves.set(event.pointerId, point);
    scheduleMoveFlush();
  });
  surface.addEventListener('pointerup', (event) => {
    const state = active.get(event.pointerId);
    if (!state) return;
    const point = imgToDevice(surface, event.clientX, event.clientY) || state.last;
    active.delete(event.pointerId);
    pendingMoves.delete(event.pointerId);
    if (moveFrame) { cancelAnimationFrame(moveFrame); moveFrame = 0; flushMoves(); }
    surface.releasePointerCapture?.(event.pointerId);
    event.preventDefault();
    if (state.transport === 'legacy') {
      legacyAndroidGesture(state.deviceId, state.start, point);
      return;
    }
    if (state.sentDown) {
      // Do not silently switch transports after DOWN. If the socket is briefly
      // unavailable, the server's lease/socket cleanup releases the pointer.
      if (androidMirror?.isReady() && androidMirror.isController) {
        androidMirror.sendInput({ type: 'touch', action: 'up', pointerId: event.pointerId, x: point.x, y: point.y, pressure: 0 });
      } else if (androidMirror?.isReady()) {
        // Reclaiming also asks the server to flush a pointer whose DOWN was
        // accepted just before the lease changed.
        (androidMirror.sendEmergencyInput || androidMirror.sendInput).call(androidMirror, { type: 'touch', action: 'cancel', pointerId: event.pointerId, x: point.x, y: point.y, pressure: 0 });
        androidMirror.claimControl?.(true);
      }
      return;
    }

    // Control ownership and the first geometry frame arrive asynchronously.
    // Give the claim a short window to complete so the first tap after connect
    // is not discarded and does not hit a lease-protected legacy endpoint.
    void (async () => {
      for (let attempt = 0; attempt < 6; attempt++) {
        if (androidMirrorDevice !== state.deviceId) return;
        if (sendLiveAndroidGesture(state.start, point, event.pointerId)) return;
        if (!androidMirror?.isReady()) {
          legacyAndroidGesture(state.deviceId, state.start, point);
          return;
        }
        if (attempt === 0 || !androidMirror.isController) androidMirror.claimControl?.(true);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      setDeviceHint('Android 控制权尚未就绪，请稍后再试', false);
    })();
  });
  surface.addEventListener('pointercancel', (event) => {
    const state = active.get(event.pointerId);
    active.delete(event.pointerId);
    pendingMoves.delete(event.pointerId);
    if (moveFrame && pendingMoves.size === 0) { cancelAnimationFrame(moveFrame); moveFrame = 0; }
    surface.releasePointerCapture?.(event.pointerId);
    if (state?.sentDown && androidMirror?.isReady()) {
      (androidMirror.sendEmergencyInput || androidMirror.sendInput).call(androidMirror, { type: 'touch', action: 'cancel', pointerId: event.pointerId, x: state.last.x, y: state.last.y, pressure: 0 });
    }
  });
  // A few mobile browsers report lost pointer capture without a subsequent
  // pointerup/pointercancel when the page is backgrounded or its viewport
  // changes. Treat it as a cancel so a stuck DOWN cannot poison later input.
  surface.addEventListener('lostpointercapture', (event) => {
    const state = active.get(event.pointerId);
    if (!state) return;
    active.delete(event.pointerId);
    pendingMoves.delete(event.pointerId);
    if (state.sentDown && androidMirror?.isReady()) {
      (androidMirror.sendEmergencyInput || androidMirror.sendInput).call(androidMirror, { type: 'touch', action: 'cancel', pointerId: event.pointerId, x: state.last.x, y: state.last.y, pressure: 0 });
    }
  });
  const cancelOnBlur = () => {
    for (const [pointerId, state] of active) {
      if (state.sentDown && androidMirror?.isReady()) {
        (androidMirror.sendEmergencyInput || androidMirror.sendInput).call(androidMirror, { type: 'touch', action: 'cancel', pointerId, x: state.last.x, y: state.last.y, pressure: 0 });
      }
      surface.releasePointerCapture?.(pointerId);
    }
    active.clear();
    pendingMoves.clear();
    if (moveFrame) { cancelAnimationFrame(moveFrame); moveFrame = 0; }
  };
  window.addEventListener('blur', cancelOnBlur);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') cancelOnBlur();
  });
}

function setAndroidStreamStatus(status) {
  const badge = $('fullscreen-auto-btn');
  if (!badge) return;
  const labels = {
    starting: '连接中',
    ready: '实时流',
    error: '截图回退',
    disconnected: '重连中',
    stopped: '已停止',
  };
  badge.textContent = labels[status] || '实时流';
  badge.dataset.status = status || '';
}

function copyAndroidCanvas(from, to) {
  if (!(from instanceof HTMLCanvasElement) || !(to instanceof HTMLCanvasElement)) return;
  if (!from.width || !from.height) return;
  // Resizing a canvas resets its 2D context. The mirror client keeps that
  // context in a map, so a copy-time resize would freeze the fullscreen feed.
  if (to.width !== from.width || to.height !== from.height) return;
  try {
    const context = to.getContext('2d');
    if (context) context.drawImage(from, 0, 0);
  } catch { /* surface may be detached */ }
}

function openAndroidFullscreen() {
  const fallbackSrc = $('device-preview')?.src || '';
  const live = Boolean(androidMirror?.hasFrame || androidJpeg?.hasFrame);
  if (fallbackSrc) $('fullscreen-preview').src = fallbackSrc;
  const preview = $('device-preview');
  const fullscreenPreview = $('fullscreen-preview');
  if (preview && fullscreenPreview) {
    writeSurfaceGeometry(fullscreenPreview, 'fallback', readSurfaceGeometry(preview, 'fallback'));
    writeSurfaceGeometry(fullscreenPreview, 'mirror', readSurfaceGeometry(preview, 'mirror'));
  }
  copyAndroidCanvas($('device-video'), $('fullscreen-video'));
  const deviceVideo = $('device-video');
  const fullscreenVideo = $('fullscreen-video');
  if (deviceVideo && fullscreenVideo) {
    writeSurfaceGeometry(fullscreenVideo, 'mirror', readSurfaceGeometry(deviceVideo, 'mirror'));
    writeSurfaceGeometry(fullscreenVideo, 'fallback', readSurfaceGeometry(deviceVideo, 'fallback'));
  }
  $('fullscreen-overlay').style.display = 'flex';
  setAndroidVideoVisible(live);
  remoteTapEnabled = true;
  androidMirror?.claimControl?.(true);
  requestAnimationFrame(fitAndroidSurfaces);
  if (live || fallbackSrc) showCopyToast('拖动操控 · 输入文字');
}

async function showPhoneControl() {
  openDevicePanel('device');
  const ready = await refreshAndroidDevices();
  if (!ready) {
    showCopyToast('请先连接 Android 设备');
    return;
  }
  const deviceId = $('device-select')?.value;
  if (deviceId) startAndroidMirror(deviceId);
  remoteTapEnabled = true;
  openAndroidFullscreen();
}

function initDevicePage() {
  const moreBtn = $('device-more-btn');
  const moreMenu = $('device-more-menu');
  const closeDeviceMoreMenu = () => {
    if (!moreMenu || moreMenu.hidden) return;
    moreMenu.hidden = true;
    moreBtn?.setAttribute('aria-expanded', 'false');
  };
  if (moreBtn && !moreBtn.dataset.bound) {
    moreBtn.dataset.bound = '1';
    moreBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      const opening = Boolean(moreMenu?.hidden);
      if (moreMenu) moreMenu.hidden = !opening;
      moreBtn.setAttribute('aria-expanded', String(opening));
    });
    moreMenu?.addEventListener('click', (event) => {
      if (event.target.closest('button')) closeDeviceMoreMenu();
    });
    document.addEventListener('click', (event) => {
      if (!moreMenu || moreMenu.hidden) return;
      if (event.target.closest('.device-header-tools')) return;
      closeDeviceMoreMenu();
    });
  }

  $('device-console-btn').onclick = () => { void showPhoneControl(); };

  $('device-back-btn').onclick = () => {
    if ($('device-page').classList.contains('landscape-drawer-open')) {
      $('device-page').classList.remove('landscape-drawer-open');
      document.body.classList.remove('landscape-device-open');
      stopAndroidMirror();
      syncLandscapePanelButtons();
      scheduleLandscapeWorkspaceResize();
      return;
    }
    stopAndroidMirror();
    const returnPage = currentDevicePanel === 'preview' && currentSessionId
      ? 'detail-page'
      : devicePanelReturnPage;
    showPage(returnPage === 'detail-page' && currentSessionId ? 'detail-page' : 'main-page');
    if (returnPage === 'detail-page' && currentSessionId) {
      requestAnimationFrame(() => {
        handleResize();
        recoverVisibleTerminal();
      });
    }
  };
  $('fullscreen-back-btn').onclick = () => {
    $('fullscreen-overlay').style.display = 'none';
  };
  const sendTextToDevice = async () => {
    const text = $('fullscreen-text-input').value;
    if (!text) return;
    const deviceId = $('device-select').value;
    if (!deviceId) { showCopyToast('请先选择设备'); return; }
    if (androidMirror?.isReady()) {
      const sequence = androidMirror.sendInput({ type: 'text', text });
      if (sequence != null) {
        try {
          const ack = await androidMirror.waitForAck(sequence);
          if (ack?.ok === false) throw new Error(ack.error || '设备未接受文字');
          $('fullscreen-text-input').value = '';
          $('input-text-modal').classList.remove('active');
          showCopyToast('已发送');
        } catch (error) {
          showCopyToast(error?.message || '文字发送结果未知');
        }
        return;
      }
    }
    const response = await fetch(`${API}/api/android/input-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        deviceId,
        text,
        ...(androidMediaSessions.get(String(deviceId))?.clientId
          ? { clientId: androidMediaSessions.get(String(deviceId)).clientId }
          : {}),
        ...(androidMirrorDevice === String(deviceId) && Number.isSafeInteger(androidMirror?.controlEpoch)
          ? { controlEpoch: androidMirror.controlEpoch }
          : {}),
      }),
    }).catch(() => {});
    if (response?.ok) {
      $('fullscreen-text-input').value = '';
      $('input-text-modal').classList.remove('active');
      showCopyToast('已发送（截图回退）');
    } else showCopyToast('文字发送失败，请重试');
  };
  $('fullscreen-text-btn').onclick = () => {
    $('fullscreen-text-input').value = '';
    $('input-text-modal').classList.add('active');
    setTimeout(() => $('fullscreen-text-input').focus(), 100);
  };
  $('input-text-close').onclick = () => $('input-text-modal').classList.remove('active');
  $('fullscreen-text-send').onclick = sendTextToDevice;
  $('fullscreen-text-input').addEventListener('keydown', e => { if (e.key === 'Enter') void sendTextToDevice(); });

  $('device-fullscreen-btn').onclick = openAndroidFullscreen;

  // Persistent mirror input: send down/move/up immediately over the control
  // channel. The old image-only touch handlers are intentionally not kept;
  // they made a swipe arrive only after the gesture had already ended.
  const deviceVideo = $('device-video');
  const devicePreview = $('device-preview');
  const fullscreenVideo = $('fullscreen-video');
  const fullscreenPreview = $('fullscreen-preview');
  bindAndroidPointerSurface(deviceVideo, true);
  bindAndroidPointerSurface(devicePreview, true);
  bindAndroidPointerSurface(fullscreenVideo, true);
  bindAndroidPointerSurface(fullscreenPreview, true);
  [deviceVideo, devicePreview].forEach((surface) => {
    surface?.addEventListener('click', () => {
      if ($('fullscreen-overlay')?.style.display === 'none') openAndroidFullscreen();
    });
  });

  const syncRemoteTapUi = () => {
    const button = $('device-tap-toggle');
    if (button) {
      button.textContent = remoteTapEnabled ? '远程点击 · 已开' : '远程点击 · 已关';
      button.setAttribute('aria-pressed', String(remoteTapEnabled));
    }
    [deviceVideo, devicePreview].forEach((surface) => {
      if (surface) surface.style.cursor = remoteTapEnabled ? 'crosshair' : 'default';
    });
  };
  syncRemoteTapUi();
  if (!$('device-preview-wrap')?.dataset.fitObserved) {
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fitAndroidSurfaces()) : null;
    const previewWrap = $('device-preview-wrap');
    const fullscreenScreen = $('fullscreen-screen') || $('fullscreen-overlay');
    if (previewWrap) observer?.observe(previewWrap);
    if (fullscreenScreen) observer?.observe(fullscreenScreen);
    if (previewWrap) previewWrap.dataset.fitObserved = '1';
  }

  $('device-refresh-btn').onclick = () => { void refreshAndroidDevices(); };
  $('device-shot-btn').onclick = () => {
    showCopyToast('正在刷新截图...');
    void refreshAndroidScreenshot();
  };
  $('device-tap-toggle').onclick = () => {
    remoteTapEnabled = !remoteTapEnabled;
    syncRemoteTapUi();
    showCopyToast(remoteTapEnabled ? '远程控制已开启' : '远程控制已关闭');
  };
  $('device-select').onchange = () => {
    const id = $('device-select').value;
    if (id) {
      localStorage.setItem('duocli_android_device', id);
      startAndroidMirror(id);
    } else {
      stopAndroidMirror();
    }
  };
}

function setDeviceHint(msg, notify = Boolean(msg)) {
  const hint = $('device-hint');
  if (hint) { hint.textContent = msg; hint.hidden = !msg; }
  if (notify && msg) showCopyToast(msg);
}

async function refreshAndroidDevices() {
  setDeviceHint('正在加载设备...');
  const sel = $('device-select');
  sel.disabled = true;
  try {
    const data = await api('/api/android/devices');
    const saved = localStorage.getItem('duocli_android_device');
    sel.innerHTML = '';
    if (data.devices.length) {
      for (const d of data.devices) {
        // 用 DOM API 而非 innerHTML 拼接，避免 adb 输出里的 OEM 设备名注入 HTML
        const opt = document.createElement('option');
        opt.value = d.id;
        const state = d.state || (d.info || '').split(' ')[0] || 'device';
        opt.disabled = d.available === false || !['device', ''].includes(state);
        const reason = state === 'unauthorized' ? '请在手机上允许 USB 调试' : state === 'offline' ? '设备离线，请重新连接' : state;
        opt.textContent = opt.disabled ? `${d.id}（${reason}）` : (d.info ? `${d.id} ${d.info}` : d.id);
        if (d.id === saved && !opt.disabled) opt.selected = true;
        sel.appendChild(opt);
      }
    } else {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '未找到设备';
      sel.appendChild(opt);
    }
    const usable = Array.from(sel.options).filter(option => option.value && !option.disabled);
    if (!usable.some(option => option.selected)) sel.value = usable[0]?.value || '';
    if (usable.length) {
      startAndroidMirror(sel.value);
      setDeviceHint('', false);
    } else {
      stopAndroidMirror();
      setDeviceHint(data.devices.length ? '设备未就绪：请允许 USB 调试或重新连接离线设备' : '未找到已连接的 Android 设备');
    }
    return usable.length > 0;
  } catch (e) {
    sel.replaceChildren(new Option('设备检测失败，请刷新重试', ''));
    setDeviceHint('获取设备失败: ' + (e.message || e));
    return false;
  } finally {
    sel.disabled = false;
  }
}

let androidFallbackInFlight = false;
let androidScreenshotRequestId = 0;
let androidScreenshotController = null;

async function refreshAndroidScreenshot(quality, scale, fallback = false) {
  const deviceId = $('device-select').value;
  if (!deviceId) { setDeviceHint('请先选择设备'); return; }
  if (fallback && androidFallbackInFlight) return;
  if (fallback) androidFallbackInFlight = true;
  const requestId = ++androidScreenshotRequestId;
  if (!fallback && androidScreenshotController) androidScreenshotController.abort();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  androidScreenshotController = controller;
  try {
    let url = `${API}/api/android/screenshot?deviceId=${encodeURIComponent(deviceId)}`;
    if (quality) url += `&quality=${quality}`;
    if (scale) url += `&scale=${scale}`;
    const res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (requestId !== androidScreenshotRequestId || deviceId !== $('device-select').value) return;
    const nextUrl = URL.createObjectURL(blob);
    const previousUrl = screenshotObjectUrl;
    screenshotObjectUrl = nextUrl;
    const img = $('device-preview');
    const fullscreen = $('fullscreen-preview');
    const deviceWidth = Number(res.headers.get('X-DuoCLI-Device-Width')) || 0;
    const deviceHeight = Number(res.headers.get('X-DuoCLI-Device-Height')) || 0;
    const geometryVersion = Number(res.headers.get('X-DuoCLI-Geometry-Version')) || 0;
    for (const surface of [img, fullscreen]) {
      writeSurfaceGeometry(surface, 'fallback', {
        deviceWidth,
        deviceHeight,
        latest: geometryVersion,
        presented: geometryVersion,
      });
    }
    let surfacesLoaded = 0;
    const releasePrevious = () => {
      surfacesLoaded++;
      if (surfacesLoaded >= 2 && previousUrl) URL.revokeObjectURL(previousUrl);
    };
    img.onload = releasePrevious;
    fullscreen.onload = releasePrevious;
    img.src = nextUrl;
    fullscreen.src = nextUrl;
    if (fallback && !androidMirror?.hasFrame) setAndroidVideoVisible(false);
    if (fallback && !androidMirror?.isReady()) {
      setDeviceHint(androidMirrorLastError
        ? `${androidMirrorLastError}，截图模式可操控`
        : '截图模式可操控（实时镜像重连中）', false);
    } else if (!fallback) setDeviceHint('截图更新于 ' + new Date().toLocaleTimeString());
  } catch (e) {
    if (e?.name === 'AbortError') return;
    if (!fallback) setDeviceHint('截图失败: ' + (e.message || e));
  } finally {
    clearTimeout(timeout);
    if (fallback) androidFallbackInFlight = false;
    if (androidScreenshotController === controller) androidScreenshotController = null;
  }
}

// ========== 主页面 ==========

async function enterMain() {
  showPage('main-page');
  initDevicePage();
  await refreshSessions();
  await Promise.all([
    refreshRecentCwdOptions(),
    pullCustomPresetsFromServer(), // 从服务端同步自定义预设
    refreshBuiltinOptions(), // 按本机 CLI 是否安装过滤预制
    refreshPresetUsage(), // 使用频率，决定下拉排序
  ]);
  renderPresetSelect();
  startSSE();
  subscribePush();
  // 启动局域网探测（CF 模式提示切换；LAN 模式监控失联回退）
  LanSwitcher.start();
}

async function refreshSessions() {
  try {
    const [sessions, closed] = await Promise.all([
      api('/api/sessions'),
      api('/api/closed-sessions').catch(() => []),
    ]);
    activeSessionsCache = Array.isArray(sessions) ? sessions : [];
    closedSessions = Array.isArray(closed) ? closed : [];
    renderSessionList();
  } catch (e) {
    console.error('刷新会话失败', e);
  }
}

function cliTagHtml(dn, tagColor, tagBg) {
  const logoUrl = getLogoUrl(dn);
  const fallback = typeof getDefaultLogoUrl === 'function' ? getDefaultLogoUrl() : logoUrl;
  return `<span class="cli-tag" style="--cli-c:${tagColor};--cli-bg:${tagBg}"><img class="cli-logo-img" src="${logoUrl}" alt="${escHtml(dn)}" data-fallback="${fallback}" onerror="this.onerror=null;this.src=this.dataset.fallback||this.src"><span>${escHtml(dn)}</span></span>`;
}

function renderClosedSessionCard(cs) {
  const dn = cs.displayName || '';
  const [tagColor, tagBg] = dn ? getCliTagColors(dn) : ['', ''];

  let tagHtml = '';
  if (dn) tagHtml = cliTagHtml(dn, tagColor, tagBg);
  
  const restoring = restoringClosedSessionIds.has(cs.id) || cs.state === 'restoring';
  return `
    <div class="session-card session-card-closed" data-closed-id="${escHtml(cs.id)}">
      <div class="session-card-body">
        <div class="status-dot exited"></div>
        <div class="session-info">
          <div class="session-title-row">
            <div class="session-title">${escHtml(cs.title || '新对话')}</div>
            ${tagHtml}
          </div>
          <div class="session-meta">
            <span class="session-time">${formatTime(cs.closedAt)}</span>
            <span class="session-cwd">${escHtml((cs.cwd || '').split('/').pop() || cs.cwd || '')}</span>
          </div>
        </div>
        <div class="closed-session-actions">
          <button type="button" class="closed-restore-btn" title="恢复会话" ${restoring ? 'disabled' : ''} aria-label="恢复会话">
            ${restoring ? '…' : iconSvg('restore', 16)}
          </button>
          <button type="button" class="closed-remove-btn" title="删除记录" ${restoring ? 'disabled' : ''} aria-label="删除记录">
            ${iconSvg('x', 16)}
          </button>
        </div>
      </div>
    </div>`;
}

async function restoreClosedSession(cs) {
  if (!cs || restoringClosedSessionIds.has(cs.id) || cs.state === 'restoring') return;
  const resumeCmd = (cs.resumeCommand || '').trim();
  if (!resumeCmd) {
    showCopyToast('无法恢复此会话');
    return;
  }

  restoringClosedSessionIds.add(cs.id);
  renderSessionList();
  let claimed = false;
  let sessionId = null;
  try {
    await api(`/api/closed-sessions/${encodeURIComponent(cs.id)}/begin-restore`, { method: 'POST' });
    claimed = true;

    const session = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ cwd: cs.cwd, presetCommand: resumeCmd, themeId: 'default' }),
    });
    sessionId = session.id;

    const result = await api(`/api/closed-sessions/${encodeURIComponent(cs.id)}/confirm-restore`, {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    });

    if (result.ok) {
      await refreshSessions();
      openSession(sessionId);
      showCopyToast('会话已恢复');
      return;
    }

    await api(`/api/closed-sessions/${encodeURIComponent(cs.id)}/cancel-restore`, { method: 'POST' }).catch(() => {});
    showCopyToast('恢复未确认，请查看终端输出');
    openSession(sessionId);
  } catch (e) {
    if (claimed) {
      await api(`/api/closed-sessions/${encodeURIComponent(cs.id)}/cancel-restore`, { method: 'POST' }).catch(() => {});
    }
    showCopyToast('恢复失败: ' + (e.message || e));
    if (sessionId) openSession(sessionId);
  } finally {
    restoringClosedSessionIds.delete(cs.id);
    await refreshSessions();
  }
}

async function removeClosedSession(id) {
  try {
    const res = await api(`/api/closed-sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    closedSessions = Array.isArray(res.items) ? res.items : closedSessions.filter(item => item.id !== id);
    renderSessionList();
  } catch (e) {
    showCopyToast('删除失败: ' + (e.message || e));
  }
}

async function clearClosedSessions() {
  if (!closedSessions.length) return;
  if (!confirm(`确定清空 ${closedSessions.length} 条已关闭记录？`)) return;
  try {
    await api('/api/closed-sessions', { method: 'DELETE' });
    closedSessions = [];
    renderSessionList();
  } catch (e) {
    showCopyToast('清空失败: ' + (e.message || e));
  }
}

async function refreshRecentCwdOptions() {
  const select = $('new-cwd');
  if (!select) return;
  try {
    const res = await api('/api/recent-cwds');
    const items = Array.isArray(res?.items) ? res.items : [];
    // 保留第一个默认选项
    const defaultOpt = select.querySelector('option');
    select.innerHTML = '';
    if (defaultOpt) select.appendChild(defaultOpt);
    for (const p of items) {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = shortenPath(p);
      select.appendChild(opt);
    }
  } catch {
    // 保留默认选项
  }
}

// ========== 会话卡片左滑关闭 ==========

const SESSION_SWIPE_REVEAL = 84;
// Touch jitter while a finger is settling on a card should stay a tap (or a
// vertical list scroll). Wait for a deliberate horizontal travel before the
// card starts exposing the action underneath it.
const SESSION_SWIPE_TRIGGER = 28;
const SESSION_SWIPE_DIRECTION_RATIO = 1.25;
// 记住 id 而不是节点：SSE 随时会重渲染列表，滑动状态要跟着新节点恢复。
let swipedSessionId = null;
let sessionCloseInProgress = false;

function setSessionCardSwipe(card, offset, instant = false) {
  const body = card.querySelector('.session-card-body');
  if (!body) return;
  if (instant) {
    body.style.transition = 'none';
    body.style.transform = offset ? `translateX(${offset}px)` : '';
    void body.offsetWidth; // 强制回流，跳过补间动画
    body.style.transition = '';
  } else {
    body.style.transform = offset ? `translateX(${offset}px)` : '';
  }
  card.classList.toggle('swiped', offset !== 0);
  card.querySelector('.session-close-action')?.toggleAttribute('aria-hidden', offset === 0);
}

function closeSessionCardSwipe(card) {
  if (!card) return;
  setSessionCardSwipe(card, 0);
  if (card.dataset.id === swipedSessionId) swipedSessionId = null;
}

function findSessionCard(id) {
  const list = $('session-list');
  if (!list) return null;
  return [...list.querySelectorAll('.session-card[data-id]')].find(card => card.dataset.id === id) || null;
}

function closeSwipedSessionCard() {
  const card = swipedSessionId ? findSessionCard(swipedSessionId) : null;
  if (card) closeSessionCardSwipe(card);
  else swipedSessionId = null;
}

async function closeSessionFromList(id, title) {
  if (sessionCloseInProgress) return;
  if (!confirm(`确定关闭对话「${title}」吗？`)) return;
  sessionCloseInProgress = true;
  try {
    await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    swipedSessionId = null;
    await refreshSessions();
  } catch (e) {
    alert('关闭失败: ' + (e.message || e));
  } finally {
    sessionCloseInProgress = false;
  }
}

function bindSessionCard(card) {
  const id = card.dataset.id;
  let startX = 0;
  let startY = 0;
  let baseOffset = 0;
  let offset = 0;
  let swiping = false;
  let dragged = false;

  card.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    if (swipedSessionId && swipedSessionId !== id) closeSwipedSessionCard();
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    baseOffset = swipedSessionId === id ? -SESSION_SWIPE_REVEAL : 0;
    offset = baseOffset;
    swiping = false;
    dragged = false;
  }, { passive: true });

  card.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    if (!touch) return;
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    if (!swiping) {
      const horizontalDistance = Math.abs(dx);
      const horizontalIntent = horizontalDistance >= SESSION_SWIPE_TRIGGER
        && horizontalDistance >= Math.abs(dy) * SESSION_SWIPE_DIRECTION_RATIO;
      // A closed card only responds to a deliberate left swipe. An already
      // open card accepts either direction so a right swipe can close it.
      const allowedDirection = baseOffset < 0 || dx < 0;
      // Keep the gesture with the browser until both distance and direction
      // are clear; this prevents tiny diagonal movements from revealing red.
      if (!horizontalIntent || !allowedDirection) return;
      swiping = true;
      dragged = true;
      card.classList.add('dragging');
    }
    if (e.cancelable) e.preventDefault();
    const next = baseOffset + dx;
    offset = Math.min(next < -SESSION_SWIPE_REVEAL
      ? -SESSION_SWIPE_REVEAL + (next + SESSION_SWIPE_REVEAL) * 0.25
      : next, 12);
    setSessionCardSwipe(card, offset, true);
  }, { passive: false });

  const endSwipe = () => {
    if (!swiping) return;
    swiping = false;
    card.classList.remove('dragging');
    if (offset <= -SESSION_SWIPE_REVEAL / 2) {
      setSessionCardSwipe(card, -SESSION_SWIPE_REVEAL);
      swipedSessionId = id;
    } else {
      closeSessionCardSwipe(card);
    }
  };
  card.addEventListener('touchend', endSwipe, { passive: true });
  card.addEventListener('touchcancel', endSwipe, { passive: true });

  card.onclick = () => {
    if (dragged) { dragged = false; return; }
    if (swipedSessionId === id) { closeSessionCardSwipe(card); return; }
    openSession(id);
  };

  const closeBtn = card.querySelector('.session-close-action');
  if (closeBtn) {
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      const title = card.querySelector('.session-title')?.textContent || '对话';
      void closeSessionFromList(id, title);
    };
  }
}

function renderSessionList() {
  const list = $('session-list');
  const empty = $('empty-state');
  const sessions = activeSessionsCache;

  const activeCards = sessions.map(s => {
    const dn = s.displayName || '';
    const [tagColor, tagBg] = dn ? getCliTagColors(dn) : ['', ''];
    
    // 构建 CLI 标签 HTML（带 logo）
    let tagHtml = '';
    if (dn) tagHtml = cliTagHtml(dn, tagColor, tagBg);
    return `
    <div class="session-card" data-id="${s.id}">
      <button type="button" class="session-close-action" aria-hidden="true" aria-label="关闭对话">
        ${iconSvg('trash', 18)}<span>关闭</span>
      </button>
      <div class="session-card-body">
        <div class="status-dot ${s.status}"></div>
        <div class="session-info">
          <div class="session-title-row">
            <div class="session-title">${escHtml(s.title || s.presetCommand || '终端')}</div>
            ${tagHtml}
          </div>
          <div class="session-meta">
            <span class="session-time">${formatTime(s.createdAt)}</span>
            <span class="session-cwd">${escHtml(String(s.cwd || '').split('/').pop() || s.cwd || '')}</span>
          </div>
        </div>
        <div class="session-arrow">›</div>
      </div>
    </div>`;
  }).join('');

  let closedHtml = '';
  if (closedSessions.length > 0) {
    const sorted = [...closedSessions].sort((a, b) => b.closedAt - a.closedAt);
    const cards = closedSessionsCollapsed ? '' : sorted.map(renderClosedSessionCard).join('');
    closedHtml = `
      <div class="closed-sessions-header">
        <div class="closed-sessions-label">${iconSvg('archive', 14)}<span>已关闭 (${closedSessions.length})</span></div>
        <div class="closed-sessions-tools">
          <button type="button" class="closed-toggle-btn" title="${closedSessionsCollapsed ? '展开' : '收起'}" aria-label="${closedSessionsCollapsed ? '展开' : '收起'}">
            ${iconSvg(closedSessionsCollapsed ? 'chevron-right' : 'chevron-down', 16)}
          </button>
          <button type="button" class="closed-clear-btn" title="清空全部" aria-label="清空全部">
            ${iconSvg('trash', 16)}
          </button>
        </div>
      </div>
      ${cards}`;
  }

  if (!sessions.length && !closedSessions.length) {
    list.innerHTML = '';
    list.hidden = true;
    empty.style.display = 'flex';
    return;
  }

  list.hidden = false;
  empty.style.display = 'none';
  list.innerHTML = activeCards + closedHtml;

  list.querySelectorAll('.session-card[data-id]').forEach(card => bindSessionCard(card));
  // 列表刚被整体重建，之前滑开的卡片要立刻恢复展开态，否则用户点不到「关闭」。
  if (swipedSessionId) {
    const swiped = findSessionCard(swipedSessionId);
    if (swiped) setSessionCardSwipe(swiped, -SESSION_SWIPE_REVEAL, true);
    else swipedSessionId = null;
  }

  const toggleBtn = list.querySelector('.closed-toggle-btn');
  if (toggleBtn) {
    toggleBtn.onclick = (e) => {
      e.stopPropagation();
      closedSessionsCollapsed = !closedSessionsCollapsed;
      renderSessionList();
    };
  }

  const clearBtn = list.querySelector('.closed-clear-btn');
  if (clearBtn) {
    clearBtn.onclick = (e) => {
      e.stopPropagation();
      void clearClosedSessions();
    };
  }

  list.querySelectorAll('.session-card-closed').forEach(card => {
    const id = card.dataset.closedId;
    const cs = closedSessions.find(item => item.id === id);
    const restoreBtn = card.querySelector('.closed-restore-btn');
    const removeBtn = card.querySelector('.closed-remove-btn');
    if (restoreBtn) {
      restoreBtn.onclick = (e) => {
        e.stopPropagation();
        if (cs) void restoreClosedSession(cs);
      };
    }
    if (removeBtn) {
      removeBtn.onclick = (e) => {
        e.stopPropagation();
        void removeClosedSession(id);
      };
    }
  });
}

// ========== SSE 实时更新 ==========

function startSSE() {
  stopSSE();
  const profile = getNetworkProfile();
  sseSource = new EventSource(`${API}/api/events?token=${encodeURIComponent(token)}`);
  sseSource.onopen = () => {
    sseReconnectAttempt = 0;
  };
  sseSource.addEventListener('sessions', e => {
    try {
      activeSessionsCache = JSON.parse(e.data);
      if ($('main-page').classList.contains('active') || $('main-page').classList.contains('landscape-drawer-open')) {
        renderSessionList();
      }
      if (currentSessionId) {
        const s = activeSessionsCache.find(x => x.id === currentSessionId);
        if (s) {
          $('detail-status').className = `status-dot ${s.status}`;
        }
      }
    } catch {}
  });
  sseSource.addEventListener('closed-sessions', e => {
    try {
      closedSessions = JSON.parse(e.data);
      if ($('main-page').classList.contains('active') || $('main-page').classList.contains('landscape-drawer-open')) {
        renderSessionList();
      }
    } catch {}
  });
  sseSource.onerror = () => {
    stopSSE();
    if (navigator.onLine === false) return;
    if (sseReconnectTimer) clearTimeout(sseReconnectTimer);
    // Token 被桌面端轮换后，SSE 会断；先探测 API，401 则回登录页重新授权
    void (async () => {
      try {
        const r = await fetch(`${API}/api/sessions`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (r.status === 401) {
          logout();
          return;
        }
      } catch { /* ignore */ }
      if (!token) return;
      const delay = Math.min(profile.sseRetryBaseMs * Math.pow(2, sseReconnectAttempt), profile.sseRetryMaxMs) + Math.floor(Math.random() * 600);
      sseReconnectAttempt++;
      sseReconnectTimer = setTimeout(() => {
        sseReconnectTimer = null;
        // 会话主页或横屏会话侧栏可见时维持 SSE，保证列表可实时切换。
        if (!token) return;
        if ($('main-page').classList.contains('active') || $('main-page').classList.contains('landscape-drawer-open')) {
          startSSE();
        }
      }, delay);
    })();
  };
}

function stopSSE() {
  if (sseReconnectTimer) { clearTimeout(sseReconnectTimer); sseReconnectTimer = null; }
  if (sseSource) { sseSource.close(); sseSource = null; }
}

// 发送输入：普通文本走 input_b64；回车统一补发 hex(0d)，避免仅靠字符串换行不执行
function sendInputWithHexEnter(raw) {
  if (!raw) return;
  if (!isTerminalInputReady()) {
    showCopyToast('终端连接中，请稍候再发送');
    return;
  }
  let chunk = '';
  const flushChunk = () => {
    if (!chunk) return;
    wsSend({ type: 'input', data: chunk });
    chunk = '';
  };

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\r' || ch === '\n') {
      flushChunk();
      // CRLF 只发一次回车
      if (ch === '\n' && i > 0 && raw[i - 1] === '\r') continue;
      wsSendHex('0d');
    } else {
      chunk += ch;
    }
  }
  flushChunk();
}

// ========== xterm.js 终端 ==========

async function loadMobileFileTreeDirectory(tree, dirPath, force = false) {
  const key = dirPath || '__root__';
  const cached = tree.cache.get(key);
  if (!force && cached) {
    return { path: dirPath || tree.rootPath, root: tree.rootPath, items: cached };
  }
  const query = dirPath ? `?path=${encodeURIComponent(dirPath)}` : '';
  const data = await api(`/api/sessions/${encodeURIComponent(currentSessionId)}/file-tree${query}`);
  const items = Array.isArray(data.items) ? data.items : [];
  const actualPath = data.path || dirPath || data.root || '';
  if (data.root) tree.rootPath = data.root;
  tree.cache.set(key, items);
  if (actualPath) tree.cache.set(actualPath, items);
  return { path: actualPath, root: tree.rootPath, items };
}

function filterFileTreeItems(items, filter) {
  const helpers = globalThis.DuoFilePreviewHelpers;
  const matcher = helpers?.matchesFileBrowseFilter
    ? (item) => helpers.matchesFileBrowseFilter(item, filter)
    : (item) => !item.isDir || item.name !== 'node_modules';
  return (Array.isArray(items) ? items : []).filter(matcher);
}

async function renderFileTree(options) {
  const {
    listEl,
    pathEl,
    tree,
    filter = 'all',
    force = false,
    onFileOpen,
    emptyLabel = '当前目录为空',
  } = options;
  if (!listEl || !currentSessionId) return;
  const { cache, expandedDirs, requestRef } = tree;
  const requestId = ++requestRef.id;
  if (force) cache.clear();
  listEl.innerHTML = '<div class="mobile-file-tree-status">正在加载文件树…</div>';
  try {
    const rootData = await loadMobileFileTreeDirectory(tree, '', force);
    if (requestId !== requestRef.id || !currentSessionId) return;
    if (pathEl) pathEl.textContent = rootData.root || rootData.path || '当前项目';
    listEl.innerHTML = '';

    const appendItems = async (items, level) => {
      const visibleItems = filterFileTreeItems(items, filter);
      for (const item of visibleItems) {
        if (requestId !== requestRef.id) return;
        const row = document.createElement('button');
        row.type = 'button';
        row.className = `mobile-file-tree-row${item.isDir ? ' directory' : ' file'}`;
        row.style.paddingLeft = `${10 + level * 18}px`;
        const icon = document.createElement('span');
        icon.className = 'mobile-file-tree-icon';
        const expanded = item.isDir && expandedDirs.has(item.path);
        icon.innerHTML = item.isDir
          ? `${iconSvg(expanded ? 'chevron-down' : 'chevron-right', 10)}${iconSvg('folder', 13)}`
          : iconSvg('file', 13);
        const name = document.createElement('span');
        name.className = 'mobile-file-tree-name';
        name.textContent = item.name;
        row.append(icon, name);
        row.addEventListener('contextmenu', (event) => showMobileFileTreeMenu(event, item));
        row.onclick = async () => {
          if (!item.isDir) {
            onFileOpen(item.path);
            return;
          }
          if (expandedDirs.has(item.path)) expandedDirs.delete(item.path);
          else expandedDirs.add(item.path);
          await renderFileTree({ ...options, force: false });
        };
        listEl.appendChild(row);
        if (item.isDir && expanded) {
          try {
            const childData = await loadMobileFileTreeDirectory(tree, item.path, false);
            await appendItems(childData.items, level + 1);
          } catch (error) {
            const errorRow = document.createElement('div');
            errorRow.className = 'mobile-file-tree-status error';
            errorRow.style.paddingLeft = `${28 + level * 18}px`;
            errorRow.textContent = error.message || '读取目录失败';
            listEl.appendChild(errorRow);
          }
        }
      }
    };
    await appendItems(rootData.items, 0);
    if (!listEl.children.length) {
      listEl.innerHTML = `<div class="mobile-file-tree-status">${emptyLabel}</div>`;
    }
  } catch (error) {
    if (requestId !== requestRef.id) return;
    listEl.innerHTML = `<div class="mobile-file-tree-status error">${escapeHtml(error.message || '文件树加载失败')}</div>`;
  }
}

async function renderMobileFileTree(force = false) {
  await renderFileTree({
    listEl: $('mobile-file-tree-list'),
    pathEl: $('mobile-file-tree-path'),
    tree: mobileFileTree,
    filter: 'all',
    force,
    onFileOpen: (filePath) => openFilePreview(filePath),
    emptyLabel: '当前目录为空',
  });
}

async function renderFileBrowseTree(force = false) {
  const filterLabels = { all: '全部文件', media: '媒体文件', document: '文档' };
  await renderFileTree({
    listEl: $('file-browse-tree-list'),
    pathEl: $('file-browse-path-label'),
    tree: fileBrowseTree,
    filter: fileBrowseFilter,
    force,
    onFileOpen: (filePath) => openFilePreview(filePath, { returnPage: 'media-browse-page', useStandalonePreview: true }),
    emptyLabel: fileBrowseFilter === 'all' ? '当前目录为空' : `没有匹配的${filterLabels[fileBrowseFilter] || '文件'}`,
  });
}

function openFilePreview(requestedPath, options = {}) {
  if (!currentSessionId) return;
  const helpers = globalThis.DuoFilePreviewHelpers;
  if (helpers?.isPreviewableFileName && !helpers.isPreviewableFileName(requestedPath)) {
    showCopyToast('该文件暂不支持在手机端预览');
    return;
  }

  const sessionId = currentSessionId;
  const requestId = ++mobileFilePreviewRequest;
  const useStandalonePreview = options.useStandalonePreview === true;
  filePreviewReturnPage = options.returnPage || 'detail-page';

  const title = useStandalonePreview ? $('file-preview-title') : $('mobile-file-preview-title');
  const meta = useStandalonePreview ? $('file-preview-meta') : $('mobile-file-preview-meta');
  const content = useStandalonePreview ? $('file-preview-content') : $('mobile-file-preview-content');
  const mediaBox = useStandalonePreview ? $('file-preview-media') : $('mobile-file-preview-media');
  const legacyTitle = $('file-preview-title');
  const legacyMeta = $('file-preview-meta');
  const legacyContent = $('file-preview-content');
  if (!title || !meta || !content) return;

  const baseName = requestedPath.split(/[\\/]/).pop() || requestedPath;
  title.textContent = baseName;
  meta.textContent = '正在读取…';
  content.textContent = '';
  content.style.display = '';
  if (mediaBox) mediaBox.innerHTML = '';
  if (legacyTitle) legacyTitle.textContent = baseName;
  if (legacyMeta) legacyMeta.textContent = '正在读取…';
  if (legacyContent) legacyContent.textContent = '';

  if (useStandalonePreview) {
    showPage('file-preview-page');
  } else {
    if (!$('detail-page').classList.contains('active')) showPage('detail-page');
    openDevicePanel('preview');
    $('file-preview-page').classList.add('active', 'legacy-preview-active');
  }

  const mediaKind = helpers?.getMediaKind?.(requestedPath);
  if (mediaKind) {
    const mediaUrl = `${API}/api/sessions/${encodeURIComponent(sessionId)}/media?path=${encodeURIComponent(requestedPath)}&token=${encodeURIComponent(token)}`;
    meta.textContent = requestedPath;
    renderMediaPreview(mediaKind, mediaUrl, baseName, requestedPath, mediaBox, content);
    return;
  }

  api(`/api/sessions/${encodeURIComponent(sessionId)}/file-preview?path=${encodeURIComponent(requestedPath)}`)
    .then((data) => {
      if (requestId !== mobileFilePreviewRequest || currentSessionId !== sessionId) return;
      title.textContent = data.name || requestedPath;
      meta.textContent = data.path || requestedPath;
      content.textContent = typeof data.content === 'string' ? data.content : '';
      if (legacyTitle) legacyTitle.textContent = title.textContent;
      if (legacyMeta) legacyMeta.textContent = meta.textContent;
      if (legacyContent) legacyContent.textContent = content.textContent;
    })
    .catch((error) => {
      if (requestId !== mobileFilePreviewRequest || currentSessionId !== sessionId) return;
      meta.textContent = '';
      showCopyToast(error.message || '文件预览失败');
    });
}

// 按媒体类型渲染预览元素到 #file-preview-media
function renderMediaPreview(kind, mediaUrl, name, fullPath, mediaBox = $('mobile-file-preview-media'), content = $('mobile-file-preview-content')) {
  if (!mediaBox) return;
  mediaBox.innerHTML = '';
  content.style.display = 'none';

  const wrap = document.createElement('div');
  wrap.className = 'media-preview-wrap';

  if (kind === 'image') {
    const img = document.createElement('img');
    img.src = mediaUrl;
    img.alt = name;
    img.className = 'media-img';
    img.onerror = () => {
      mediaBox.innerHTML = `<div class="media-error"><span class="ui-status-icon">${iconSvg('alert', 14)}</span>图片加载失败：${escapeHtml(name)}</div>`;
    };
    wrap.appendChild(img);
  } else if (kind === 'video') {
    const video = document.createElement('video');
    video.src = mediaUrl;
    video.controls = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.className = 'media-video';
    video.onerror = () => {
      mediaBox.innerHTML = `<div class="media-error"><span class="ui-status-icon">${iconSvg('alert', 14)}</span>视频加载失败：${escapeHtml(name)}<br><span class="media-error-hint">mov 等格式浏览器可能不支持，建议在桌面端查看</span></div>`;
    };
    wrap.appendChild(video);
  } else if (kind === 'audio') {
    const audio = document.createElement('audio');
    audio.src = mediaUrl;
    audio.controls = true;
    audio.preload = 'metadata';
    audio.className = 'media-audio';
    wrap.appendChild(audio);
    const hint = document.createElement('div');
    hint.className = 'media-audio-name';
    hint.textContent = name;
    wrap.appendChild(hint);
  } else if (kind === 'pdf') {
    const iframe = document.createElement('iframe');
    iframe.src = mediaUrl;
    iframe.className = 'media-pdf';
    wrap.appendChild(iframe);
  }

  mediaBox.appendChild(wrap);
}

const MOBILE_LINK_COLORS = { url: '#60a5fa', file: '#4ecca3' };
let mobileLinkDecorations = [];
let mobileLinkHighlightTimer = null;

function clearMobileLinkHighlights() {
  if (mobileLinkHighlightTimer) {
    clearTimeout(mobileLinkHighlightTimer);
    mobileLinkHighlightTimer = null;
  }
  mobileLinkDecorations.forEach(deco => { try { deco.dispose(); } catch {} });
  mobileLinkDecorations = [];
}

function scheduleMobileLinkHighlights() {
  if (!term) return;
  if (mobileLinkHighlightTimer) clearTimeout(mobileLinkHighlightTimer);
  mobileLinkHighlightTimer = setTimeout(() => {
    mobileLinkHighlightTimer = null;
    refreshMobileLinkHighlights();
  }, 120);
}

function createMobileLinkDecoration(line, x, width, kind) {
  if (!term || width < 1) return;
  const buffer = term.buffer.active;
  const marker = term.registerMarker(line - (buffer.baseY + buffer.cursorY));
  if (!marker || marker.isDisposed) return;
  const decoration = term.registerDecoration({
    marker,
    x,
    width,
    height: 1,
    foregroundColor: MOBILE_LINK_COLORS[kind] || MOBILE_LINK_COLORS.file,
    layer: 'top',
  });
  if (!decoration) return;
  decoration.onRender((element) => {
    element.classList.add('xterm-mobile-link', kind === 'url' ? 'xterm-mobile-link-url' : 'xterm-mobile-link-file');
  });
  mobileLinkDecorations.push(decoration);
}

function addMobileLinkDecoration(range, kind) {
  const y1 = range.start.line;
  const y2 = range.end.line;
  if (y1 === y2) {
    createMobileLinkDecoration(y1, range.start.cell, range.end.cell - range.start.cell + 1, kind);
    return;
  }
  const cols = term.cols;
  createMobileLinkDecoration(y1, range.start.cell, Math.max(1, cols - range.start.cell), kind);
  for (let y = y1 + 1; y < y2; y++) createMobileLinkDecoration(y, 0, cols, kind);
  createMobileLinkDecoration(y2, 0, range.end.cell + 1, kind);
}

function refreshMobileLinkHighlights() {
  if (!term || !terminalContentHelpers) return;
  clearMobileLinkHighlights();
  const buffer = term.buffer.active;
  const seen = new Set();
  const start = Math.max(0, buffer.length - 3000);
  for (let y = start; y < buffer.length; ) {
    const logical = terminalContentHelpers.readLogicalLine(buffer, y);
    if (logical.text.trim()) {
      for (const match of terminalContentHelpers.findLinks(logical.text)) {
        if (match.kind === 'file' && !globalThis.DuoFilePreviewHelpers?.isPreviewableFileName?.(match.filePath)) continue;
        const range = terminalContentHelpers.matchRange(logical, match);
        if (!range) continue;
        const key = `${range.start.line}:${range.start.cell}-${range.end.line}:${range.end.cell}:${match.kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        addMobileLinkDecoration(range, match.kind);
      }
    }
    y = logical.endLine + 1;
  }
}

function registerMobileFileLinks() {
  if (!term || !globalThis.DuoFilePreviewHelpers || !terminalContentHelpers) return;
  const provider = {
    provideLinks(y, callback) {
      const buffer = term.buffer.active;
      const logical = terminalContentHelpers.readLogicalLine(buffer, y - 1);
      const links = terminalContentHelpers.findLinks(logical.text).flatMap((match) => {
        if (match.kind === 'file' && !globalThis.DuoFilePreviewHelpers.isPreviewableFileName(match.filePath)) return [];
        const range = terminalContentHelpers.matchRange(logical, match);
        if (!range) return [];
        return [{
          range: {
            start: { x: range.start.cell + 1, y: range.start.line + 1 },
            end: { x: range.end.cell + 1, y: range.end.line + 1 },
          },
          text: match.display,
          activate: () => match.kind === 'url'
            ? window.open(match.url, '_blank', 'noopener')
            : openFilePreview(match.filePath),
        }];
      });
      callback(links.length ? links : undefined);
    },
  };
  term.registerLinkProvider(provider);
}

function createTerminal() {
  closeTerminal();
  setTerminalInputReady(false);

  term = new Terminal({
    fontSize: 14,
    fontFamily: "'SF Mono', 'Menlo', 'Courier New', monospace",
    theme: {
      background: '#1a1a2e',
      foreground: '#e0e0e0',
      cursor: '#e94560',
      selectionBackground: 'rgba(233, 69, 96, 0.3)',
      black: '#1a1a2e',
      red: '#e94560',
      green: '#4ecca3',
      yellow: '#f0c040',
      blue: '#0f3460',
      magenta: '#533483',
      cyan: '#4ecca3',
      white: '#e0e0e0',
      brightBlack: '#2a2a4a',
      brightRed: '#ff6b81',
      brightGreen: '#7dffcc',
      brightYellow: '#ffe066',
      brightBlue: '#3a7bd5',
      brightMagenta: '#8854d0',
      brightCyan: '#7dffcc',
      brightWhite: '#ffffff',
    },
    cursorBlink: true,
    scrollback: 5000,
    convertEol: false,
    allowProposedApi: true,
    // 禁用光标样式同步，减少渲染
    cursorStyle: 'block',
    cursorInactiveStyle: 'none',
    // 打开长会话时必须瞬时跟到最新输出，避免按 scrollback 播放长动画。
    smoothScrollDuration: 0,
  });

  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  // 启用 unicode v11 字宽表，让 Braille spinner / emoji / CJK 等字符
  // 在手机端按和 PC 端 PTY 一致的列宽计算光标位置，避免 wrap 撕裂多行
  try {
    if (typeof Unicode11Addon !== 'undefined') {
      term.loadAddon(new Unicode11Addon.Unicode11Addon());
      term.unicode.activeVersion = '11';
    }
  } catch {}

  const container = $('terminal-container');
  // 清除旧终端 DOM，但保留 loading 遮罩
  const loading = $('terminal-loading');
  container.innerHTML = '';
  if (loading) container.appendChild(loading);
  // 显示 loading
  if (loading) loading.classList.remove('hidden');
  term.open(container);
  ensureTerminalScrollButton();
  ensureTerminalCopyButton();
  ensureTerminalSelectHandles();
  registerMobileFileLinks();

  // 终端键盘输入 → WebSocket
  term.onData((data) => {
    sendInputWithHexEnter(data);
  });

  // 窗口大小变化 → resize
  window.addEventListener('resize', scheduleTerminalResize);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', scheduleTerminalResize);
  if (typeof ResizeObserver !== 'undefined') {
    terminalResizeObserver = new ResizeObserver(scheduleTerminalResize);
    terminalResizeObserver.observe(container);
  }

  // 返回 Promise，确保终端完全 ready 后再做后续操作（如连接 WebSocket）
  // 双重 rAF 确保页面切换后 DOM 布局完成，避免 fit 算出 0 列 0 行
  return new Promise((resolve) => {
    requestAnimationFrame(() => { requestAnimationFrame(() => {
      fitAddon.fit();
      // 移动端：禁止点击终端区域弹出键盘
      const xtermTextarea = container.querySelector('.xterm-helper-textarea');
      if (xtermTextarea) {
        xtermTextarea.setAttribute('readonly', 'readonly');
      }

      // xterm 的 canvas 会遮住内部 viewport，直接依赖浏览器滚动在手机上不稳定。
      // 在容器捕获阶段把手势交给 xterm 的公开滚动 API。
      term.onScroll(() => {
        scheduleTerminalSelectHandlesUpdate();
        // 输出写入也会触发 xterm 的 scroll 事件，不能误判为用户回看。
        // xterm v6 平滑滚动期间 onScroll 会异步多次触发，落在时间戳窗口内即视为程序化滚动。
        if (terminalTouchActive || terminalOutputWriteCount > 0) return;
        if (Date.now() < programmaticScrollUntil) {
          isUserScrolling = false;
          setTerminalUnreadOutput(false);
          if (isAtBottom()) programmaticScrollUntil = 0;
        } else if (terminalOutputWriteCount === 0) {
          markUserScrolling();
        } else if (isAtBottom()) {
          isUserScrolling = false;
          setTerminalUnreadOutput(false);
        }
      });

      term.onSelectionChange(() => {
        updateTerminalCopyButton();
        scheduleTerminalSelectHandlesUpdate();
      });

      let touchGesture = null;
      let longPressTimer = null;
      const SELECT_DRAG_THRESHOLD = 8;
      // 位移在这个范围内仍算"按着没动"，手指抖动不该打断长按；超出就是滚动。
      const LONG_PRESS_SLOP = 10;
      const LONG_PRESS_MS = 500;

      const clearLongPress = () => {
        if (!longPressTimer) return;
        clearTimeout(longPressTimer);
        longPressTimer = null;
      };
      // 长按＝选中手指下的词，和普通文本选择一致；之后继续拖动可扩选，
      // 松手后用手柄微调范围，只有点「复制」才写剪贴板。
      const armLongPress = () => {
        clearLongPress();
        longPressTimer = setTimeout(() => {
          longPressTimer = null;
          if (touchGesture?.mode !== 'pending') return;
          const cell = getCellFromTouch(touchGesture.startX, touchGesture.startY);
          const word = cell && selectWordAtCell(cell);
          if (!word) return;
          touchGesture.mode = 'word';
          touchGesture.startCell = word.start;
          if (navigator.vibrate) navigator.vibrate(15);
        }, LONG_PRESS_MS);
      };

      const onTouchStart = (e) => {
        if (e.target?.closest?.('#terminal-copy-selection-btn')) {
          clearLongPress();
          touchGesture = null;
          return;
        }
        const handle = e.target?.closest?.('.terminal-select-handle');
        if (handle && e.touches.length === 1) {
          const cells = getSelectionCells();
          // 拖哪一端，另一端就当作锚点固定住。
          const anchor = handle.dataset.handle === 'start' ? cells?.end : cells?.start;
          clearLongPress();
          touchGesture = anchor ? { mode: 'handle', anchor } : null;
          terminalTouchActive = true;
          return;
        }
        if (e.touches.length === 2) {
          clearLongPress();
          touchGesture = {
            mode: 'scroll',
            lastY: (e.touches[0].clientY + e.touches[1].clientY) / 2,
          };
          terminalTouchActive = true;
          terminalScrollInteractionRevision++;
          programmaticScrollUntil = 0;
          updateTerminalCopyButton();
          if (scrollToBottomRaf) {
            cancelAnimationFrame(scrollToBottomRaf);
            scrollToBottomRaf = 0;
          }
          resetScrollAccum();
          return;
        }
        if (e.touches.length !== 1) {
          clearLongPress();
          terminalTouchActive = false;
          touchGesture = null;
          return;
        }
        const t = e.touches[0];
        touchGesture = {
          mode: 'pending',
          startX: t.clientX,
          startY: t.clientY,
          lastY: t.clientY,
          startCell: null,
        };
        terminalTouchActive = true;
        terminalScrollInteractionRevision++;
        programmaticScrollUntil = 0;
        if (scrollToBottomRaf) {
          cancelAnimationFrame(scrollToBottomRaf);
          scrollToBottomRaf = 0;
        }
        resetScrollAccum();
        armLongPress();
      };
      const onTouchMove = (e) => {
        if (!touchGesture) return;
        if (touchGesture.mode === 'handle') {
          if (e.touches.length !== 1) return;
          if (e.cancelable) e.preventDefault();
          const cell = getCellFromTouch(e.touches[0].clientX, e.touches[0].clientY);
          if (cell) selectTerminalRange(touchGesture.anchor, cell);
          return;
        }
        if (e.touches.length === 2 && touchGesture.mode === 'scroll') {
          const currentY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
          const deltaY = touchGesture.lastY - currentY;
          touchGesture.lastY = currentY;
          if (e.cancelable) e.preventDefault();
          if (deltaY !== 0) scrollTerminalByPixels(deltaY);
          return;
        }
        if (e.touches.length !== 1 || !term) return;
        const t = e.touches[0];
        const moved = Math.hypot(t.clientX - touchGesture.startX, t.clientY - touchGesture.startY);
        if (touchGesture.mode === 'pending') {
          if (moved < LONG_PRESS_SLOP) return;
          // 没长按就拖动＝回看滚动，抢成选区会打断手动滚动。
          clearLongPress();
          touchGesture.mode = 'pan';
          touchGesture.lastY = t.clientY;
        } else if (touchGesture.mode === 'word' && moved >= SELECT_DRAG_THRESHOLD) {
          // 长按已经选中词，之后再拖动才是扩选。
          touchGesture.mode = 'select';
        }
        if (touchGesture.mode === 'select') {
          if (e.cancelable) e.preventDefault();
          const endCell = getCellFromTouch(t.clientX, t.clientY);
          if (endCell && touchGesture.startCell) {
            selectTerminalRange(touchGesture.startCell, endCell);
          }
          return;
        }
        if (touchGesture.mode !== 'pan') return;
        if (e.cancelable) e.preventDefault();
        const deltaY = touchGesture.lastY - t.clientY;
        touchGesture.lastY = t.clientY;
        if (deltaY !== 0) scrollTerminalByPixels(deltaY);
      };
      const onTouchEnd = (e) => {
        clearLongPress();
        const mode = touchGesture?.mode;
        // 长按/拖手柄松手后，浏览器会补发 mousedown，xterm 收到就把刚选好的内容清掉。
        if ((mode === 'word' || mode === 'select' || mode === 'handle') && e?.cancelable) e.preventDefault();
        // 没长按也没拖动的单击＝取消选区，和普通文本一致。
        if (mode === 'pending' && term?.hasSelection()) term.clearSelection();
        touchGesture = null;
        terminalTouchActive = false;
        if (term && isAtBottom()) {
          isUserScrolling = false;
          setTerminalUnreadOutput(false);
        } else if (term) {
          isUserScrolling = true;
        }
      };
      const onWheel = () => {
        terminalScrollInteractionRevision++;
        programmaticScrollUntil = 0;
        if (scrollToBottomRaf) {
          cancelAnimationFrame(scrollToBottomRaf);
          scrollToBottomRaf = 0;
        }
      };

      container.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
      container.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
      container.addEventListener('touchend', onTouchEnd, { passive: false, capture: true });
      container.addEventListener('touchcancel', onTouchEnd, { passive: false, capture: true });
      container.addEventListener('wheel', onWheel, { passive: true, capture: true });
      terminalTouchCleanup = () => {
        clearLongPress();
        container.removeEventListener('touchstart', onTouchStart, true);
        container.removeEventListener('touchmove', onTouchMove, true);
        container.removeEventListener('touchend', onTouchEnd, true);
        container.removeEventListener('touchcancel', onTouchEnd, true);
        container.removeEventListener('wheel', onWheel, true);
        terminalTouchCleanup = null;
      };

      if (!container.dataset.tapLinkBound) {
        let tapStartTime = 0;
        let tapStartX = 0;
        let tapStartY = 0;
        let linkTapAt = 0;
        container.addEventListener('click', (e) => {
          // 点链接后浏览器还会补发一次 click，不吞掉会误触终端；但预览页已经切走，
          // 这次补发不一定落回容器里，所以只在紧随其后的短窗口内生效，别吃掉后面真正的点击。
          if (Date.now() - linkTapAt > 700) return;
          linkTapAt = 0;
          e.preventDefault();
          e.stopPropagation();
        }, true);
        container.addEventListener('touchstart', (e) => {
          if (e.touches.length !== 1) return;
          tapStartTime = Date.now();
          tapStartX = e.touches[0].clientX;
          tapStartY = e.touches[0].clientY;
        }, { passive: true });
        container.addEventListener('touchend', (e) => {
          if (!term || !globalThis.DuoFilePreviewHelpers || !terminalContentHelpers) return;
          if (e.target?.closest?.('.terminal-select-handle, #terminal-copy-selection-btn')) return;
          const elapsed = Date.now() - tapStartTime;
          // 真实手机点击可能在 30ms 内完成；只需排除长按，不能把快速点击
          // 当成误触，否则短路径链接在移动端会悄悄失效。
          if (elapsed > 300) return;
          const t = e.changedTouches[0];
          if (!t) return;
          if (Math.abs(t.clientX - tapStartX) > 10 || Math.abs(t.clientY - tapStartY) > 10) return;

          const cell = getCellFromTouch(t.clientX, t.clientY);
          if (!cell) return;
          const buffer = term.buffer.active;
          const lineIndex = cell.row;

          const logical = terminalContentHelpers.readLogicalLine(buffer, lineIndex);
          const matches = terminalContentHelpers.findLinks(logical.text).filter(match =>
            match.kind === 'file' && globalThis.DuoFilePreviewHelpers.isPreviewableFileName(match.filePath));
          if (!matches.length) return;

          const tapCol = cell.col;
          let tapCharIndex = -1;
          for (let i = 0; i < logical.positions.length; i++) {
            const position = logical.positions[i];
            if (position && position.line === lineIndex && position.cell >= tapCol) {
              tapCharIndex = i;
              break;
            }
          }
          if (tapCharIndex < 0) tapCharIndex = logical.positions.length - 1;

          let best = null;
          let bestDist = Infinity;
          for (const m of matches) {
            const mStart = m.index;
            const mEnd = m.index + m.length;
            let dist;
            if (tapCharIndex >= mStart && tapCharIndex < mEnd) {
              dist = 0;
            } else {
              dist = Math.min(Math.abs(tapCharIndex - mStart), Math.abs(tapCharIndex - mEnd));
            }
            if (dist < bestDist) {
              bestDist = dist;
              best = m;
            }
          }

          if (best && bestDist <= 15) {
            linkTapAt = Date.now();
            openFilePreview(best.filePath);
          }
        }, { passive: true });
        container.dataset.tapLinkBound = '1';
      }

      // 绑定 canvas context lost 监听（黑屏修复）
      if (typeof bindCanvasContextLost === 'function') {
        setTimeout(bindCanvasContextLost, 100);
      }

      scheduleMobileLinkHighlights();
      resolve(term);
    }); });
  });
}

function handleResize() {
  if (!fitAddon || !term) return;
  clearTimeout(resizeSendTimer);
  // 在键盘/工具栏动画结束后请求最终行列数。实际尺寸由 PTY 快照确认，
  // 避免客户端先 fit、CLI 仍按旧坐标重绘的窗口。
  resizeSendTimer = setTimeout(() => {
    resizeSendTimer = null;
    if (!fitAddon || !term) return;
    const dims = fitAddon.proposeDimensions();
    if (!dims || dims.cols < 2 || dims.rows < 1) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (dims.cols === lastSentCols && dims.rows === lastSentRows) return;
    lastSentCols = dims.cols;
    lastSentRows = dims.rows;
    wsSend({ type: 'resize', cols: dims.cols, rows: dims.rows });
  }, 250);
}

function closeTerminal() {
  if (terminalTouchCleanup) terminalTouchCleanup();
  window.removeEventListener('resize', scheduleTerminalResize);
  if (window.visualViewport) window.visualViewport.removeEventListener('resize', scheduleTerminalResize);
  if (terminalResizeObserver) {
    terminalResizeObserver.disconnect();
    terminalResizeObserver = null;
  }
  if (terminalResizeFrame !== null) {
    cancelAnimationFrame(terminalResizeFrame);
    terminalResizeFrame = null;
  }
  lastTerminalSize = '';
  lastSentCols = 0;
  lastSentRows = 0;
  clearTimeout(resizeSendTimer);
  resizeSendTimer = null;
  resetTerminalScrollState();
  clearMobileLinkHighlights();
  closeWebSocket();
  if (term) {
    term.dispose();
    term = null;
    fitAddon = null;
  }
}

// WebSocket 包边界不是终端帧边界。任何基于单包内容的 spinner 过滤都会
// 丢失清行、光标移动或不完整 ANSI 序列，因此原样交给 xterm 解析。
function interceptSpinnerData(rawData) {
  return spinnerInterceptor.intercept(rawData);
}

// ========== WebSocket ==========

function connectWebSocket(sessionId) {
  closeWebSocket();
  setTerminalInputReady(false);
  hideWeakNetworkPrompt();
  const profile = getNetworkProfile();

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('[ws] onopen, term exists=', !!term);
    hideWeakNetworkPrompt();
    wsReconnectAttempt = 0;
    wsLastPongAt = Date.now();
    // 保留旧屏幕直到快照到达，断网时不把用户视口重置到顶部。
    // 订阅会话
    wsSend({ type: 'subscribe', sessionId });
    // 发送当前终端尺寸（过滤无效值，避免 pty resize(0,0) 异常）
    if (term && term.cols > 0 && term.rows > 0) {
      console.log('[ws] sending resize', term.cols, term.rows);
      wsSend({ type: 'resize', cols: term.cols, rows: term.rows });
      lastSentCols = term.cols;
      lastSentRows = term.rows;
    } else {
      console.log('[ws] skipping resize, cols=', term?.cols, 'rows=', term?.rows);
    }
    // 心跳保活，防止 iOS Safari 后台杀连接
    clearInterval(wsHeartbeat);
    wsHeartbeat = setInterval(() => {
      // 后台标签页会被浏览器节流：ping/pong 到不了，不能据此把还活着的连接掐掉。
      // 否则一切回标签就会重连 + 全量 replay，看起来像页面被刷新。
      if (document.hidden) return;
      wsSend({ type: 'ping' });
      if (Date.now() - wsLastPongAt > profile.wsStaleTimeoutMs && ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }, profile.wsPingIntervalMs);
  };

  let replayReceived = false;
  wsReplayRetryCount = 0;
  if (wsReplayRetryTimer) { clearTimeout(wsReplayRetryTimer); wsReplayRetryTimer = null; }

  // 8秒内未收到 replay，显示重连提示
  if (wsConnectTimeoutTimer) clearTimeout(wsConnectTimeoutTimer);
  wsConnectTimeoutTimer = setTimeout(() => {
    if (!replayReceived && term) {
      hideTerminalLoading();
      writeTerminalOutput('\r\n\x1b[33m⚠ 连接超时，正在重连...\x1b[0m\r\n');
      showWeakNetworkPrompt('连接超时，正在重试');
      if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    }
  }, profile.wsConnectTimeoutMs);

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'submitted') {
        const pending = pendingSubmissions.get(msg.id);
        if (msg.error) pending?.reject(new Error(msg.error));
        else pending?.resolve();
        return;
      }
      if (!term) return;
      wsLastPongAt = Date.now();

      if (msg.type === 'pong') {
        return;
      }

      if (msg.type === 'replay') {
        replayReceived = true;
        if (wsConnectTimeoutTimer) { clearTimeout(wsConnectTimeoutTimer); wsConnectTimeoutTimer = null; }
        hideWeakNetworkPrompt();
        console.log('[ws] replay received, data length=', (msg.data || '').length);
        setTerminalInputReady(true);
        if (Number.isInteger(msg.sequence)) terminalSequence = msg.sequence;
        if (msg.data) {
          restoreTerminalSnapshot(msg);
        } else {
          hideTerminalLoading();
          applyTerminalSnapshotGeometry(msg);
          if (wsReplayRetryTimer || wsReplayRetryCount >= 3) return;
          // 新建会话 pty 刚启动时 buffer 可能仍为空，延迟重新订阅。
          wsReplayRetryCount++;
          wsReplayRetryTimer = setTimeout(() => {
            wsReplayRetryTimer = null;
            if (ws && ws.readyState === WebSocket.OPEN && currentSessionId === sessionId) {
              wsSend({ type: 'subscribe', sessionId });
            }
          }, 800);
        }
      } else if (msg.type === 'output') {
        if (Number.isInteger(msg.sequence)) {
          if (msg.sequence <= terminalSequence) return;
          terminalSequence = msg.sequence;
        }
        hideTerminalLoading();
        hideWeakNetworkPrompt();
        setTerminalInputReady(true);

        let writeData = interceptSpinnerData(msg.data);

        if (writeData !== null) {
          writeTerminalOutput(writeData, !isUserScrolling);
        }
      }
    } catch {}
  };

  ws.onclose = () => {
    setTerminalInputReady(false);
    clearInterval(wsHeartbeat);
    if (wsConnectTimeoutTimer) { clearTimeout(wsConnectTimeoutTimer); wsConnectTimeoutTimer = null; }
    if (navigator.onLine === false) return;
    // 如果还在详情页，尝试重连
    if (currentSessionId === sessionId && $('detail-page').classList.contains('active')) {
      if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
      const delay = Math.min(profile.wsRetryBaseMs * Math.pow(2, wsReconnectAttempt), profile.wsRetryMaxMs) + Math.floor(Math.random() * 500);
      wsReconnectAttempt++;
      showWeakNetworkPrompt('连接中断，正在重试');
      wsReconnectTimer = setTimeout(() => {
        wsReconnectTimer = null;
        if (currentSessionId === sessionId && $('detail-page').classList.contains('active')) {
          connectWebSocket(sessionId);
        }
      }, delay);
    }
  };

  ws.onerror = () => {
    setTerminalInputReady(false);
    // 某些浏览器弱网下只触发 onerror 不触发 onclose，主动 close 统一走重连逻辑
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      ws.close();
    }
  };
}

function closeWebSocket() {
  clearInterval(wsHeartbeat);
  setTerminalInputReady(false);
  hideWeakNetworkPrompt();
  if (wsConnectTimeoutTimer) { clearTimeout(wsConnectTimeoutTimer); wsConnectTimeoutTimer = null; }
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  if (wsReplayRetryTimer) { clearTimeout(wsReplayRetryTimer); wsReplayRetryTimer = null; }
  wsReplayRetryCount = 0;
  if (ws) {
    // close() 是异步的，关闭过程中已在路上的帧仍会调用旧 ws 的 onmessage，
    // 全置 null 避免会话切换时旧 session 的输出写入新 term
    ws.onclose = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onopen = null;
    ws.close();
    ws = null;
  }
}

// 将 Uint8Array 或普通数组安全转为 base64（避免 spread 栈溢出）
function uint8ToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function wsSend(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    // 对 input 类型的数据，用 base64 编码传输，避免控制字符在 JSON 中丢失
    if (data.type === 'input' && data.data) {
      const bytes = new TextEncoder().encode(data.data);
      const b64 = uint8ToBase64(bytes);
      ws.send(JSON.stringify({ type: 'input_b64', data: b64 }));
    } else {
      ws.send(JSON.stringify(data));
    }
  }
}

// ========== 会话详情 ==========

async function openSession(id) {
  console.log('[openSession] start, id=', id);
  const requestId = ++terminalOpenRequest;
  currentSessionId = id;
  resetFileTreeState(mobileFileTree);
  resetFileTreeState(fileBrowseTree);
  mobileFilePreviewRequest++;
  showPage('detail-page');

  // 更新标题（不阻塞 WebSocket 连接）
  api('/api/sessions').then(sessions => {
    const s = sessions.find(x => x.id === id);
    if (s && currentSessionId === id) {
      $('detail-name').textContent = s.title || s.presetCommand || '终端';
      $('detail-status').className = `status-dot ${s.status}`;
      lastKnownSessionCwd = s.cwd || '';
    }
  }).catch(() => {});

  // 创建终端并连接 WebSocket（等终端 ready 后再连，避免 replay 数据丢失）
  console.log('[openSession] creating terminal...');
  await createTerminal();
  if (requestId !== terminalOpenRequest || currentSessionId !== id) return;
  console.log('[openSession] terminal ready, cols=', term?.cols, 'rows=', term?.rows);
  connectWebSocket(id);
  console.log('[openSession] connectWebSocket called');

  // 初始化催工 UI（从桌面端读取配置）
  getAutoContinueConfig(id).then(config => {
    if (requestId === terminalOpenRequest && currentSessionId === id) {
      updateDetailAutoContinueUI(config);
    }
  });
}

// 点击标题编辑
$('detail-name').onclick = async () => {
  if (!currentSessionId) return;
  const current = $('detail-name').textContent || '';
  const newTitle = prompt('修改标题', current);
  if (newTitle === null || newTitle.trim() === '' || newTitle.trim() === current) return;
  try {
    const res = await api(`/api/sessions/${currentSessionId}/title`, {
      method: 'PUT',
      body: JSON.stringify({ title: newTitle.trim() }),
    });
    if (res.ok) {
      $('detail-name').textContent = newTitle.trim();
    }
  } catch (e) {
    console.error('修改标题失败', e);
  }
};

// 返回按钮
$('back-btn').onclick = () => {
  terminalOpenRequest++;
  currentSessionId = null;
  closeTerminal();
  showPage('main-page');
  refreshSessions();
};

$('file-preview-back-btn').onclick = () => {
  const returnPage = filePreviewReturnPage || 'detail-page';
  showPage(returnPage);
  if (returnPage === 'detail-page') {
    requestAnimationFrame(() => {
      handleResize();
      recoverVisibleTerminal();
    });
  }
};

// ========== 项目文件浏览页 ==========
function updateFileBrowseFilterUI() {
  document.querySelectorAll('.file-browse-filter').forEach((btn) => {
    const active = btn.dataset.filter === fileBrowseFilter;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  const labels = { all: '项目文件', media: '媒体文件', document: '文档' };
  const title = $('media-browse-title');
  if (title) title.textContent = labels[fileBrowseFilter] || '项目文件';
}

function openFileBrowse() {
  if (!currentSessionId) return;
  resetFileTreeState(fileBrowseTree);
  updateFileBrowseFilterUI();
  showPage('media-browse-page');
  void renderFileBrowseTree(true);
}

$('media-browse-back-btn').onclick = () => {
  showPage('detail-page');
  requestAnimationFrame(() => {
    handleResize();
    recoverVisibleTerminal();
  });
};

$('media-browse-refresh-btn').onclick = () => {
  void renderFileBrowseTree(true);
};

document.querySelectorAll('.file-browse-filter').forEach((btn) => {
  btn.addEventListener('click', () => {
    const next = btn.dataset.filter;
    if (!next || next === fileBrowseFilter) return;
    fileBrowseFilter = next;
    updateFileBrowseFilterUI();
    void renderFileBrowseTree(false);
  });
});

// 详情页「更多」下拉：项目文件 / 计划设置 / 手机设备
const detailMoreBtn = $('detail-more-btn');
const detailMoreMenu = $('detail-more-menu');
function closeDetailMoreMenu() {
  if (!detailMoreMenu || detailMoreMenu.hidden) return;
  detailMoreMenu.hidden = true;
  detailMoreBtn?.setAttribute('aria-expanded', 'false');
}
detailMoreBtn?.addEventListener('click', (event) => {
  event.stopPropagation();
  const opening = Boolean(detailMoreMenu?.hidden);
  if (detailMoreMenu) detailMoreMenu.hidden = !opening;
  detailMoreBtn.setAttribute('aria-expanded', String(opening));
});
detailMoreMenu?.addEventListener('click', (event) => {
  if (event.target.closest('button')) closeDetailMoreMenu();
});
document.addEventListener('click', (event) => {
  if (!detailMoreMenu || detailMoreMenu.hidden) return;
  if (event.target.closest('.detail-header-tools')) return;
  closeDetailMoreMenu();
});
$('detail-menu-files-btn').onclick = () => {
  openFileBrowse();
};
$('detail-menu-plan-btn').onclick = () => {
  if (currentSessionId) showAutoContinueConfigModal(currentSessionId);
};
$('detail-menu-device-btn').onclick = () => { void showPhoneControl(); };

document.querySelectorAll('.landscape-sessions-toggle').forEach(button => {
  button.addEventListener('click', () => { void toggleLandscapeSessionsPanel(); });
});
document.querySelectorAll('.landscape-device-toggle').forEach(button => {
  button.addEventListener('click', () => { void toggleLandscapeDevicePanel(); });
});
document.querySelectorAll('.device-panel-tab').forEach(button => {
  button.addEventListener('click', () => {
    setDevicePanel(button.dataset.devicePanel || 'device');
    if (currentDevicePanel === 'device' && $('device-select').value) startAndroidMirror($('device-select').value);
  });
});
$('mobile-file-tree-refresh').onclick = () => { void renderMobileFileTree(true); };
setDevicePanel('device');
$('main-drawer-close').onclick = () => { void toggleLandscapeSessionsPanel(); };
window.addEventListener('resize', () => {
  if (!supportsLandscapePanels()) closeLandscapePanels();
  syncLandscapePanelButtons();
  requestAnimationFrame(fitAndroidSurfaces);
});

// 催工：点击标签直接弹配置弹窗
$('detail-ac-label').onclick = () => {
  if (!currentSessionId) return;
  showAutoContinueConfigModal(currentSessionId);
};

// 催工配置弹窗：自动同意 checkbox 联动
$('ac-auto-agree').onchange = () => {
  $('ac-agree-delay-row').style.display = $('ac-auto-agree').checked ? '' : 'none';
};

// 催工配置弹窗：取消
$('ac-cancel').onclick = () => {
  $('auto-continue-modal').classList.remove('active');
};

// 催工配置弹窗：点击遮罩关闭
$('auto-continue-modal').onclick = (e) => {
  if (e.target === $('auto-continue-modal')) {
    $('auto-continue-modal').classList.remove('active');
  }
};

// 催工配置弹窗：关闭催工
$('ac-stop').onclick = async () => {
  if (!currentSessionId) return;
  await toggleAutoContinue(currentSessionId, false);
  $('auto-continue-modal').classList.remove('active');
};

// 催工配置弹窗：保存并开启
$('ac-save').onclick = async () => {
  if (!currentSessionId) return;
  const msgs = $('ac-message').value.split('\n').map(m => m.trim()).filter(Boolean);
  if (!msgs.length) { $('ac-message').focus(); return; }
  const intervalMinutes = parseInt($('ac-interval').value, 10);
  if (isNaN(intervalMinutes) || intervalMinutes < 1) { $('ac-interval').focus(); return; }
  const initialDelayMinutes = parseInt($('ac-initial-delay').value || '0', 10);
  if (isNaN(initialDelayMinutes) || initialDelayMinutes < 0) { $('ac-initial-delay').focus(); return; }
  const agreeDelay = parseInt($('ac-agree-delay').value, 10);
  const cmdIntervalSec = parseInt($('ac-cmd-interval')?.value || '2', 10);
  const sendDelaySec = parseInt($('ac-send-delay')?.value || '2', 10);
  const maxLoops = parseInt($('ac-max-loops')?.value || '-1', 10);
  if ($('ac-auto-agree').checked && (isNaN(agreeDelay) || agreeDelay < 0)) { $('ac-agree-delay').focus(); return; }
  if (isNaN(cmdIntervalSec) || cmdIntervalSec < 0) { $('ac-cmd-interval').focus(); return; }
  if (isNaN(sendDelaySec) || sendDelaySec < 0) { $('ac-send-delay').focus(); return; }
  if (isNaN(maxLoops) || maxLoops === 0 || maxLoops < -1) { $('ac-max-loops').focus(); return; }

  const config = {
    enabled: true,
    messages: msgs,
    intervalMs: intervalMinutes * 60000,
    initialDelayMs: initialDelayMinutes * 60000,
    commandIntervalMs: cmdIntervalSec * 1000,
    sendDelaySec,
    maxLoops,
    autoAgree: $('ac-auto-agree').checked,
    autoAgreeDelaySec: isNaN(agreeDelay) ? 5 : agreeDelay,
  };

  await saveAutoContinueConfig(currentSessionId, config);
  $('auto-continue-modal').classList.remove('active');
  updateDetailAutoContinueUI(config);
};

// 点击与键盘共用一次提交；回车快捷键仍可单独发送原始 Enter。
let composerComposing = false;
let submitAfterComposition = false;
let allowComposerLineBreak = false;
let failedSubmission = null;
const pendingSubmissions = new Map();

function requestSubmission(sessionId, text, id) {
  return new Promise((resolve, reject) => {
    const fallback = () => {
      pendingSubmissions.delete(id);
      if (!isTerminalInputReady()) {
        reject(new Error('终端连接已中断，请稍后重试'));
        return;
      }
      api(`/api/sessions/${sessionId}/input`, {
        method: 'POST', body: JSON.stringify({ input: text, submissionId: id }),
      }).then(resolve, reject);
    };
    if (!ws || ws.readyState !== WebSocket.OPEN) { fallback(); return; }
    const timer = setTimeout(fallback, 5000);
    pendingSubmissions.set(id, {
      resolve: () => { clearTimeout(timer); pendingSubmissions.delete(id); resolve(); },
      reject: error => { clearTimeout(timer); pendingSubmissions.delete(id); reject(error); },
    });
    wsSend({ type: 'submit', id, text });
  });
}

async function sendMessage() {
  const input = $('msg-input');
  if (!currentSessionId || composerSubmission) return;
  if (!isTerminalInputReady()) {
    showCopyToast('终端连接中，请稍候再发送');
    updateComposerAvailability();
    return;
  }
  if (composerComposing) {
    submitAfterComposition = true;
    input.blur(); // 让输入法提交组合文字后，再读取最终文本。
    return;
  }
  const text = input.value.replace(/\r\n?/g, '\n');
  if (!text.trim()) return;
  const sessionId = currentSessionId;
  const retry = failedSubmission?.sessionId === sessionId && failedSubmission?.text === text;
  const id = retry ? failedSubmission.id : (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  composerSubmission = { id, sessionId };
  input.value = '';
  updateComposerAvailability();
  scrollTerminalToBottom();
  try {
    await requestSubmission(sessionId, text, id);
    failedSubmission = null;
  } catch (error) {
    failedSubmission = { id, sessionId, text };
    if (currentSessionId === sessionId && !input.value) input.value = text;
    showCopyToast('发送未确认：' + (error.message || error));
  } finally {
    if (composerSubmission?.id === id) {
      composerSubmission = null;
      updateComposerAvailability();
    }
    input.blur();
    resetMobileKeyboardLayout();
    scheduleDelayedTerminalResize();
  }
}

updateComposerAvailability();

$('msg-input').addEventListener('blur', () => {
  resetMobileKeyboardLayout();
  scheduleDelayedTerminalResize();
});

$('send-btn').addEventListener('touchend', event => {
  event.preventDefault();
  void sendMessage();
});
$('send-btn').onclick = () => { void sendMessage(); };
$('msg-input').addEventListener('compositionstart', () => { composerComposing = true; });
$('msg-input').addEventListener('compositionend', () => {
  composerComposing = false;
  if (submitAfterComposition) {
    submitAfterComposition = false;
    queueMicrotask(() => { void sendMessage(); });
  }
});
$('msg-input').addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.isComposing || composerComposing || event.keyCode === 229) return;
  allowComposerLineBreak = event.shiftKey;
  if (event.shiftKey) return;
  event.preventDefault();
  void sendMessage();
});
$('msg-input').addEventListener('beforeinput', event => {
  if (!['insertLineBreak', 'insertParagraph'].includes(event.inputType) || event.isComposing || composerComposing) return;
  if (allowComposerLineBreak) return;
  if (event.cancelable) {
    event.preventDefault();
    void sendMessage();
  }
});
$('msg-input').addEventListener('input', event => {
  if (!['insertLineBreak', 'insertParagraph'].includes(event.inputType) || event.isComposing || composerComposing) return;
  // 部分软键盘只发 input；只移除此次插入的换行，不破坏粘贴的多行文字。
  if (allowComposerLineBreak) { allowComposerLineBreak = false; return; }
  const input = $('msg-input');
  const pos = input.selectionStart;
  if (pos > 0 && input.value[pos - 1] === '\n') input.value = input.value.slice(0, pos - 1) + input.value.slice(pos);
  void sendMessage();
});

// 发送 hex 编码的原始字节（用于回车、控制字符等）
function wsSendHex(hexStr) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    const bytes = hexStr.match(/.{2}/g).map(h => parseInt(h, 16));
    const b64 = uint8ToBase64(bytes);
    ws.send(JSON.stringify({ type: 'input_b64', data: b64 }));
  }
}

// ========== iOS 键盘弹出时输入框紧贴键盘 ==========
if (window.visualViewport) {
  const vv = window.visualViewport;
  function adjustForKeyboard() {
    const detailPage = $('detail-page');
    if (!detailPage || !detailPage.classList.contains('active')) return;

    const inputArea = $('input-area');
    const shortcutBar = $('shortcut-bar');

    // visualViewport.height < window.innerHeight 说明键盘弹出了
    const keyboardHeight = window.innerHeight - vv.height - vv.offsetTop;
    keyboardVisible = keyboardHeight > 50;

    if (keyboardHeight > 50) {
      // 键盘弹出：把整个 detail-page 的 bottom 抬高键盘的高度
      detailPage.style.top = '0';
      detailPage.style.bottom = keyboardHeight + 'px';
      detailPage.style.height = 'auto';
      if (inputArea) inputArea.style.paddingBottom = '6px';
      if (shortcutBar) shortcutBar.style.paddingBottom = '0';
    } else {
      resetMobileKeyboardLayout();
      scheduleDelayedTerminalResize();
      return;
    }

    scheduleTerminalResize();
  }

  vv.addEventListener('resize', adjustForKeyboard);
  vv.addEventListener('scroll', adjustForKeyboard);
} else {
  function adjustForKeyboardFallback() {
    resetMobileKeyboardLayout();
    scheduleDelayedTerminalResize();
  }
  $('msg-input')?.addEventListener('blur', adjustForKeyboardFallback);
}

// 快捷键按钮 — 通过 WebSocket 发送原始键码（不弹键盘）

// ========== 快捷命令栏 ==========

const QCMD_STORAGE_KEY = 'duocli_quick_commands';
const QCMD_DEFAULTS = ['/new', '/help', '/compact', '/unicloud-log-viewer', '/uniapp-dev'];

function loadQuickCommands() {
  try {
    const saved = localStorage.getItem(QCMD_STORAGE_KEY);
    if (saved) return JSON.parse(saved);
  } catch {}
  return [...QCMD_DEFAULTS];
}

function saveQuickCommands(cmds) {
  localStorage.setItem(QCMD_STORAGE_KEY, JSON.stringify(cmds));
}

function renderQuickCommands() {
  const bar = $('quick-commands');
  if (!bar) return;
  bar.innerHTML = '';
  const cmds = loadQuickCommands();

  cmds.forEach((cmd, idx) => {
    const btn = document.createElement('button');
    btn.className = 'qcmd-btn';
    btn.textContent = cmd;
    // 必须走 submit 通道：裸写会被 CLI 的斜杠补全菜单吞掉回车，导致命令重复执行
    btn.onclick = () => {
      if (!currentSessionId) return;
      if (!isTerminalInputReady()) {
        showCopyToast('终端连接中，请稍候再发送');
        return;
      }
      if (!confirm(`确定发送快捷指令「${cmd}」到当前终端吗？`)) return;
      const sessionId = currentSessionId;
      const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      scrollTerminalToBottom();
      void requestSubmission(sessionId, cmd, id).catch((error) => {
        showCopyToast('发送未确认：' + (error.message || error));
      });
    };
    // 长按 → 删除
    let longTimer = null;
    btn.addEventListener('touchstart', (e) => {
      longTimer = setTimeout(() => {
        longTimer = null;
        if (confirm(`删除快捷命令「${cmd}」？`)) {
          const list = loadQuickCommands();
          list.splice(idx, 1);
          saveQuickCommands(list);
          renderQuickCommands();
        }
      }, 600);
    }, { passive: true });
    btn.addEventListener('touchend', () => { if (longTimer) clearTimeout(longTimer); });
    btn.addEventListener('touchmove', () => { if (longTimer) clearTimeout(longTimer); });
    bar.appendChild(btn);
  });

  // 添加按钮
  const addBtn = document.createElement('button');
  addBtn.className = 'qcmd-btn qcmd-add';
  addBtn.textContent = '+ 添加';
  addBtn.onclick = () => {
    const cmd = prompt('输入快捷命令：');
    if (cmd && cmd.trim()) {
      const list = loadQuickCommands();
      list.push(cmd.trim());
      saveQuickCommands(list);
      renderQuickCommands();
    }
  };
  bar.appendChild(addBtn);
}

renderQuickCommands();

// ========== 文件上传 ==========
$('upload-btn').onclick = () => {
  $('file-input').click();
};

$('file-input').onchange = async (e) => {
  const files = e.target.files;
  if (!files || !files.length || !currentSessionId) return;

  const btn = $('upload-btn');
  btn.classList.add('uploading');

  for (const file of files) {
    try {
      const res = await fetch(`${API}/api/sessions/${currentSessionId}/upload`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
          'X-Filename': encodeURIComponent(file.name),
        },
        body: file,
      });
      const data = await res.json();
      if (data.ok) {
        // 在终端显示上传成功提示
        writeTerminalOutput(`\r\n\x1b[32m✓ 已上传: ${file.name} (${formatSize(data.size)})\x1b[0m\r\n`);
        // 把文件路径填入输入框，方便用户直接发送给 AI
        if (data.path) {
          const input = $('msg-input');
          const prev = input.value.trim();
          input.value = prev ? prev + ' ' + data.path : data.path;
        }
      } else {
        writeTerminalOutput(`\r\n\x1b[31m✗ 上传失败: ${file.name} - ${data.error}\x1b[0m\r\n`);
      }
    } catch (err) {
      writeTerminalOutput(`\r\n\x1b[31m✗ 上传失败: ${file.name} - ${err.message}\x1b[0m\r\n`);
    }
  }

  btn.classList.remove('uploading');
  e.target.value = ''; // 清空，允许重复选同一文件
};

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

document.querySelectorAll('.key-btn').forEach(btn => {
  // 用 click 统一处理桌面和移动端，辅以 touch-action: manipulation 消除 300ms 延迟
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    if (!currentSessionId) return;
    const key = btn.dataset.key;
    const parsed = key.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
                      .replace(/\\r/g, '\r')
                      .replace(/\\t/g, '\t')
                      .replace(/\\n/g, '\n');
    sendInputWithHexEnter(parsed);
  });
});

// 删除会话
$('delete-btn').onclick = async () => {
  if (!currentSessionId) return;
  if (!confirm('确定终止此会话？')) return;
  try {
    await api(`/api/sessions/${currentSessionId}`, { method: 'DELETE' });
    currentSessionId = null;
    closeTerminal();
    showPage('main-page');
    refreshSessions();
  } catch (e) {
    alert('删除失败: ' + e.message);
  }
};

// 手机浏览器不会经过 Electron 的 before-input-event。拦截 Command/Ctrl+W，
// 只关闭当前终端会话，避免浏览器直接关闭标签页或退出当前页面。
let mobileCloseInProgress = false;
async function closeCurrentMobileSession() {
  if (mobileCloseInProgress) return;
  if (!currentSessionId || !$('detail-page').classList.contains('active')) {
    showCopyToast('当前没有可关闭的终端');
    return;
  }
  const sessionId = currentSessionId;
  const title = $('detail-name').textContent || '终端';
  if (!confirm(`确定关闭当前终端「${title}」吗？`)) return;
  mobileCloseInProgress = true;
  try {
    await api(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    if (currentSessionId !== sessionId) return;
    terminalOpenRequest++;
    currentSessionId = null;
    closeTerminal();
    showPage('main-page');
    await refreshSessions();
  } catch (e) {
    alert('关闭失败: ' + (e.message || e));
  } finally {
    mobileCloseInProgress = false;
  }
}

// ========== 自定义预设 ==========

const CUSTOM_PRESETS_KEY = 'duocli_custom_presets';
const MOBILE_THEME_KEY = 'duocli_mobile_new_theme';
const LEGACY_QODER_CHAT_AUTO_COMMAND = 'qoder chat --dangerously-skip-permissions';
const LEGACY_QODER_AUTO_COMMAND = 'qoder --dangerously-skip-permissions';
const QODER_AUTO_COMMAND = 'qodercli --dangerously-skip-permissions';
const QODERCN_AUTO_COMMAND = 'qodercn --dangerously-skip-permissions';

function migrateLegacyQoderPreset(value) {
  if (value === LEGACY_QODER_CHAT_AUTO_COMMAND) return QODERCN_AUTO_COMMAND;
  if (value === LEGACY_QODER_AUTO_COMMAND) return QODER_AUTO_COMMAND;
  return value;
}

const FALLBACK_BUILTIN_OPTIONS = [
  { value: '', label: '纯终端 (shell)' },
];
let BUILTIN_OPTIONS = FALLBACK_BUILTIN_OPTIONS.slice();

async function refreshBuiltinOptions() {
  if (!token || !API) return;
  try {
    const list = await api('/api/builtin-presets');
    if (Array.isArray(list) && list.length > 0) {
      // 手机端空终端文案与桌面略有不同
      BUILTIN_OPTIONS = list.map((p) =>
        p.value === '' ? { value: '', label: '纯终端 (shell)' } : p
      );
    }
  } catch (e) {
    console.warn('[Mobile Preset] Failed to load builtin presets:', e);
  }
}

let customPresetNextId = 1;
// 已与服务端对齐过的预设 id：拉取时以服务端为准，本地只留还没推上去的新增项，
// 否则另一端删掉的预设会在本机一直复活。
const CUSTOM_PRESETS_SYNCED_KEY = 'duocli_custom_presets_synced';
// 预设命令 → 使用次数，由服务端统计，两端共用同一份排序
let PRESET_USAGE = new Map();

function getCustomPresets() {
  try { return JSON.parse(localStorage.getItem(CUSTOM_PRESETS_KEY) || '[]'); } catch { return []; }
}

function stripPresetEnvQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function parsePresetEnv(text) {
  const env = {};
  if (!text) return env;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const ps = line.match(/^\$env:([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/i);
    if (ps) { env[ps[1]] = stripPresetEnvQuotes(ps[2].trim()); continue; }
    const rest = line.replace(/^(export|set)\s+/i, '');
    const kv = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (kv) env[kv[1]] = stripPresetEnvQuotes(kv[2].trim());
  }
  return env;
}

function formatPresetEnv(env) {
  if (!env) return '';
  return Object.entries(env)
    .filter(([key, value]) => key && value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function getSyncedPresetIds() {
  try { return JSON.parse(localStorage.getItem(CUSTOM_PRESETS_SYNCED_KEY) || '[]'); } catch { return []; }
}

function markPresetsSynced(list) {
  localStorage.setItem(CUSTOM_PRESETS_SYNCED_KEY, JSON.stringify(list.map(p => p.id)));
}

// 计数器要跟着合并后的列表走，否则两端各自生成 custom-N 会撞号互相覆盖
function refreshCustomPresetIdCounter() {
  customPresetNextId = 1;
  for (const p of getCustomPresets()) {
    const m = p.id && p.id.match(/^custom-(\d+)$/);
    if (m) customPresetNextId = Math.max(customPresetNextId, parseInt(m[1]) + 1);
  }
}

function pushCustomPresetsToServer(list) {
  if (!token || !API) return Promise.resolve(false);
  return fetch(`${API}/api/custom-presets`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(list),
  })
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      markPresetsSynced(list);
      return true;
    })
    .catch(() => false);
}

function saveCustomPresets(list) {
  localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(list));
  refreshCustomPresetIdCounter();
  void pushCustomPresetsToServer(list);
}

async function pullCustomPresetsFromServer() {
  if (!token || !API) return;
  try {
    const serverPresets = await api('/api/custom-presets');
    if (!Array.isArray(serverPresets)) return;
    const localPresets = getCustomPresets();
    const synced = getSyncedPresetIds();
    const serverIds = new Set(serverPresets.map(p => p.id));
    const pending = localPresets.filter(p => !synced.includes(p.id) && !serverIds.has(p.id));
    const list = [...serverPresets, ...pending];
    localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(list));
    refreshCustomPresetIdCounter();
    if (pending.length) await pushCustomPresetsToServer(list);
    else markPresetsSynced(list);
  } catch (e) {
    console.warn('[Mobile Preset] Failed to sync presets with server:', e);
  }
}

async function refreshPresetUsage() {
  if (!token || !API) return;
  try {
    const res = await api('/api/preset-usage');
    const items = Array.isArray(res?.items) ? res.items : [];
    PRESET_USAGE = new Map(
      items.filter(i => i && typeof i.command === 'string').map(i => [i.command, Number(i.count) || 0])
    );
  } catch (e) {
    console.warn('[Mobile Preset] Failed to load preset usage:', e);
  }
}

refreshCustomPresetIdCounter();

function renderPresetSelect() {
  const presetSelect = $('new-preset');
  if (!presetSelect) return;
  const prev = presetSelect.value;
  presetSelect.innerHTML = '';

  const options = BUILTIN_OPTIONS.map(o => ({ value: o.value, label: o.label }));
  for (const p of getCustomPresets()) {
    options.push({
      value: p.autoFlag ? p.command + ' ' + p.autoFlag : p.command,
      label: p.autoFlag ? p.name + ' (全自动)' : p.name,
    });
  }
  // 用得多的靠上；次数相同时保持内置在前、自定义在后（sort 稳定）
  options.sort((a, b) => (PRESET_USAGE.get(b.value) || 0) - (PRESET_USAGE.get(a.value) || 0));

  for (const opt of options) {
    const el = document.createElement('option');
    el.value = opt.value;
    el.textContent = opt.label;
    presetSelect.appendChild(el);
  }

  // 恢复之前的选中值
  if (prev) presetSelect.value = prev;
  if (presetSelect.selectedIndex === -1) presetSelect.value = '';
}

function showPresetDialog(preset) {
  return new Promise((resolve) => {
    const isEdit = !!preset;
    const overlay = document.createElement('div');
    overlay.className = 'modal active';
    overlay.style.zIndex = '1001';
    const dialog = document.createElement('div');
    dialog.className = 'modal-content';
    dialog.innerHTML = `
      <h3>${isEdit ? '编辑' : '新建'}自定义预设</h3>
      <label>名称</label>
      <input type="text" id="preset-name-input" placeholder="如 Qoder代理、Aider 等" />
      <label>启动命令</label>
      <input type="text" id="preset-cmd-input" placeholder="如 qodercli、aider 等" />
      <label>全自动参数（可选）</label>
      <input type="text" id="preset-auto-input" placeholder="如 --dangerously-skip-permissions" />
      <label>同一终端先执行（可选）</label>
      <textarea id="preset-env-input" rows="4" placeholder="export HTTP_PROXY=http://127.0.0.1:39900&#10;export HTTPS_PROXY=http://127.0.0.1:39900"></textarea>
      <div class="preset-form-hint">会在这个终端里先敲这些命令，再启动上面的 CLI</div>
      <div class="modal-actions">
        <button id="preset-dialog-cancel" class="btn-secondary">取消</button>
        <button id="preset-dialog-ok" class="btn-primary">确定</button>
      </div>
    `;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const nameInput = dialog.querySelector('#preset-name-input');
    const cmdInput = dialog.querySelector('#preset-cmd-input');
    const autoInput = dialog.querySelector('#preset-auto-input');
    const envInput = dialog.querySelector('#preset-env-input');
    nameInput.value = preset ? preset.name : '';
    cmdInput.value = preset ? preset.command : '';
    autoInput.value = preset ? preset.autoFlag : '';
    envInput.value = formatPresetEnv(preset && preset.env);

    const cleanup = (result) => { overlay.remove(); resolve(result); };

    dialog.querySelector('#preset-dialog-cancel').onclick = () => cleanup(null);
    overlay.onclick = (e) => { if (e.target === overlay) cleanup(null); };

    dialog.querySelector('#preset-dialog-ok').onclick = () => {
      const name = nameInput.value.trim();
      const cmd = cmdInput.value.trim();
      const autoFlag = autoInput.value.trim();
      if (!name || !cmd) { alert('名称和命令不能为空'); return; }
      const id = preset ? preset.id : `custom-${customPresetNextId++}`;
      const env = parsePresetEnv(envInput.value);
      cleanup({ id, name, command: cmd, autoFlag, ...(Object.keys(env).length ? { env } : {}) });
    };
  });
}

function showPresetManageDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'modal active';
  overlay.style.zIndex = '1001';
  const dialog = document.createElement('div');
  dialog.className = 'modal-content preset-manage-dialog';

  dialog.innerHTML = '<h3>管理自定义预设</h3>';
  const listEl = document.createElement('div');
  listEl.className = 'preset-manage-list';

  const customs = getCustomPresets();
  if (customs.length === 0) {
    listEl.innerHTML = '<div class="preset-manage-empty">暂无自定义预设，点击上方 ＋ 按钮新建</div>';
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
      cmdEl.textContent = p.command + (p.autoFlag ? ' ' + p.autoFlag : '') + (p.env && Object.keys(p.env).length ? ' · 先执行环境变量' : '');
      info.appendChild(nameEl);
      info.appendChild(cmdEl);
      item.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'preset-manage-item-actions';

      const editBtn = document.createElement('button');
      editBtn.className = 'preset-manage-btn';
      setIcon(editBtn, 'edit', 14);
      editBtn.onclick = async () => {
        const edited = await showPresetDialog(p);
        if (edited) {
          const list = getCustomPresets();
          const idx = list.findIndex(x => x.id === p.id);
          if (idx !== -1) { list[idx] = edited; saveCustomPresets(list); }
          renderPresetSelect();
          overlay.remove();
          showPresetManageDialog(); // 刷新管理列表
        }
      };

      const delBtn = document.createElement('button');
      delBtn.className = 'preset-manage-btn preset-manage-btn-del';
      setIcon(delBtn, 'x', 14);
      delBtn.onclick = () => {
        if (!confirm(`确定删除预设「${p.name}」？`)) return;
        const list = getCustomPresets().filter(x => x.id !== p.id);
        saveCustomPresets(list);
        renderPresetSelect();
        overlay.remove();
        showPresetManageDialog(); // 刷新管理列表
      };

      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
      item.appendChild(actions);
      listEl.appendChild(item);
    }
  }

  dialog.appendChild(listEl);

  const actionsBar = document.createElement('div');
  actionsBar.className = 'modal-actions';
  actionsBar.innerHTML = '<button id="preset-manage-close" class="btn-secondary">关闭</button>';
  dialog.appendChild(actionsBar);

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  dialog.querySelector('#preset-manage-close').onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}

// 自定义预设按钮事件
const presetAddBtn = $('preset-add-btn');
const presetManageBtn = $('preset-manage-btn');
if (presetAddBtn) {
  presetAddBtn.addEventListener('click', async () => {
    const result = await showPresetDialog();
    if (result) {
      const list = getCustomPresets();
      list.push(result);
      saveCustomPresets(list);
      renderPresetSelect();
      const presetSelect = $('new-preset');
      if (presetSelect) presetSelect.value = result.autoFlag ? result.command + ' ' + result.autoFlag : result.command;
    }
  });
}
if (presetManageBtn) {
  presetManageBtn.addEventListener('click', () => {
    showPresetManageDialog();
  });
}

// 初始化渲染预设下拉
renderPresetSelect();

// ========== 新建会话 ==========

let lastKnownSessionCwd = '';


async function openNewSessionModal() {
  await Promise.all([
    refreshRecentCwdOptions(),
    pullCustomPresetsFromServer(),
    refreshBuiltinOptions(),
    refreshPresetUsage(),
  ]);
  renderPresetSelect();
  const select = $('new-cwd');
  if (select) {
    const lastCwd = localStorage.getItem(MOBILE_LAST_CWD_KEY) || '';
    select.value = lastCwd;
    if (lastCwd && select.value !== lastCwd) select.value = '';
  }
  const presetSelect = $('new-preset');
  if (presetSelect) {
    const savedPreset = localStorage.getItem(MOBILE_LAST_PRESET_KEY) || '';
    const lastPreset = migrateLegacyQoderPreset(savedPreset);
    if (lastPreset !== savedPreset) localStorage.setItem(MOBILE_LAST_PRESET_KEY, lastPreset);
    presetSelect.value = lastPreset;
    if (lastPreset && presetSelect.value !== lastPreset) presetSelect.value = '';
  }
  const themeSelect = $('new-theme');
  if (themeSelect) themeSelect.value = localStorage.getItem(MOBILE_THEME_KEY) || 'default';
  $('new-session-modal').classList.add('active');
}

$('new-session-btn').onclick = () => { void openNewSessionModal(); };
const emptyNewSessionBtn = $('empty-new-session-btn');
if (emptyNewSessionBtn) {
  emptyNewSessionBtn.onclick = () => { void openNewSessionModal(); };
}

$('modal-cancel').onclick = () => {
  $('new-session-modal').classList.remove('active');
};

$('modal-create').onclick = async () => {
  const cwd = $('new-cwd').value.trim() || '';
  const preset = $('new-preset').value;
  const themeId = $('new-theme')?.value || 'default';
  localStorage.setItem(MOBILE_THEME_KEY, themeId);
  $('new-session-modal').classList.remove('active');

  try {
    const session = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ cwd: cwd || undefined, presetCommand: preset, themeId }),
    });
    localStorage.setItem(MOBILE_LAST_CWD_KEY, cwd);
    localStorage.setItem(MOBILE_LAST_PRESET_KEY, preset);
    await refreshSessions();
    openSession(session.id);
  } catch (e) {
    alert('创建失败: ' + e.message);
  }
};

$('new-session-modal').onclick = (e) => {
  if (e.target === $('new-session-modal')) {
    $('new-session-modal').classList.remove('active');
  }
};

// ========== Web Push ==========

async function subscribePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

  try {
    const reg = await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;

    const { key } = await api('/api/vapid-public-key');
    const vapidKey = urlBase64ToUint8Array(key);

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKey,
      });
    }

    await api('/api/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({ subscription: sub }),
    });
  } catch (e) {
    console.warn('推送注册失败:', e);
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// ========== iOS PWA 黑屏修复 ==========
// iOS standalone 模式下切换输入法/app 后 canvas 上下文被系统回收，
// term.refresh() 无法恢复，必须销毁终端重建 + 重连 WebSocket 拿 replay

let repaintDebounce = null;
let isRecreating = false;

async function forceTerminalRecreate() {
  // 只在会话详情页且有当前会话时才重建
  if (!currentSessionId || !$('detail-page').classList.contains('active')) return;
  if (isRecreating) return;
  isRecreating = true;
  console.log('[黑屏修复] 重建终端, session=', currentSessionId);
  const sid = currentSessionId;
  const viewport = isUserScrolling && term ? term.buffer.active.viewportY : null;
  try {
    await createTerminal();
    pendingRecreateViewport = viewport;
    isUserScrolling = viewport != null;
    connectWebSocket(sid);
  } finally {
    isRecreating = false;
  }
}

function scheduleRepaint() {
  if (repaintDebounce) return; // 防抖，避免多个事件重复触发
  repaintDebounce = setTimeout(() => {
    repaintDebounce = null;
    forceTerminalRecreate();
  }, 300);
}

// xterm 5 用的是 2D canvas。不能对已有 2D 上下文的 canvas 再 getContext('webgl')。
// 切回标签时 backing store 可能短暂为 0，不能立刻当成黑屏去拆终端。
function isCanvasContextLost() {
  if (!term) return false;
  const container = $('terminal-container');
  if (!container || container.clientWidth < 1 || container.clientHeight < 1) return false;
  const canvas = container.querySelector('.xterm-screen canvas, canvas');
  if (!canvas) return false;
  return canvas.width === 0 || canvas.height === 0;
}

function recoverVisibleTerminal() {
  if (!currentSessionId || !$('detail-page').classList.contains('active')) return;
  wsLastPongAt = Date.now();
  if (term) term.refresh(0, term.rows - 1);
  if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
    connectWebSocket(currentSessionId);
  }
  setTimeout(() => {
    if (isCanvasContextLost()) scheduleRepaint();
  }, 400);
}

function recoverAndroidMedia() {
  const deviceId = androidMirrorDevice || $('device-select')?.value || '';
  const overlayOpen = $('fullscreen-overlay')?.style.display === 'flex';
  const deviceVisible = $('device-page')?.classList.contains('active')
    || $('device-page')?.classList.contains('landscape-drawer-open')
    || overlayOpen;
  if (!deviceId || !deviceVisible) return;
  if (document.visibilityState !== 'visible') {
    // End any active pointer at the application boundary and stop media
    // sockets while backgrounded; the last canvas/image remains as a stable
    // placeholder and no stale input is replayed on resume.
    androidMirror?.close();
    androidJpeg?.close();
    stopAndroidFallback();
    return;
  }
  startAndroidMirror(deviceId);
}

// 切回前台：重绘 + 必要时重连。只有 canvas 真丢了才拆终端。
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') recoverVisibleTerminal();
  recoverAndroidMedia();
});

window.addEventListener('pageshow', (e) => {
  if (e.persisted) recoverVisibleTerminal();
  if (e.persisted) recoverAndroidMedia();
});

// focus 事件兜底：语音输入法跳转回来时可能不触发 visibilitychange
// 只在 canvas 上下文确实丢失时才重建，避免正常打字时频繁触发
window.addEventListener('focus', () => {
  if (!currentSessionId || !$('detail-page').classList.contains('active')) return;
  // 延迟检测，等 iOS 完成页面恢复
  setTimeout(() => {
    if (isCanvasContextLost()) {
      console.log('[黑屏修复] focus 检测到 canvas 上下文丢失');
      scheduleRepaint();
    }
  }, 200);
});

// 监听 canvas 的 WebGL context lost 事件（最精准的检测）
function bindCanvasContextLost() {
  const container = $('terminal-container');
  if (!container) return;
  const canvas = container.querySelector('canvas');
  if (!canvas || canvas.dataset.ctxBound) return;
  canvas.addEventListener('webglcontextlost', (e) => {
    console.log('[黑屏修复] webglcontextlost 事件触发');
    e.preventDefault(); // 允许上下文恢复
    // 上下文丢失后，等页面恢复可见时重建
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        document.removeEventListener('visibilitychange', onVisible);
        scheduleRepaint();
      }
    };
    // 如果当前已经可见（语音输入法场景），直接重建
    if (document.visibilityState === 'visible') {
      scheduleRepaint();
    } else {
      document.addEventListener('visibilitychange', onVisible);
    }
  });
  canvas.dataset.ctxBound = '1';
}

// ========== 初始化 ==========

// 屏蔽 Cmd+R / F5 刷新，避免丢失所有对话
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'w') {
    e.preventDefault();
    void closeCurrentMobileSession();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
    e.preventDefault();
    showCopyToast('已阻止刷新，对话不会丢失');
    return;
  }
  if (e.key === 'F5') {
    e.preventDefault();
    showCopyToast('已阻止刷新，对话不会丢失');
  }
}, { capture: true });

async function loadServerInfo() {
  try {
    const res = await fetch(`${API}/api/server-info`);
    const info = await res.json();
    const el = $('server-info');
    el.innerHTML = `
      <div><span class="label">主机: </span><span class="value">${info.hostname}</span></div>
      <div><span class="label">局域网: </span><span class="value">http://${info.ip}:${info.port}</span></div>
    `;
  } catch {
    $('server-info').innerHTML = '<div style="color:var(--accent)">无法连接服务器</div>';
  }
}

loadServerInfo();

if (token) {
  api('/api/sessions').then(() => enterMain()).catch(() => showPage('login-page'));
} else {
  showPage('login-page');
}

window.addEventListener('online', () => {
  if (($('main-page').classList.contains('active') || $('main-page').classList.contains('landscape-drawer-open')) && token && !sseSource) {
    startSSE();
  }
  if (currentSessionId && $('detail-page').classList.contains('active')
      && (!ws || ws.readyState !== WebSocket.OPEN || !terminalInputReady)) {
    connectWebSocket(currentSessionId);
  }
  recoverAndroidMedia();
});

window.addEventListener('offline', () => {
  setTerminalInputReady(false);
  showCopyToast('网络已断开，恢复后将自动重连');
});

// ========== 初始化：自动验证 token 并进入主页 ==========

async function init() {
  const savedToken = localStorage.getItem('duocli_token');
  if (!savedToken) {
    showPage('login-page');
    return;
  }

  // 验证 token 是否有效
  try {
    const res = await fetch(`${API}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: savedToken }),
    });
    const data = await res.json();
    if (data.ok) {
      token = savedToken;
      enterMain();
    } else {
      localStorage.removeItem('duocli_token');
      showPage('login-page');
    }
  } catch (e) {
    // 网络错误时仍显示登录页
    showPage('login-page');
  }
}

init();
