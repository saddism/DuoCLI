const test = require('node:test');
const assert = require('node:assert/strict');
globalThis.self = globalThis;
const { Terminal } = require('./xterm.js');
const { Unicode11Addon } = require('./addon-unicode11.js');
const helpers = require('./terminal-content-helpers.js');
const write = (term, data) => new Promise(resolve => term.write(data, resolve));
function terminal(cols, rows) {
  const term = new Terminal({ cols, rows, scrollback: 100, allowProposedApi: true });
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  return term;
}

test('soft wraps form one mapped logical line', async t => {
  const term = terminal(12, 5);
  t.after(() => term.dispose());
  await write(term, 'prefix src/components/LongName.tsx:12:3 suffix');
  const logical = helpers.readLogicalLine(term.buffer.active, 2);
  assert.equal(logical.text, 'prefix src/components/LongName.tsx:12:3 suffix');
  const match = helpers.findLinks(logical.text).find(item => item.kind === 'file');
  assert.equal(match.filePath, 'src/components/LongName.tsx');
  const range = helpers.matchRange(logical, match);
  assert.ok(range.start.line < range.end.line);
});

test('quoted spaces, Windows, parent, alias and URL formats are distinguished', () => {
  const text = '"src/My File.ts":8 C:\\work\\app\\main.py:4:2 ../docs/README.MD @/ui/App.vue https://example.com/a.ts';
  assert.deepEqual(helpers.findLinks(text).map(item => item.kind === 'file' ? item.filePath : item.url), [
    'src/My File.ts', 'C:\\work\\app\\main.py', '../docs/README.MD', '@/ui/App.vue', 'https://example.com/a.ts',
  ]);
});

test('common prose tokens are not mistaken for file links', () => {
  const text = 'and/or input/output yes/no 档案/聊天 2026/09/06 50/100 example.com v1.2.3 user@host.com @types/node README';
  assert.deepEqual(helpers.findLinks(text), []);
});

test('Chinese prose containing a slash does not decorate the whole paragraph as a path', () => {
  const text = '家长在确认选回「一年级」，或档案/聊天改回来，本学年就会锁住。没法在自动升之前预知谁会留级。';
  assert.deepEqual(helpers.findLinks(text), []);
});

test('real paths and source files are still detected', () => {
  const text = 'edit src/app.ts and/or see src/renderer/styles.css for 192.168.1.1';
  assert.deepEqual(helpers.findLinks(text).map(item => item.filePath), [
    'src/app.ts',
    'src/renderer/styles.css',
  ]);
});

test('Cursor-style hard-rendered wraps copy as one natural paragraph', async t => {
  const term = terminal(43, 8);
  t.after(() => term.dispose());
  await write(term, '  这是输入测试，不要读文件，不要调用\r\n  工具，只回复“CURSOR_SE\r\n  ND_OK”。');
  const buffer = term.buffer.active;
  const text = helpers.getSelectionText(buffer, { start: { x: 0, y: 0 }, end: { x: 43, y: 2 } });
  assert.equal(text, '  这是输入测试，不要读文件，不要调用工具，只回复“CURSOR_SEND_OK”。');
});

test('ordinary short rows and lists keep their real newlines', async t => {
  const term = terminal(43, 8);
  t.after(() => term.dispose());
  await write(term, '  1. first\r\n  2. second\r\nshort line');
  const text = helpers.getSelectionText(term.buffer.active, { start: { x: 0, y: 0 }, end: { x: 10, y: 2 } });
  assert.equal(text, '  1. first\n  2. second\nshort line');
});

test('separate full-width code rows are not mistaken for a TUI paragraph', async t => {
  const term = terminal(20, 5);
  t.after(() => term.dispose());
  await write(term, '  const first = 1\r\n  const next = 2');
  const text = helpers.getSelectionText(term.buffer.active, { start: { x: 0, y: 0 }, end: { x: 20, y: 1 } });
  assert.equal(text, '  const first = 1\n  const next = 2');
});

test('long press selects the token under the finger, not the whole line', async t => {
  const term = terminal(40, 6);
  t.after(() => term.dispose());
  await write(term, 'edit src/app.ts now');
  const logical = helpers.readLogicalLine(term.buffer.active, 0);
  const range = helpers.wordRangeAt(logical, { row: 0, col: 7 });
  assert.deepEqual(range.start, { line: 0, cell: 5 });
  assert.deepEqual(range.end, { line: 0, cell: 14 });
  assert.equal(logical.text.slice(range.start.cell, range.end.cell + 1), 'src/app.ts');
});

test('quotes and trailing punctuation are dropped from the selected word', async t => {
  const term = terminal(40, 6);
  t.after(() => term.dispose());
  await write(term, 'see "src/My File.ts":8 run npm test.');
  const logical = helpers.readLogicalLine(term.buffer.active, 0);
  const quoted = helpers.wordRangeAt(logical, { row: 0, col: 5 });
  assert.equal(logical.text.slice(quoted.start.cell, quoted.end.cell + 1), 'src/My');
  const trailing = helpers.wordRangeAt(logical, { row: 0, col: 32 });
  assert.equal(logical.text.slice(trailing.start.cell, trailing.end.cell + 1), 'test');
});

test('Chinese text selects one character per long press, wide cell halves included', async t => {
  const term = terminal(20, 5);
  t.after(() => term.dispose());
  await write(term, '你好世界');
  const logical = helpers.readLogicalLine(term.buffer.active, 0);
  for (const col of [2, 3]) {
    const range = helpers.wordRangeAt(logical, { row: 0, col });
    assert.deepEqual(range, { start: { line: 0, cell: 2 }, end: { line: 0, cell: 2 } });
  }
});

test('a soft-wrapped token selects across buffer rows', async t => {
  const term = terminal(12, 6);
  t.after(() => term.dispose());
  await write(term, 'prefix src/components/LongName.tsx:12:3 suffix');
  const logical = helpers.readLogicalLine(term.buffer.active, 1);
  const range = helpers.wordRangeAt(logical, { row: 1, col: 0 });
  assert.equal(range.start.line, 0);
  assert.ok(range.end.line > range.start.line);
});
