import assert from 'node:assert/strict';
import test from 'node:test';
import { isTransientTerminalOutput, resolveSessionUiStatus } from '../dist/main/session-status.js';

test('session status: green while running, yellow only if stopped and unseen', () => {
  assert.equal(resolveSessionUiStatus('running'), 'running');
  assert.equal(resolveSessionUiStatus('idle'), 'idle');
  assert.equal(resolveSessionUiStatus('inactive'), 'inactive');
  assert.equal(resolveSessionUiStatus(undefined), 'inactive');
  assert.equal(resolveSessionUiStatus('idle', { viewing: true }), 'inactive');
  assert.equal(resolveSessionUiStatus('running', { viewing: true }), 'running');
  assert.equal(resolveSessionUiStatus('idle', { exited: true }), 'exited');
  assert.equal(resolveSessionUiStatus(undefined, { exited: true }), 'exited');
});

test('resize and cursor sequences are not treated as running output', () => {
  assert.equal(isTransientTerminalOutput('\x1b[8;24;80t'), true);
  assert.equal(isTransientTerminalOutput('\x1b[?25h\x1b[0m'), true);
  assert.equal(isTransientTerminalOutput('\x1b[2J\x1b[H'), true);
  assert.equal(isTransientTerminalOutput(''), true);
  assert.equal(isTransientTerminalOutput('Thinking...\n'), false);
  assert.equal(isTransientTerminalOutput('\x1b[32mhello\x1b[0m'), false);
});
