import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { TerminalState } = require('../dist/main/terminal-state.js');
const { readLogicalScrollback } = require('../dist/main/terminal-history.js');
const write = (state, data) => new Promise(resolve => state.write(data, resolve));
const snapshot = async state => { let result; await state.snapshot(value => { result = value; }); return result; };

test('live writes only scan the newly archived tail, not all old cells', async () => {
  const state = new TerminalState();
  try {
    await write(state, Array.from({ length: 800 }, (_, i) => `line-${i}\r\n`).join(''));
    let fullScans = 0;
    const full = state.history.syncFromBuffer.bind(state.history);
    state.history.syncFromBuffer = buffer => { fullScans++; return full(buffer); };
    for (let i = 0; i < 20; i++) await write(state, `new-${i}\r\n`);
    assert.equal(fullScans, 0);
    const expected = readLogicalScrollback(state.terminal.buffer.normal).map(line => line.text);
    assert.deepEqual(state.history.getLines().slice(-expected.length).map(line => line.text), expected);
    const before = state.history.count;
    await write(state, '\rworking\rworking');
    assert.equal(fullScans, 0);
    assert.equal(state.history.count, before);
  } finally { state.dispose(); }
});

test('identical output rows are not lost when the xterm ring buffer is full', async () => {
  const state = new TerminalState();
  try {
    state.terminal.options.scrollback = 8;
    state.resize(80, 4);
    for (let i = 0; i < 25; i++) await write(state, 'same\r\n');
    assert.equal(state.history.count, 22);
    assert.equal(state.history.getLines().filter(line => line.text === 'same').length, 22);
    const page = await state.historyBefore({ limitRows: 80 });
    assert.equal(page.items.length, 22);
    assert.equal(new Set(page.items.map(line => line.lineId)).size, 22);
  } finally { state.dispose(); }
});

test('a wrapped logical line grows without duplicating its archived prefix', async () => {
  const state = new TerminalState();
  try {
    state.resize(10, 3);
    await write(state, '0123456789'.repeat(5));
    const id = state.history.lastLineId;
    await write(state, '0123456789'.repeat(3));
    assert.equal(state.history.lastLineId, id);
    assert.equal(state.history.count, 1);
    const expected = readLogicalScrollback(state.terminal.buffer.normal);
    assert.deepEqual(state.history.getLines().map(line => line.text), expected.map(line => line.text));
  } finally { state.dispose(); }
});

test('resize reconciles history and subsequent output stays ordered', async () => {
  const state = new TerminalState();
  try {
    await write(state, Array.from({ length: 100 }, (_, i) => `${i}:abcdefghijabcdefghij\r\n`).join(''));
    state.resize(20, 24);
    await snapshot(state);
    await write(state, 'after-resize\r\n'.repeat(30));
    const expected = readLogicalScrollback(state.terminal.buffer.normal).map(line => line.text);
    assert.deepEqual(state.history.getLines().slice(-expected.length).map(line => line.text), expected);
    const result = await snapshot(state);
    assert.equal(result.sequence, 2);
    assert.equal(result.cols, 20);
  } finally { state.dispose(); }
});
