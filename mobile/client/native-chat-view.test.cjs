const test = require('node:test');
const assert = require('node:assert/strict');
const {
  render, highlightCode, chooseSessionViewMode, mergeLocalMessages, renderText,
  messagePlainText, formatMessageTime, buildChatRenderItems, pairToolGroupBlocks,
} = require('./native-chat-view.js');

test('CLI control commands open a terminal but paths and multiline prompts stay chat', () => {
  const { terminalCommand } = require('./native-chat-view.js');
  for (const text of ['/model', '/model gpt-5', '/permissions', '/review', '/mcp', '/help']) {
    assert.ok(terminalCommand(text), text);
  }
  for (const text of ['/Users/me/app needs review', '/model\nexplain this file', ' /model', '/my-custom-skill', 'hello']) {
    assert.equal(terminalCommand(text), null, text);
  }
});

test('slash detection covers unknown commands but rejects paths and multiline input', () => {
  const { slashCommandText } = require('./native-chat-view.js');
  assert.equal(slashCommandText('/init'), 'init');
  assert.equal(slashCommandText('/cost'), 'cost');
  assert.equal(slashCommandText('/my-skill extra args'), 'my-skill');
  assert.equal(slashCommandText('/MODEL'), 'model');
  assert.equal(slashCommandText('/my-custom-skill'), 'my-custom-skill');
  for (const text of ['/Users/me/app needs review', '/model\nexplain this file', ' /model', '/9start', 'hello', '']) {
    assert.equal(slashCommandText(text), null, text);
  }
});

test('first render without a snapshot shows loading', () => {
  const container = { innerHTML: '' };
  render(container, undefined);
  assert.match(container.innerHTML, /正在读取对话/);
});

test('a missing transcript does not claim the conversation is empty', () => {
  const container = { innerHTML: '' };
  render(container, { supported: true, ready: false, notFound: true, messages: [] });
  assert.match(container.innerHTML, /暂时未找到.*正在重试/);
  assert.doesNotMatch(container.innerHTML, /还没有对话/);
  render(container, { supported: true, ready: true, messages: [] });
  assert.match(container.innerHTML, /还没有对话记录/);
});

test('an unbound native chat explains automatic binding retries', () => {
  const container = { innerHTML: '' };
  render(container, { supported: true, ready: false, notFound: true, unbound: true, messages: [] });
  assert.match(container.innerHTML, /正在关联.*自动重试/);
  assert.doesNotMatch(container.innerHTML, /请切到终端|还没有对话/);
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

test('chat-capable session with transcript still defaults to the terminal', () => {
  assert.equal(chooseSessionViewMode({ chatCapable: true, pref: null, hasMessages: true }), 'terminal');
  assert.equal(chooseSessionViewMode({ chatCapable: true, pref: 'terminal', hasMessages: true }), 'terminal');
});

test('explicit view preference wins over transcript presence', () => {
  assert.equal(chooseSessionViewMode({ chatCapable: true, pref: 'chat', hasMessages: false }), 'chat');
  assert.equal(chooseSessionViewMode({ chatCapable: true, pref: 'terminal', hasMessages: true }), 'terminal');
});

test('unsupported clis never open native chat', () => {
  assert.equal(chooseSessionViewMode({ chatCapable: false, pref: 'chat', hasMessages: true }), 'terminal');
});

test('assistant text renders markdown structure while user text stays literal', () => {
  const container = { innerHTML: '' };
  render(container, { supported: true, messages: [
    { id: 'md', role: 'assistant', blocks: [{ type: 'text', text: '## 计划\n使用 **粗体** 与 `npm test` 以及 *斜体*。\n\n- 第一项\n- 第二项\n\n1. 甲\n2. 乙\n\n> 引用内容\n\n---\n看 https://example.com/x?a=1&b=2' }] },
    { id: 'u', role: 'user', blocks: [{ type: 'text', text: '**不渲染** 的 # 原文' }] },
  ] });
  const html = container.innerHTML;
  assert.match(html, /native-chat-heading-2[^>]*>计划/);
  assert.match(html, /<strong>粗体<\/strong>/);
  assert.match(html, /native-chat-icode[^>]*>npm test/);
  assert.match(html, /<em>斜体<\/em>/);
  assert.match(html, /<ul class="native-chat-list"><li>第一项<\/li><li>第二项<\/li><\/ul>/);
  assert.match(html, /<ol class="native-chat-list"><li>甲<\/li><li>乙<\/li><\/ol>/);
  assert.match(html, /native-chat-quote[^>]*>引用内容/);
  assert.match(html, /native-chat-hr/);
  assert.match(html, /href="https:\/\/example.com\/x\?a=1&amp;b=2"/);
  assert.match(html, /\*\*不渲染\*\*/);
  assert.ok(!html.includes('<strong>不渲染'), 'user text must not be markdown-rendered');
});

test('markdown emphasis is line-bounded and cannot inject html', () => {
  const html = renderText('**<b>x</b>** 和 *斜体*\n跨行 ** 未闭合', true);
  assert.doesNotMatch(html, /<b>/);
  assert.match(html, /<strong>&lt;b&gt;x&lt;\/b&gt;<\/strong>/);
  assert.match(html, /<em>斜体<\/em>/);
  assert.match(html, /\*\* 未闭合/, 'unbalanced marker stays literal');
  // 下划线不参与强调：路径与标识符不被误判。
  const snake = renderText('读取 some_var_name 的值', true);
  assert.match(snake, /some_var_name/);
  assert.ok(!snake.includes('<em>'), 'underscores must not emphasize');
});

test('reasoning messages collapse by default with a length summary', () => {
  const container = { innerHTML: '' };
  render(container, { supported: true, messages: [
    { id: 'r', role: 'reasoning', blocks: [{ type: 'text', text: '推理'.repeat(20) }] },
  ] });
  assert.match(container.innerHTML,
    /<details class="native-chat-reasoning-box"><summary>思考过程 · 40 字<\/summary>/);
  assert.match(container.innerHTML, /推理/);
});

test('text messages expose copy-full-message and plain text extraction skips tools', () => {
  assert.equal(messagePlainText({
    blocks: [{ type: 'text', text: 'a' }, { type: 'tool-call', input: { x: 1 } }, { type: 'text', text: 'b' }],
  }), 'a\n\nb');
  assert.equal(messagePlainText({ blocks: [{ type: 'tool-result', output: 'hidden' }] }), '');
  const container = { innerHTML: '' };
  render(container, { supported: true, messages: [
    { id: 't', role: 'assistant', blocks: [{ type: 'text', text: '正文' }] },
    { id: 'tool-only', role: 'assistant', blocks: [{ type: 'tool-result', output: 'x' }] },
  ] });
  assert.equal((container.innerHTML.match(/native-chat-copy-msg/g) || []).length, 1,
    'only messages with text get the copy button');
});

test('message meta shows the date for messages from previous days', () => {
  const now = new Date('2026-09-30T10:00:00').getTime();
  assert.equal(formatMessageTime(new Date('2026-09-30T08:05:00').getTime(), now), '08:05');
  assert.equal(formatMessageTime(new Date('2026-09-28T14:03:00').getTime(), now), '09-28 14:03');
  assert.equal(formatMessageTime(undefined, now), '');
  const container = { innerHTML: '' };
  render(container, { supported: true, messages: [
    { id: 'd', role: 'user', timestamp: new Date('2026-09-28T14:03:00').getTime(), blocks: [{ type: 'text', text: '早前的消息' }] },
  ] });
  assert.match(container.innerHTML, /09-28 14:03/);
});

const toolCall = (id, name, input = {}, state) => ({ type: 'tool-call', name, input, callId: id, ...(state ? { state } : {}) });
const toolResult = (id, output, isError = false) => ({ type: 'tool-result', callId: id, output, ...(isError ? { isError: true } : {}) });

test('consecutive process messages collapse into one expandable task group', () => {
  const container = { innerHTML: '' };
  render(container, { supported: true, messages: [
    { id: 'u', role: 'user', blocks: [{ type: 'text', text: '跑一下构建' }] },
    { id: 'c1', role: 'assistant', blocks: [toolCall('k1', 'shell', { command: 'npm test' })] },
    { id: 'r1', role: 'tool', blocks: [toolResult('k1', 'ok')] },
    { id: 'c2', role: 'assistant', blocks: [toolCall('k2', 'read', { path: 'a.ts' })] },
    { id: 'r2', role: 'tool', blocks: [toolResult('k2', 'content')] },
    { id: 'a', role: 'assistant', blocks: [{ type: 'text', text: '全部通过。' }] },
  ] });
  const html = container.innerHTML;
  assert.match(html, /<details class="native-chat-tool-group"><summary><span class="native-chat-tool-name">执行任务<\/span><span class="native-chat-tool-count">2 个<\/span>/);
  assert.match(html, /state-completed">已完成<\/span>/);
  // 调用与输出按 callId 配对成单条，而不是 4 个碎胶囊。
  assert.equal((html.match(/native-chat-tool-items/g) || []).length, 1);
  assert.equal((html.match(/<details class="native-chat-tool">/g) || []).length, 2);
  assert.match(html, /npm test[\s\S]*—— 输出 ——[\s\S]*ok/);
  assert.doesNotMatch(html, /<details class="native-chat-tool">[\s\S]*结果 k/);
});

test('a text message between tool messages splits the groups', () => {
  const items = buildChatRenderItems([
    { id: 'c1', role: 'assistant', blocks: [toolCall('k1', 'shell')] },
    { id: 'c2', role: 'assistant', blocks: [toolCall('k2', 'read')] },
    { id: 'a', role: 'assistant', blocks: [{ type: 'text', text: '中间结论' }] },
    { id: 'c3', role: 'assistant', blocks: [toolCall('k3', 'shell')] },
    { id: 'c4', role: 'assistant', blocks: [toolCall('k4', 'read')] },
  ]);
  assert.deepEqual(items.map(item => item.kind), ['tool-group', 'message', 'tool-group']);
  assert.equal(items[0].messages.length, 2);
  assert.equal(items[2].messages.length, 2);
  // 单条不成组：退回普通消息渲染，不多包一层。
  const lone = buildChatRenderItems([
    { id: 'c1', role: 'assistant', blocks: [toolCall('k1', 'shell')] },
  ]);
  assert.deepEqual(lone.map(item => item.kind), ['message']);
});

test('tool group aggregates running and failed states', () => {
  const container = { innerHTML: '' };
  render(container, { supported: true, messages: [
    { id: 'c1', role: 'assistant', blocks: [toolCall('k1', 'shell', { command: 'ls' })] },
    { id: 'c2', role: 'assistant', blocks: [toolCall('k2', 'shell')] },
    { id: 'r2', role: 'tool', blocks: [toolResult('k2', 'boom', true)] },
  ] });
  // 两个徽标都在组摘要里：进行中不掩盖失败。
  const html = container.innerHTML;
  const groupSummary = html.slice(html.indexOf('native-chat-tool-group'), html.indexOf('</summary>'));
  assert.match(groupSummary, /进行中[\s\S]*?1 个失败/);
  assert.match(html, /native-chat-tool-error/);
  // 未匹配 callId 的结果独立成项，不丢内容。
  const pairs = pairToolGroupBlocks([
    { blocks: [toolCall('k1', 'a')] },
    { blocks: [toolResult('unknown', '孤儿输出')] },
  ]);
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0].result, null);
  assert.equal(pairs[1].call, null);
});

test('assistant messages that mix text and tools are not grouped away', () => {
  const items = buildChatRenderItems([
    { id: 'm1', role: 'assistant', blocks: [{ type: 'text', text: '先看文件' }, toolCall('k1', 'read')] },
    { id: 'm2', role: 'assistant', blocks: [toolCall('k2', 'read')] },
  ]);
  // m1 有正文，按普通消息渲染；m2 单条不成组。
  assert.deepEqual(items.map(item => item.kind), ['message', 'message']);
});

test('tool group reuse keeps one group when polling appends more process messages', () => {
  const container = { innerHTML: '' };
  render(container, { supported: true, messages: [
    { id: 'c1', role: 'assistant', blocks: [toolCall('k1', 'shell')] },
  ] });
  const withResult = [
    { id: 'c1', role: 'assistant', blocks: [toolCall('k1', 'shell')] },
    { id: 'r1', role: 'tool', blocks: [toolResult('k1', 'ok')] },
    { id: 'c2', role: 'assistant', blocks: [toolCall('k2', 'shell')] },
    { id: 'r2', role: 'tool', blocks: [toolResult('k2', 'done')] },
  ];
  const items = buildChatRenderItems(withResult);
  assert.equal(items.length, 1);
  assert.equal(items[0].messages.length, 4);
  render(container, { supported: true, messages: withResult });
  assert.match(container.innerHTML, /2 个/);
  assert.equal((container.innerHTML.match(/native-chat-tool-group/g) || []).length >= 1, true);
});
