import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';

const entry = path.resolve('src/renderer/auto-continue-runtime.ts');
const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const source = result.outputFiles[0].text;
const runtime = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function createState() {
  return {
    enabled: true,
    sending: true,
    runVersion: 1,
    timeoutIds: new Set(),
  };
}

test('cancelling a run prevents its pending callback', async () => {
  const state = createState();
  let called = false;
  runtime.scheduleAutoContinueRunTimeout(state, state.runVersion, () => { called = true; }, 10);

  runtime.cancelAutoContinueRun(state);
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(called, false);
  assert.equal(state.sending, false);
  assert.equal(state.runVersion, 2);
  assert.equal(state.timeoutIds.size, 0);
});

test('a stale run cannot override a newly configured run', async () => {
  const state = createState();
  const calls = [];
  runtime.scheduleAutoContinueRunTimeout(state, state.runVersion, () => calls.push('old'), 15);

  runtime.cancelAutoContinueRun(state);
  state.sending = true;
  runtime.scheduleAutoContinueRunTimeout(state, state.runVersion, () => calls.push('new'), 5);
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(calls, ['new']);
});

test('stored next-run deadline survives reload and invalid data is migrated', () => {
  assert.equal(runtime.resolveNextRunAt(5000, 1000, 2000), 5000);
  assert.equal(runtime.resolveNextRunAt(undefined, 1000, 2000), 3000);
});

test('manual input does not move the first-run deadline', () => {
  assert.equal(runtime.shouldResetAfterManualInput(0, false), false);
  assert.equal(runtime.shouldResetAfterManualInput(1, false), true);
  assert.equal(runtime.shouldResetAfterManualInput(1, true), false);
});
