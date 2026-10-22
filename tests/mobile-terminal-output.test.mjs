import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';

const helpers = createRequire(import.meta.url)('../mobile/client/terminal-scroll-helpers.js');
const source = fs.readFileSync(new URL('../mobile/client/app.js', import.meta.url), 'utf8');
const ast = ts.createSourceFile('app.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function harness() {
  const writes = [];
  const frames = [];
  const context = vm.createContext({
    term: { buffer: { active: { viewportY: 10, baseY: 10 } }, hasSelection: () => false,
      reset() {}, write(data, done) { writes.push(data); queueMicrotask(done); } },
    terminalPendingWrite: null, terminalWriteQueue: Promise.resolve(),
    terminalScrollInteractionRevision: 0, terminalOutputWriteCount: 0,
    terminalTouchActive: false, isUserScrolling: false,
    terminalOpenGeneration: 1, wsConnectionGeneration: 1, pendingRecreateViewport: null,
    terminalSnapshotGeneration: 0, terminalResyncing: false, terminalInputReady: false,
    terminalResizeFrame: null, fitAddon: null, terminalFirstLatestPaint: false,
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
    terminalHistoryLayer: null, terminalScrollHelpers: helpers,
    isAtBottom: () => true, setTerminalUnreadOutput() {}, scrollTerminalToBottom() {},
    scheduleMobileLinkHighlights() {}, setTerminalInputReady: ready => { context.terminalInputReady = ready; },
    setTerminalRevealPending() {}, hideTerminalLoading() {}, jumpTerminalToLatest() {},
    syncTerminalToViewport() {}, rebindMobilePromptMarker() {}, renderMobilePromptBanner() {},
    noteTerminalHistoryMeta() {},
  });
  for (const name of ['writeTerminalOutput', 'restoreTerminalSnapshot', 'revealTerminalAtLatest']) {
    const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(node, name);
    vm.runInContext(node.getText(ast), context);
  }
  return { context, writes, frames };
}

test('output bursts share one parser write without changing byte order or split ANSI sequences', async () => {
  const { context, writes } = harness();
  const chunks = ['\x1b[', '32m', ...Array.from({ length: 200 }, (_, i) => `${i}\r\n`), '\x1b[0m'];
  for (const chunk of chunks) context.writeTerminalOutput(chunk);
  await context.terminalWriteQueue;
  assert.deepEqual(writes, [chunks.join('')]);
  assert.equal(context.terminalOutputWriteCount, 0);
});

test('a snapshot remains a barrier between output batches', async () => {
  const { context, writes } = harness();
  context.writeTerminalOutput('before');
  context.restoreTerminalSnapshot({ data: 'snapshot' });
  context.writeTerminalOutput('after');
  await context.terminalWriteQueue;
  assert.deepEqual(writes, ['before', 'snapshot', 'after']);
});

test('output received during an in-flight parse becomes one next batch', async () => {
  const { context, writes } = harness();
  const callbacks = [];
  context.term.write = (data, done) => { writes.push(data); callbacks.push(done); };
  context.writeTerminalOutput('first');
  await Promise.resolve();
  context.writeTerminalOutput('second');
  context.writeTerminalOutput('third');
  callbacks.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(writes, ['first', 'secondthird']);
  callbacks.shift()();
  await context.terminalWriteQueue;
});

test('queued bytes for an obsolete terminal never reach its replacement', async () => {
  const { context, writes } = harness();
  context.writeTerminalOutput('old');
  context.term = { ...context.term };
  context.writeTerminalOutput('new');
  await context.terminalWriteQueue;
  assert.deepEqual(writes, ['new']);
});

test('reconnecting during snapshot parsing does not leave scrolling permanently classified as output', async () => {
  const { context } = harness();
  let complete;
  context.term.write = (_data, done) => { complete = done; };
  context.restoreTerminalSnapshot({ data: 'old connection snapshot' });
  await Promise.resolve();
  assert.equal(context.terminalOutputWriteCount, 1);
  context.wsConnectionGeneration++;
  complete();
  await context.terminalWriteQueue;
  assert.equal(context.terminalOutputWriteCount, 0);
});

test('an earlier snapshot animation cannot unlock input while the next snapshot is parsing', async () => {
  const { context, frames } = harness();
  context.restoreTerminalSnapshot({ data: 'first' });
  await context.terminalWriteQueue;
  let complete;
  context.term.write = (_data, done) => { complete = done; };
  context.restoreTerminalSnapshot({ data: 'next' });
  await Promise.resolve();
  assert.equal(context.terminalOutputWriteCount, 1);
  while (frames.length) frames.shift()();
  assert.equal(context.terminalInputReady, false);
  complete();
  await context.terminalWriteQueue;
  while (frames.length) frames.shift()();
  assert.equal(context.terminalInputReady, true);
});

test('a snapshot animation cannot dismiss recovery started by a subsequent sequence gap', async () => {
  const { context, frames } = harness();
  context.restoreTerminalSnapshot({ data: 'first' });
  await context.terminalWriteQueue;
  context.terminalResyncing = true;
  context.terminalInputReady = false;
  while (frames.length) frames.shift()();
  assert.equal(context.terminalInputReady, false);
});
