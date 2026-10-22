import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function harness(env) {
  const calls = [];
  const context = vm.createContext({
    process: { env }, URL, Headers, Request,
    fetch: async (input, init) => {
      calls.push({ input, init });
      return { headers: new Headers({ 'set-cookie': 'dsh-session=fixture; HttpOnly' }) };
    },
  });
  vm.runInContext(fs.readFileSync('dist/main/dsh-tui-auth-preload.js', 'utf8'), context);
  return { calls, fetch: context.fetch };
}

test('DSH authentication cookies are attached only to the configured host origin', async () => {
  const { calls, fetch } = harness({ DSH_URL: 'http://localhost:3080', DSH_TOKEN: 'fixture-token' });
  for (const url of ['https://example.com', 'http://localhost:3080.example.com', 'http://localhost:3081/api']) {
    await fetch(url);
    assert.equal(calls.at(-1).init, undefined);
  }
  assert.equal(calls.length, 3, 'unrelated fetches must not bootstrap DSH authentication');
  await fetch(new URL('http://localhost:3080/api'));
  assert.equal(calls.length, 5);
  assert.equal(calls.at(-1).init.headers.get('cookie'), 'dsh-session=fixture');
  await fetch('https://example.com/after-login');
  assert.equal(calls.at(-1).init, undefined, 'a loaded cookie must not leak to another host');
});

test('DSH preload preserves Request headers and explicit caller cookies', async () => {
  const { calls, fetch } = harness({ DSH_URL: 'http://localhost:3080', DSH_COOKIE: 'dsh-session=fixture' });
  const request = new Request('http://localhost:3080/api', { headers: { authorization: 'Bearer fixture' } });
  await fetch(request);
  assert.equal(calls.at(-1).init.headers.get('authorization'), 'Bearer fixture');
  assert.equal(calls.at(-1).init.headers.get('cookie'), 'dsh-session=fixture');
  await fetch(request, { headers: { cookie: 'caller=fixture' } });
  assert.equal(calls.at(-1).init.headers.get('cookie'), 'caller=fixture');
});
