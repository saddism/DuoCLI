import assert from 'node:assert/strict';
import test from 'node:test';
import { isMacDesktopHost, normalizeDesktopPoint, toQuartzPoint } from '../dist/main/mac-desktop-capture.js';

test('normalizeDesktopPoint accepts on-screen coordinates only', () => {
  assert.equal(normalizeDesktopPoint(12.8), 13);
  assert.equal(normalizeDesktopPoint('40'), 40);
  assert.equal(normalizeDesktopPoint(-1), null);
  assert.equal(normalizeDesktopPoint('nope'), null);
});

test('mac desktop capture is only claimed on darwin hosts', () => {
  assert.equal(isMacDesktopHost(), process.platform === 'darwin');
});

test('toQuartzPoint flips screenshot Y into CGEvent coordinates', () => {
  assert.deepEqual(toQuartzPoint(10, 0, 900), { x: 10, y: 900 });
  assert.deepEqual(toQuartzPoint(10, 900, 900), { x: 10, y: 0 });
  assert.deepEqual(toQuartzPoint(40, 200, 800), { x: 40, y: 600 });
});
