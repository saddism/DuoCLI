const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LIVE_TERMINAL_SCROLLBACK,
  SERVER_TERMINAL_SCROLLBACK,
  isAtBottom,
  isAtHistoryEdge,
  shouldFollowOutput,
  isHistoryDirection,
  shouldRequestHistory,
  shouldFollowAfterLayout,
  alternateScreenPageKeys,
  ALT_SCREEN_PAGE_UP,
  ALT_SCREEN_PAGE_DOWN,
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
  assert.equal(LIVE_TERMINAL_SCROLLBACK, SERVER_TERMINAL_SCROLLBACK);
  assert.equal(LIVE_TERMINAL_SCROLLBACK, 5000);
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

test('alternate-screen swipes become page keys instead of arrow keys', () => {
  const screen = { bufferType: 'alternate', rowHeight: 20, rows: 20 };
  const idle = alternateScreenPageKeys({ ...screen, deltaY: 40, accumulated: 0 });
  assert.equal(idle.data, '');
  assert.equal(idle.remainder, 40);

  const down = alternateScreenPageKeys({ ...screen, deltaY: 100, accumulated: idle.remainder });
  assert.equal(down.data, ALT_SCREEN_PAGE_DOWN);
  assert.ok(down.remainder < 20 * 20 * 0.34);

  const up = alternateScreenPageKeys({ ...screen, deltaY: -200, accumulated: 0 });
  assert.equal(up.data, ALT_SCREEN_PAGE_UP);

  const flick = alternateScreenPageKeys({ ...screen, deltaY: 0, accumulated: 50, flush: true });
  assert.equal(flick.data, ALT_SCREEN_PAGE_DOWN);
  assert.equal(flick.remainder, 0);

  const jitter = alternateScreenPageKeys({ ...screen, deltaY: 0, accumulated: 20, flush: true });
  assert.equal(jitter.data, '');
  assert.equal(jitter.remainder, 20);

  const normal = alternateScreenPageKeys({ bufferType: 'normal', deltaY: -400, accumulated: 12 });
  assert.equal(normal.data, '');
  assert.equal(normal.remainder, 12);

  const burst = alternateScreenPageKeys({ ...screen, deltaY: 20 * 20 * 0.34 * 6, accumulated: 0 });
  assert.equal(burst.data, ALT_SCREEN_PAGE_DOWN.repeat(4));
});

test('reversing an alternate-screen gesture drops the old direction remainder', () => {
  const result = alternateScreenPageKeys({ bufferType: 'alternate', rowHeight: 20, rows: 20,
    accumulated: 120, deltaY: -140 });
  assert.equal(result.data, ALT_SCREEN_PAGE_UP);
});

test('a short wheel gesture flushes once and reset cancels delayed input', async () => {
  const { createAlternateScreenScroller } = require('./terminal-scroll-helpers.js');
  const sent = [];
  const scroller = createAlternateScreenScroller(
    () => ({ bufferType: 'alternate', rowHeight: 20, rows: 20 }), data => sent.push(data));
  scroller.wheel(-50);
  assert.deepEqual(sent, []);
  await new Promise(resolve => setTimeout(resolve, 130));
  assert.deepEqual(sent, [ALT_SCREEN_PAGE_UP]);
  scroller.wheel(50);
  scroller.reset();
  await new Promise(resolve => setTimeout(resolve, 130));
  assert.deepEqual(sent, [ALT_SCREEN_PAGE_UP]);
});

test('a pending wheel never sends input after leaving the alternate screen', async () => {
  const { createAlternateScreenScroller } = require('./terminal-scroll-helpers.js');
  let bufferType = 'alternate';
  const sent = [];
  const scroller = createAlternateScreenScroller(() => ({ bufferType, rowHeight: 20, rows: 20 }), data => sent.push(data));
  scroller.wheel(-50);
  bufferType = 'normal';
  await new Promise(resolve => setTimeout(resolve, 130));
  assert.deepEqual(sent, []);
});
