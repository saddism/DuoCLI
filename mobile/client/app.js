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
let sseSource = null;

// xterm.js 相关
let term = null;
let fitAddon = null;
let ws = null;
let wsHeartbeat = null;
let wsReconnectTimer = null;
let wsReconnectAttempt = 0;
let wsConnectTimeoutTimer = null;
let wsLastPongAt = 0;
let copyToastTimer = null;
let isUserScrolling = false;
let terminalTouchActive = false;
let terminalScrollInteractionRevision = 0;
let terminalOutputWriteCount = 0;
// xterm v6 的 scrollToBottom 是平滑动画，onScroll 会在同步代码之后异步触发，
// 用布尔标志会被竞态误判。改用时间戳窗口标记程序化滚动。
let programmaticScrollUntil = 0;
let sseReconnectTimer = null;
let sseReconnectAttempt = 0;
const WEAK_NETWORK_STORAGE_KEY = 'duocli_weak_network_mode';
const MOBILE_LAST_CWD_KEY = 'duocli_mobile_last_cwd';
const MOBILE_LAST_PRESET_KEY = 'duocli_mobile_last_preset';
let weakNetworkMode = localStorage.getItem(WEAK_NETWORK_STORAGE_KEY) === '1';
const chatHelpers = globalThis.DuoChatHelpers || {
  ensureApiSuccess(ok, status, payload) {
    if (!ok) {
      const message = payload && typeof payload.error === 'string' && payload.error.trim()
        ? payload.error.trim()
        : `请求失败 (${status})`;
      throw new Error(message);
    }
    return payload;
  },
  mergePendingMessages(history, pendingMessages) {
    return {
      messages: Array.isArray(history) ? history : [],
      pendingMessages: Array.isArray(pendingMessages) ? pendingMessages : [],
    };
  },
  getResumeAgentLabel(agent) {
    if (agent === 'codex') return 'Codex';
    if (agent === 'claude') return 'Claude Code';
    return 'Agent';
  },
};
const terminalScrollHelpers = globalThis.DuoTerminalScrollHelpers || {
  isAtBottom(viewportY, baseY) { return viewportY >= baseY - 2; },
  shouldFollowOutput(wasAtBottom, touchActive, startInteraction, currentInteraction) {
    return wasAtBottom && !touchActive && startInteraction === currentInteraction;
  },
};

// 通用 spinner 拦截器（与 CLI 品牌无关：合并 \r 同行覆盖链，透传 \x1b[1A 等跨行定位码）。
const spinnerInterceptor = globalThis.DuoSpinnerInterceptor || {
  intercept(rawData) {
    // 兜底：保留原始数据不做合并，比丢内容安全。
    return rawData || null;
  },
  looksLikeSpinnerFrame() { return false; },
};

// spinner 高频期检测：短时间内连续多帧覆盖写入时，暂停滚动判定，
// 避免 spinner 每帧都触发一次 scrollToBottom 造成抖动与空白。
let spinnerActivityUntil = 0;
let spinnerFollowTimer = 0;
// 记录进入 spinner 期前用户是否在底部，供结束补滚判定。
let wasAtBottomBeforeSpinner = false;
function noteSpinnerActivity() {
  // 从「非活跃」进入活跃时，记录此刻用户是否在底部，供结束补滚判定。
  if (!isSpinnerActive()) {
    wasAtBottomBeforeSpinner = !isUserScrolling && isAtBottom();
  }
  spinnerActivityUntil = Date.now() + 200;
  // spinner 期间不滚；停顿 220ms 后若原本在底部且不在底部了，补一次 scrollToBottom，
  // 把 spinner 推下去的内容拉回视口，避免「spinner 结束后停在中间」。
  if (spinnerFollowTimer) clearTimeout(spinnerFollowTimer);
  spinnerFollowTimer = setTimeout(() => {
    spinnerFollowTimer = 0;
    if (term && !isUserScrolling && wasAtBottomBeforeSpinner && !isAtBottom()) {
      scrollTerminalToBottom();
    }
    wasAtBottomBeforeSpinner = false;
  }, 220);
}
function isSpinnerActive() {
  return Date.now() < spinnerActivityUntil;
}

// ========== 循环（自动继续）==========
// 手机端只做 UI，实际配置存在桌面端，通过 API 读写

// ========== 工具函数 ==========

function $(id) { return document.getElementById(id); }

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

// CLI 标签颜色映射 [文字色, 背景色]，与桌面端保持一致
const CLI_TAG_COLORS = {
  'Claude全自动':  ['#e5a100', '#3d3010'],
  'Codex全自动':   ['#56d4a0', '#1a3d2e'],
  'Devin全自动':   ['#7ec699', '#1e3328'],
  'Kimi全自动':    ['#d19ae8', '#33204a'],
  'Gemini全自动':  ['#99bbff', '#222d4a'],
  'OpenCode':     ['#61afef', '#1e2e3d'],
  'Qoder':        ['#e5c07b', '#3d3520'],
  'Qoder全自动':  ['#d4a020', '#3d3520'],
  'Kiro全自动':    ['#ff9e7a', '#4a2a1a'],
};

function getCliTagColors(name) {
  if (CLI_TAG_COLORS[name]) return CLI_TAG_COLORS[name];
  for (const key of Object.keys(CLI_TAG_COLORS)) {
    if (name.startsWith(key)) return CLI_TAG_COLORS[key];
  }
  // 未知 CLI：hash 选色
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  const palette = [
    ['#e06c75', '#3d1e22'], ['#e5c07b', '#3d3520'], ['#98c379', '#253320'],
    ['#f78c6c', '#3d2518'], ['#c792ea', '#2e1e3d'], ['#ff5370', '#3d1825'],
  ];
  return palette[Math.abs(h) % palette.length];
}

function hideTerminalLoading() {
  const el = $('terminal-loading');
  if (el && !el.classList.contains('hidden')) {
    el.classList.add('hidden');
  }
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
      return chatHelpers.ensureApiSuccess(r.ok, r.status, data);
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

function showPage(id) {
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
    label.textContent = '催';
    label.className = 'ac-label' + (enabled ? ' enabled' : '');
  }
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
  button.textContent = '↓';
  button.addEventListener('click', scrollTerminalToBottom);
  container.appendChild(button);
}

function setTerminalUnreadOutput(hasUnread) {
  const button = $('terminal-scroll-bottom-btn');
  if (button) button.hidden = !hasUnread;
}

let scrollToBottomRaf = 0;
function scrollTerminalToBottom() {
  if (!term) return;
  isUserScrolling = false;
  resetScrollAccum();
  setTerminalUnreadOutput(false);
  if (isAtBottom()) return;
  // 高频输出时 writeTerminalOutput 每次 write 回调都可能调到这里。
  // xterm v6 的 scrollToBottom 是平滑动画，多次叠加会在动画过程中把 viewport
  // 反复拉到底，渲染出中间空白帧（屏幕表现为「滚出很多空白」）。
  // 用 rAF 把同一帧内的多次调用合并成一次。
  if (scrollToBottomRaf) return;
  scrollToBottomRaf = requestAnimationFrame(() => {
    scrollToBottomRaf = 0;
    if (!term) return;
    if (isAtBottom()) return;
    // 200ms 足以覆盖一次平滑滚动；过长会让 onScroll 长时间被当成程序化滚动，
    // 吞掉用户真实触摸滚动。
    programmaticScrollUntil = Date.now() + 200;
    term.scrollToBottom();
  });
}

function resetTerminalScrollState() {
  isUserScrolling = false;
  terminalTouchActive = false;
  terminalScrollInteractionRevision = 0;
  terminalOutputWriteCount = 0;
  programmaticScrollUntil = 0;
  spinnerActivityUntil = 0;
  wasAtBottomBeforeSpinner = false;
  if (spinnerFollowTimer) { clearTimeout(spinnerFollowTimer); spinnerFollowTimer = 0; }
  if (scrollToBottomRaf) {
    cancelAnimationFrame(scrollToBottomRaf);
    scrollToBottomRaf = 0;
  }
  resetScrollAccum();
  setTerminalUnreadOutput(false);
}

function writeTerminalOutput(data, wasAtBottom = isAtBottom()) {
  if (!term) return;
  const activeTerm = term;
  const startInteraction = terminalScrollInteractionRevision;
  terminalOutputWriteCount++;
  activeTerm.write(data, () => {
    if (term !== activeTerm) return;
    terminalOutputWriteCount = Math.max(0, terminalOutputWriteCount - 1);
    // spinner 高频期暂停滚动判定：spinner 每秒 10+ 帧 \r 覆盖，逐帧 scrollToBottom
    // 会让 xterm 平滑动画叠加成抖动 + 空白。期间只写不滚，等带 \n 的真实输出恢复跟随。
    if (isSpinnerActive()) return;
    if (terminalScrollHelpers.shouldFollowOutput(
      wasAtBottom,
      terminalTouchActive,
      startInteraction,
      terminalScrollInteractionRevision,
    )) {
      scrollTerminalToBottom();
    } else if (!isAtBottom()) {
      setTerminalUnreadOutput(true);
    }
  });
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
function scheduleTerminalResize() {
  if (terminalResizeFrame !== null) return;
  terminalResizeFrame = requestAnimationFrame(() => {
    terminalResizeFrame = null;
    const container = $('terminal-container');
    if (!term || !fitAddon || !container || container.clientWidth < 1 || container.clientHeight < 1) return;
    const size = `${container.clientWidth}x${container.clientHeight}`;
    if (size === lastTerminalSize) return;
    lastTerminalSize = size;
    handleResize();
  });
}

function getLineTextByTouchY(clientY) {
  if (!term) return '';
  const container = $('terminal-container');
  const rect = container.getBoundingClientRect();
  const rowsEl = container.querySelector('.xterm-rows');
  const firstRow = rowsEl?.children?.[0];
  const rowHeight = firstRow?.getBoundingClientRect().height || 18;
  const yInTerminal = clientY - rect.top;
  const visualRow = Math.max(0, Math.floor(yInTerminal / rowHeight));
  const buffer = term.buffer.active;
  const lineIndex = Math.min(
    Math.max(0, buffer.viewportY + visualRow),
    Math.max(0, buffer.length - 1),
  );
  const line = buffer.getLine(lineIndex);
  return line ? line.translateToString(true).trim() : '';
}

// ========== 登录 ==========

function logout() {
  token = '';
  localStorage.removeItem('duocli_token');
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
    showCopyToast(`🟢 切到 ${ip}:${port}`);
    setTimeout(() => location.replace(`http://${ip}:${port}/?token=${encodeURIComponent(token)}`), 200);
  }

  // LAN → CF：用户点 或 自检失败
  function switchToCloud(auto) {
    const cloudUrl = localStorage.getItem(STORAGE_CLOUD_URL) || 'https://duocli.guixian.fun';
    showCopyToast(auto ? '局域网失联，回到云端…' : '☁️ 切到云端…');
    setTimeout(() => location.replace(`${cloudUrl}/?token=${encodeURIComponent(token)}`), 200);
  }

  function updateButton() {
    const btn = $('net-mode-btn');
    if (!btn) return;
    if (!token) { btn.style.display = 'none'; return; }
    btn.style.display = 'inline-flex';
    if (isLanMode()) {
      btn.textContent = '🟢 局域网';
      btn.title = '当前局域网直连，点击切回云端';
      btn.className = 'net-mode-btn lan';
      btn.onclick = () => switchToCloud(false);
    } else if (isCfMode()) {
      btn.textContent = '🟡 切局域网';
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

let remoteTapEnabled = false;
let screenshotObjectUrl = null;

function initDevicePage() {
  $('device-console-btn').onclick = async () => {
    showPage('device-page');
    await refreshAndroidDevices();
    // 设备加载完后自动截图
    if ($('device-select').value) {
      refreshAndroidScreenshot();
    }
    showCopyToast('🖱 开启后可点击操控');
  };
  // ---- 自适应帧率控制器 ----
  let autoRunning = false;
  let autoStopped = false;
  let adaptiveQuality = 60;
  let adaptiveScale = 0.5;
  const TARGET_MS = 1000; // 目标帧间隔

  async function adaptiveLoop() {
    if (autoStopped) return;
    autoRunning = true;
    const t0 = Date.now();
    try {
      await refreshAndroidScreenshot(adaptiveQuality, adaptiveScale);
      $('fullscreen-preview').src = $('device-preview').src;
    } catch {}
    const elapsed = Date.now() - t0;
    // 自适应：太慢就降质量/分辨率，够快就提升
    if (elapsed > TARGET_MS * 1.2) {
      if (adaptiveQuality > 20) { adaptiveQuality = Math.max(20, adaptiveQuality - 10); }
      else if (adaptiveScale > 0.2) { adaptiveScale = Math.max(0.2, adaptiveScale - 0.1); }
    } else if (elapsed < TARGET_MS * 0.6) {
      if (adaptiveScale < 0.5) { adaptiveScale = Math.min(0.5, adaptiveScale + 0.05); }
      else if (adaptiveQuality < 70) { adaptiveQuality = Math.min(70, adaptiveQuality + 5); }
    }
    if (!autoStopped) {
      const wait = Math.max(0, TARGET_MS - elapsed);
      setTimeout(adaptiveLoop, wait);
    }
  }

  function startAutoRefresh() {
    if (autoRunning && !autoStopped) return;
    autoStopped = false;
    adaptiveLoop();
    $('fullscreen-auto-btn').textContent = '停止刷新';
  }

  function stopAutoRefresh() {
    autoStopped = true;
    autoRunning = false;
    $('fullscreen-auto-btn').textContent = '自动刷新';
  }

  $('device-back-btn').onclick = () => { stopAutoRefresh(); showPage('main-page'); };
  $('fullscreen-back-btn').onclick = () => {
    stopAutoRefresh();
    $('fullscreen-overlay').style.display = 'none';
  };
  $('fullscreen-auto-btn').onclick = () => {
    if (autoRunning && !autoStopped) { stopAutoRefresh(); }
    else { startAutoRefresh(); }
  };
  const sendTextToDevice = async () => {
    const text = $('fullscreen-text-input').value;
    if (!text) return;
    const deviceId = $('device-select').value;
    if (!deviceId) { showCopyToast('请先选择设备'); return; }
    $('fullscreen-text-input').value = '';
    $('input-text-modal').classList.remove('active');
    showCopyToast('⚠️ 请确保手机上已点击输入框');
    await new Promise(r => setTimeout(r, 800));
    await fetch(`${API}/api/android/input-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ deviceId, text }),
    }).catch(() => {});
    showCopyToast('已发送');
  };
  $('fullscreen-text-btn').onclick = () => {
    $('fullscreen-text-input').value = '';
    $('input-text-modal').classList.add('active');
    setTimeout(() => $('fullscreen-text-input').focus(), 100);
  };
  $('input-text-close').onclick = () => $('input-text-modal').classList.remove('active');
  $('fullscreen-text-send').onclick = sendTextToDevice;
  $('fullscreen-text-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendTextToDevice(); });
  $('device-fullscreen-btn').onclick = () => {
    const src = $('device-preview').src;
    if (!src) { showCopyToast('请先获取截图'); return; }
    $('fullscreen-preview').src = src;
    $('fullscreen-overlay').style.display = 'flex';
    startAutoRefresh(); // 进入全屏默认开启自动刷新
    showCopyToast('点击/拖动操控 · ⌨️ 输入文字');
  };
  $('device-shell-btn').onclick = () => {
    $('shell-output').style.display = 'none';
    $('shell-input').value = '';
    $('shell-modal').classList.add('active');
  };
  $('shell-modal-close').onclick = () => $('shell-modal').classList.remove('active');
  $('shell-run-btn').onclick = async () => {
    const command = $('shell-input').value.trim();
    const deviceId = $('device-select').value;
    if (!command) return;
    if (!deviceId) { showCopyToast('请先选择设备'); return; }
    $('shell-run-btn').textContent = '执行中...';
    $('shell-run-btn').disabled = true;
    try {
      const res = await fetch(`${API}/api/android/shell`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ deviceId, command }),
      });
      const data = await res.json();
      const out = $('shell-output');
      out.textContent = data.output || data.error || '（无输出）';
      out.style.display = 'block';
    } catch (e) {
      showCopyToast('执行失败: ' + e.message);
    } finally {
      $('shell-run-btn').textContent = '执行';
      $('shell-run-btn').disabled = false;
    }
  };
  // ---- 全屏触摸：区分点击(tap)和拖动(swipe) ----
  let touchStart = null;
  const fsImg = $('fullscreen-preview');
  function imgToDevice(clientX, clientY) {
    const rect = fsImg.getBoundingClientRect();
    return {
      x: Math.round((clientX - rect.left) * fsImg.naturalWidth / rect.width),
      y: Math.round((clientY - rect.top) * fsImg.naturalHeight / rect.height),
    };
  }
  fsImg.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    touchStart = { cx: t.clientX, cy: t.clientY, time: Date.now() };
  }, { passive: true });
  fsImg.addEventListener('touchend', async (e) => {
    if (!touchStart) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.cx;
    const dy = t.clientY - touchStart.cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const duration = Date.now() - touchStart.time;
    const deviceId = $('device-select').value;
    if (!deviceId) { touchStart = null; return; }
    e.preventDefault();
    if (dist < 15) {
      // 点击
      const p = imgToDevice(t.clientX, t.clientY);
      fetch(`${API}/api/android/tap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ deviceId, x: p.x, y: p.y }),
      }).catch(() => {});
    } else {
      // 拖动
      const p1 = imgToDevice(touchStart.cx, touchStart.cy);
      const p2 = imgToDevice(t.clientX, t.clientY);
      const swipeDur = Math.max(150, Math.min(2000, duration));
      fetch(`${API}/api/android/swipe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ deviceId, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, duration: swipeDur }),
      }).catch(() => {});
    }
    touchStart = null;
  });
  // 桌面端兜底：鼠标点击 = tap
  fsImg.onclick = async (e) => {
    const deviceId = $('device-select').value;
    if (!deviceId) return;
    const p = imgToDevice(e.clientX, e.clientY);
    fetch(`${API}/api/android/tap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ deviceId, x: p.x, y: p.y }),
    }).catch(() => {});
  };
  $('device-refresh-btn').onclick = refreshAndroidDevices;
  $('device-shot-btn').onclick = () => {
    showCopyToast('正在刷新截图...');
    refreshAndroidScreenshot();
  };
  $('device-tap-toggle').onclick = () => {
    remoteTapEnabled = !remoteTapEnabled;
    $('device-tap-toggle').style.opacity = remoteTapEnabled ? '1' : '0.4';
    $('device-preview').style.cursor = remoteTapEnabled ? 'crosshair' : 'default';
    showCopyToast(remoteTapEnabled ? '🖱 远程控制已开启，点击截图操控手机' : '🖱 远程控制已关闭');
  };
  $('device-preview').onclick = async (e) => {
    if (!remoteTapEnabled) {
      // 非控制模式：进入全屏
      const overlay = $('fullscreen-overlay');
      $('fullscreen-preview').src = $('device-preview').src;
      overlay.style.display = 'flex';
      return;
    }
    const img = e.currentTarget;
    const rect = img.getBoundingClientRect();
    const x = Math.round((e.clientX - rect.left) * img.naturalWidth / rect.width);
    const y = Math.round((e.clientY - rect.top) * img.naturalHeight / rect.height);
    const deviceId = $('device-select').value;
    if (!deviceId) return;
    await fetch(`${API}/api/android/tap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ deviceId, x, y }),
    }).catch(() => {});
    setTimeout(() => refreshAndroidScreenshot(), 800);
  };
  $('device-select').onchange = () => {
    const id = $('device-select').value;
    if (id) localStorage.setItem('duocli_android_device', id);
  };
}

function setDeviceHint(msg) {
  showCopyToast(msg);
}

async function refreshAndroidDevices() {
  setDeviceHint('正在加载设备...');
  try {
    const data = await api('/api/android/devices');
    const sel = $('device-select');
    const saved = localStorage.getItem('duocli_android_device');
    sel.innerHTML = '';
    if (data.devices.length) {
      for (const d of data.devices) {
        // 用 DOM API 而非 innerHTML 拼接，避免 adb 输出里的 OEM 设备名注入 HTML
        const opt = document.createElement('option');
        opt.value = d.id;
        opt.textContent = d.info ? `${d.id} ${d.info}` : d.id;
        if (d.id === saved) opt.selected = true;
        sel.appendChild(opt);
      }
    } else {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '未找到设备';
      sel.appendChild(opt);
    }
    setDeviceHint(data.devices.length ? '' : '未找到已连接的 Android 设备');
  } catch (e) {
    setDeviceHint('获取设备失败: ' + (e.message || e));
  }
}

async function refreshAndroidScreenshot(quality, scale) {
  const deviceId = $('device-select').value;
  if (!deviceId) { setDeviceHint('请先选择设备'); return; }
  try {
    let url = `${API}/api/android/screenshot?deviceId=${encodeURIComponent(deviceId)}`;
    if (quality) url += `&quality=${quality}`;
    if (scale) url += `&scale=${scale}`;
    const res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (screenshotObjectUrl) URL.revokeObjectURL(screenshotObjectUrl);
    screenshotObjectUrl = URL.createObjectURL(blob);
    const img = $('device-preview');
    img.src = screenshotObjectUrl;
    img.style.display = 'block';
    $('device-preview-empty').style.display = 'none';
    setDeviceHint('截图更新于 ' + new Date().toLocaleTimeString());
  } catch (e) {
    setDeviceHint('截图失败: ' + (e.message || e));
  }
}

// ========== 主页面 ==========

async function enterMain() {
  showPage('main-page');
  initDevicePage();
  await refreshSessions();
  await refreshRecentCwdOptions();
  await pullCustomPresetsFromServer(); // 从服务端同步预设
  renderPresetSelect();
  startSSE();
  subscribePush();
  // 预加载 chat 会话列表
  chatSessionsLastFetch = 0;
  fetchChatSessions().then(list => { cachedChatSessions = list || []; });
  // 启动局域网探测（CF 模式提示切换；LAN 模式监控失联回退）
  LanSwitcher.start();
}

async function refreshSessions() {
  try {
    const sessions = await api('/api/sessions');
    renderSessionList(sessions);
  } catch (e) {
    console.error('刷新会话失败', e);
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

function renderSessionList(sessions) {
  const list = $('session-list');
  const empty = $('empty-state');

  const allCards = sessions.map(s => {
    const dn = s.displayName || '';
    const [tagColor, tagBg] = dn ? getCliTagColors(dn) : ['', ''];
    const tagHtml = dn
      ? `<span class="cli-tag" style="--cli-c:${tagColor};--cli-bg:${tagBg}">${escHtml(dn)}</span>`
      : '';
    return `
    <div class="session-card" data-id="${s.id}">
      <div class="status-dot ${s.status}"></div>
      <div class="session-info">
        <div class="session-title-row">
          <div class="session-title">${escHtml(s.title || s.presetCommand || '终端')}</div>
          ${tagHtml}
        </div>
        <div class="session-meta">
          <span class="session-time">${formatTime(s.createdAt)}</span>
          <span class="session-cwd">${escHtml(s.cwd.split('/').pop() || s.cwd)}</span>
        </div>
      </div>
      <div class="session-arrow">›</div>
    </div>`;
  }).join('');

  if (!sessions.length) {
    list.innerHTML = '';
    empty.style.display = 'flex';
    return;
  }

  empty.style.display = 'none';
  list.innerHTML = allCards;

  list.querySelectorAll('.session-card').forEach(card => {
    const id = card.dataset.id;
    card.onclick = () => openSession(id);
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
      const sessions = JSON.parse(e.data);
      if ($('main-page').classList.contains('active')) {
        renderSessionList(sessions);
      }
      if (currentSessionId) {
        const s = sessions.find(x => x.id === currentSessionId);
        if (s) {
          $('detail-status').className = `status-dot ${s.status}`;
        }
      }
    } catch {}
  });
  sseSource.onerror = () => {
    stopSSE();
    if (navigator.onLine === false) return;
    if (sseReconnectTimer) clearTimeout(sseReconnectTimer);
    const delay = Math.min(profile.sseRetryBaseMs * Math.pow(2, sseReconnectAttempt), profile.sseRetryMaxMs) + Math.floor(Math.random() * 600);
    sseReconnectAttempt++;
    sseReconnectTimer = setTimeout(() => {
      sseReconnectTimer = null;
      // 只在主页面时维持 SSE，减少弱网反复连接抖动
      if ($('main-page').classList.contains('active')) {
        startSSE();
      }
    }, delay);
  };
}

function stopSSE() {
  if (sseReconnectTimer) { clearTimeout(sseReconnectTimer); sseReconnectTimer = null; }
  if (sseSource) { sseSource.close(); sseSource = null; }
}

// 发送输入：普通文本走 input_b64；回车统一补发 hex(0d)，避免仅靠字符串换行不执行
function sendInputWithHexEnter(raw) {
  if (!raw) return;
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

function openFilePreview(requestedPath) {
  if (!currentSessionId) return;
  const title = $('file-preview-title');
  const meta = $('file-preview-meta');
  const content = $('file-preview-content');
  const mediaBox = $('file-preview-media');
  if (!title || !meta || !content) return;

  const baseName = requestedPath.split('/').pop() || requestedPath;
  title.textContent = baseName;
  meta.textContent = '正在读取…';
  content.textContent = '';
  content.style.display = '';
  if (mediaBox) mediaBox.innerHTML = '';
  showPage('file-preview-page');

  // 媒体文件：用 <img>/<video>/<audio>/<iframe> 直接加载（src 带 token）
  const mediaKind = globalThis.DuoFilePreviewHelpers?.getMediaKind?.(requestedPath);
  if (mediaKind) {
    const mediaUrl = `${API}/api/sessions/${encodeURIComponent(currentSessionId)}/media?path=${encodeURIComponent(requestedPath)}&token=${encodeURIComponent(token)}`;
    meta.textContent = requestedPath;
    renderMediaPreview(mediaKind, mediaUrl, baseName, requestedPath);
    return;
  }

  // 文本文件：走原逻辑
  api(`/api/sessions/${encodeURIComponent(currentSessionId)}/file-preview?path=${encodeURIComponent(requestedPath)}`)
    .then((data) => {
      if (!currentSessionId) return;
      title.textContent = data.name || requestedPath;
      meta.textContent = data.path || requestedPath;
      content.textContent = typeof data.content === 'string' ? data.content : '';
    })
    .catch((error) => {
      showPage('detail-page');
      showCopyToast(error.message || '文件预览失败');
    });
}

// 按媒体类型渲染预览元素到 #file-preview-media
function renderMediaPreview(kind, mediaUrl, name, fullPath) {
  const mediaBox = $('file-preview-media');
  const content = $('file-preview-content');
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
      mediaBox.innerHTML = `<div class="media-error">⚠️ 图片加载失败：${escapeHtml(name)}</div>`;
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
      mediaBox.innerHTML = `<div class="media-error">⚠️ 视频加载失败：${escapeHtml(name)}<br><span class="media-error-hint">mov 等格式浏览器可能不支持，建议在桌面端查看</span></div>`;
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

function registerMobileFileLinks() {
  if (!term || !globalThis.DuoFilePreviewHelpers) return;
  const provider = {
    provideLinks(y, callback) {
      const buffer = term.buffer.active;
      let startLineIndex = y - 1;
      if (!buffer.getLine(startLineIndex)) { callback(undefined); return; }
      while (startLineIndex > 0 && buffer.getLine(startLineIndex)?.isWrapped) startLineIndex--;

      const lines = [];
      let nextLineIndex = startLineIndex;
      while (true) {
        const line = buffer.getLine(nextLineIndex);
        if (!line || (nextLineIndex !== startLineIndex && !line.isWrapped)) break;
        lines.push(line);
        nextLineIndex++;
      }

      let text = '';
      const posLine = [];
      const posCell = [];
      lines.forEach((line, lineOffset) => {
        const bufferLineIndex = startLineIndex + lineOffset;
        for (let cellIndex = 0; cellIndex < line.length; cellIndex++) {
          const cell = line.getCell(cellIndex);
          const chars = cell?.getChars() || '';
          const width = cell?.getWidth() || 1;
          if (chars) {
            for (let charIndex = 0; charIndex < chars.length; charIndex++) {
              posLine.push(bufferLineIndex);
              posCell.push(cellIndex);
            }
            text += chars;
          } else if (width !== 0) {
            posLine.push(bufferLineIndex);
            posCell.push(cellIndex);
            text += ' ';
          }
        }
      });

      const links = globalThis.DuoFilePreviewHelpers.findFilePathMatches(text).flatMap((match) => {
        const start = match.index;
        const end = match.index + match.length - 1;
        if (start >= posLine.length || end >= posLine.length) return [];
        return [{
          range: {
            start: { x: posCell[start] + 1, y: posLine[start] + 1 },
            end: { x: posCell[end] + 1, y: posLine[end] + 1 },
          },
          text: match.filePath,
          activate: () => openFilePreview(match.filePath),
        }];
      });
      callback(links.length ? links : undefined);
    },
  };
  term.registerLinkProvider(provider);
}

function createTerminal() {
  closeTerminal();

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
        // 输出写入也会触发 xterm 的 scroll 事件，不能误判为用户回看。
        // xterm v6 平滑滚动期间 onScroll 会异步多次触发，落在时间戳窗口内即视为程序化滚动。
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

      let touchLastY = 0;
      let touchActive = false;
      const onTouchStart = (e) => {
        if (e.touches.length !== 1) {
          touchActive = false;
          terminalTouchActive = false;
          return;
        }
        touchLastY = e.touches[0].clientY;
        touchActive = true;
        terminalTouchActive = true;
        resetScrollAccum();
      };
      const onTouchMove = (e) => {
        if (!touchActive || e.touches.length !== 1) return;
        const currentY = e.touches[0].clientY;
        const deltaY = touchLastY - currentY;
        touchLastY = currentY;
        // 页面本身不可滚动，始终拦截可避免浏览器在第一小段位移后接管手势。
        if (e.cancelable) e.preventDefault();
        if (deltaY !== 0) scrollTerminalByPixels(deltaY);
      };
      const onTouchEnd = () => {
        touchActive = false;
        terminalTouchActive = false;
        if (term && isAtBottom()) {
          isUserScrolling = false;
          setTerminalUnreadOutput(false);
        } else if (term) {
          isUserScrolling = true;
        }
      };

      container.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
      container.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
      container.addEventListener('touchend', onTouchEnd, { passive: true, capture: true });
      container.addEventListener('touchcancel', onTouchEnd, { passive: true, capture: true });
      terminalTouchCleanup = () => {
        container.removeEventListener('touchstart', onTouchStart, true);
        container.removeEventListener('touchmove', onTouchMove, true);
        container.removeEventListener('touchend', onTouchEnd, true);
        container.removeEventListener('touchcancel', onTouchEnd, true);
        terminalTouchCleanup = null;
      };

      if (!container.dataset.copyBound) {
        // 长按复制：优先复制已选中文本；未选择时复制当前按住行
        let copyPressTimer = null;
        let copyStartX = 0;
        let copyStartY = 0;
        let copyLineY = 0;
        const cancelCopyPress = () => {
          if (copyPressTimer) {
            clearTimeout(copyPressTimer);
            copyPressTimer = null;
          }
        };
        container.addEventListener('touchstart', (e) => {
          if (!term || e.touches.length !== 1) return;
          const t = e.touches[0];
          copyStartX = t.clientX;
          copyStartY = t.clientY;
          copyLineY = t.clientY;
          cancelCopyPress();
          copyPressTimer = setTimeout(async () => {
            let text = term.hasSelection() ? term.getSelection().trim() : '';
            if (!text) text = getLineTextByTouchY(copyLineY);
            if (!text) {
              showCopyToast('当前无可复制内容');
              return;
            }
            const ok = await copyTextToClipboard(text);
            showCopyToast(ok ? '已复制到剪贴板' : '复制失败');
          }, 520);
        }, { passive: true });
        container.addEventListener('touchmove', (e) => {
          if (!copyPressTimer || e.touches.length !== 1) return;
          const t = e.touches[0];
          if (Math.abs(t.clientX - copyStartX) > 10 || Math.abs(t.clientY - copyStartY) > 10) {
            cancelCopyPress();
          }
        }, { passive: true });
        container.addEventListener('touchend', cancelCopyPress, { passive: true });
        container.addEventListener('touchcancel', cancelCopyPress, { passive: true });
        container.dataset.copyBound = '1';
      }

      // 绑定 canvas context lost 监听（黑屏修复）
      if (typeof bindCanvasContextLost === 'function') {
        setTimeout(bindCanvasContextLost, 100);
      }

      resolve(term);
    }); });
  });
}

function handleResize() {
  if (!fitAddon || !term) return;
  // fit() 改变 cols/rows 时，xterm 会保持视口相对位置，不需要手动 scrollToBottom。
  // 旧版在 fit 后强制 scrollToBottom，会在输出期间与 ResizeObserver 形成自激循环：
  // 输出 → xterm 内部 DOM 重排 → container 尺寸微变 → ResizeObserver → fit → scrollToBottom
  // → 平滑动画期间又触发 onScroll → 反复滚到底，渲染出大片空白行。
  fitAddon.fit();
  if (ws && ws.readyState === WebSocket.OPEN && term.cols > 0 && term.rows > 0) {
    wsSend({ type: 'resize', cols: term.cols, rows: term.rows });
  }
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
  resetTerminalScrollState();
  closeWebSocket();
  // 重置 spinner 拦截状态
  resetSpinnerState();
  if (term) {
    term.dispose();
    term = null;
    fitAddon = null;
  }
}

// ========== Spinner 拦截（手机窄屏优化，通用 CLI 兼容） ==========

// 手机端列数少（40-50），各 CLI（Claude/Codex/Cursor/Qoder）的 spinner 用 \r
// 反复覆盖同一行，但窄屏下内容超宽 wrap 后 \r 无法清除上方残留行 → 重复多行
// → 视觉上「滚出空白屏」。
//
// 本模块调用 spinner-interceptor.js 的通用拦截器：按 \n 切段，对每段合并 \r 同行
// 覆盖链（只保留最后一个有效 \r 之后的内容），含 \x1b[1A 等跨行定位码的段透传
// 给 xterm 原生处理。与 CLI 品牌无关。
//
// 同时联动滚动：检测到 spinner 覆盖帧时进入高频节流期，期间暂停 scrollToBottom，
// 避免 spinner 每帧都触发平滑动画叠加成抖动。

function resetSpinnerState() {
  spinnerActivityUntil = 0;
}

/** 核心拦截：返回应写入 term 的数据；null 表示丢弃该帧 */
function interceptSpinnerData(rawData) {
  const result = spinnerInterceptor.intercept(rawData);
  // 检测到覆盖帧（被合并或仍含 \r 覆盖链）→ 标记 spinner 活跃期，暂停滚动判定。
  if (result && spinnerInterceptor.looksLikeSpinnerFrame(rawData)) {
    noteSpinnerActivity();
  }
  return result;
}

// ========== WebSocket ==========

function connectWebSocket(sessionId) {
  closeWebSocket();
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
    // 重连时清空终端，避免 replay 叠加
    if (term) term.reset();
    // 订阅会话
    wsSend({ type: 'subscribe', sessionId });
    // 发送当前终端尺寸（过滤无效值，避免 pty resize(0,0) 异常）
    if (term && term.cols > 0 && term.rows > 0) {
      console.log('[ws] sending resize', term.cols, term.rows);
      wsSend({ type: 'resize', cols: term.cols, rows: term.rows });
    } else {
      console.log('[ws] skipping resize, cols=', term?.cols, 'rows=', term?.rows);
    }
    // 心跳保活，防止 iOS Safari 后台杀连接
    clearInterval(wsHeartbeat);
    wsHeartbeat = setInterval(() => {
      wsSend({ type: 'ping' });
      // 超过 45 秒未收到任何服务端消息（含 pong）则主动断开并重连
      if (Date.now() - wsLastPongAt > profile.wsStaleTimeoutMs && ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }, profile.wsPingIntervalMs);
  };

  let replayReceived = false;
  let replayRetryTimer = null;
  let replayRetryCount = 0;

  // 8秒内未收到 replay，显示重连提示
  if (wsConnectTimeoutTimer) clearTimeout(wsConnectTimeoutTimer);
  wsConnectTimeoutTimer = setTimeout(() => {
    if (!replayReceived && term) {
      hideTerminalLoading();
      writeTerminalOutput('\r\n\x1b[33m⚠ 连接超时，正在重连...\x1b[0m\r\n');
      showWeakNetworkPrompt('连接超时，正在重试');
    }
  }, profile.wsConnectTimeoutMs);

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
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
        // 先彻底清空，再写入 replay 内容，避免残留
        term.reset();
        resetTerminalScrollState();
        if (msg.data) {
          // 有内容，隐藏 loading 并写入
          hideTerminalLoading();
          writeTerminalOutput(msg.data, true);
        } else {
          // replay 为空（新建会话，pty 刚启动）：也隐藏 loading，连接已成功
          hideTerminalLoading();
          // 延迟重新订阅以获取最新 buffer，最多重试 3 次
          if (!replayRetryTimer && replayRetryCount < 3) {
            replayRetryCount++;
            replayRetryTimer = setTimeout(() => {
              replayRetryTimer = null;
              if (ws && ws.readyState === WebSocket.OPEN && currentSessionId === sessionId) {
                wsSend({ type: 'subscribe', sessionId });
              }
            }, 800);
          }
        }
      } else if (msg.type === 'output') {
        hideTerminalLoading();
        hideWeakNetworkPrompt();

        // 手机窄屏 spinner 拦截：避免 \r 覆盖帧 wrap 后产生多行残留
        let writeData = msg.data;
        if (term && term.cols <= 60) {
          writeData = interceptSpinnerData(msg.data);
        }

        if (writeData !== null) {
          writeTerminalOutput(writeData, !isUserScrolling && isAtBottom());
        }
      }
    } catch {}
  };

  ws.onclose = () => {
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
    // 某些浏览器弱网下只触发 onerror 不触发 onclose，主动 close 统一走重连逻辑
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      ws.close();
    }
  };
}

function closeWebSocket() {
  clearInterval(wsHeartbeat);
  hideWeakNetworkPrompt();
  if (wsConnectTimeoutTimer) { clearTimeout(wsConnectTimeoutTimer); wsConnectTimeoutTimer = null; }
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
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
  currentSessionId = id;
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
  console.log('[openSession] terminal ready, cols=', term?.cols, 'rows=', term?.rows);
  connectWebSocket(id);
  console.log('[openSession] connectWebSocket called');

  // 初始化催工 UI（从桌面端读取配置）
  getAutoContinueConfig(id).then(config => updateDetailAutoContinueUI(config));
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
  currentSessionId = null;
  closeTerminal();
  showPage('main-page');
  refreshSessions();
};

$('file-preview-back-btn').onclick = () => {
  showPage('detail-page');
  requestAnimationFrame(() => {
    handleResize();
    scheduleRepaint();
  });
};

// ========== 媒体浏览页 ==========
function openMediaBrowse() {
  if (!currentSessionId) return;
  $('media-browse-title').textContent = '媒体';
  const body = $('media-browse-body');
  if (body) {
    body.innerHTML = '<div class="media-browse-loading"><div class="loading-spinner"></div><span>加载中…</span></div>';
  }
  showPage('media-browse-page');
  api(`/api/sessions/${encodeURIComponent(currentSessionId)}/media-list`)
    .then((data) => {
      if (!currentSessionId) return;
      renderMediaBrowse(data.items || []);
    })
    .catch((err) => {
      const b = $('media-browse-body');
      if (b) b.innerHTML = `<div class="media-browse-empty">加载失败：${escapeHtml(err.message || String(err))}</div>`;
    });
}

function renderMediaBrowse(items) {
  const body = $('media-browse-body');
  if (!body) return;
  $('media-browse-title').textContent = `媒体 (${items.length})`;
  if (!items.length) {
    body.innerHTML = '<div class="media-browse-empty">当前工作目录没有可预览的媒体文件</div>';
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'media-grid';
  const KIND_ICON = { image: '🖼️', video: '🎬', audio: '🎵', pdf: '📄' };
  items.forEach((item) => {
    const cell = document.createElement('div');
    cell.className = 'media-cell';
    const isImg = item.kind === 'image';
    // 图片：直接用 media 接口做缩略图（带小尺寸参数会更快，但本期复用原图，浏览器自适应缩放）
    const mediaUrl = `${API}/api/sessions/${encodeURIComponent(currentSessionId)}/media?path=${encodeURIComponent(item.path)}&token=${encodeURIComponent(token)}`;
    if (isImg) {
      const img = document.createElement('img');
      img.src = mediaUrl;
      img.loading = 'lazy';
      img.alt = item.name;
      img.className = 'media-thumb';
      cell.appendChild(img);
    } else {
      const ic = document.createElement('div');
      ic.className = 'media-thumb-icon';
      ic.textContent = KIND_ICON[item.kind] || '📎';
      cell.appendChild(ic);
    }
    const name = document.createElement('div');
    name.className = 'media-cell-name';
    name.textContent = item.name;
    cell.appendChild(name);
    const size = document.createElement('div');
    size.className = 'media-cell-size';
    size.textContent = formatSize(item.size);
    cell.appendChild(size);
    cell.onclick = () => openFilePreview(item.path);
    grid.appendChild(cell);
  });
  body.innerHTML = '';
  body.appendChild(grid);
}

$('media-browse-back-btn').onclick = () => {
  showPage('detail-page');
  requestAnimationFrame(() => {
    handleResize();
    scheduleRepaint();
  });
};

$('media-browse-refresh-btn').onclick = () => {
  openMediaBrowse();
};

$('detail-media-btn').onclick = () => {
  openMediaBrowse();
};

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
  if (isNaN(maxLoops) || maxLoops === 0 || maxLoops < -1) { $('ac-max-loops').focus(); return; }

  const config = {
    enabled: true,
    messages: msgs,
    intervalMs: intervalMinutes * 60000,
    initialDelayMs: initialDelayMinutes * 60000,
    commandIntervalMs: (isNaN(cmdIntervalSec) || cmdIntervalSec < 0 ? 2 : cmdIntervalSec) * 1000,
    sendDelaySec: isNaN(sendDelaySec) || sendDelaySec < 0 ? 2 : sendDelaySec,
    maxLoops,
    autoAgree: $('ac-auto-agree').checked,
    autoAgreeDelaySec: isNaN(agreeDelay) ? 5 : agreeDelay,
  };

  await saveAutoContinueConfig(currentSessionId, config);
  $('auto-continue-modal').classList.remove('active');
  updateDetailAutoContinueUI(config);
};

// 发送消息 — 点击发送按钮
// 用 touchend 替代 onclick，避免手机端 textarea 失焦吞掉第一次点击
$('send-btn').addEventListener('touchend', (e) => {
  e.preventDefault();
  sendMessage();
});
$('send-btn').onclick = sendMessage; // 桌面端兜底

// iOS 键盘"发送"在 textarea 上会插入换行符，用轮询检测并发送
// 保存换行前的文本，防止纯换行时丢失内容
let pendingText = '';
setInterval(() => {
  const input = $('msg-input');
  if (!input || !currentSessionId) return;
  const val = input.value;
  if (val && (val.includes('\n') || val.includes('\r'))) {
    const cleaned = val.replace(/[\r\n]/g, '');
    input.value = '';
    const textToSend = cleaned || pendingText;
    pendingText = '';
    if (textToSend) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        sendInputWithHexEnter(textToSend);
        wsSendHex('0d');
      } else {
        api(`/api/sessions/${currentSessionId}/input`, {
          method: 'POST',
          body: JSON.stringify({ input: textToSend }),
        }).catch(() => {});
      }
    }
    scrollTerminalToBottom();
  } else if (val) {
    pendingText = val;
  } else {
    // val 为空说明用户清空了输入，立即重置 pendingText，
    // 避免下次纯换行时把上一次残留内容重复发送
    pendingText = '';
  }
}, 50);

function sendMessage() {
  const input = $('msg-input');
  const text = input.value.replace(/[\r\n]/g, '');
  if (!currentSessionId) return;
  input.value = '';
  pendingText = '';

  if (text) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendInputWithHexEnter(text);
      wsSendHex('0d');
    } else {
      // WebSocket 不可用时走 HTTP API 兜底
      api(`/api/sessions/${currentSessionId}/input`, {
        method: 'POST',
        body: JSON.stringify({ input: text }),
      }).catch(() => showCopyToast('发送失败，连接已断开'));
    }
  } else {
    // 空消息只发回车
    wsSendHex('0d');
  }
  scrollTerminalToBottom();
}

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

    if (keyboardHeight > 50) {
      // 键盘弹出：把整个 detail-page 的 bottom 抬高键盘的高度
      detailPage.style.top = '0';
      detailPage.style.bottom = keyboardHeight + 'px';
      detailPage.style.height = 'auto';
      if (inputArea) inputArea.style.paddingBottom = '6px';
      if (shortcutBar) shortcutBar.style.paddingBottom = '0';
    } else {
      // 键盘收起：恢复默认
      detailPage.style.top = '';
      detailPage.style.bottom = '';
      detailPage.style.height = '';
      if (inputArea) inputArea.style.paddingBottom = '';
      if (shortcutBar) shortcutBar.style.paddingBottom = '';
    }

    scheduleTerminalResize();
  }

  vv.addEventListener('resize', adjustForKeyboard);
  vv.addEventListener('scroll', adjustForKeyboard);
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
    // 点击 → 填入输入框并发送
    btn.onclick = () => {
      if (!currentSessionId) return;
      if (ws && ws.readyState === WebSocket.OPEN) {
        sendInputWithHexEnter(cmd);
        wsSendHex('0d');
      } else {
        api(`/api/sessions/${currentSessionId}/input`, {
          method: 'POST',
          body: JSON.stringify({ input: cmd }),
        }).catch(() => showCopyToast('发送失败'));
      }
      scrollTerminalToBottom();
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

// ========== 自定义预设 ==========

const CUSTOM_PRESETS_KEY = 'duocli_custom_presets';
const MOBILE_THEME_KEY = 'duocli_mobile_new_theme';

const BUILTIN_OPTIONS = [
  { value: '', label: '纯终端 (shell)' },
  { value: 'claude --dangerously-skip-permissions', label: 'Claude 全自动' },
  { value: 'codex -c sandbox_mode="danger-full-access" -c approval="never" -c network="enabled"', label: 'Codex 全自动' },
  { value: 'devin --permission-mode bypass', label: 'Devin 全自动' },
  { value: 'kimi --auto', label: 'Kimi 全自动' },
  { value: 'gemini --yolo', label: 'Gemini 全自动' },
  { value: 'qoder chat --dangerously-skip-permissions', label: 'Qoder 全自动' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'kiro-cli chat --trust-all-tools', label: 'Kiro 全自动' },
];

let customPresetNextId = 1;

function getCustomPresets() {
  try { return JSON.parse(localStorage.getItem(CUSTOM_PRESETS_KEY) || '[]'); } catch { return []; }
}

function saveCustomPresets(list) {
  localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(list));
  // 同步到服务端
  if (token && API) {
    fetch(`${API}/api/custom-presets`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(list),
    }).catch(() => {});
  }
}

async function pullCustomPresetsFromServer() {
  if (!token || !API) {
    console.log('[Mobile Preset] No token or API, skipping server sync');
    return;
  }
  
  console.log('[Mobile Preset] Pulling presets from server...');
  
  try {
    const serverPresets = await api('/api/custom-presets');
    console.log('[Mobile Preset] Server response:', serverPresets);
    
    if (Array.isArray(serverPresets)) {
      const localPresets = getCustomPresets();
      console.log('[Mobile Preset] Local presets:', localPresets.length, 'items');
      console.log('[Mobile Preset] Server presets:', serverPresets.length, 'items');
      
      if (serverPresets.length > 0) {
        // 服务端有预设，进行合并（服务端优先）
        const merged = new Map();
        for (const p of localPresets) merged.set(p.id, p);
        for (const p of serverPresets) merged.set(p.id, p);
        const list = Array.from(merged.values());
        
        console.log('[Mobile Preset] Merged presets:', list.length, 'items');
        localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(list));
      } else if (localPresets.length > 0) {
        // 服务端没有预设，把本地的推上去
        console.log('[Mobile Preset] No server presets, pushing local presets to server');
        fetch(`${API}/api/custom-presets`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify(localPresets),
        }).catch(err => {
          console.error('[Mobile Preset] Failed to push local presets:', err);
        });
      } else {
        console.log('[Mobile Preset] No presets on either side');
      }
    } else {
      console.warn('[Mobile Preset] Invalid server response format:', typeof serverPresets);
    }
  } catch (e) {
    console.error('[Mobile Preset] Failed to pull presets from server:', e);
  }
}

// 初始化自定义预设 ID 计数器
(function initCustomPresetId() {
  const customs = getCustomPresets();
  for (const p of customs) {
    const m = p.id && p.id.match(/custom-(\d+)/);
    if (m) customPresetNextId = Math.max(customPresetNextId, parseInt(m[1]) + 1);
  }
})();

function renderPresetSelect() {
  const presetSelect = $('new-preset');
  if (!presetSelect) return;
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
  console.log('[Mobile Preset] Rendering preset select with', customs.length, 'custom presets');
  
  if (customs.length > 0) {
    const sep = document.createElement('option');
    sep.disabled = true;
    sep.textContent = '── 自定义 ──';
    presetSelect.appendChild(sep);

    for (const p of customs) {
      console.log('[Mobile Preset] Adding custom preset:', p.name, '→', p.command);
      const el = document.createElement('option');
      el.value = p.autoFlag ? p.command + ' ' + p.autoFlag : p.command;
      el.textContent = p.autoFlag ? p.name + ' (全自动)' : p.name;
      presetSelect.appendChild(el);
    }
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
      <input type="text" id="preset-name-input" placeholder="如 Aider、自定义 CLI 等" value="${preset ? preset.name : ''}" />
      <label>启动命令</label>
      <input type="text" id="preset-cmd-input" placeholder="如 aider、my-cli 等" value="${preset ? preset.command : ''}" />
      <label>全自动参数（可选）</label>
      <input type="text" id="preset-auto-input" placeholder="如 --yes、--yolo 等" value="${preset ? preset.autoFlag : ''}" />
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

    const cleanup = (result) => { overlay.remove(); resolve(result); };

    dialog.querySelector('#preset-dialog-cancel').onclick = () => cleanup(null);
    overlay.onclick = (e) => { if (e.target === overlay) cleanup(null); };

    dialog.querySelector('#preset-dialog-ok').onclick = () => {
      const name = nameInput.value.trim();
      const cmd = cmdInput.value.trim();
      const autoFlag = autoInput.value.trim();
      if (!name || !cmd) { alert('名称和命令不能为空'); return; }
      const id = preset ? preset.id : `custom-${customPresetNextId++}`;
      cleanup({ id, name, command: cmd, autoFlag });
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
      cmdEl.textContent = p.command + (p.autoFlag ? ' ' + p.autoFlag : '');
      info.appendChild(nameEl);
      info.appendChild(cmdEl);
      item.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'preset-manage-item-actions';

      const editBtn = document.createElement('button');
      editBtn.className = 'preset-manage-btn';
      editBtn.textContent = '✎';
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
      delBtn.textContent = '✕';
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


$('new-session-btn').onclick = async () => {
  await Promise.all([refreshRecentCwdOptions(), pullCustomPresetsFromServer()]);
  renderPresetSelect();
  const select = $('new-cwd');
  if (select) {
    const lastCwd = localStorage.getItem(MOBILE_LAST_CWD_KEY) || '';
    select.value = lastCwd;
    if (lastCwd && select.value !== lastCwd) select.value = '';
  }
  const presetSelect = $('new-preset');
  if (presetSelect) {
    const lastPreset = localStorage.getItem(MOBILE_LAST_PRESET_KEY) || '';
    presetSelect.value = lastPreset;
    if (lastPreset && presetSelect.value !== lastPreset) presetSelect.value = '';
  }
  const themeSelect = $('new-theme');
  if (themeSelect) themeSelect.value = localStorage.getItem(MOBILE_THEME_KEY) || 'default';
  $('new-session-modal').classList.add('active');
};

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
  try {
    await createTerminal();
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

// 检测终端 canvas 是否黑屏（WebGL 上下文丢失）
function isCanvasContextLost() {
  if (!term) return false;
  const container = $('terminal-container');
  if (!container) return false;
  const canvas = container.querySelector('canvas');
  if (!canvas) return false;
  // 检查 WebGL 上下文
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  if (gl && gl.isContextLost()) return true;
  // 兜底：检查 canvas 尺寸是否为 0（被系统回收后可能出现）
  if (canvas.width === 0 || canvas.height === 0) return true;
  return false;
}

// 页面从后台恢复可见时重建终端
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    scheduleRepaint();
  }
});

// iOS Safari/PWA 的 BFCache 恢复
window.addEventListener('pageshow', (e) => {
  if (e.persisted) {
    scheduleRepaint();
  }
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
  if ($('main-page').classList.contains('active') && token && !sseSource) {
    startSSE();
  }
  if (currentSessionId && $('detail-page').classList.contains('active') && (!ws || ws.readyState !== WebSocket.OPEN)) {
    connectWebSocket(currentSessionId);
  }
});

window.addEventListener('offline', () => {
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

// ========== Chat 功能 ==========

let activeChatId = null;
let chatStreamController = null;

async function fetchChatSessions() {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const r = await fetch(`${API}/api/chat/sessions`, { headers });
    if (!r.ok) return [];
    return await r.json();
  } catch { return []; }
}

/** 创建 Chat 会话（支持指定工作目录） */
async function createChatSession(workspace) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const r = await fetch(`${API}/api/chat/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ workspace: workspace || '' }),
    });
    if (!r.ok) throw new Error('创建失败');
    const session = await r.json();
    chatSessionsLastFetch = 0; // 失效缓存
    openChatSession(session.id);
  } catch (e) {
    alert('创建聊天失败: ' + (e.message || '网络错误'));
  }
}

async function createNewChat() {
  return createChatSession('');
}

async function openChatSession(id) {
  activeChatId = id;
  showPage('chat-detail-page');

  const msgEl = $('chat-messages');
  msgEl.innerHTML = '';

  // 加载历史消息
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const r = await fetch(`${API}/api/chat/sessions/${encodeURIComponent(id)}/messages`, { headers });
    if (r.ok) {
      const data = await r.json();
      const messages = data.messages || [];
      for (const m of messages) {
        addChatBubble(m.role, m.content);
      }
      msgEl.scrollTop = msgEl.scrollHeight;
    }
  } catch {}

  $('chat-msg-input').focus();
}

function addChatBubble(role, content, isStreaming) {
  const msgEl = $('chat-messages');
  const el = document.createElement('div');
  el.className = 'chat-bubble-mobile ' + role + (isStreaming ? ' streaming' : '');

  const label = document.createElement('div');
  label.className = 'chat-label-mobile';
  if (role === 'user') {
    label.textContent = 'YOU';
  } else if (role === 'assistant') {
    label.textContent = 'AI';
  } else if (role === 'system') {
    label.textContent = 'SYS';
    label.classList.add('system');
  }
  el.appendChild(label);

  const body = document.createElement('div');
  body.className = 'chat-body-mobile';
  body.textContent = content;
  el.appendChild(body);

  msgEl.appendChild(el);
  msgEl.scrollTop = msgEl.scrollHeight;
  return el;
}

async function sendChatMessage() {
  if (!activeChatId) return;
  const inputEl = $('chat-msg-input');
  const content = inputEl.value.trim();
  if (!content) return;

  // 显示用户消息
  addChatBubble('user', content);
  inputEl.value = '';
  inputEl.style.height = 'auto';

  // 通过 SSE 发送并接收流式响应
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  // 中断之前的流
  if (chatStreamController) {
    chatStreamController.abort();
    chatStreamController = null;
  }
  chatStreamController = new AbortController();

  try {
    const r = await fetch(`${API}/api/chat/sessions/${encodeURIComponent(activeChatId)}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content }),
      signal: chatStreamController.signal,
    });

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${r.status}`);
    }

    // SSE 流式读取
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let streamBubble = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;

        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'delta') {
            if (!streamBubble) {
              streamBubble = addChatBubble('assistant', '', true);
            }
            const body = streamBubble.querySelector('.chat-body-mobile');
            body.textContent += parsed.text;
            $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
          } else if (parsed.type === 'done') {
            if (streamBubble) {
              streamBubble.classList.remove('streaming');
            }
            streamBubble = null;
          } else if (parsed.type === 'error') {
            if (streamBubble) {
              streamBubble.classList.remove('streaming');
              streamBubble.querySelector('.chat-body-mobile').textContent += '\n\n❌ ' + parsed.error;
            } else {
              addChatBubble('system', '❌ ' + parsed.error);
            }
            streamBubble = null;
          } else if (parsed.type === 'system') {
            if (streamBubble) {
              streamBubble.classList.remove('streaming');
              streamBubble = null;
            }
            addChatBubble('system', parsed.message);
          }
        } catch {}
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      addChatBubble('system', '❌ ' + (e.message || '请求失败'));
    }
  } finally {
    chatStreamController = null;
  }
}

function closeChatSession() {
  if (chatStreamController) {
    chatStreamController.abort();
    chatStreamController = null;
  }
  activeChatId = null;
  showPage('main-page');
  refreshSessions(); // 刷新以显示新建的 chat 会话
}

async function deleteChatSession() {
  if (!activeChatId) return;
  if (!confirm('确定删除此对话？')) return;

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    await fetch(`${API}/api/chat/sessions/${encodeURIComponent(activeChatId)}`, {
      method: 'DELETE',
      headers,
    });
    chatSessionsLastFetch = 0; // 失效缓存
  } catch {}

  closeChatSession();
}

// Chat 事件绑定
function initChatEvents() {
  $('new-chat-btn').addEventListener('click', createNewChat);
  $('chat-back-btn').addEventListener('click', closeChatSession);
  $('chat-delete-btn').addEventListener('click', deleteChatSession);
  $('chat-send-btn').addEventListener('click', sendChatMessage);

  $('chat-msg-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  // iOS/部分 Agent 键盘点发送时不触发 keydown Enter，而是直接插入换行符
  // 用轮询检测换行并自动发送，与终端输入区保持一致
  let chatPending = '';
  setInterval(() => {
    const input = $('chat-msg-input');
    if (!input || !activeChatId) return;
    const val = input.value;
    if (val && (val.includes('\n') || val.includes('\r'))) {
      const cleaned = val.replace(/[\r\n]/g, '').trim();
      input.value = '';
      input.style.height = 'auto';
      const textToSend = cleaned || chatPending;
      chatPending = '';
      if (textToSend) {
        input.value = textToSend;
        sendChatMessage();
      }
    } else if (val) {
      chatPending = val;
    } else {
      chatPending = '';
    }
  }, 50);

  $('chat-msg-input').addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 100) + 'px';
  });
}

// 在会话列表加载时合并 chat 会话
let cachedChatSessions = [];
let chatSessionsLastFetch = 0;
const origRenderSessionList = renderSessionList;
renderSessionList = function(sessions) {
  origRenderSessionList(sessions);

  // 缓存 chat 会话列表，避免每次 SSE 刷新都请求
  const now = Date.now();
  if (now - chatSessionsLastFetch > 10000) {
    chatSessionsLastFetch = now;
    fetchChatSessions().then(list => {
      cachedChatSessions = list || [];
      appendChatCards(sessions);
    });
  } else {
    appendChatCards(sessions);
  }
};

function appendChatCards(sessions) {
  if (!cachedChatSessions.length) return;
  const list = $('session-list');
  const empty = $('empty-state');

  const divider = document.createElement('div');
  divider.className = 'chat-sessions-divider';
  divider.textContent = '💬 Chat 对话';
  divider.style.cssText = 'padding:12px 14px 4px;font-size:12px;color:#888;font-weight:600;';
  list.appendChild(divider);

  for (const s of cachedChatSessions) {
    const card = document.createElement('div');
    card.className = 'session-card';
    card.dataset.id = s.id;
    card.innerHTML = `
      <div class="status-dot" style="background:#a78bfa;"></div>
      <div class="session-info">
        <div class="session-title-row">
          <div class="session-title">${escHtml(s.title || 'Chat')}</div>
        </div>
        <div class="session-meta">
          <span class="session-time">${formatTime(s.createdAt)}</span>
          <span class="session-cwd">${s.messageCount || 0} 条消息</span>
        </div>
      </div>
      <div class="session-arrow">›</div>
    `;
    card.onclick = () => openChatSession(s.id);
    list.appendChild(card);
  }

  if (!sessions.length) {
    empty.style.display = 'none';
  }
}

initChatEvents();

init();
