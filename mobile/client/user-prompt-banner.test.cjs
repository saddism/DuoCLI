const test = require('node:test');
const assert = require('node:assert/strict');
const banner = require('./user-prompt-banner.js');

test('previewText keeps 200 code points and marks truncation', () => {
  const short = banner.previewText('修好远程镜像');
  assert.equal(short.truncated, false);
  assert.equal(short.preview, '修好远程镜像');

  const long = '测'.repeat(250);
  const result = banner.previewText(long);
  assert.equal(result.truncated, true);
  assert.equal(Array.from(result.preview).length, 200);
  assert.equal(result.full.length, 250);
});

test('lastUserPromptFrom returns the latest real prompt', () => {
  assert.equal(banner.lastUserPromptFrom(['y', '修好远程镜像', 'n', '补上浏览器横幅']), '补上浏览器横幅');
  assert.equal(banner.lastUserPromptFrom(['ok']), '');
});

test('stored prompts stay isolated per session id', () => {
  const storage = {
    data: {},
    getItem(key) { return this.data[key] ?? null; },
    setItem(key, value) { this.data[key] = String(value); },
  };
  banner.writeStoredPrompt('term-old-1', '别的对话里的话', storage);
  banner.writeStoredPrompt('term-new-2', '', storage);
  assert.equal(banner.readStoredPrompt('term-old-1', storage), '别的对话里的话');
  assert.equal(banner.readStoredPrompt('term-new-2', storage), '');
  banner.writeStoredPrompt('term-old-1', '', storage);
  assert.equal(banner.readStoredPrompt('term-old-1', storage), '');
});


test('looksLikeUserPrompt ignores confirmations and empty text', () => {
  assert.equal(banner.looksLikeUserPrompt('  '), false);
  assert.equal(banner.looksLikeUserPrompt('y'), false);
  assert.equal(banner.looksLikeUserPrompt('N'), false);
  assert.equal(banner.looksLikeUserPrompt('修好这个 bug'), true);
});

test('consumeTypedInput flushes a finished prompt on enter', () => {
  const first = banner.consumeTypedInput('', '修');
  assert.equal(first.line, '修');
  assert.deepEqual(first.segments, []);
  const done = banner.consumeTypedInput(first.line, '好远程\r');
  assert.equal(done.line, '');
  assert.deepEqual(done.segments, ['修好远程']);
});

function makeBuffer(lines) {
  return {
    length: lines.length,
    getLine(y) {
      const item = lines[y];
      if (item && typeof item === 'object') {
        return { translateToString: () => item.text, isWrapped: Boolean(item.isWrapped) };
      }
      return { translateToString: () => item };
    },
  };
}

test('findPromptLine locates the last matching buffer line', () => {
  const buffer = makeBuffer(['noise', '请修好远程镜像交互', 'agent output']);
  assert.equal(banner.findPromptLine(buffer, '请修好远程镜像交互，并补测试'), 1);
});

test('findPromptLine ignores box chrome after wrap and finds the title bar top', () => {
  const buffer = makeBuffer([
    'noise',
    '╭─── User ────────────────╮',
    '│ 请修好远程镜像交互      │',
    '╰─────────────────────────╯',
    'agent output',
  ]);
  assert.equal(banner.findPromptLine(buffer, '请修好远程镜像交互，并补测试'), 2);
  assert.equal(banner.promptBlockStartLine(buffer, '请修好远程镜像交互，并补测试'), 1);
});

test('promptBlockStartLine walks hard wraps without isWrapped up to the title bar', () => {
  const buffer = makeBuffer([
    '╭─── User ───╮',
    '│ 请修好远程',
    '镜像交互 │',
    '╰────────────╯',
  ]);
  assert.equal(banner.promptBlockStartLine(buffer, '请修好远程镜像交互'), 0);
});

test('findPromptLine joins wrapped rows after a narrow resize', () => {
  const buffer = makeBuffer([
    '╭─── User ───╮',
    { text: '│ 请修好远程', isWrapped: false },
    { text: '镜像交互 │', isWrapped: true },
    '╰────────────╯',
  ]);
  assert.equal(banner.findPromptLine(buffer, '请修好远程镜像交互'), 1);
  assert.equal(banner.promptBlockStartLine(buffer, '请修好远程镜像交互'), 0);
});

test('promptBlockStartLine does not walk into the previous message box', () => {
  const buffer = makeBuffer([
    '╭─── User ───╮',
    '│ 上一条任务 │',
    '╰────────────╯',
    '╭─── User ───╮',
    '│ 请修好远程镜像交互 │',
    '╰────────────╯',
  ]);
  assert.equal(banner.promptBlockStartLine(buffer, '请修好远程镜像交互'), 3);
});

test('resolvePromptJumpLine prefers a fresh title-bar line over a stale marker', () => {
  const buffer = makeBuffer([
    '╭─── User ───╮',
    '│ 请修好远程镜像交互 │',
    '╰────────────╯',
  ]);
  assert.equal(banner.resolvePromptJumpLine(buffer, '请修好远程镜像交互', { line: 8, isDisposed: false }), 0);
});

test('findPromptItemIndex uses the title bar of the last matching history block', () => {
  const items = [
    { text: '╭─── User ───╮' },
    { text: '│ 上一条任务 │' },
    { text: '╰────────────╯' },
    { text: '╭─── User ───╮' },
    { text: '│ 请修好远程镜像交互 │' },
    { text: '╰────────────╯' },
  ];
  assert.equal(banner.findPromptItemIndex(items, '请修好远程镜像交互'), 3);
});

test('findPromptItemIndex still matches a plain archived line', () => {
  assert.equal(banner.findPromptItemIndex([{ text: 'noise' }, { text: '修好远程镜像交互' }], '修好远程镜像交互'), 1);
});
