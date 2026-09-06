import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DVM2_HEADER_SIZE,
  DVM2_KIND_JPEG,
  decodeDvm2Frame,
  encodeDvm2Frame,
} from '../dist/main/android-mirror-protocol.js';

test('DVM2 JPEG envelope round-trips with strict length and BigInt timestamps', () => {
  const packet = encodeDvm2Frame({
    kind: DVM2_KIND_JPEG,
    captureGeneration: 4,
    geometryVersion: 9,
    frameId: 12,
    ptsUs: 0n,
    hostFrameReceivedUs: 1234567890123n,
    width: 600,
    height: 1000,
    payload: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  });
  assert.equal(packet.length, DVM2_HEADER_SIZE + 4);
  const decoded = decodeDvm2Frame(packet);
  assert.equal(decoded.kind, DVM2_KIND_JPEG);
  assert.equal(decoded.captureGeneration, 4);
  assert.equal(decoded.hostFrameReceivedUs, 1234567890123n);
  assert.deepEqual([...decoded.payload], [0xff, 0xd8, 0xff, 0xd9]);
});

test('DVM2 rejects truncated and trailing payloads', () => {
  const packet = encodeDvm2Frame({ kind: DVM2_KIND_JPEG, width: 1, height: 1, payload: Buffer.from([1]) });
  assert.throws(() => decodeDvm2Frame(packet.subarray(0, packet.length - 1)), /长度/);
  assert.throws(() => decodeDvm2Frame(Buffer.concat([packet, Buffer.from([0])])), /长度/);
});
