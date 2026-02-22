// DuoCLI Mobile PWA - 客户端逻辑 (xterm.js + WebSocket)

const API = location.origin;
let token = localStorage.getItem('duocli_token') || '';
let currentSessionId = null;
let sseSource = null;

// xterm.js 相关
let term = null;
let fitAddon = null;
let ws = null;
let wsHeartbeat = null;
let copyToastTimer = null;
let isUserScrolling = false;
let scrollToBottomTimer = null;

// ========== 催工（自动继续）==========
// 手机端只做 UI，实际配置存在桌面端，通过 API 读写

// ========== 工具函数 ==========

function $(id) { return document.getElementById(id); }

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
  return fetch(`${API}${path}`, { ...opts, headers }).then(async r => {
    if (r.status === 401) { logout(); throw new Error('未授权'); }
    return r.json();
  });
}

function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  $(id).classList.add('active');
}

function formatTime(ts) {
  const d = new Date(ts);
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
  $('ac-message').value = config.message || '继续';
  $('ac-interval').value = String(Math.round((config.intervalMs || 600000) / 60000));
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

// 判断终端是否滚动到底部附近（容差 2 行）
function isAtBottom() {
  if (!term) return true;
  const buf = term.buffer.active;
  return buf.viewportY >= buf.baseY - 2;
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
  showPage('login-page');
}

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
  $('device-console-btn').onclick = () => {
    showPage('device-page');
    refreshAndroidDevices();
    showCopyToast('📷 截图查看手机画面 · 🖱 开启后可点击操控');
  };
  let autoRefreshTimer = null;
  $('device-back-btn').onclick = () => showPage('main-page');
  $('fullscreen-back-btn').onclick = () => {
    if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
    $('fullscreen-auto-btn').textContent = '自动刷新';
    $('fullscreen-overlay').style.display = 'none';
  };
  $('fullscreen-auto-btn').onclick = () => {
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
      $('fullscreen-auto-btn').textContent = '自动刷新';
    } else {
      const secs = parseInt($('fullscreen-interval').value);
      const doRefresh = async () => {
        await refreshAndroidScreenshot();
        $('fullscreen-preview').src = $('device-preview').src;
      };
      doRefresh();
      autoRefreshTimer = setInterval(doRefresh, secs * 1000);
      $('fullscreen-auto-btn').textContent = '停止刷新';
    }
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
    showCopyToast('点击屏幕可远程操控 · ⌨️ 输入文字 · 📷 刷新截图');
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
  $('fullscreen-preview').onclick = async (e) => {
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
    setTimeout(async () => {
      await refreshAndroidScreenshot();
      $('fullscreen-preview').src = $('device-preview').src;
    }, 800);
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
    sel.innerHTML = data.devices.length
      ? data.devices.map(d => `<option value="${d.id}"${d.id === saved ? ' selected' : ''}>${d.id} ${d.info}</option>`).join('')
      : '<option value="">未找到设备</option>';
    setDeviceHint(data.devices.length ? '' : '未找到已连接的 Android 设备');
  } catch (e) {
    setDeviceHint('获取设备失败: ' + (e.message || e));
  }
}

async function refreshAndroidScreenshot() {
  const deviceId = $('device-select').value;
  if (!deviceId) { setDeviceHint('请先选择设备'); return; }
  setDeviceHint('正在获取截图...');
  try {
    const res = await fetch(`${API}/api/android/screenshot?deviceId=${encodeURIComponent(deviceId)}`, {
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
  startSSE();
  subscribePush();
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

  if (!sessions.length) {
    list.innerHTML = '';
    empty.style.display = 'flex';
    return;
  }

  empty.style.display = 'none';
  list.innerHTML = sessions.map(s => {
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

  list.querySelectorAll('.session-card').forEach(card => {
    card.onclick = () => openSession(card.dataset.id);
  });
}

// ========== SSE 实时更新 ==========

function startSSE() {
  stopSSE();
  sseSource = new EventSource(`${API}/api/events?token=${encodeURIComponent(token)}`);
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
    setTimeout(startSSE, 5000);
  };
}

function stopSSE() {
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

  const container = $('terminal-container');
  // 清除旧终端 DOM，但保留 loading 遮罩
  const loading = $('terminal-loading');
  container.innerHTML = '';
  if (loading) container.appendChild(loading);
  // 显示 loading
  if (loading) loading.classList.remove('hidden');
  term.open(container);

  // 终端键盘输入 → WebSocket
  term.onData((data) => {
    sendInputWithHexEnter(data);
  });

  // 窗口大小变化 → resize
  window.addEventListener('resize', handleResize);

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

      // 移动端触摸滚动：xterm.js 默认拦截触摸事件，手动实现滚动
      let touchLastY = 0;
      const screen = container.querySelector('.xterm-screen');
      const viewport = container.querySelector('.xterm-viewport');
      if (screen) {
        screen.addEventListener('touchstart', (e) => {
          if (e.touches.length === 1) {
            touchLastY = e.touches[0].clientY;
            // 标记用户正在手动滚动
            isUserScrolling = true;
          }
        }, { passive: true });

        screen.addEventListener('touchmove', (e) => {
          if (e.touches.length === 1 && term) {
            const currentY = e.touches[0].clientY;
            const deltaY = touchLastY - currentY;
            touchLastY = currentY;
            const lines = Math.round(deltaY / 8);
            if (lines !== 0) {
              term.scrollLines(lines);
            }
          }
        }, { passive: true });

        screen.addEventListener('touchend', () => {
          // 触摸结束后检查是否在底部，如果在底部则恢复自动滚动
          setTimeout(() => {
            if (term && isAtBottom()) {
              isUserScrolling = false;
            }
          }, 150);
        }, { passive: true });
      }

      // 用户手动滚动期间，阻止 xterm 内部 write() 自动滚到底部
      // 通过拦截 viewport 的 scrollTop 赋值实现
      if (viewport) {
        let savedScrollTop = null;
        const origScrollTopDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop') ||
                                   Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
        if (origScrollTopDesc && origScrollTopDesc.set) {
          const origSet = origScrollTopDesc.set;
          const origGet = origScrollTopDesc.get;
          Object.defineProperty(viewport, 'scrollTop', {
            get() {
              return origGet.call(this);
            },
            set(val) {
              if (isUserScrolling) {
                // 用户滚动中，忽略 xterm 内部的 scrollTop 设置
                return;
              }
              origSet.call(this, val);
            },
            configurable: true,
          });
        }
      }

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
  fitAddon.fit();
  if (ws && ws.readyState === WebSocket.OPEN && term.cols > 0 && term.rows > 0) {
    wsSend({ type: 'resize', cols: term.cols, rows: term.rows });
  }
}

function closeTerminal() {
  window.removeEventListener('resize', handleResize);
  closeWebSocket();
  if (term) {
    term.dispose();
    term = null;
    fitAddon = null;
  }
}

// ========== WebSocket ==========

function connectWebSocket(sessionId) {
  closeWebSocket();

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('[ws] onopen, term exists=', !!term);
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
    }, 15000);
  };

  let replayReceived = false;
  let replayRetryTimer = null;
  let replayRetryCount = 0;

  // 8秒内未收到 replay，显示重连提示
  const connectTimeoutTimer = setTimeout(() => {
    if (!replayReceived && term) {
      hideTerminalLoading();
      term.write('\r\n\x1b[33m⚠ 连接超时，正在重连...\x1b[0m\r\n');
    }
  }, 8000);

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (!term) return;

      if (msg.type === 'replay') {
        replayReceived = true;
        clearTimeout(connectTimeoutTimer);
        console.log('[ws] replay received, data length=', (msg.data || '').length);
        // 先彻底清空，再写入 replay 内容，避免残留
        term.reset();
        if (msg.data) {
          // 有内容，隐藏 loading 并写入
          hideTerminalLoading();
          term.write(msg.data, () => {
            if (!isUserScrolling) {
              term.scrollToBottom();
            }
          });
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
        term.write(msg.data);
        // 用户手动滚动时不自动滚到底部，避免死循环
        if (!isUserScrolling) {
          if (scrollToBottomTimer) clearTimeout(scrollToBottomTimer);
          scrollToBottomTimer = setTimeout(() => {
            term.scrollToBottom();
          }, 50);
        }
      }
    } catch {}
  };

  ws.onclose = () => {
    clearInterval(wsHeartbeat);
    // 如果还在详情页，尝试重连
    if (currentSessionId === sessionId && $('detail-page').classList.contains('active')) {
      setTimeout(() => {
        if (currentSessionId === sessionId) {
          connectWebSocket(sessionId);
        }
      }, 2000);
    }
  };

  ws.onerror = () => {};
}

function closeWebSocket() {
  clearInterval(wsHeartbeat);
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
}

function wsSend(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    // 对 input 类型的数据，用 base64 编码传输，避免控制字符在 JSON 中丢失
    if (data.type === 'input' && data.data) {
      // TextEncoder 将字符串转为 UTF-8 字节，再 base64 编码
      const bytes = new TextEncoder().encode(data.data);
      const b64 = btoa(String.fromCharCode(...bytes));
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

  // 更新标题
  try {
    const sessions = await api('/api/sessions');
    const s = sessions.find(x => x.id === id);
    if (s) {
      $('detail-name').textContent = s.title || s.presetCommand || '终端';
      $('detail-status').className = `status-dot ${s.status}`;
    }
  } catch {}

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
  const message = $('ac-message').value.trim();
  if (!message) { $('ac-message').focus(); return; }
  const intervalMinutes = parseInt($('ac-interval').value, 10);
  if (isNaN(intervalMinutes) || intervalMinutes < 1) { $('ac-interval').focus(); return; }
  const agreeDelay = parseInt($('ac-agree-delay').value, 10);

  const config = {
    enabled: true,
    message,
    intervalMs: intervalMinutes * 60000,
    autoAgree: $('ac-auto-agree').checked,
    autoAgreeDelaySec: isNaN(agreeDelay) ? 5 : agreeDelay,
  };

  await saveAutoContinueConfig(currentSessionId, config);
  $('auto-continue-modal').classList.remove('active');
  updateDetailAutoContinueUI(config);
};

// 发送消息 — 点击发送按钮
$('send-btn').onclick = sendMessage;

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
      sendInputWithHexEnter(textToSend);
    }
    // 单独用 hex 发送回车
    wsSendHex('0d');
    // 发送后滚到底部
    if (term) term.scrollToBottom();
  } else if (val) {
    // 持续记录最新的非空文本，以备换行时使用
    pendingText = val;
  }
}, 50);

function sendMessage() {
  const input = $('msg-input');
  const text = input.value.replace(/[\r\n]/g, '');
  if (!currentSessionId) return;
  input.value = '';
  pendingText = '';

  // 文本部分：纯文本发送
  if (text) {
    sendInputWithHexEnter(text);
  }
  // 回车部分：单独用 hex 发送，确保终端收到真正的 CR
  wsSendHex('0d');
  // 发送后滚到底部
  if (term) term.scrollToBottom();
}

// 发送 hex 编码的原始字节（用于回车、控制字符等）
function wsSendHex(hexStr) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    const bytes = hexStr.match(/.{2}/g).map(h => parseInt(h, 16));
    const b64 = btoa(String.fromCharCode(...bytes));
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

    // 重新 fit 终端
    if (fitAddon && term) {
      requestAnimationFrame(() => fitAddon.fit());
    }
  }

  vv.addEventListener('resize', adjustForKeyboard);
  vv.addEventListener('scroll', adjustForKeyboard);
}

// 快捷键按钮 — 通过 WebSocket 发送原始键码（不弹键盘）

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
        if (term) term.write(`\r\n\x1b[32m✓ 已上传: ${file.name} (${formatSize(data.size)})\x1b[0m\r\n`);
        // 把文件路径填入输入框，方便用户直接发送给 AI
        if (data.path) {
          const input = $('msg-input');
          const prev = input.value.trim();
          input.value = prev ? prev + ' ' + data.path : data.path;
        }
      } else {
        if (term) term.write(`\r\n\x1b[31m✗ 上传失败: ${file.name} - ${data.error}\x1b[0m\r\n`);
      }
    } catch (err) {
      if (term) term.write(`\r\n\x1b[31m✗ 上传失败: ${file.name} - ${err.message}\x1b[0m\r\n`);
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
  btn.addEventListener('touchstart', (e) => { e.preventDefault(); }, { passive: false });
  btn.addEventListener('touchend', (e) => {
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

// ========== 新建会话 ==========

$('new-session-btn').onclick = async () => {
  await refreshRecentCwdOptions();
  const select = $('new-cwd');
  const options = select?.querySelectorAll('option');
  const first = options?.length > 1 ? options[1].value : '';
  if (!select.value.trim() && first) select.value = first;
  $('new-session-modal').classList.add('active');
};

$('modal-cancel').onclick = () => {
  $('new-session-modal').classList.remove('active');
};

$('modal-create').onclick = async () => {
  const cwd = $('new-cwd').value.trim() || '';
  const preset = $('new-preset').value;
  $('new-session-modal').classList.remove('active');

  try {
    const session = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ cwd: cwd || undefined, presetCommand: preset }),
    });
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
