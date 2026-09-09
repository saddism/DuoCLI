import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLaunchWrite,
  formatPresetEnv,
  matchCustomPreset,
  parsePresetEnv,
  resolvePresetEnv,
} from '../dist/main/preset-env.js';
test('writes export/set into the same terminal before the CLI', () => {
  const env = {
    HTTP_PROXY: 'http://127.0.0.1:39900',
    HTTPS_PROXY: 'http://127.0.0.1:39900',
    http_proxy: 'http://127.0.0.1:39900',
    https_proxy: 'http://127.0.0.1:39900',
  };
  assert.equal(
    buildLaunchWrite('qodercli --dangerously-skip-permissions', env, 'darwin'),
    'export HTTP_PROXY=http://127.0.0.1:39900\rexport HTTPS_PROXY=http://127.0.0.1:39900\rqodercli --dangerously-skip-permissions\r',
  );
  assert.equal(
    buildLaunchWrite('qodercli --dangerously-skip-permissions', env, 'win32'),
    'set HTTP_PROXY=http://127.0.0.1:39900\rset HTTPS_PROXY=http://127.0.0.1:39900\rqodercli --dangerously-skip-permissions\r',
  );
});

test('parses export, set, $env and plain KEY=VALUE proxy snippets', () => {
  const env = parsePresetEnv(`
export HTTP_PROXY=http://127.0.0.1:39900
set HTTPS_PROXY=http://127.0.0.1:39900
$env:ALL_PROXY = "http://127.0.0.1:39900"
# comment
NO_PROXY=localhost,127.0.0.1
`);
  assert.deepEqual(env, {
    HTTP_PROXY: 'http://127.0.0.1:39900',
    HTTPS_PROXY: 'http://127.0.0.1:39900',
    ALL_PROXY: 'http://127.0.0.1:39900',
    NO_PROXY: 'localhost,127.0.0.1',
  });
});

test('round-trips custom preset env text', () => {
  const env = { HTTP_PROXY: 'http://127.0.0.1:39900', HTTPS_PROXY: 'http://127.0.0.1:39900' };
  assert.deepEqual(parsePresetEnv(formatPresetEnv(env)), env);
});

test('matches the auto Qoder preset even when resume flags are appended', () => {
  const presets = [
    { command: 'qodercli', autoFlag: '', env: { HTTP_PROXY: 'skip' } },
    {
      command: 'qodercli',
      autoFlag: '--dangerously-skip-permissions',
      env: { HTTP_PROXY: 'http://127.0.0.1:39900', HTTPS_PROXY: 'http://127.0.0.1:39900' },
    },
  ];
  assert.equal(
    matchCustomPreset(presets, 'qodercli --dangerously-skip-permissions --resume abc')?.env?.HTTP_PROXY,
    'http://127.0.0.1:39900',
  );
  const resolved = resolvePresetEnv(presets, 'qodercli --dangerously-skip-permissions');
  assert.equal(resolved.HTTP_PROXY, 'http://127.0.0.1:39900');
  assert.equal(resolved.http_proxy, 'http://127.0.0.1:39900');
  assert.equal(resolved.HTTPS_PROXY, 'http://127.0.0.1:39900');
  assert.equal(resolved.https_proxy, 'http://127.0.0.1:39900');
});
