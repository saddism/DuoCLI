import test from 'node:test';
import assert from 'node:assert/strict';
import { NetworkHandoffStore } from '../dist/main/network-handoff.js';

test('handoff tickets are bound to the access token, single use, and retain the submission id', () => {
  const store = new NetworkHandoffStore();
  const state = { sessionId: 'a', draft: '未发出的草稿', pendingSubmission: { id: 'same-send-id', text: '未确认的消息' } };
  const ticket = store.put('secret', state);
  assert.equal(store.take('different', ticket), null);
  assert.deepEqual(store.take('secret', ticket), state);
  assert.equal(store.take('secret', ticket), null);
});

test('expired tickets cannot restore stale state, and abandoned tickets are bounded', () => {
  let now = 1000;
  const store = new NetworkHandoffStore(() => now);
  const ticket = store.put('secret', { draft: 'old' });
  now += 120_000;
  assert.equal(store.take('secret', ticket), null);
  for (let i = 0; i < 16; i++) store.put('secret', { draft: String(i) });
  assert.throws(() => store.put('secret', {}), /Too many/);
  now += 120_000;
  assert.doesNotThrow(() => store.put('secret', {}));
  assert.throws(() => store.put('secret', { draft: 'a'.repeat(2 * 1024 * 1024) }), /Invalid/);
});
