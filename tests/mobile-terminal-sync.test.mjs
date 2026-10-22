import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../mobile/client/app.js', import.meta.url), 'utf8');
const ast = ts.createSourceFile('app.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function harness() {
  const timers = new Map(), sent = [], writes = [];
  let nextTimer = 0;
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSED = 3;
    readyState = 1;
    close() { this.readyState = 3; }
  }
  const context = vm.createContext({
    WebSocket: Socket, term: {}, pendingRecreateViewport: null, isUserScrolling: false,
    terminalSequence: 10, terminalResyncing: false, terminalInputReady: true,
    wsConnectionGeneration: 0, wsConnectTimeoutTimer: null, wsReplayRetryTimer: null,
    wsReconnectTimer: null, wsReplayRetryCount: 0, pendingSubmissions: new Map(),
    terminalOpenGeneration: 1, terminalSnapshotGeneration: 0,
    currentSessionId: 'a', sessionViewMode: 'terminal',
    location: { protocol: 'http:', host: 'fixture' }, token: 'fixture-token',
    navigator: { onLine: true }, document: { hidden: false }, console: { log() {} },
    $: () => ({ classList: { contains: () => false } }),
    getNetworkProfile: () => ({ wsConnectTimeoutMs: 8000 }),
    setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: timer => timers.delete(timer), clearInterval() {},
    cancelTerminalHistoryRequest() {}, closeWebSocket() {}, hideWeakNetworkPrompt() {},
    showWeakNetworkPrompt() {}, hideTerminalLoading() {}, setTerminalRevealPending() {},
    noteTerminalHistoryMeta() {}, applyTerminalSnapshotGeometry() {},
    restoreTerminalSnapshot() { context.terminalInputReady = true; },
    interceptSpinnerData: data => data, writeTerminalOutput: data => writes.push(data),
    setTerminalInputReady: ready => { context.terminalInputReady = ready; },
    wsSend: data => sent.push(data),
  });
  const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'connectWebSocket');
  vm.runInContext(node.getText(ast), context);
  context.connectWebSocket('a');
  context.terminalInputReady = true;
  const receive = payload => context.ws.onmessage({ data: JSON.stringify(payload) });
  return { context, timers, sent, writes, receive };
}

test('a sequence gap blocks input and ignores live output until a complete replay arrives', () => {
  const { context, sent, writes, receive } = harness();
  receive({ type: 'output', sequence: 12, data: 'gap' });
  assert.equal(context.terminalInputReady, false);
  assert.equal(context.terminalResyncing, true);
  assert.equal(sent.at(-1).type, 'subscribe');
  receive({ type: 'output', sequence: 11, data: 'late missing output' });
  assert.equal(context.terminalSequence, 10);
  assert.equal(context.terminalInputReady, false);
  assert.deepEqual(writes, []);
  receive({ type: 'replay', sequence: 12, data: '' });
  assert.equal(context.terminalSequence, 12);
  assert.equal(context.terminalInputReady, true);
  assert.equal(context.wsReplayRetryTimer, null);
});

test('a missing gap-recovery replay closes its exact socket so normal reconnect can retry', () => {
  const { context, timers, receive } = harness();
  receive({ type: 'output', sequence: 12, data: 'gap' });
  assert.ok(context.wsReplayRetryTimer);
  timers.get(context.wsReplayRetryTimer)();
  assert.equal(context.ws.readyState, 3);
});
