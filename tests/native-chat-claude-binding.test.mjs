import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { resolveSessionId } from '../dist/main/session-resume.js';
import { PtyManager } from '../dist/main/pty-manager.js';

test('Claude continued/restored chats bind to their live PID registry and follow conversation changes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duocli-claude-binding-'));
  const registry = path.join(root, 'sessions');
  const project = path.join(root, 'projects', root.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(registry);
  fs.mkdirSync(project, { recursive: true });
  const createdAt = Date.now();
  const firstId = '11111111-1111-4111-8111-111111111111';
  const nextId = '22222222-2222-4222-8222-222222222222';
  const otherId = '33333333-3333-4333-8333-333333333333';
  const record = (pid, sessionId, extra = {}) => ({ pid, sessionId, cwd: root,
    startedAt: createdAt, kind: 'interactive', ...extra });
  const register = value => fs.writeFileSync(path.join(registry, `${value.pid}.json`), JSON.stringify(value));
  register(record(111, firstId));
  register(record(211, otherId)); // A different PTY in the very same directory.
  register(record(999, otherId)); // An unrelated application.
  const original = childProcess.execFileSync;
  t.mock.method(childProcess, 'execFileSync', (file, args, options) => {
    if (path.basename(file) === 'ps') return '101 1\n111 101\n201 1\n211 201\n999 1\n';
    return original(file, args, options);
  });
  const resolve = pid => resolveSessionId('claude', root, createdAt, 'claude --continue', pid, { CLAUDE_CONFIG_DIR: root });
  assert.equal(resolve(101)?.sessionId, firstId);
  assert.equal(resolve(201)?.sessionId, otherId);
  assert.equal(resolve(301), null, 'never choose the latest file in the same cwd');
  for (const extra of [{ pid: 112 }, { cwd: '/different-project' }, { startedAt: createdAt - 6000 },
    { startedAt: Date.now() + 60000 }, { kind: 'bg' }, { sessionId: '../wrong-id' }]) {
    fs.writeFileSync(path.join(registry, '111.json'), JSON.stringify(record(111, firstId, extra)));
    assert.equal(resolve(101), null, JSON.stringify(extra));
  }
  fs.writeFileSync(path.join(registry, '111.json'), '{partial');
  assert.equal(resolve(101), null, 'a registry rewrite retries without selecting another terminal');
  register(record(111, firstId));
  for (const id of [firstId, nextId, otherId]) {
    fs.writeFileSync(path.join(project, `${id}.jsonl`), [
      { type: 'user', uuid: `${id}-user`, parentUuid: null, message: { content: `question ${id}` } },
      { type: 'assistant', uuid: `${id}-answer`, parentUuid: `${id}-user`, message: { content: `answer ${id}` } },
    ].map(JSON.stringify).join('\n') + '\n');
  }
  process.env.DUOCLI_REMOTE_PORT = '0';
  process.env.DUOCLI_REMOTE_HOST = '127.0.0.1';
  process.env.DUOCLI_REMOTE_CONFIG_DIR = root;
  const { startRemoteServer } = await import('../dist/main/remote-server.js');
  const manager = new PtyManager({ onData() {}, onTitleUpdate() {}, onExit() {} });
  for (const [id, pid, resumeId] of [['a', 101, otherId], ['b', 201, null]]) {
    manager.sessions.set(id, { id, cliKind: 'claude', cwd: root, createdAt,
      presetCommand: 'claude --continue', resumeId, ptyProcess: { pid },
      cliStorageEnv: { CLAUDE_CONFIG_DIR: root }, submissions: new Map() });
  }
  let server;
  const info = await new Promise(resolve => { server = startRemoteServer(manager, undefined, undefined, resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const chat = async id => (await fetch(`http://127.0.0.1:${info.port}/api/sessions/${id}/chat`, {
    headers: { Authorization: `Bearer ${info.token}` },
  })).json();
  const first = await chat('a');
  assert.equal(first.ready, true);
  assert.equal(first.sessionId, firstId, 'replace a stale binding even when its old transcript exists');
  assert.equal(first.totalMessages, 2);
  assert.equal(first.messages.at(-1).blocks[0].text, `answer ${firstId}`);
  assert.equal((await chat('b')).sessionId, otherId);
  register(record(111, nextId));
  manager.getSession('a').resumeLookupAt = Date.now() - 8001;
  const next = await chat('a');
  assert.equal(next.sessionId, nextId, '/clear and /resume update the live PID registration');
  assert.equal(next.messages.at(-1).blocks[0].text, `answer ${nextId}`);
  assert.notEqual(next.revision, first.revision);
  assert.equal((await chat('b')).sessionId, otherId, 'conversation changes never cross PTYs');
});
