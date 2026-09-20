const test = require('node:test');
const assert = require('node:assert/strict');
const { render, highlightCode, chooseSessionViewMode, mergeLocalMessages } = require('./native-chat-view.js');

test('first render without a snapshot shows loading', () => {
  const container = { innerHTML: '' };
  render(container, undefined);
  assert.match(container.innerHTML, /正在读取对话/);
});

test('chat updates equal-length edits, earlier turns, and tool arguments', () => {
  const container = { innerHTML: '' };
  const snapshot = { supported: true, ready: true, messages: [
    { id: 'a', role: 'assistant', blocks: [{ type: 'text', text: 'old' }, { type: 'tool-call', input: { command: 'pwd' } }] },
    { id: 'b', role: 'user', blocks: [{ type: 'text', text: 'next' }] },
  ] };
  render(container, snapshot);
  snapshot.messages[0].blocks[0].text = 'new';
  snapshot.messages[0].blocks[1].input.command = 'ls';
  render(container, snapshot);
  assert.match(container.innerHTML, /new/);
  assert.match(container.innerHTML, /ls/);
  assert.doesNotMatch(container.innerHTML, /pwd/);
});

test('local echo waits for the new occurrence, including repeated prompts', () => {
  const user = { role: 'user', blocks: [{ type: 'text', text: '继续' }] };
  const snapshot = { supported: true, messages: [user] };
  const pending = [{ id: 'new', text: '继续', occurrence: 2, status: '发送中…' }];
  const waiting = mergeLocalMessages(snapshot, pending);
  assert.equal(waiting.pending.length, 1);
  assert.equal(waiting.snapshot.messages.length, 2);
  const delivered = mergeLocalMessages({ ...snapshot, messages: [user, user] }, pending);
  assert.equal(delivered.pending.length, 0);
  assert.equal(delivered.snapshot.messages.length, 2);
});

test('submission tracking reconciles only the matching local echo id', () => {
  const snapshot = { supported: true, submissionTracking: true, messages: [
    { role: 'user', submissionId: 'older', blocks: [{ type: 'text', text: '继续' }] },
    { role: 'user', submissionId: 'current', blocks: [{ type: 'text', text: '继续' }] },
  ] };
  const result = mergeLocalMessages(snapshot, [
    { id: 'current', text: '继续', occurrence: 2, status: '发送中…' },
    { id: 'future', text: '继续', occurrence: 3, status: '发送中…' },
  ]);
  assert.deepEqual(result.pending.map(item => item.id), ['future']);
  assert.equal(result.snapshot.messages.at(-1).id, 'local:future');
});

test('local echo is visible before a transcript exists and escapes input', () => {
  const merged = mergeLocalMessages(null, [{ id: 'a', text: '<img>', occurrence: 1, status: '发送中…' }]);
  const container = { innerHTML: '' };
  render(container, merged.snapshot);
  assert.match(container.innerHTML, /&lt;img&gt;/);
  assert.match(container.innerHTML, /发送中/);
});

test('native chat view renders user and assistant turns', () => {
  const container = { innerHTML: '' };
  render(container, {
    supported: true,
    ready: true,
    messages: [
      { role: 'user', blocks: [{ type: 'text', text: '<hi>' }] },
      { role: 'assistant', blocks: [{ type: 'text', text: 'ok' }] },
    ],
  });
  assert.match(container.innerHTML, /native-chat-user/);
  assert.match(container.innerHTML, /&lt;hi&gt;/);
  assert.match(container.innerHTML, /native-chat-assistant/);
});

test('chat renders safe links, code fences, and complete tool output', () => {
  const container = { innerHTML: '' };
  const long = 'x'.repeat(5000);
  render(container, { supported: true, messages: [{ id: 'a', role: 'assistant', blocks: [
    { type: 'text', text: '<script>alert(1)</script> https://example.com\n```js\nconst x = 1;\n```' },
    { type: 'tool-result', output: long },
  ] }] });
  assert.doesNotMatch(container.innerHTML, /<script>/);
  assert.match(container.innerHTML, /href="https:\/\/example.com/);
  assert.match(container.innerHTML, /native-chat-code/);
  assert.match(container.innerHTML, /JavaScript/);
  assert.match(container.innerHTML, /tok-keyword[^>]*>const/);
  assert.match(container.innerHTML, new RegExp(`x{${long.length}}`));
});

test('syntax highlighting colors tokens without allowing code HTML', () => {
  const html = highlightCode('const value = "<img>"; // note\nreturn 42;', 'js');
  assert.match(html, /tok-keyword[^>]*>const/);
  assert.match(html, /tok-string[^>]*>&quot;&lt;img&gt;&quot;/);
  assert.match(html, /tok-comment[^>]*>\/\/ note/);
  assert.match(html, /tok-number[^>]*>42/);
  assert.doesNotMatch(html, /<img>/);
});

test('tool and delivery states render as visible semantic badges', () => {
  const container = { innerHTML: '' };
  render(container, { supported: true, messages: [
    { id: 'tool', role: 'assistant', blocks: [{ type: 'tool-call', name: 'shell', state: 'running', input: {} }] },
    { id: 'local', role: 'user', localStatus: '发送状态未确认 · 原文已保留', blocks: [{ type: 'text', text: 'hello' }] },
  ] });
  assert.match(container.innerHTML, /state-running[^>]*>进行中/);
  assert.match(container.innerHTML, /native-chat-delivery state-error/);
});

test('native chat view skips an unchanged snapshot', () => {
  const container = { innerHTML: '' };
  const snapshot = {
    supported: true,
    ready: true,
    messages: [
      { id: 'u1', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
    ],
  };
  render(container, snapshot);
  container.innerHTML = 'keep-me';
  render(container, snapshot);
  assert.equal(container.innerHTML, 'keep-me');
});

test('new chat-capable session without transcript stays on the terminal', () => {
  assert.equal(chooseSessionViewMode({ chatCapable: true, pref: null, hasMessages: false }), 'terminal');
  assert.equal(chooseSessionViewMode({ chatCapable: true, hasMessages: false }), 'terminal');
});

test('chat-capable session with transcript defaults to chat view', () => {
  assert.equal(chooseSessionViewMode({ chatCapable: true, pref: null, hasMessages: true }), 'chat');
});

test('explicit view preference wins over transcript presence', () => {
  assert.equal(chooseSessionViewMode({ chatCapable: true, pref: 'chat', hasMessages: false }), 'chat');
  assert.equal(chooseSessionViewMode({ chatCapable: true, pref: 'terminal', hasMessages: true }), 'terminal');
});

test('unsupported clis never open native chat', () => {
  assert.equal(chooseSessionViewMode({ chatCapable: false, pref: 'chat', hasMessages: true }), 'terminal');
});
