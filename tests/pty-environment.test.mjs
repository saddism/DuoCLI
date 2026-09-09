import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPtyEnvironment } from '../dist/main/pty-manager.js';

test('Cursor PTY does not inherit Cursor Agent memory-only credentials', () => {
  const env = buildPtyEnvironment('cursor', undefined, {
    HOME: '/Users/tester',
    AGENT_CLI_CREDENTIAL_STORE: 'memory',
    PATH: '/bin',
  });

  assert.equal(env.HOME, '/Users/tester');
  assert.equal(env.PATH, '/bin');
  assert.equal(env.AGENT_CLI_CREDENTIAL_STORE, undefined);
});

test('PTY environment keeps explicit credential-store choices and overrides', () => {
  const env = buildPtyEnvironment('cursor', {
    AGENT_CLI_CREDENTIAL_STORE: 'file',
    CURSOR_API_ENDPOINT: 'https://example.test',
  }, {
    AGENT_CLI_CREDENTIAL_STORE: 'memory',
    CURSOR_API_ENDPOINT: '',
  });

  assert.equal(env.AGENT_CLI_CREDENTIAL_STORE, 'file');
  assert.equal(env.CURSOR_API_ENDPOINT, 'https://example.test');
});

test('non-Cursor PTYs keep the inherited credential-store environment', () => {
  const env = buildPtyEnvironment('claude', undefined, {
    AGENT_CLI_CREDENTIAL_STORE: 'memory',
  });

  assert.equal(env.AGENT_CLI_CREDENTIAL_STORE, 'memory');
});
