import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ScrcpyVideoParser,
  emptyReplayCache,
  encodeVideoFrame,
  packetsForNewSubscriber,
  rememberReplayFrame,
  serializeKeyControl,
  serializeTextControls,
  serializeTouchControl,
} from '../dist/main/android-mirror.js';

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
