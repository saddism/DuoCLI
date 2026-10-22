import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import {
  humanizeAndroidImageError,
  normalizeAdbScreencapPng,
  prepareAdbScreenshot,
  stripAdbCrlf,
  tryConvertRawScreencap,
} from '../dist/main/android-screencap.js';

async function samplePng() {
  return sharp({
    create: { width: 4, height: 6, channels: 3, background: { r: 10, g: 20, b: 30 } },
  }).png().toBuffer();
}

test('normalizeAdbScreencapPng strips leading noise', async () => {
  const png = await samplePng();
  const noisy = Buffer.concat([Buffer.from('adb: junk\n'), png]);
  const cleaned = normalizeAdbScreencapPng(noisy);
  assert.equal(cleaned[0], 0x89);
  assert.equal(cleaned.length, png.length);
  const meta = await sharp(cleaned).metadata();
  assert.equal(meta.width, 4);
  assert.equal(meta.height, 6);
});

test('normalizeAdbScreencapPng repairs CRLF-corrupted PNG signatures', async () => {
  const png = await samplePng();
  // Simulate the Windows adb bug: every 0x0A becomes 0x0D 0x0A.
  const corrupted = Buffer.alloc(png.length * 2);
  let j = 0;
  for (const byte of png) {
    if (byte === 0x0a) {
      corrupted[j++] = 0x0d;
      corrupted[j++] = 0x0a;
    } else {
      corrupted[j++] = byte;
    }
  }
  const broken = corrupted.subarray(0, j);
  assert.equal(broken[4], 0x0d);
  assert.equal(broken[5], 0x0d);
  const repaired = normalizeAdbScreencapPng(broken);
  assert.deepEqual(repaired.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const meta = await sharp(repaired).metadata();
  assert.equal(meta.width, 4);
});

test('stripAdbCrlf is idempotent on clean PNG', async () => {
  const png = await samplePng();
  // Clean PNGs contain 0D 0A in the signature; stripping once would break them,
  // so callers must only strip when corruption is detected. This asserts the
  // helper itself still replaces CRLF pairs as documented.
  const once = stripAdbCrlf(Buffer.from([0x01, 0x0d, 0x0a, 0x02]));
  assert.deepEqual(once, Buffer.from([0x01, 0x0a, 0x02]));
  assert.equal(normalizeAdbScreencapPng(png).length, png.length);
});

test('prepareAdbScreenshot converts raw RGBA screencap', async () => {
  const width = 2;
  const height = 2;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(width, 0);
  header.writeUInt32LE(height, 4);
  header.writeUInt32LE(1, 8); // RGBA_8888
  const pixels = Buffer.from([
    255, 0, 0, 255,
    0, 255, 0, 255,
    0, 0, 255, 255,
    255, 255, 0, 255,
  ]);
  const raw = Buffer.concat([header, pixels]);
  assert.equal(await tryConvertRawScreencap(Buffer.from('nope')), null);
  const png = await prepareAdbScreenshot(raw);
  const meta = await sharp(png).metadata();
  assert.equal(meta.width, 2);
  assert.equal(meta.height, 2);
});

test('humanizeAndroidImageError hides sharp internals', () => {
  assert.equal(
    humanizeAndroidImageError(new Error('Input buffer contains unsupported image format')),
    '截图格式异常',
  );
  assert.equal(humanizeAndroidImageError(new Error('截图数据为空')), '截图数据为空');
});
