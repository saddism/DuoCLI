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
