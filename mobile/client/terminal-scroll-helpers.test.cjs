const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isAtBottom,
  shouldFollowOutput,
} = require('./terminal-scroll-helpers.js');

test('terminal follows output only at the exact bottom', () => {
  assert.equal(isAtBottom(120, 120), true);
  assert.equal(isAtBottom(119, 120), false);
  assert.equal(isAtBottom(118, 120), false);
  assert.equal(isAtBottom(117, 120), false);
});

test('terminal does not follow output when a user gesture starts after the write begins', () => {
  assert.equal(shouldFollowOutput(true, false, 3, 3), true);
  assert.equal(shouldFollowOutput(true, true, 3, 3), false);
  assert.equal(shouldFollowOutput(true, false, 3, 4), false);
  assert.equal(shouldFollowOutput(false, false, 3, 3), false);
});
