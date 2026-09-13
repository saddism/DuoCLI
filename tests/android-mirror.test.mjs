import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import {
  AndroidMirrorSession,
  ScrcpyVideoParser,
  emptyReplayCache,
  encodeVideoFrame,
  packetsForNewSubscriber,
  rememberReplayFrame,
  serializeKeyControl,
  serializeTextControls,
  serializeTouchControl,
  validateAndroidMirrorInput,
} from '../dist/main/android-mirror.js';

test('browser mouse pointerId -1 and out-of-range pressure stay valid', () => {
  assert.equal(validateAndroidMirrorInput({
    type: 'touch', action: 'down', pointerId: -1, x: 10, y: 20, pressure: 1,
  }), true);
  assert.equal(validateAndroidMirrorInput({
    type: 'touch', action: 'move', pointerId: 1.7, x: 10.4, y: 20.6, pressure: 1.4,
  }), true);
  assert.equal(validateAndroidMirrorInput({ type: 'touch', action: 'down', x: 10, y: 20 }), true);
  assert.equal(validateAndroidMirrorInput({ type: 'touch', action: 'down', pointerId: Infinity, x: 10, y: 20 }), false);
  assert.equal(validateAndroidMirrorInput({ type: 'touch', action: 'down' }), false);
});

test('signed browser pointer IDs can be injected once the session is ready', async t => {
  const session = controlSession(t);
  await session.sendInput({ type: 'touch', action: 'down', pointerId: -1, x: 10, y: 20, pressure: 1.4 }, 1, 'desktop');
  await session.sendInput({ type: 'touch', action: 'up', pointerId: -1, x: 10, y: 20, pressure: 0 }, 2, 'desktop');
  assert.equal(session.activePointers.size, 0);
});

function controlSession(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const session = new AndroidMirrorSession('test-phone');
  // Avoid starting ADB; exercise the real lease and control queue with a socket recorder.
  session.status = 'ready';
  session.width = 100;
  session.height = 200;
  session.controlSocket = Object.assign(new EventEmitter(), {
    write(_message, callback) { callback(); },
    destroy() { this.destroyed = true; this.emit('close'); },
  });
  for (const id of ['desktop', 'mobile']) {
    session.addClient({ id, sendJson() {}, sendBinary() {} });
  }
  return session;
}

test('automatic owner renewal does not cancel takeover of a stuck contact', async t => {
  const session = controlSession(t);
  await session.sendInput({ type: 'touch', action: 'down', pointerId: 1, x: 10, y: 10 }, 1, 'desktop');
  assert.equal(session.claim('mobile', true), false);
  t.mock.timers.tick(1000);
  assert.equal(session.renew('desktop'), true);
  t.mock.timers.tick(501);
  assert.equal(session.getControlOwner(), 'mobile');
});

test('actual owner movement keeps an active gesture during a takeover challenge', async t => {
  const session = controlSession(t);
  await session.sendInput({ type: 'touch', action: 'down', pointerId: 1, x: 10, y: 10 }, 1, 'desktop');
  session.claim('mobile', true);
  await session.sendInput({ type: 'touch', action: 'move', pointerId: 1, x: 20, y: 20 }, 2, 'desktop');
  t.mock.timers.tick(1501);
  assert.equal(session.getControlOwner(), 'desktop');
});

test('a claim without takeover does not interrupt the owner', t => {
  const session = controlSession(t);
  assert.equal(session.claim('mobile', false), false);
  assert.equal(session.getControlOwner(), 'desktop');
});

test('releasing the final finger completes the pending takeover after UP is written', async t => {
  const session = controlSession(t);
  await session.sendInput({ type: 'touch', action: 'down', pointerId: 1, x: 10, y: 10 }, 1, 'desktop');
  session.claim('mobile', true);
  await session.sendInput({ type: 'touch', action: 'up', pointerId: 1, x: 10, y: 10 }, 2, 'desktop');
  assert.equal(session.getControlOwner(), 'mobile');
  assert.equal(session.activePointers.size, 0);
});

test('disconnecting a challenger allows the next client to request control', async t => {
  const session = controlSession(t);
  session.addClient({ id: 'tablet', sendJson() {}, sendBinary() {} });
  await session.sendInput({ type: 'touch', action: 'down', pointerId: 1, x: 10, y: 10 }, 1, 'desktop');
  session.claim('mobile', true);
  session.removeClient('mobile');
  session.claim('tablet', true);
  t.mock.timers.tick(1501);
  assert.equal(session.getControlOwner(), 'tablet');
});

test('stale input cannot cancel a pending takeover', async t => {
  const session = controlSession(t);
  await session.sendInput({ type: 'touch', action: 'down', pointerId: 1, x: 10, y: 10 }, 1, 'desktop');
  session.claim('mobile', true);
  await assert.rejects(session.sendInput({ type: 'touch', action: 'move', pointerId: 1, x: 20, y: 20 }, 2, 'desktop', 999), { code: 'CONTROL_EPOCH_STALE' });
  t.mock.timers.tick(1501);
  assert.equal(session.getControlOwner(), 'mobile');
});

test('stopping a session cancels delayed ownership changes', async t => {
  const session = controlSession(t);
  await session.sendInput({ type: 'touch', action: 'down', pointerId: 1, x: 10, y: 10 }, 1, 'desktop');
  session.claim('mobile', true);
  await session.stop();
  t.mock.timers.tick(1501);
  assert.equal(session.getControlOwner(), 'desktop');
  assert.equal(session.pendingClaim, null);
});

test('a stalled control write fails and drains the queue instead of blocking every gesture', async t => {
  const session = controlSession(t);
  const socket = session.controlSocket;
  let lateCallback;
  socket.write = (_message, callback) => { lateCallback = callback; };
  const input = { type: 'touch', action: 'down', pointerId: 1, x: 10, y: 10 };
  const first = assert.rejects(session.sendInput(input, 1, 'desktop'), { code: 'CONTROL_WRITE_TIMEOUT' });
  const second = assert.rejects(session.sendInput({ ...input, action: 'up' }, 2, 'desktop'), { code: 'DEVICE_OFFLINE' });
  await Promise.resolve();
  t.mock.timers.tick(2001);
  await Promise.all([first, second]);
  lateCallback();
  assert.equal(session.status, 'error');
  assert.equal(session.controlQueueDepth, 0);
  assert.equal(session.activePointers.size, 0);
  assert.equal(socket.listenerCount('close'), 0);
});

test('socket closure rejects an in-flight write immediately', async t => {
  const session = controlSession(t);
  session.controlSocket.write = () => {};
  const result = assert.rejects(session.sendInput({ type: 'touch', action: 'down', x: 10, y: 10 }, 1, 'desktop'), { code: 'DEVICE_OFFLINE' });
  await Promise.resolve();
  session.controlSocket.destroy();
  await result;
  assert.equal(session.controlQueueDepth, 0);
});

test('queued input is never replayed onto a replacement control socket', async t => {
  const session = controlSession(t);
  const result = assert.rejects(session.sendInput({ type: 'touch', action: 'down', x: 10, y: 10 }, 1, 'desktop'), { code: 'DEVICE_OFFLINE' });
  let writes = 0;
  session.controlSocket = Object.assign(new EventEmitter(), { write() { writes++; } });
  await result;
  assert.equal(writes, 0);
  assert.equal(session.controlQueueDepth, 0);
});

test('takeover waits for all fingers to release', async t => {
  const session = controlSession(t);
  const input = { type: 'touch', action: 'down', x: 10, y: 10 };
  await session.sendInput({ ...input, pointerId: 1 }, 1, 'desktop');
  await session.sendInput({ ...input, pointerId: 2 }, 2, 'desktop');
  session.claim('mobile', true);
  await session.sendInput({ ...input, action: 'up', pointerId: 1 }, 3, 'desktop');
  assert.equal(session.getControlOwner(), 'desktop');
  await session.sendInput({ ...input, action: 'up', pointerId: 2 }, 4, 'desktop');
  assert.equal(session.getControlOwner(), 'mobile');
});

test('serializes scrcpy touch coordinates and pointer identity', () => {
  const message = serializeTouchControl({
    action: 'down',
    pointerId: 7,
    x: 12.4,
    y: 34.6,
    pressure: 0.5,
  }, 572, 1280);

  assert.equal(message.length, 32);
  assert.equal(message[0], 2);
  assert.equal(message[1], 0);
  assert.equal(message.readBigUInt64BE(2), 7n);
  assert.equal(message.readInt32BE(10), 12);
  assert.equal(message.readInt32BE(14), 35);
  assert.equal(message.readUInt16BE(18), 572);
  assert.equal(message.readUInt16BE(20), 1280);
  assert.equal(message.readUInt16BE(22), 0x8000);
  assert.equal(message.readUInt32BE(24), 1);
});

test('splits text controls on UTF-8 byte boundaries', () => {
  const text = 'a'.repeat(299) + '中';
  const messages = serializeTextControls(text);
  assert.equal(messages.length, 2);
  assert.ok(messages.every((message) => message.length <= 305));
  assert.equal(Buffer.concat(messages.map((message) => message.subarray(5))).toString('utf8'), text);
});

test('serializes scrcpy key events', () => {
  const message = serializeKeyControl({ keyCode: 66, keyAction: 'up', repeat: 2, metastate: 1 });
  assert.equal(message.length, 14);
  assert.deepEqual([...message.subarray(0, 2)], [0, 1]);
  assert.equal(message.readUInt32BE(2), 66);
  assert.equal(message.readUInt32BE(6), 2);
  assert.equal(message.readUInt32BE(10), 1);
});

test('parses fragmented scrcpy video metadata and frames', () => {
  const codecs = [];
  const sessions = [];
  const frames = [];
  const errors = [];
  const parser = new ScrcpyVideoParser({
    onCodec: (codec) => codecs.push(codec),
    onSession: (width, height) => sessions.push([width, height]),
    onFrame: (frame) => frames.push(frame),
    onError: (error) => errors.push(error),
  });

  const session = Buffer.alloc(12);
  session.writeBigUInt64BE(1n << 63n, 0);
  session.writeUInt32BE(572, 4);
  session.writeUInt32BE(1280, 8);
  const payload = Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1e]);
  const packetHeader = Buffer.alloc(12);
  packetHeader.writeBigUInt64BE((1n << 62n) | (1n << 61n) | 123n, 0);
  packetHeader.writeUInt32BE(payload.length, 8);
  const stream = Buffer.concat([Buffer.from('h264'), session, packetHeader, payload]);

  parser.push(stream.subarray(0, 5));
  parser.push(stream.subarray(5, 17));
  parser.push(stream.subarray(17));

  assert.deepEqual(codecs, ['h264']);
  assert.deepEqual(sessions, [[572, 1280]]);
  assert.equal(errors.length, 0);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].pts, 123n);
  assert.equal(frames[0].keyFrame, true);
  assert.equal(frames[0].config, true);
  assert.equal(frames[0].payload.equals(payload), true);

  const envelope = encodeVideoFrame(frames[0]);
  assert.equal(envelope.subarray(0, 4).toString('ascii'), 'DVM1');
  assert.equal(envelope[5], 3);
  assert.equal(envelope.readUInt16BE(6), 572);
  assert.equal(envelope.readUInt16BE(8), 1280);
  assert.equal(envelope.readBigUInt64BE(10), 123n);
  assert.equal(envelope.readUInt32BE(18), payload.length);
});

test('replays the latest config and keyframe to a late subscriber', () => {
  const config = Buffer.from('config-packet');
  const key = Buffer.from('key-packet');
  const delta = Buffer.from('delta-packet');
  let cache = emptyReplayCache();
  cache = rememberReplayFrame(cache, config, { config: true, keyFrame: false });
  cache = rememberReplayFrame(cache, key, { config: false, keyFrame: true });
  cache = rememberReplayFrame(cache, delta, { config: false, keyFrame: false });
  assert.deepEqual(packetsForNewSubscriber(cache), [config, key]);

  const combined = Buffer.from('config-and-key');
  cache = rememberReplayFrame(emptyReplayCache(), combined, { config: true, keyFrame: true });
  assert.deepEqual(packetsForNewSubscriber(cache), [combined]);
});
