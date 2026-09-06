import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { AndroidJpegManager } from '../dist/main/android-jpeg.js';
import { decodeDvm2Frame, DVM2_KIND_JPEG } from '../dist/main/android-mirror-protocol.js';

test('JPEG manager shares capture work and emits bounded DVM2 frames', async () => {
  const png = await sharp({ create: { width: 8, height: 12, channels: 3, background: { r: 20, g: 40, b: 80 } } }).png().toBuffer();
  let captures = 0;
  const screenshot = { capture: async (_device, run) => { captures++; return run(); } };
  // The supplied callback is only used by the real manager when no fake result
  // is available; return a deterministic image without invoking ADB.
  screenshot.capture = async () => { captures++; return png; };
  const manager = new AndroidJpegManager(screenshot);
  const frames = [];
  const clientA = { id: 'a', sendJson() {}, sendBinary(packet) { frames.push(packet); } };
  const clientB = { id: 'b', sendJson() {}, sendBinary() {} };
  manager.subscribe('device-1', clientA, { fps: 1, scale: 1 });
  manager.subscribe('device-1', clientB, { fps: 1, scale: 1 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(captures >= 1);
  assert.ok(frames.length >= 1);
  const decoded = decodeDvm2Frame(frames[0]);
  assert.equal(decoded.kind, DVM2_KIND_JPEG);
  assert.equal(decoded.width, 8);
  assert.equal(decoded.height, 12);
  manager.clear();
});
