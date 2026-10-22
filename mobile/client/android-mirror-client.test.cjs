const assert = require('node:assert/strict');
const test = require('node:test');

require('./android-mirror-client.js');

test('closing a mirror clears its lease heartbeat', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const client = new global.DuoAndroidMirrorClient({});
  let ticks = 0;
  client.leaseTimer = setInterval(() => ticks++, 2000);
  client.close();
  t.mock.timers.tick(6000);
  assert.equal(ticks, 0);
  assert.equal(client.leaseTimer, null);
});

test('disconnect clears ownership and rejects pending input without waiting for its timeout', async t => {
  const previousWebSocket = global.WebSocket;
  const previousLocation = global.location;
  t.after(() => { global.WebSocket = previousWebSocket; global.location = previousLocation; });
  global.WebSocket = class {
    static OPEN = 1;
    readyState = 1;
    send() {}
    close() {}
  };
  global.location = { protocol: 'http:', host: 'localhost' };
  const client = new global.DuoAndroidMirrorClient({});
  t.after(() => client.close());
  client.connect('phone');
  client.isController = true;
  client.recentAcks.set(1, { ok: true });
  const result = assert.rejects(client.waitForAck(2), /连接已断开/);
  client.socket.onclose();
  assert.equal(client.isController, false);
  assert.equal(client.pendingAcks.size, 0);
  assert.equal(client.recentAcks.size, 0);
  await result;
});

test('ignores messages from an Android mirror socket replaced by a new device', () => {
  const previousWebSocket = global.WebSocket;
  const previousLocation = global.location;
  const sockets = [];

  class FakeWebSocket {
    static OPEN = 1;

    constructor(url) {
      this.url = url;
      this.readyState = 0;
      sockets.push(this);
    }

    send() {}

    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  }

  global.WebSocket = FakeWebSocket;
  global.location = { protocol: 'http:', host: '127.0.0.1:9800' };
  try {
    const statuses = [];
    const client = new global.DuoAndroidMirrorClient({ onStatus: message => statuses.push(message) });
    client.connect('old-device');
    const oldSocket = sockets[0];
    const oldMessageHandler = oldSocket.onmessage;

    client.connect('new-device');
    assert.equal(oldSocket.onmessage, null);
    oldMessageHandler({ data: JSON.stringify({ type: 'android:status', status: 'ready', deviceId: 'old-device' }) });
    assert.deepEqual(statuses, []);

    const newSocket = sockets[1];
    client.close();
    assert.equal(newSocket.onmessage, null);
    assert.equal(newSocket.onopen, null);
  } finally {
    global.WebSocket = previousWebSocket;
    global.location = previousLocation;
  }
});
