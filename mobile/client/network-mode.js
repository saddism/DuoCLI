/**
 * 网页端网络模式：局域网 / 云端地址探测与跳转辅助。切换只由用户点击触发。
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
  const LAN_FAIL_CYCLES_BEFORE_CLOUD = 3;
  const MANUAL_CLOUD_PIN_MS = 10 * 60 * 1000;
  /** 从局域网退回云端后，短冷却：仍允许硬探针（回家连上 Wi-Fi 应立刻切回）。 */
  const AFTER_LAN_FALLBACK_MS = 15 * 1000;
  /** 退回后更长冷却：禁止「乐观软切」，避免刚失败又马上跳回 192.168。 */
  const AFTER_SOFT_LAN_COOLDOWN_MS = 2 * 60 * 1000;
  /** 探针被浏览器拦住时，连续几轮后可按上次成功 IP 软切（回家 Safari 主要靠这个）。 */
  const SOFT_LAN_CYCLES_BEFORE_SWITCH = 2;

  function isPrivateIp(host) {
    return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(String(host || ''));
  }

  function isLocalHostname(host) {
    const value = String(host || '').toLowerCase();
    return value === 'localhost' || value.endsWith('.local');
  }

  function isCellularConnection(conn) {
    return String(conn && conn.type || '').toLowerCase() === 'cellular';
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
    const unique = [...new Set((ips || []).filter(Boolean))];
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
    return url.toString();
  }

  function buildLanOrigin(ip, port) {
    return `http://${ip}:${Number(port) || 9800}`;
  }

  function decideNetworkAction(state) {
    const now = Number(state && state.now) || 0;
    const mode = state && state.mode;
    const cloudUrl = parseTrustedOrigin(state && state.cloudUrl);
    const pinnedUntil = Number(state && state.pinnedCloudUntil) || 0;
    const cooldownUntil = Number(state && state.cooldownUntil) || 0;
    const softCooldownUntil = Number(state && state.softCooldownUntil) || 0;
    const failCount = Number(state && state.lanFailCount) || 0;
    const softCount = Number(state && state.softLanCount) || 0;
    const target = state && state.lanTarget;
    const softTarget = state && state.softLanTarget;

    if (mode === 'lan') {
      if (state.lanReachable === false && failCount >= LAN_FAIL_CYCLES_BEFORE_CLOUD && cloudUrl) {
        return { type: 'switch-cloud', reason: 'lan-unreachable' };
      }
      return { type: 'stay' };
    }

    if (mode === 'cf') {
      if (now < pinnedUntil) return { type: 'stay', reason: 'pinned-cloud' };
      // 硬探针成功：立刻切。回家连上 Wi-Fi 不应被冷却或「软切熔断」挡住。
      if (state.lanReachable && target && target.ip) {
        return { type: 'switch-lan', target, reason: 'lan-available' };
      }
      // 蜂窝 / 刚从局域网失败退回：不要再按「上次 192.168」乐观跳，否则户外会反复刷新。
      if (state.cellular) return { type: 'stay', reason: 'cellular' };
      if (state.softLanDisabled) return { type: 'stay', reason: 'soft-blocked' };
      if (now < cooldownUntil) return { type: 'stay', reason: 'cooldown' };
      // Safari / 未授权本地网络时硬探针会一直失败，回家仍要靠上次成功 IP 软切。
      if (
        softTarget && softTarget.ip
        && softCount >= SOFT_LAN_CYCLES_BEFORE_SWITCH
        && now >= softCooldownUntil
      ) {
        return { type: 'switch-lan', target: softTarget, reason: 'lan-soft' };
      }
      return { type: 'stay' };
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
      if (await probeLanUrl(pingUrl(origin), PROBE_TIMEOUT_MS, deps)) {
        return { ip, port: portNum };
      }
      return null;
    }));
  }

  function softLanTarget(ips, port, lastIp) {
    const list = Array.isArray(ips) ? ips : [];
    // 只信「曾经成功连上过、且电脑仍挂着」的 IP，避免乱跳到从未验证过的网卡地址。
    if (!lastIp || !list.includes(lastIp)) return null;
    return { ip: lastIp, port: Number(port) || 9800 };
  }

  return {
    PROBE_TIMEOUT_MS,
    LAN_FAIL_CYCLES_BEFORE_CLOUD,
    MANUAL_CLOUD_PIN_MS,
    AFTER_LAN_FALLBACK_MS,
    AFTER_SOFT_LAN_COOLDOWN_MS,
    SOFT_LAN_CYCLES_BEFORE_SWITCH,
    isPrivateIp,
    isLocalHostname,
    isCellularConnection,
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
    softLanTarget,
    raceFirstSuccess,
  };
});
