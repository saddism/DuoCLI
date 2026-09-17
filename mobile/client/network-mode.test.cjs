const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isPrivateIp,
  isLocalHostname,
  detectNetworkMode,
  orderLanIps,
  pickBestIp,
  parseTrustedOrigin,
  buildHandoffUrl,
  buildLanOrigin,
  decideNetworkAction,
  probeViaFetch,
  findReachableLan,
  isCellularConnection,
  softLanTarget,
  LAN_FAIL_CYCLES_BEFORE_CLOUD,
  SOFT_LAN_CYCLES_BEFORE_SWITCH,
} = require('./network-mode.js');

test('detects LAN vs public HTTPS', () => {
  assert.equal(isPrivateIp('192.168.1.8'), true);
  assert.equal(isPrivateIp('10.0.0.2'), true);
  assert.equal(isPrivateIp('172.16.0.4'), true);
  assert.equal(isPrivateIp('172.32.0.1'), false);
  assert.equal(isPrivateIp('8.8.8.8'), false);
  assert.equal(isLocalHostname('localhost'), true);
  assert.equal(isLocalHostname('mac.local'), true);
  assert.equal(isLocalHostname('example.com'), false);
  assert.equal(detectNetworkMode({ protocol: 'http:', hostname: '192.168.1.8' }), 'lan');
  assert.equal(detectNetworkMode({ protocol: 'http:', hostname: 'localhost' }), 'lan');
  assert.equal(detectNetworkMode({ protocol: 'https:', hostname: 'cli.example.com' }), 'cf');
  assert.equal(detectNetworkMode({ protocol: 'http:', hostname: 'cli.example.com' }), 'other');
});

test('prefers last successful LAN IP then 192.168', () => {
  const ips = ['172.16.1.2', '10.0.0.8', '192.168.1.8'];
  assert.deepEqual(orderLanIps(ips), ['192.168.1.8', '10.0.0.8', '172.16.1.2']);
  assert.equal(pickBestIp(ips, '10.0.0.8'), '10.0.0.8');
  assert.equal(pickBestIp([], null), null);
});

test('builds a token handoff URL and rejects bad origins', () => {
  assert.equal(parseTrustedOrigin('https://cli.example.com/path'), 'https://cli.example.com');
  assert.equal(parseTrustedOrigin('javascript:alert(1)'), '');
  assert.equal(
    buildHandoffUrl('http://192.168.1.8:9800', {
      token: 'abc',
      cloud: 'https://cli.example.com',
      session: 's1',
      from: 'lan',
    }),
    'http://192.168.1.8:9800/?token=abc&cloud=https%3A%2F%2Fcli.example.com&session=s1&from=lan'
  );
  assert.equal(buildLanOrigin('10.0.0.2', 9800), 'http://10.0.0.2:9800');
});

test('prefers LAN when reachable and falls back to cloud after repeated LAN failures', () => {
  assert.deepEqual(decideNetworkAction({
    mode: 'cf',
    lanReachable: true,
    lanTarget: { ip: '192.168.1.8', port: 9800 },
    cloudUrl: 'https://cli.example.com',
    now: 1000,
  }), {
    type: 'switch-lan',
    target: { ip: '192.168.1.8', port: 9800 },
    reason: 'lan-available',
  });

  // 硬探针成功时不受短冷却限制
  assert.deepEqual(decideNetworkAction({
    mode: 'cf',
    lanReachable: true,
    lanTarget: { ip: '192.168.1.8', port: 9800 },
    cooldownUntil: 2000,
    now: 1000,
  }), {
    type: 'switch-lan',
    target: { ip: '192.168.1.8', port: 9800 },
    reason: 'lan-available',
  });

  assert.equal(decideNetworkAction({
    mode: 'cf',
    lanReachable: true,
    lanTarget: { ip: '192.168.1.8', port: 9800 },
    pinnedCloudUntil: 2000,
    now: 1000,
  }).reason, 'pinned-cloud');

  assert.equal(decideNetworkAction({
    mode: 'cf',
    lanReachable: false,
    softLanTarget: { ip: '192.168.1.8', port: 9800 },
    softLanCount: SOFT_LAN_CYCLES_BEFORE_SWITCH,
    cooldownUntil: 2000,
    now: 1000,
  }).reason, 'cooldown');

  assert.deepEqual(decideNetworkAction({
    mode: 'lan',
    lanReachable: false,
    lanFailCount: LAN_FAIL_CYCLES_BEFORE_CLOUD - 1,
    cloudUrl: 'https://cli.example.com',
    now: 1000,
  }), { type: 'stay' });

  assert.deepEqual(decideNetworkAction({
    mode: 'lan',
    lanReachable: false,
    lanFailCount: LAN_FAIL_CYCLES_BEFORE_CLOUD,
    cloudUrl: 'https://cli.example.com',
    now: 1000,
  }), { type: 'switch-cloud', reason: 'lan-unreachable' });

  assert.deepEqual(decideNetworkAction({
    mode: 'lan',
    lanReachable: false,
    lanFailCount: LAN_FAIL_CYCLES_BEFORE_CLOUD,
    now: 1000,
  }), { type: 'stay' });
});

test('soft-switches to last known LAN IP unless cellular or previously failed', () => {
  assert.deepEqual(
    softLanTarget(['10.0.0.8', '192.168.1.8'], 9800, '192.168.1.8'),
    { ip: '192.168.1.8', port: 9800 }
  );
  assert.equal(softLanTarget(['10.0.0.8'], 9800, '192.168.1.8'), null);
  assert.equal(softLanTarget(['192.168.1.8'], 9800, null), null);
  assert.equal(isCellularConnection({ type: 'cellular' }), true);
  assert.equal(isCellularConnection({ type: 'wifi' }), false);
  assert.equal(isCellularConnection(null), false);

  assert.deepEqual(decideNetworkAction({
    mode: 'cf',
    lanReachable: false,
    softLanTarget: { ip: '192.168.1.8', port: 9800 },
    softLanCount: SOFT_LAN_CYCLES_BEFORE_SWITCH - 1,
    now: 1000,
  }), { type: 'stay' });

  assert.deepEqual(decideNetworkAction({
    mode: 'cf',
    lanReachable: false,
    softLanTarget: { ip: '192.168.1.8', port: 9800 },
    softLanCount: SOFT_LAN_CYCLES_BEFORE_SWITCH,
    now: 1000,
  }), {
    type: 'switch-lan',
    target: { ip: '192.168.1.8', port: 9800 },
    reason: 'lan-soft',
  });

  assert.equal(decideNetworkAction({
    mode: 'cf',
    lanReachable: false,
    softLanTarget: { ip: '192.168.1.8', port: 9800 },
    softLanCount: SOFT_LAN_CYCLES_BEFORE_SWITCH,
    cellular: true,
    now: 1000,
  }).reason, 'cellular');

  assert.equal(decideNetworkAction({
    mode: 'cf',
    lanReachable: false,
    softLanTarget: { ip: '192.168.1.8', port: 9800 },
    softLanCount: SOFT_LAN_CYCLES_BEFORE_SWITCH,
    softLanDisabled: true,
    now: 1000,
  }).reason, 'soft-blocked');

  assert.deepEqual(decideNetworkAction({
    mode: 'cf',
    lanReachable: true,
    lanTarget: { ip: '192.168.1.8', port: 9800 },
    softLanDisabled: true,
    cellular: true,
    now: 1000,
  }), {
    type: 'switch-lan',
    target: { ip: '192.168.1.8', port: 9800 },
    reason: 'lan-available',
  });
});

test('LAN probe uses fetch first and stops at the first reachable IP', async () => {
  const tried = [];
  const fakeFetch = async (url) => {
    tried.push(String(url));
    if (String(url).includes('10.0.0.8')) return { ok: true };
    throw new Error('offline');
  };
  assert.equal(await probeViaFetch('http://10.0.0.8:9800/ping.png', 50, fakeFetch), true);
  assert.equal(await probeViaFetch('http://192.168.0.9:9800/ping.png', 50, fakeFetch), false);

  const found = await findReachableLan(
    ['192.168.0.9', '10.0.0.8'],
    9800,
    null,
    { fetch: fakeFetch, Image: null }
  );
  assert.deepEqual(found, { ip: '10.0.0.8', port: 9800 });
  assert.equal(tried.some(url => url.includes('192.168.0.9')), true);
});

test('LAN probe races IPs in parallel instead of waiting sequentially', async () => {
  const started = [];
  const fakeFetch = (url) => new Promise((resolve, reject) => {
    started.push(String(url));
    const slow = String(url).includes('192.168.0.9');
    setTimeout(() => {
      if (slow) reject(new Error('timeout'));
      else resolve({ ok: true });
    }, slow ? 80 : 10);
  });
  const t0 = Date.now();
  const found = await findReachableLan(
    ['192.168.0.9', '10.0.0.8'],
    9800,
    null,
    { fetch: fakeFetch, Image: null }
  );
  const elapsed = Date.now() - t0;
  assert.deepEqual(found, { ip: '10.0.0.8', port: 9800 });
  assert.equal(started.length >= 2, true);
  assert.equal(elapsed < 70, true);
});
