import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Parse the shipped function, rather than maintaining a second implementation.
const source = fs.readFileSync(new URL('../mobile/client/app.js', import.meta.url), 'utf8');
const ast = ts.createSourceFile('app.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'revealTerminalAtLatest');
assert.ok(declaration, 'mobile reveal function must exist');
function harness() {
  const frames = [];
  const counts = { fit: 0, resize: 0, jumps: 0, hides: 0, reveal: [], inputReady: [] };
  const context = vm.createContext({
    terminalOpenGeneration: 1, wsConnectionGeneration: 1, terminalScrollInteractionRevision: 1,
    terminalSnapshotGeneration: 0, terminalResyncing: false,
    terminalTouchActive: false, isUserScrolling: false, terminalFirstLatestPaint: false,
    terminalResizeFrame: null, lastTerminalSize: '',
    term: { cols: 43, rows: 33 },
    terminalHistoryLayer: { isVisible: () => false },
    fitAddon: { fit: () => counts.fit++ },
    fitTerminalToVisibleBox: (_term, addon) => addon.fit(),
    handleResize: () => counts.resize++,
    jumpTerminalToLatest: () => counts.jumps++,
    setTerminalRevealPending: value => counts.reveal.push(value),
    setTerminalInputReady: value => counts.inputReady.push(value),
    hideTerminalLoading: () => counts.hides++,
    $: () => ({ clientWidth: 390, clientHeight: 600 }),
    requestAnimationFrame: fn => { frames.push(fn); return frames.length; },
    cancelAnimationFrame() {},
  });
  vm.runInContext(declaration.getText(ast), context);
  const flush = () => { while (frames.length) frames.shift()(); };
  return { context, counts, flush };
}

test('mobile reveal preserves geometry already acknowledged by the backend', () => {
  const { context, counts, flush } = harness();
  context.revealTerminalAtLatest(context.term, true, true); flush();
  assert.equal(counts.fit, 0, 'an acknowledged geometry must not be silently fitted again');
  assert.equal(counts.hides, 1);
  assert.deepEqual(counts.inputReady, [true]);
});

test('an upward user gesture wins over every delayed reveal frame', () => {
  const { context, counts, flush } = harness();
  context.revealTerminalAtLatest(context.term, true);
  const before = counts.jumps;
  context.terminalScrollInteractionRevision++;
  context.isUserScrolling = true;
  flush();
  assert.equal(counts.jumps, before, 'a queued frame must not override a newer user gesture');
  assert.equal(counts.hides, 1);
});

test('an obsolete reveal does not hide the loading state of a newer terminal', () => {
  const { context, counts, flush } = harness();
  context.revealTerminalAtLatest(context.term, true);
  context.term = { cols: 42, rows: 32 };
  context.terminalOpenGeneration++;
  flush();
  assert.equal(counts.hides, 0);
  assert.deepEqual(counts.reveal, []);
  assert.deepEqual(counts.inputReady, []);
  assert.equal(context.terminalFirstLatestPaint, false);
});

test('a necessary local fit is followed by a backend resize request', () => {
  const { context, counts, flush } = harness();
  context.revealTerminalAtLatest(context.term, true, false); flush();
  assert.equal(counts.fit, 1);
  assert.equal(counts.resize, 1);
});

function resizeHarness() {
  const callbacks = [], sent = [];
  let clears = 0;
  const dims = { cols: 42, rows: 32 };
  const context = vm.createContext({ term: {}, fitAddon: { proposeDimensions: () => dims },
    resizeSendTimer: null, lastSentCols: 42, lastSentRows: 32,
    ws: { readyState: 1 }, WebSocket: { OPEN: 1 },
    setTimeout: callback => { callbacks.push(callback); return callbacks.length; },
    clearTimeout: () => clears++, wsSend: request => sent.push(request) });
  const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'handleResize');
  assert.ok(node); vm.runInContext(node.getText(ast), context);
  return { context, callbacks, sent, dims, clears: () => clears };
}

test('continuous keyboard layout events cannot starve the resize acknowledgement', () => {
  const { context, callbacks, sent, dims, clears } = resizeHarness();
  for (let rows = 31; rows >= 16; rows--) { dims.rows = rows; context.handleResize(); }
  assert.equal(callbacks.length, 1, 'new layout events must not restart the timer');
  assert.equal(clears(), 0);
  callbacks[0]();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].rows, 16, 'the coalesced request must use the final dimensions');
  assert.equal(context.resizeSendTimer, null);
});

test('resize coalescing does not resend an already acknowledged geometry', () => {
  const { context, callbacks, sent } = resizeHarness();
  context.handleResize(); callbacks[0]();
  assert.equal(sent.length, 0);
});

test('a delayed resize cannot apply to a replacement terminal', () => {
  const { context, callbacks, sent, dims } = resizeHarness();
  dims.rows = 16; context.handleResize(); context.term = {}; callbacks[0]();
  assert.equal(sent.length, 0);
});

function installSnapshot(context) {
  const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'restoreTerminalSnapshot');
  assert.ok(node);
  context.terminalWriteQueue = Promise.resolve();
  context.pendingRecreateViewport = null;
  context.terminalOutputWriteCount = 0;
  vm.runInContext(node.getText(ast), context);
}

test('an obsolete queued snapshot does not dismiss the new session loading state', async () => {
  const { context, counts } = harness(); installSnapshot(context);
  context.restoreTerminalSnapshot({ data: 'OLD' });
  counts.reveal.length = 0;
  context.term = {};
  context.terminalOpenGeneration++;
  await context.terminalWriteQueue;
  assert.deepEqual(counts.reveal, []);
  assert.equal(counts.hides, 0);
});

test('an obsolete parser callback cannot dismiss loading for a newer connection', async () => {
  const { context, counts } = harness(); installSnapshot(context);
  let complete;
  Object.assign(context.term, { buffer: { active: { viewportY: 0 } }, reset() {}, resize() {},
    write(_data, callback) { complete = callback; } });
  context.restoreTerminalSnapshot({ data: 'OLD' });
  await Promise.resolve();
  assert.equal(typeof complete, 'function');
  counts.reveal.length = 0;
  context.wsConnectionGeneration++;
  complete();
  await context.terminalWriteQueue;
  assert.deepEqual(counts.reveal, []);
  assert.equal(counts.hides, 0);
});
