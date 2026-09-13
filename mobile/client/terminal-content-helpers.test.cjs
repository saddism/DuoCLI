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

test('hard-wrapped markdown paths rejoin across short phone rows', async t => {
  const term = terminal(28, 8);
  t.after(() => term.dispose());
  await write(term, 'Open docs/guides/getting-star\r\nted.md for details');
  const logical = helpers.readLogicalLine(term.buffer.active, 0);
  assert.match(logical.text, /docs\/guides\/getting-started\.md/);
  const match = helpers.findLinks(logical.text).find(item => item.kind === 'file');
  assert.equal(match.filePath, 'docs/guides/getting-started.md');
  const hit = helpers.findLinkAtCell(logical, { row: 1, col: 2 }, {
    cols: 28,
    predicate: (item) => item.kind === 'file',
  });
  assert.equal(hit.filePath, 'docs/guides/getting-started.md');
});

test('hard-wrapped path after hyphen keeps the separator', async t => {
  const term = terminal(32, 8);
  t.after(() => term.dispose());
  await write(term, 'see docs/reliability-usability-\r\naudit-2026-09-11.md please');
  const logical = helpers.readLogicalLine(term.buffer.active, 1);
  const match = helpers.findLinks(logical.text).find(item => item.kind === 'file');
  assert.equal(match.filePath, 'docs/reliability-usability-audit-2026-09-11.md');
});

test('hard-wrapped typescript / vue / python / json paths rejoin', async t => {
  const cases = [
    { cols: 28, text: 'Open src/components/VeryLongCompo\r\nnent.tsx please', path: 'src/components/VeryLongComponent.tsx' },
    { cols: 26, text: 'edit pages/home/index-page\r\n.vue now', path: 'pages/home/index-page.vue' },
    { cols: 30, text: 'run scripts/data_pipeline_hel\r\npers.py ok', path: 'scripts/data_pipeline_helpers.py' },
    { cols: 28, text: 'load config/app-settings.pro\r\nd.json', path: 'config/app-settings.prod.json' },
  ];
  for (const item of cases) {
    const term = terminal(item.cols, 8);
    t.after(() => term.dispose());
    await write(term, item.text);
    const logical = helpers.readLogicalLine(term.buffer.active, 0);
    assert.match(logical.text, new RegExp(item.path.replace(/\./g, '\\.')));
    const match = helpers.findLinks(logical.text).find(entry => entry.kind === 'file');
    assert.equal(match.filePath, item.path, item.path);
  }
});

test('hard wrap that splits a known extension rejoins', async t => {
  const term = terminal(24, 8);
  t.after(() => term.dispose());
  await write(term, 'touch src/ui/ButtonComponen\r\nt.tsx');
  const logical = helpers.readLogicalLine(term.buffer.active, 0);
  const match = helpers.findLinks(logical.text).find(item => item.kind === 'file');
  assert.equal(match.filePath, 'src/ui/ButtonComponent.tsx');
});

test('hard wrap that splits only the extension suffix rejoins', async t => {
  const term = terminal(22, 8);
  t.after(() => term.dispose());
  await write(term, 'open src/App.t\r\nsx');
  const logical = helpers.readLogicalLine(term.buffer.active, 0);
  const match = helpers.findLinks(logical.text).find(item => item.kind === 'file');
  assert.equal(match.filePath, 'src/App.tsx');
});

test('hard-wrapped image path is linkable', async t => {
  const term = terminal(28, 8);
  t.after(() => term.dispose());
  await write(term, 'see assets/brand/hero-banner-\r\nlarge.png');
  const logical = helpers.readLogicalLine(term.buffer.active, 0);
  const match = helpers.findLinks(logical.text).find(item => item.kind === 'file');
  assert.equal(match.filePath, 'assets/brand/hero-banner-large.png');
});

test('ordinary word before a filename is not glued into a fake path', async t => {
  const term = terminal(40, 6);
  t.after(() => term.dispose());
  await write(term, 'please src/helpers.ts today');
  const logical = helpers.readLogicalLine(term.buffer.active, 0);
  assert.deepEqual(helpers.findLinks(logical.text).map(item => item.filePath), ['src/helpers.ts']);
  assert.equal(logical.text.includes('pleasesrc/helpers.ts'), false);
});

test('artifact ZIP and image links both survive Chinese text and terminal wraps', async t => {
  const zip = 'data-store/Artifacts/20260912-app-store-parent-v7/家长糖宣传图-V7.zip';
  const png = 'data-store/Artifacts/20260912-app-store-parent-v7/images/04.png';
  const text = `下载整组图片 (${zip}) · 查看新版 04 (${png})`;
  for (const cols of [36, 80, 240]) {
    const term = terminal(cols, 12);
    t.after(() => term.dispose());
    await write(term, text);
    const logical = helpers.readLogicalLine(term.buffer.active, 0);
    const matches = helpers.findLinks(logical.text);
    assert.deepEqual(matches.map(item => item.filePath), [zip, png]);
    for (const match of matches) {
      const range = helpers.matchRange(logical, match);
      assert.equal(helpers.findLinkAtCell(logical, { row: range.start.line, col: range.start.cell }, { cols }).filePath, match.filePath);
    }
  }
});

test('hard wrapped archive extension rejoins', async t => {
  const term = terminal(80, 6);
  t.after(() => term.dispose());
  await write(term, '下载 data-store/家长糖.z\r\nip');
  const logical = helpers.readLogicalLine(term.buffer.active, 0);
  assert.deepEqual(helpers.findLinks(logical.text).map(item => item.filePath), ['data-store/家长糖.zip']);
});

test('parenthesized Chinese artifact citations are file links', () => {
  const mp4 = 'Artifacts/20260913-原生验证/enhanced-review.mp4';
  const md = 'docs/制作总稿原生验证-20260913.md';
  const text = `增强检查片（23.9 秒） (${mp4}) · 验证记录 (${md})`;
  assert.deepEqual(helpers.findLinks(text).map(item => item.filePath), [mp4, md]);
});

test('glued Chinese labels still expose parenthesized paths', () => {
  const mp4 = 'Artifacts/20260913-原生验证/enhanced-review.mp4';
  const md = 'docs/制作总稿原生验证-20260913.md';
  const text = `增强检查片（23.9 秒）(${mp4})·验证记录(${md})`;
  assert.deepEqual(helpers.findLinks(text).map(item => item.filePath), [mp4, md]);
});

test('hard-wrapped parenthesized citations keep both paths clickable', async t => {
  const mp4 = 'Artifacts/20260913-原生验证/enhanced-review.mp4';
  const md = 'docs/制作总稿原生验证-20260913.md';
  const term = terminal(100, 8);
  t.after(() => term.dispose());
  await write(term, `  增强检查片（23.9 秒） (${mp4}) · 验证记录\r\n  (${md})`);
  const found = [];
  const seen = new Set();
  for (let y = 0; y < 4; y++) {
    const logical = helpers.readLogicalLine(term.buffer.active, y);
    for (const item of helpers.findLinks(logical.text)) {
      if (item.kind !== 'file' || seen.has(item.filePath)) continue;
      seen.add(item.filePath);
      found.push(item.filePath);
    }
  }
  assert.deepEqual(found, [mp4, md]);
});

test('hard wrap that splits docs/ inside parentheses rejoins', async t => {
  const md = 'docs/制作总稿原生验证-20260913.md';
  const term = terminal(88, 8);
  t.after(() => term.dispose());
  await write(term, `  验证记录 (${md.slice(0, 2)}\r\n${md.slice(2)})`);
  const logical = helpers.readLogicalLine(term.buffer.active, 0);
  assert.deepEqual(helpers.findLinks(logical.text).map(item => item.filePath), [md]);
});

test('phone-width hard wrap through a Chinese HTML path stays clickable', async t => {
  const html = 'Artifacts/20260913-全片总稿验证/project/views/r000134-b8055f7f9fea-4e4df0ce/index.html';
  const rows = [
    '• 完整内容提案已整理好：全片制作总稿 HTML',
    '  (Artifacts/20260913-全片总稿验',
    '证/project/views/r000134-b8055f7',
    'f9fea-4e4df0ce/index.html)。它包',
    '含全文、18 个观点段、顶部',
  ];
  const term = terminal(32, 12);
  t.after(() => term.dispose());
  await write(term, rows.join('\r\n'));
  const logical = helpers.readLogicalLine(term.buffer.active, 2);
  assert.equal(helpers.findLinks(logical.text).find(item => item.kind === 'file')?.filePath, html);
  const hit = helpers.findLinkAtCell(logical, { row: 2, col: 8 }, {
    cols: 32,
    predicate: (item) => item.kind === 'file',
  });
  assert.equal(hit.filePath, html);
});
