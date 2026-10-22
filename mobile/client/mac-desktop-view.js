(() => {
  const API = location.origin;
  const params = new URLSearchParams(location.search);
  const token = params.get('token')
    || localStorage.getItem('duocli_token')
    || '';

  const $ = (id) => document.getElementById(id);
  const desktop = $('desktop');
  const statusEl = $('status');
  const hintEl = $('hint');
  const stage = $('stage');

  let objectUrl = '';
  let inFlight = false;
  let requestId = 0;
  let timer = 0;
  let hintTimer = 0;

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text || '';
  }

  function showHint(text, ms = 1800) {
    if (!hintEl) return;
    hintEl.textContent = text;
    hintEl.classList.add('show');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => hintEl.classList.remove('show'), ms);
  }

  function writeGeometry(surface, geometry) {
    if (!surface || !geometry) return;
    if (geometry.deviceWidth) surface.dataset.fallbackDeviceWidth = String(geometry.deviceWidth);
    if (geometry.deviceHeight) surface.dataset.fallbackDeviceHeight = String(geometry.deviceHeight);
    surface.dataset.fallbackLatestGeometry = '1';
    surface.dataset.fallbackPresentedGeometry = '1';
  }

  function mapPoint(clientX, clientY, clampToEdge = false) {
    const helpers = globalThis.DuoAndroidPointerHelpers;
    const rect = desktop.getBoundingClientRect();
    const contentWidth = desktop.naturalWidth || 0;
    const contentHeight = desktop.naturalHeight || 0;
    const deviceWidth = Number(desktop.dataset.fallbackDeviceWidth) || contentWidth;
    const deviceHeight = Number(desktop.dataset.fallbackDeviceHeight) || contentHeight;
    if (!rect.width || !rect.height || !contentWidth || !contentHeight) return null;
    if (typeof helpers?.mapClientPointToDevice === 'function') {
      return helpers.mapClientPointToDevice({
        clientX,
        clientY,
        clampToEdge,
        rect,
        contentWidth,
        contentHeight,
        fillsCssBox: false,
        deviceWidth,
        deviceHeight,
        latestGeometry: 1,
        presentedGeometry: 1,
        physicalWidth: deviceWidth,
        physicalHeight: deviceHeight,
      });
    }
    const scale = Math.min(rect.width / contentWidth, rect.height / contentHeight);
    const left = rect.left + (rect.width - contentWidth * scale) / 2;
    const top = rect.top + (rect.height - contentHeight * scale) / 2;
    const x = (clientX - left) / scale;
    const y = (clientY - top) / scale;
    if (!clampToEdge && (x < 0 || y < 0 || x > contentWidth || y > contentHeight)) return null;
    return {
      x: Math.round(Math.max(0, Math.min(deviceWidth - 1, (x / contentWidth) * deviceWidth))),
      y: Math.round(Math.max(0, Math.min(deviceHeight - 1, (y / contentHeight) * deviceHeight))),
    };
  }

  async function refresh() {
    if (inFlight) return;
    const id = ++requestId;
    inFlight = true;
    try {
      const res = await fetch(`${API}/api/mac-desktop/screenshot?quality=72&scale=0.8`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      if (id !== requestId) return;
      const blob = await res.blob();
      const nextUrl = URL.createObjectURL(blob);
      const prev = objectUrl;
      objectUrl = nextUrl;
      writeGeometry(desktop, {
        deviceWidth: Number(res.headers.get('X-DuoCLI-Device-Width')) || 0,
        deviceHeight: Number(res.headers.get('X-DuoCLI-Device-Height')) || 0,
      });
      desktop.onload = () => {
        if (prev) URL.revokeObjectURL(prev);
        setStatus('已连接');
      };
      desktop.src = nextUrl;
    } catch (error) {
      if (id === requestId) setStatus(error?.message || '无法获取画面');
    } finally {
      inFlight = false;
    }
  }

  function sendGesture(start, end, duration) {
    if (!start || !end) return;
    const moved = Math.hypot(end.x - start.x, end.y - start.y) > 8;
    const headers = {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const request = moved
      ? fetch(`${API}/api/mac-desktop/swipe`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ x1: start.x, y1: start.y, x2: end.x, y2: end.y, duration }),
      })
      : fetch(`${API}/api/mac-desktop/tap`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ x: end.x, y: end.y }),
      });
    request.then(async (res) => {
      if (res.ok) return;
      const data = await res.json().catch(() => ({}));
      showHint(data.error || '操作失败');
    }).catch((error) => {
      showHint(error?.message || '操作失败');
    });
  }

  function bindPointer() {
    let gesture = null;
    stage.style.touchAction = 'none';
    stage.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      const point = mapPoint(event.clientX, event.clientY, false);
      if (!point) return;
      event.preventDefault();
      gesture = { start: point, last: point, at: performance.now(), pointerId: event.pointerId };
      try { stage.setPointerCapture?.(event.pointerId); } catch { /* ignore */ }
    });
    stage.addEventListener('pointermove', (event) => {
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      const point = mapPoint(event.clientX, event.clientY, true);
      if (point) gesture.last = point;
    });
    const finish = (event) => {
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      const current = gesture;
      gesture = null;
      try { stage.releasePointerCapture?.(event.pointerId); } catch { /* ignore */ }
      sendGesture(current.start, current.last, performance.now() - current.at);
    };
    stage.addEventListener('pointerup', finish);
    stage.addEventListener('pointercancel', finish);
  }

  function loop() {
    const tick = async () => {
      await refresh();
      timer = setTimeout(tick, 420);
    };
    timer = setTimeout(tick, 0);
  }

  $('fit-btn')?.addEventListener('click', () => {
    void refresh();
    showHint('已刷新');
  });
  $('close-btn')?.addEventListener('click', () => {
    window.close();
    setTimeout(() => {
      location.href = './';
    }, 120);
  });

  if (!token) {
    setStatus('缺少访问令牌');
    showHint('请从 DuoCLI 设备页打开，或带上 ?token=', 4000);
    return;
  }

  bindPointer();
  loop();
  showHint('点击画面即可操作电脑');
})();
