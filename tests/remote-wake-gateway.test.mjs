import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import net from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { createWakeGateway } from '../scripts/remote-wake-gateway.mjs';

const listen = (server, port = 0) => new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));
async function freePort() {
  const server = net.createServer();
  await listen(server);
  const port = server.address().port;
  await close(server);
  return port;
}
function request(port, options = {}, body = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/', agent: false, ...options }, (res) => {
      let text = '';
      res.on('data', (data) => { text += data; });
      res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('starts once for concurrent requests and preserves request body, path and authentication', async () => {
  const targetPort = await freePort();
  let launches = 0;
  const app = http.createServer((req, res) => {
    let body = '';
    req.on('data', (data) => { body += data; });
    req.on('end', () => {
      res.statusCode = req.headers.authorization === 'Bearer secret' ? 200 : 401;
      res.end(`${req.method} ${req.url} ${body}`);
    });
  });
  const gateway = createWakeGateway({ targetPort, log: () => {}, launch: async () => {
    launches++;
    await new Promise((resolve) => setTimeout(resolve, 50));
    await listen(app, targetPort);
  } });
  await listen(gateway);
  try {
    assert.equal(launches, 0, 'an idle gateway must not launch the app');
    const port = gateway.address().port;
    const responses = await Promise.all(Array.from({ length: 8 }, () => request(port, {
      method: 'POST', path: '/api/example?token=unchanged', headers: { authorization: 'Bearer secret' },
    }, 'original body')));
    assert.equal(launches, 1);
    for (const response of responses) {
      assert.equal(response.status, 200);
      assert.equal(response.text, 'POST /api/example?token=unchanged original body');
    }
    assert.equal((await request(port)).status, 401, 'the app still rejects unauthenticated requests');
    assert.equal(launches, 1);
  } finally { await gateway.stop(); await close(app); }
});

test('forwards WebSocket traffic without launching an already running app', async () => {
  const app = http.createServer();
  const wss = new WebSocketServer({ server: app });
  wss.on('connection', (socket) => socket.on('message', (data) => socket.send(data)));
  await listen(app);
  const gateway = createWakeGateway({ targetPort: app.address().port, launch: () => assert.fail('already running') });
  await listen(gateway);
  const socket = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/ws?token=original`);
  try {
    const echoed = await new Promise((resolve, reject) => {
      socket.on('error', reject);
      socket.on('open', () => socket.send('terminal data'));
      socket.on('message', (data) => resolve(data.toString()));
    });
    assert.equal(echoed, 'terminal data');
  } finally { socket.terminate(); await gateway.stop(); wss.close(); await close(app); }
});

test('returns a retryable error on startup timeout and limits repeated launches', async () => {
  let launches = 0;
  const gateway = createWakeGateway({
    targetPort: await freePort(), startupTimeoutMs: 60, pollMs: 10,
    log: () => {}, launch: async () => { launches++; },
  });
  await listen(gateway);
  try {
    const first = await request(gateway.address().port);
    assert.equal(first.status, 503);
    assert.equal(first.headers['retry-after'], '5');
    assert.equal((await request(gateway.address().port)).status, 503);
    assert.equal(launches, 1);
  } finally { await gateway.stop(); }
});

test('a later request starts the app again after it has exited', async () => {
  const targetPort = await freePort();
  let launches = 0;
  let app;
  const gateway = createWakeGateway({ targetPort, log: () => {}, launch: async () => {
    launches++;
    app = http.createServer((_req, res) => res.end('ready'));
    await listen(app, targetPort);
  } });
  await listen(gateway);
  try {
    assert.equal((await request(gateway.address().port)).text, 'ready');
    await close(app);
    assert.equal((await request(gateway.address().port)).text, 'ready');
    assert.equal(launches, 2);
  } finally { await gateway.stop(); await close(app); }
});
