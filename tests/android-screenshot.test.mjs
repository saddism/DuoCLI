import assert from 'node:assert/strict';
import test from 'node:test';
import { AndroidScreenshotManager } from '../dist/main/android-screenshot.js';

test('coalesces concurrent screenshots for one device', async () => {
  const manager = new AndroidScreenshotManager();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const capture = async () => { calls++; await gate; return Buffer.from('jpeg'); };
  const first = manager.capture('device-1', capture);
  const second = manager.capture('device-1', capture);
  assert.equal(calls, 1);
  release();
  assert.equal((await first).toString(), 'jpeg');
  assert.equal((await second).toString(), 'jpeg');
  await manager.capture('device-1', capture);
  assert.equal(calls, 2);
});

