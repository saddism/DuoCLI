import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { AndroidScreenshotManager } from '../dist/main/android-screenshot.js';

test('coalesces concurrent screenshots for one device', async () => {
  const manager = new AndroidScreenshotManager();
  const png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: { r: 1, g: 2, b: 3 } },
  }).png().toBuffer();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const capture = async () => { calls++; await gate; return png; };
  const first = manager.capture('device-1', capture);
  const second = manager.capture('device-1', capture);
  assert.equal(calls, 1);
  release();
  assert.equal((await first).length, png.length);
  assert.equal((await second).length, png.length);
  await manager.capture('device-1', capture);
  assert.equal(calls, 2);
});

test('capture normalizes noisy adb PNG before returning', async () => {
  const manager = new AndroidScreenshotManager();
  const png = await sharp({
    create: { width: 3, height: 3, channels: 3, background: { r: 9, g: 8, b: 7 } },
  }).png().toBuffer();
  const result = await manager.capture('device-2', async () => Buffer.concat([Buffer.from('noise'), png]));
  assert.equal(result[0], 0x89);
  const meta = await sharp(result).metadata();
  assert.equal(meta.width, 3);
});
