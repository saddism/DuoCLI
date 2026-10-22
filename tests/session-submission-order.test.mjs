import assert from 'node:assert/strict';
import test from 'node:test';
import { PtyManager } from '../dist/main/pty-manager.js';

test('only submitted nonempty terminal input advances conversation order', () => {
  const submitted = [];
  const writes = [];
  const manager = new PtyManager({
    onData() {}, onTitleUpdate() {}, onExit() {},
    onUserSubmitted(id, at) { submitted.push({ id, at }); },
  });
  const session = id => ({
    id, closing: false, currentLine: '', accumulatedInputs: [],
    titleGenerated: true, titleLocked: false, titleSegmentCount: 0,
    autoResponseTimers: new Set(), sizeOwner: 'desktop',
    sizeBySource: { desktop: null, mobile: null, chat: null },
    lastInputAt: { desktop: 0, mobile: 0, chat: 0 },
    createdAt: id === 'old' ? 100 : 200, updatedAt: 0, lastSubmittedAt: 0,
    ptyProcess: { write(data) { writes.push({ id, data }); } },
  });
  const old = session('old');
  const newer = session('newer');
  manager.sessions.set(old.id, old);
  manager.sessions.set(newer.id, newer);

  manager.write('old', '\x1b[A');
  manager.write('old', 'hello');
  assert.equal(old.lastSubmittedAt, 0);
  manager.write('old', '\r');
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].id, 'old');
  assert.equal(old.lastSubmittedAt, submitted[0].at);

  manager.write('old', '\r');
  manager.write('old', '\x1b[0c');
  assert.equal(submitted.length, 1);
  manager.write('newer', '/model', 'mobile');
  manager.write('newer', '\r', 'mobile');
  assert.equal(submitted.length, 2);
  assert.equal(submitted[1].id, 'newer');
  assert.ok(newer.lastSubmittedAt > old.lastSubmittedAt);
  assert.ok(writes.some(entry => entry.id === 'newer' && entry.data === '\r'));
});
