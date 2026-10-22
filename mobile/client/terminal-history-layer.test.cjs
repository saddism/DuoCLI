const test = require('node:test');
const assert = require('node:assert/strict');
const {
  captureAnchor,
  restoreAnchorTop,
  mergeItems,
  shouldEnterHistory,
  isHistoryDirection,
  itemKey,
  renderLineHtml,
  beforeLiveEdge,
} = require('./terminal-history-layer.js');

test('history intent does not fire on layout, program scroll or ordinary tap', () => {
  assert.equal(shouldEnterHistory({
    explicitIntent: false,
    hasMore: true,
    noLocalHistory: true,
    viewportY: 0,
  }), false);
  assert.equal(shouldEnterHistory({
    explicitIntent: true,
    hasMore: true,
    loading: true,
    noLocalHistory: true,
    viewportY: 0,
  }), false);
  assert.equal(shouldEnterHistory({
    explicitIntent: true,
    hasMore: true,
    bufferType: 'alternate',
    noLocalHistory: true,
    viewportY: 0,
  }), false);
  assert.equal(shouldEnterHistory({
    explicitIntent: true,
    hasMore: true,
    noLocalHistory: true,
    viewportY: 0,
  }), true);
});

test('first upward history gesture is valid even without local scrollback', () => {
  assert.equal(isHistoryDirection(-12), true);
  assert.equal(isHistoryDirection(8), false);
  assert.equal(shouldEnterHistory({
    explicitIntent: true,
    hasMore: true,
    noLocalHistory: true,
    viewportY: 0,
  }), true);
  assert.equal(shouldEnterHistory({
    explicitIntent: true,
    hasMore: true,
    livePaged: true,
    viewportY: 12,
    noLocalHistory: false,
  }), false);
  assert.equal(shouldEnterHistory({
    explicitIntent: true,
    hasMore: true,
    viewportY: 1,
    noLocalHistory: false,
  }), true);
  assert.equal(shouldEnterHistory({
    explicitIntent: true,
    hasMore: true,
    viewportY: 8,
    noLocalHistory: false,
    edgeLines: 3,
  }), false);
});

test('prepend keeps a content anchor and deduplicates by line id', () => {
  const existing = [{ epoch: 1, lineId: 4, part: 0, text: 'four' }];
  const merged = mergeItems(existing, [
    { epoch: 1, lineId: 3, part: 0, text: 'three' },
    { epoch: 1, lineId: 4, part: 0, text: 'four-dup' },
  ]);
  assert.deepEqual(merged.map(itemKey), ['1:3:0', '1:4:0']);
  const layout = [
    { item: merged[0], top: 0, height: 18 },
    { item: merged[1], top: 18, height: 18 },
  ];
  const anchor = captureAnchor(merged, layout, 18, 18);
  assert.equal(anchor.lineId, 4);
  assert.equal(restoreAnchorTop(layout, anchor), 18);
});

test('history html escapes output and never executes styles as markup', () => {
  const html = renderLineHtml({
    text: '<script>alert(1)</script>',
    styles: [{ start: 0, end: 8, flags: 1 }],
  });
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('&lt;script&gt;'), true);
});

test('archive seam drops the native scrollback even when it is longer than one page', () => {
  const local = Array.from({ length: 10 }, (_, index) => ({ text: `L${index}` }));
  const items = [
    { epoch: 1, lineId: 1, part: 0, text: 'older' },
    { epoch: 1, lineId: 2, part: 0, text: 'L8' },
    { epoch: 1, lineId: 3, part: 0, text: 'L9' },
    { epoch: 1, lineId: 4, part: 0, text: 'screen' },
  ];
  const kept = beforeLiveEdge(items, local);
  assert.deepEqual(kept.map(item => item.text), ['older']);
});

test('visible screen is not repeated when the native scrollback is empty', () => {
  const screen = [{ text: 'visible-a' }, { text: 'visible-b' }];
  const items = [
    { epoch: 1, lineId: 1, part: 0, text: 'older' },
    { epoch: 1, lineId: 2, part: 0, text: 'visible-a' },
    { epoch: 1, lineId: 3, part: 0, text: 'visible-b' },
  ];
  assert.equal(beforeLiveEdge(items, []), null);
  assert.deepEqual(beforeLiveEdge(items, screen).map(item => item.text), ['older']);
});

test('a single short repeated token does not cut the archive', () => {
  const local = [{ text: 'ok' }, { text: 'tail' }];
  const items = [
    { epoch: 1, lineId: 1, part: 0, text: 'keep-me' },
    { epoch: 1, lineId: 2, part: 0, text: 'ok' },
  ];
  assert.equal(beforeLiveEdge(items, local), null);
});

test('history html paints xterm palette and raw CM bitmask colors', () => {
  const { colorOf, normalizeColorMode } = require('./terminal-history-layer.js');
  assert.equal(normalizeColorMode(0x1000000), 1);
  assert.equal(normalizeColorMode(0x2000000), 2);
  assert.equal(normalizeColorMode(0x3000000), 3);
  assert.equal(colorOf(1, 2), '#0dbc79');
  assert.equal(colorOf(0x1000000, 1), '#cd3131');
  assert.equal(colorOf(2, 2), '#0dbc79');
  assert.equal(colorOf(3, 0xff8800), 'rgb(255,136,0)');
  assert.equal(colorOf(0x3000000, 0x00ff00), 'rgb(0,255,0)');
  const html = renderLineHtml({
    text: 'red',
    styles: [{ start: 0, end: 3, fg: 1, fgMode: 0x1000000 }],
  });
  assert.match(html, /color:#cd3131/);
});
