import test from 'node:test';
import assert from 'node:assert/strict';

const {
  DEFAULT_TERMINAL_AUTO_RESPONSE_CONFIG,
  findNewAutoResponseRule,
  normalizeTerminalAutoResponseConfig,
} = await import('../dist/main/terminal-auto-response.js');

test('uses the capacity response rule by default', () => {
  assert.equal(DEFAULT_TERMINAL_AUTO_RESPONSE_CONFIG.enabled, false);
  assert.deepEqual(DEFAULT_TERMINAL_AUTO_RESPONSE_CONFIG.rules, [
    { keyword: 'Selected model is at capacity', response: '继续' },
  ]);
});

test('keeps auto-response off unless the saved config explicitly enables it', () => {
  assert.equal(normalizeTerminalAutoResponseConfig({}).enabled, false);
  assert.equal(normalizeTerminalAutoResponseConfig({ enabled: true }).enabled, true);
});

test('matches a keyword that completes across two new output chunks', () => {
  const [rule] = DEFAULT_TERMINAL_AUTO_RESPONSE_CONFIG.rules;
  assert.equal(findNewAutoResponseRule('Selected model is at ', 'capacity', [rule]), rule);
});

test('does not match a keyword that exists only in previously processed output', () => {
  const [rule] = DEFAULT_TERMINAL_AUTO_RESPONSE_CONFIG.rules;
  assert.equal(findNewAutoResponseRule('Selected model is at capacity', ' — please try later', [rule]), null);
});

test('normalizes unsafe or empty rules before saving', () => {
  const config = normalizeTerminalAutoResponseConfig({
    enabled: false,
    rules: [{ keyword: '  overload  ', response: '  continue  ' }, { keyword: '', response: 'skip' }],
    delaySeconds: -2,
    cooldownSeconds: 999999,
  });
  assert.deepEqual(config, {
    enabled: false,
    rules: [{ keyword: 'overload', response: 'continue' }],
    delaySeconds: 0,
    cooldownSeconds: 3600,
  });
});
