import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../mobile/client/app.js', import.meta.url), 'utf8');
const ast = ts.createSourceFile('app.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const message = id => ({ id, role: 'assistant', blocks: [{ type: 'text', text: id }] });
const snapshot = (ids, extra = {}) => ({ supported: true, ready: true, paged: true,
  sessionId: 'thread-a', startIndex: 2, totalMessages: 4, hasMore: true,
  messages: ids.map(message), ...extra });

function harness(initial) {
  const statuses = [];
  const scroller = { scrollHeight: 100, scrollTop: 0 };
  const context = vm.createContext({
    currentSessionId: 'a', sessionViewMode: 'chat', sessionViewGeneration: 1,
    chatPollGeneration: 1, chatRefreshRequest: 0, chatRefreshController: null, chatPollFailures: 0,
    chatSnapshots: new Map([['a', initial]]), chatLocalMessages: new Map(), chatOlderLoads: new Set(),
    AbortController, api: async () => {},
    $: id => id === 'chat-transcript' ? scroller : {},
    setChatStatus: (text, state) => statuses.push({ text, state }), renderCurrentChat() {},
    isChatPinnedToBottom: () => false, captureChatScrollAnchor: () => null, restoreChatScrollAnchor() {},
  });
  for (const name of ['refreshNativeChat', 'loadOlderChatMessages']) {
    const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(node, name);
    vm.runInContext(node.getText(ast), context);
  }
  return { context, statuses, scroller };
}

test('a failed older-page response preserves readable messages and reports the error', async () => {
  const initial = snapshot(['a2', 'a3']);
  const { context, statuses } = harness(initial);
  context.api = async () => ({ supported: true, ready: false, notFound: true,
    sessionId: 'thread-a', error: 'transcript unavailable', messages: [] });
  await context.loadOlderChatMessages('a');
  assert.equal(context.chatSnapshots.get('a'), initial);
  assert.equal(statuses.at(-1).state, 'error');
});

test('a late older page cannot roll back the latest revision and total', async () => {
  const initial = snapshot(['a2', 'a3'], { revision: 'r1' });
  const { context } = harness(initial);
  let release;
  context.api = () => new Promise(resolve => { release = resolve; });
  const loading = context.loadOlderChatMessages('a');
  const latest = snapshot(['a2', 'a3', 'a4'], { revision: 'r2', totalMessages: 5 });
  context.chatSnapshots.set('a', latest);
  release(snapshot(['a0', 'a1'], { revision: 'r1', startIndex: 0, hasMore: false }));
  await loading;
  assert.equal(context.chatSnapshots.get('a').revision, 'r2');
  assert.equal(context.chatSnapshots.get('a').totalMessages, 5);
});

test('a page from a previous visit cannot overwrite the status after A to B to A', async () => {
  const initial = snapshot(['a2', 'a3']);
  const { context, statuses } = harness(initial);
  let reject;
  context.api = () => new Promise((_, fail) => { reject = fail; });
  const loading = context.loadOlderChatMessages('a');
  context.sessionViewGeneration += 2;
  context.setChatStatus('new visit', 'success');
  reject(new Error('old visit failed'));
  await loading;
  assert.equal(statuses.at(-1).text, 'new visit');
});

test('rewriting the same native thread discards expanded history from its abandoned branch', async () => {
  const initial = snapshot(['old0', 'old1', 'old2', 'old3'], { startIndex: 0, hasMore: false });
  const { context } = harness(initial);
  context.api = async () => snapshot(['new2', 'new3']);
  await context.refreshNativeChat('a', 1);
  assert.equal(context.chatSnapshots.get('a').messages.map(m => m.id).join(','), 'new2,new3');
  assert.equal(context.chatSnapshots.get('a').startIndex, 2);
});

test('a temporarily missing transcript does not erase an already readable conversation', async () => {
  const initial = snapshot(['a2', 'a3'], { revision: 'r1' });
  const { context, statuses } = harness(initial);
  context.api = async () => ({ supported: true, ready: false, notFound: true,
    sessionId: 'thread-a', error: 'temporarily unavailable', messages: [] });
  await context.refreshNativeChat('a', 1);
  assert.equal(context.chatSnapshots.get('a'), initial);
  assert.equal(statuses.at(-1).state, 'error');
});

test('temporary loss of the native binding keeps this terminal conversation visible', async () => {
  const initial = snapshot(['a2', 'a3'], { revision: 'r1' });
  const { context, statuses } = harness(initial);
  context.api = async () => ({ supported: true, ready: false, notFound: true,
    unbound: true, sessionId: null, messages: [] });
  await context.refreshNativeChat('a', 1);
  assert.equal(context.chatSnapshots.get('a'), initial);
  assert.equal(statuses.at(-1).state, 'error');
});

test('an older page preserves reading moves and live growth made while the request was pending', async () => {
  const initial = snapshot(['a2', 'a3'], { revision: 'r1' });
  const { context, scroller } = harness(initial);
  let release;
  context.api = () => new Promise(resolve => { release = resolve; });
  context.renderCurrentChat = () => { scroller.scrollHeight += 60; };
  const loading = context.loadOlderChatMessages('a');
  scroller.scrollHeight = 140;
  scroller.scrollTop = 30;
  release(snapshot(['a0', 'a1'], { revision: 'r1', startIndex: 0, hasMore: false }));
  await loading;
  assert.equal(scroller.scrollTop, 90);
});
