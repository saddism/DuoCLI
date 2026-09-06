const assert = require('node:assert/strict');
const test = require('node:test');

require('./android-mirror-client.js');

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
