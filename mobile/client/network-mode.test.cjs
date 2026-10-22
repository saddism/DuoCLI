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

test('automatic switching requires verified targets, repeated success and fallback confirmation', () => {
  const target = { ip: '192.168.1.8', port: 9800 };
  assert.equal(decideNetworkAction({ mode: 'cf', lanReachable: true, lanTarget: target, lanSuccessCount: 1 }).type, 'stay');
  assert.deepEqual(decideNetworkAction({ mode: 'cf', lanReachable: true, lanTarget: target, lanSuccessCount: 2 }),
    { type: 'switch-lan', target, reason: 'lan-available' });
  assert.equal(decideNetworkAction({ mode: 'cf', lanReachable: false, softLanTarget: target, softLanCount: 100 }).type, 'stay');
  assert.equal(decideNetworkAction({ mode: 'cf', lanReachable: true, lanTarget: target, lanSuccessCount: 2, now: 100, cooldownUntil: 200 }).reason, 'cooldown');
  assert.equal(decideNetworkAction({ mode: 'lan', lanReachable: false, lanFailCount: 2, cloudUrl: 'https://cli.example.com', cloudReachable: false }).type, 'stay');
  assert.deepEqual(decideNetworkAction({ mode: 'lan', lanReachable: false, lanFailCount: 2, cloudUrl: 'https://cli.example.com', cloudReachable: true }),
    { type: 'switch-cloud', reason: 'lan-unreachable' });
});

test('manual choices stay pinned indefinitely and offline probes never switch', () => {
  for (const preference of ['lan', 'cf']) {
    assert.equal(decideNetworkAction({ preference, mode: 'cf', lanReachable: true, lanSuccessCount: 99, lanTarget: { ip: '10.0.0.8' }, now: Number.MAX_SAFE_INTEGER }).reason, 'manual');
  }
  assert.equal(decideNetworkAction({ offline: true, mode: 'lan', lanFailCount: 99, cloudReachable: true, cloudUrl: 'https://cli.example.com' }).reason, 'offline');
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

test('LAN candidates require an authenticated verification when provided', async () => {
  const target = await findReachableLan(['192.168.1.8', '10.0.0.8', '8.8.8.8'], 9800, null, {
    verify: async origin => origin.includes('10.0.0.8'),
    fetch: () => assert.fail('the unauthenticated image probe must not decide switching'),
  });
  assert.deepEqual(target, { ip: '10.0.0.8', port: 9800 });
});
