import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { CloudflaredManager } from '../dist/main/cloudflared-manager.js';
import { probeLocalRemoteServer, probePublicRemoteServer } from '../dist/main/remote-sync-monitor.js';

test('probeLocalRemoteServer succeeds when ping endpoint responds', async () => {
  const server = http.createServer((_req, res) => {
    res.statusCode = 200;
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    assert.equal(await probeLocalRemoteServer(port), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('probeLocalRemoteServer fails for closed port', async () => {
  assert.equal(await probeLocalRemoteServer(1), false);
});

test('probePublicRemoteServer succeeds for reachable ping endpoint', async () => {
  const server = http.createServer((_req, res) => {
    res.statusCode = 200;
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    assert.equal(await probePublicRemoteServer(`http://127.0.0.1:${port}`), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('probePublicRemoteServer fails for invalid or unreachable url', async () => {
  assert.equal(await probePublicRemoteServer(''), false);
  assert.equal(await probePublicRemoteServer('not-a-url'), false);
  assert.equal(await probePublicRemoteServer('http://127.0.0.1:1'), false);
});

test('probePublicRemoteServer fails when server returns 502', async () => {
  const server = http.createServer((_req, res) => {
    res.statusCode = 502;
    res.end('bad gateway');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    assert.equal(await probePublicRemoteServer(`http://127.0.0.1:${port}`), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('isDuocliTunnelCommand recognizes project and legacy config paths', () => {
  assert.equal(
    CloudflaredManager.isDuocliTunnelCommand('/opt/homebrew/bin/cloudflared --protocol http2 --config /Users/me/DuoCLI/frp/cloudflared-config.local.yml tunnel run'),
    true,
  );
  assert.equal(
    CloudflaredManager.isDuocliTunnelCommand('/opt/homebrew/bin/cloudflared --protocol http2 --config /Users/me/.config/duocli-tunnel/config.yml tunnel run'),
    true,
  );
  assert.equal(
    CloudflaredManager.isDuocliTunnelCommand('/opt/homebrew/bin/cloudflared tunnel --url http://localhost:8080'),
    false,
  );
});
