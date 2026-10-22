import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TerminalState } = require('../dist/main/terminal-state.js');
const { readLogicalScrollback } = require('../dist/main/terminal-history.js');
const write = (state, data) => new Promise(resolve => state.write(data, resolve));
const resize = async (state, cols, rows) => {
  state.resize(cols, rows);
  await state.snapshot(() => {});
};
const welcome = [
  'Claude Code v2.1.165',
  'deepseek-ai/DeepSeek-V4-Pro with max effort',
  'API Usage Billing',
  '~/AITrendAPP',
  '',
  '1 setup issue: MCP /doctor',
  '> /model',
  'Set model to deepseek-ai/DeepSeek-V4-Flash and saved as your default for new sessions',
  ...Array.from({ length: 42 }, (_, i) => `output-${i}: ${'content '.repeat(10)}`),
];

test('desktop-to-phone reflow keeps one Claude welcome and one model command in history', async t => {
  const state = new TerminalState();
  t.after(() => state.dispose());
  await resize(state, 100, 24);
  await write(state, welcome.join('\r\n') + '\r\n');
  const before = state.history.getLines();
  await resize(state, 30, 10);
  const after = state.history.getLines();
  assert.equal(after.filter(line => line.text === welcome[0]).length, 1);
  assert.equal(after.filter(line => line.text === '> /model').length, 1);
  assert.deepEqual(after.slice(0, before.length).map(line => line.lineId), before.map(line => line.lineId));
  assert.deepEqual(after.map(line => line.text), readLogicalScrollback(state.terminal.buffer.normal).map(line => line.text));
});

test('archived rows returning to the live screen keep their IDs across repeated resizes and later output', async t => {
  const state = new TerminalState();
  t.after(() => state.dispose());
  await resize(state, 100, 24);
  await write(state, welcome.join('\r\n') + '\r\n');
  await resize(state, 30, 10);
  const archivedIds = state.history.getLines().map(line => line.lineId);
  for (const [cols, rows] of [[100, 40], [30, 10], [100, 24], [30, 10]]) {
    await resize(state, cols, rows);
    assert.deepEqual(state.history.getLines().map(line => line.lineId), archivedIds);
  }
  await resize(state, 100, 40);
  await write(state, Array.from({ length: 80 }, (_, i) => `later-${i}\r\n`).join(''));
  const lines = state.history.getLines();
  assert.deepEqual(lines.slice(0, archivedIds.length).map(line => line.lineId), archivedIds);
  assert.equal(lines.filter(line => line.text === welcome[0]).length, 1);
  assert.equal(lines.filter(line => line.text === '> /model').length, 1);
  assert.equal(lines.filter(line => line.text === 'later-0').length, 1);
  const native = readLogicalScrollback(state.terminal.buffer.normal).map(line => line.text);
  assert.deepEqual(lines.slice(-native.length).map(line => line.text), native);
});
