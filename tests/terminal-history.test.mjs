import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TerminalHistoryArchive,
  decodeHistoryCursor,
  encodeHistoryCursor,
  fragmentHistoryLine,
  overlapLogicalCount,
  readLogicalScrollback,
  sameLogicalTexts,
} from '../dist/main/terminal-history.js';
import { TerminalState } from '../dist/main/terminal-state.js';

test('overlap and cursor encoding stay stable across pages', () => {
  assert.equal(overlapLogicalCount(['a', 'b', 'c'], ['b', 'c', 'd']), 2);
  assert.equal(overlapLogicalCount(['a'], ['x']), 0);
  assert.deepEqual(decodeHistoryCursor(encodeHistoryCursor(3, 12, 2)), { epoch: 3, lineId: 12, part: 2 });
  assert.equal(decodeHistoryCursor('bad'), null);
  assert.equal(sameLogicalTexts(['一', '二'], ['一', '二']), true);
});

test('archive captures new scrollback once and pages without rewriting live ids', () => {
  const archive = new TerminalHistoryArchive(1);
  archive.syncFromLogical([
    { text: 'one', wraps: [], styles: [] },
    { text: 'two', wraps: [], styles: [] },
  ]);
  archive.syncFromLogical([
    { text: 'one', wraps: [], styles: [] },
    { text: 'two', wraps: [], styles: [] },
    { text: 'two', wraps: [], styles: [] },
  ]);
  const ids = archive.getLines().map(line => [line.lineId, line.text]);
  assert.deepEqual(ids, [[1, 'one'], [2, 'two'], [3, 'two']]);

  const first = archive.pageBefore({ limitRows: 2, requestId: 'r1' });
  assert.equal(first.requestId, 'r1');
  assert.equal(first.stale, false);
  assert.deepEqual(first.items.map(item => item.lineId), [2, 3]);
  const second = archive.pageBefore({ beforeCursor: first.nextCursor, limitRows: 2, requestId: 'r2' });
  assert.deepEqual(second.items.map(item => item.lineId), [1]);
  assert.equal(second.hasMore, false);
  assert.equal(first.items[0].lineId, 2);
});

test('stale epoch cursor is not an empty success page', () => {
  const archive = new TerminalHistoryArchive(2);
  archive.syncFromLogical([{ text: 'keep', wraps: [], styles: [] }]);
  const page = archive.pageBefore({ beforeCursor: '1:9', requestId: 'stale' });
  assert.equal(page.stale, true);
  assert.equal(page.items.length, 0);
  assert.equal(page.epoch, 2);
});

test('eviction marks the retained window as truncated', () => {
  const archive = new TerminalHistoryArchive(1, { maxRows: 3, maxBytes: 10_000 });
  archive.syncFromLogical(['a', 'b', 'c', 'd'].map(text => ({ text, wraps: [], styles: [] })));
  assert.equal(archive.truncated, true);
  assert.deepEqual(archive.getLines().map(line => line.text), ['b', 'c', 'd']);
  const page = archive.pageBefore({ limitRows: 10 });
  assert.equal(page.truncated, true);
  assert.equal(page.hasMore, false);
});

test('long logical lines fragment instead of silent truncation', () => {
  const line = {
    lineId: 7,
    epoch: 1,
    text: 'x'.repeat(9000),
    wraps: [4000, 8000],
    styles: [],
    order: 1,
  };
  const parts = fragmentHistoryLine(line, 4000);
  assert.equal(parts.length, 3);
  assert.equal(parts[0].partCount, 3);
  assert.equal(parts.map(part => part.text.length).reduce((a, b) => a + b, 0), 9000);
});

test('logical scrollback joins wrapped rows and ignores the live viewport', () => {
  const rows = [
    { text: 'hello', wrapped: false },
    { text: 'world', wrapped: true },
    { text: 'live', wrapped: false },
  ];
  const buffer = {
    length: 3,
    baseY: 2,
    getLine(y) {
      const row = rows[y];
      return row && {
        isWrapped: row.wrapped,
        translateToString() { return row.text; },
      };
    },
  };
  assert.deepEqual(readLogicalScrollback(buffer).map(line => line.text), ['helloworld']);
});

test('TerminalState snapshot exposes history bounds without claiming infinite history', async t => {
  const state = new TerminalState();
  t.after(() => state.dispose());
  state.resize(40, 8);
  state.write(Array.from({ length: 40 }, (_, i) => `row-${String(i).padStart(2, '0')}\r\n`).join(''), () => {});
  let latest;
  await state.snapshot(value => { latest = value; }, { scrollback: 0 });
  assert.equal(latest.capabilityVersion, 2);
  assert.equal(latest.scrollback, 0);
  assert.equal(latest.hasMoreHistory, true);
  assert.equal(latest.historyHasMore, true);
  assert.ok(latest.historyCursor);
  const meta = await state.historyMeta();
  assert.equal(meta.historyHasMore, true);
  assert.equal(meta.historyCursor, latest.historyCursor);

  const page = await state.historyBefore({ beforeCursor: latest.historyCursor, limitRows: 80, requestId: 'p1' });
  assert.equal(page.stale, false);
  assert.ok(page.items.length > 0);
  assert.match(page.items[0].text, /row-/);
});

test('clear screen keeps archived lines and resize does not duplicate them', async t => {
  const state = new TerminalState();
  t.after(() => state.dispose());
  state.resize(20, 4);
  state.write(Array.from({ length: 12 }, (_, i) => `keep-${i}\r\n`).join(''), () => {});
  await state.snapshot(() => {});
  const before = state.history.getLines().map(line => line.text);
  assert.ok(before.some(text => text.startsWith('keep-')));
  state.write('\x1b[2J\x1b[Hfresh\r\n', () => {});
  state.resize(32, 10);
  await state.snapshot(() => {});
  const after = state.history.getLines().map(line => line.text);
  assert.ok(before.every(text => after.includes(text)));
  assert.equal(after.filter(text => text === before[0]).length, 1);
});
