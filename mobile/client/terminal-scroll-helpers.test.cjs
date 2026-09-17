const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LIVE_TERMINAL_SCROLLBACK,
  isAtBottom,
  isAtHistoryEdge,
  shouldFollowOutput,
  isHistoryDirection,
  shouldRequestHistory,
  shouldFollowAfterLayout,
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

test('history is requested only by an explicit history gesture at the live top', () => {
  assert.ok(LIVE_TERMINAL_SCROLLBACK >= 24 && LIVE_TERMINAL_SCROLLBACK <= 200);
  assert.equal(isHistoryDirection(-1), true);
  assert.equal(isAtHistoryEdge({ viewportY: 8, noLocalHistory: false }), false);
  assert.equal(isAtHistoryEdge({ viewportY: 0, noLocalHistory: false }), true);
  assert.equal(shouldRequestHistory({
    explicitIntent: false,
    hasMore: true,
    noLocalHistory: true,
    viewportY: 0,
  }), false);
  assert.equal(shouldRequestHistory({
    explicitIntent: true,
    hasMore: true,
    noLocalHistory: true,
    viewportY: 0,
  }), true);
  assert.equal(shouldRequestHistory({
    explicitIntent: true,
    hasMore: true,
    viewportY: 8,
    noLocalHistory: false,
  }), false);
  assert.equal(shouldRequestHistory({
    explicitIntent: true,
    hasMore: true,
    livePaged: true,
    viewportY: 8,
    noLocalHistory: false,
  }), false);
});

test('layout/fit keeps following only when the user is still on the live edge', () => {
  assert.equal(shouldFollowAfterLayout({
    userScrolling: false,
    touchActive: false,
    historyVisible: false,
    alreadyAtBottom: false,
    firstLatestPaint: false,
  }), true);
  assert.equal(shouldFollowAfterLayout({
    userScrolling: false,
    touchActive: false,
    historyVisible: false,
    alreadyAtBottom: false,
    firstLatestPaint: true,
  }), false);
  assert.equal(shouldFollowAfterLayout({
    userScrolling: false,
    touchActive: false,
    historyVisible: false,
    alreadyAtBottom: true,
  }), false);
  assert.equal(shouldFollowAfterLayout({
    userScrolling: true,
    touchActive: false,
    historyVisible: false,
  }), false);
  assert.equal(shouldFollowAfterLayout({
    userScrolling: false,
    touchActive: true,
    historyVisible: false,
  }), false);
  assert.equal(shouldFollowAfterLayout({
    userScrolling: false,
    touchActive: false,
    historyVisible: true,
  }), false);
});
