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
  const text = 'and/or input/output yes/no 2026/09/06 50/100 example.com v1.2.3 user@host.com @types/node README';
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
