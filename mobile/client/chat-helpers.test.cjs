const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ensureApiSuccess,
  getResumeAgentLabel,
  mergePendingMessages,
} = require('./chat-helpers.js');

test('mergePendingMessages keeps optimistic user bubble until history catches up', () => {
  const history = [
    { role: 'assistant', content: '旧回复' },
  ];
  const pending = [
    { role: 'user', content: '刚发出去的消息', timestamp: '2026-04-13T21:00:00+08:00' },
  ];

  const result = mergePendingMessages(history, pending);

  assert.equal(result.messages.length, 2);
  assert.deepEqual(result.messages[1], pending[0]);
  assert.deepEqual(result.pendingMessages, pending);
});

test('mergePendingMessages removes optimistic user bubble after history contains it', () => {
  const history = [
    { role: 'user', content: '刚发出去的消息' },
    { role: 'assistant', content: '已收到' },
  ];
  const pending = [
    { role: 'user', content: '刚发出去的消息', timestamp: '2026-04-13T21:00:00+08:00' },
  ];

  const result = mergePendingMessages(history, pending);

  assert.equal(result.messages.length, 2);
  assert.deepEqual(result.pendingMessages, []);
});

test('ensureApiSuccess throws backend error message on non-2xx responses', () => {
  assert.throws(
    () => ensureApiSuccess(false, 500, { error: 'connect ECONNREFUSED 127.0.0.1:9820' }),
    /ECONNREFUSED/
  );
});

test('getResumeAgentLabel renders native resume session agents', () => {
  assert.equal(getResumeAgentLabel('claude'), 'Claude Code');
  assert.equal(getResumeAgentLabel('codex'), 'Codex');
  assert.equal(getResumeAgentLabel('copilot'), 'GitHub Copilot');
  assert.equal(getResumeAgentLabel('unknown'), 'Agent');
});
