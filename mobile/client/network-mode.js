/**
 * 网页端网络模式：验证可用线路后自动切换，也支持持久的手动选择。
 *
 * HTTPS 公网页探测 HTTP 局域网：
 * - Chromium Local Network Access：cors fetch + targetAddressSpace=local
 *   （授权后可豁免 Mixed Content；no-cors 既看不了状态也不易弹出授权）
 * - 其它浏览器：退回 <img> 探针（被动混合内容）
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DuoNetworkMode = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const PROBE_TIMEOUT_MS = 1800;
  const LAN_FAIL_CYCLES_BEFORE_CLOUD = 2;
  const LAN_SUCCESS_CYCLES_BEFORE_SWITCH = 2;

  function isPrivateIp(host) {
    return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(String(host || ''));
  }

  function isLocalHostname(host) {
    const value = String(host || '').toLowerCase();
    return value === 'localhost' || value.endsWith('.local');
  }

  function detectNetworkMode(loc) {
    const protocol = String(loc && loc.protocol || '');
    const host = String(loc && loc.hostname || '').toLowerCase();
    if (protocol === 'http:' && (isPrivateIp(host) || isLocalHostname(host))) return 'lan';
    if (protocol === 'https:') return 'cf';
    return 'other';
  }

  function scoreLanIp(ip) {
    const value = String(ip || '');
    if (value.startsWith('192.168.')) return 3;
    if (value.startsWith('10.')) return 2;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(value)) return 1;
    return 0;
  }

  function orderLanIps(ips, lastIp) {
    const unique = [...new Set((ips || []).filter(ip => isPrivateIp(ip) && !String(ip).startsWith('127.')))];
    return unique.sort((a, b) => {
      if (lastIp && a === lastIp) return -1;
      if (lastIp && b === lastIp) return 1;
      return scoreLanIp(b) - scoreLanIp(a);
    });
  }

  function pickBestIp(ips, lastIp) {
    return orderLanIps(ips, lastIp)[0] || null;
  }

  function parseTrustedOrigin(value) {
    try {
      const parsed = new URL(String(value || ''));
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      return parsed.origin;
    } catch {
      return '';
    }
  }

  function buildHandoffUrl(origin, extra) {
    const url = new URL('/', origin);
    const params = extra || {};
    if (params.token) url.searchParams.set('token', params.token);
    if (params.cloud) url.searchParams.set('cloud', params.cloud);
    if (params.session) url.searchParams.set('session', params.session);
    if (params.from) url.searchParams.set('from', params.from);
    if (params.network) url.searchParams.set('network', params.network);
    if (params.handoff) url.searchParams.set('handoff', params.handoff);
    return url.toString();
  }

  function buildLanOrigin(ip, port) {
    return `http://${ip}:${Number(port) || 9800}`;
  }

  function decideNetworkAction(state) {
    if (state.preference && state.preference !== 'auto') return { type: 'stay', reason: 'manual' };
    if (state.offline) return { type: 'stay', reason: 'offline' };
    if (state.mode === 'lan') {
      if (state.lanReachable === false && state.lanFailCount >= LAN_FAIL_CYCLES_BEFORE_CLOUD && state.cloudReachable
          && parseTrustedOrigin(state.cloudUrl)) return { type: 'switch-cloud', reason: 'lan-unreachable' };
    } else if (state.mode === 'cf') {
      if (state.now < state.cooldownUntil) return { type: 'stay', reason: 'cooldown' };
      if (state.lanReachable && state.lanSuccessCount >= LAN_SUCCESS_CYCLES_BEFORE_SWITCH && state.lanTarget) {
        return { type: 'switch-lan', target: state.lanTarget, reason: 'lan-available' };
      }
    }
    return { type: 'stay' };
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function probeViaFetch(url, timeoutMs, fetchImpl) {
    const fetchFn = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!fetchFn) return false;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => {
      try { if (ctrl) ctrl.abort(); } catch { /* ignore */ }
    }, timeoutMs);
    try {
      // 必须用 cors：才能读到 ok，也才能在 Chromium 上正常弹出 Local Network Access。
      const init = { cache: 'no-store', mode: 'cors', credentials: 'omit' };
      if (ctrl) init.signal = ctrl.signal;
      init.targetAddressSpace = 'local';
      const res = await fetchFn(url, init);
      return Boolean(res && res.ok);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  function probeViaImage(url, timeoutMs, imageCtor) {
    const ImageCtor = imageCtor || (typeof Image === 'function' ? Image : null);
    if (!ImageCtor) return Promise.resolve(false);
    return new Promise(resolve => {
      const img = new ImageCtor();
      let settled = false;
      const finish = ok => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        img.onload = null;
        img.onerror = null;
        try { img.src = ''; } catch { /* ignore */ }
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      img.onload = () => finish(true);
      img.onerror = () => finish(false);
      img.src = url;
    });
  }

  async function probeLanUrl(url, timeoutMs, deps) {
    const ms = timeoutMs == null ? PROBE_TIMEOUT_MS : timeoutMs;
    const fetchImpl = deps && deps.fetch;
    const imageCtor = deps && deps.Image;
    if (await probeViaFetch(url, ms, fetchImpl)) return true;
    return probeViaImage(url, ms, imageCtor);
  }

  function pingUrl(origin) {
    return `${origin.replace(/\/$/, '')}/ping.png?_=${Date.now()}`;
  }

  function raceFirstSuccess(promises) {
    return new Promise(resolve => {
      let remaining = promises.length;
      if (!remaining) {
        resolve(null);
        return;
      }
      let done = false;
      const finish = value => {
        if (done) return;
        if (value) {
          done = true;
          resolve(value);
          return;
        }
        remaining -= 1;
        if (remaining <= 0) {
          done = true;
          resolve(null);
        }
      };
      for (const promise of promises) {
        Promise.resolve(promise).then(finish, () => finish(null));
      }
    });
  }

  async function findReachableLan(ips, port, lastIp, deps) {
    const ordered = orderLanIps(ips, lastIp).slice(0, 4);
    if (!ordered.length) return null;
    const portNum = Number(port) || 9800;
    // 并行探测：串行时 4 个 IP × (fetch+img) 经常超过一轮探测间隔，导致永远探不完。
    return raceFirstSuccess(ordered.map(async (ip) => {
      const origin = buildLanOrigin(ip, portNum);
      const verified = deps && deps.verify
        ? await deps.verify(origin)
        : await probeLanUrl(pingUrl(origin), PROBE_TIMEOUT_MS, deps);
      if (verified) {
        return { ip, port: portNum };
      }
      return null;
    }));
  }

  return {
    PROBE_TIMEOUT_MS,
    LAN_FAIL_CYCLES_BEFORE_CLOUD,
    LAN_SUCCESS_CYCLES_BEFORE_SWITCH,
    isPrivateIp,
    isLocalHostname,
    detectNetworkMode,
    scoreLanIp,
    orderLanIps,
    pickBestIp,
    parseTrustedOrigin,
    buildHandoffUrl,
    buildLanOrigin,
    decideNetworkAction,
    delay,
    probeViaFetch,
    probeViaImage,
    probeLanUrl,
    pingUrl,
    findReachableLan,
    raceFirstSuccess,
  };
});
