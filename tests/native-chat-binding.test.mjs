import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { resolveSessionId } from '../dist/main/session-resume.js';
import { PtyManager } from '../dist/main/pty-manager.js';

test('chat binds live Codex histories despite lsof mount warnings and follows thread changes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duocli-chat-binding-'));
  const locks = path.join(root, 'thread-writer-locks');
  const sessions = path.join(root, 'sessions');
  fs.mkdirSync(locks);
  fs.mkdirSync(sessions);
  const writeTranscript = (id, text) => fs.writeFileSync(path.join(sessions, `${id}.jsonl`), [
    { type: 'event_msg', payload: { type: 'user_message', message: `question ${text}` } },
    { type: 'event_msg', payload: { type: 'agent_message', message: `answer ${text}` } },
  ].map(record => JSON.stringify(record)).join('\n') + '\n');
  for (const id of ['live-a', 'live-b', 'old-a', 'next-a']) {
    writeTranscript(id, id);
    fs.utimesSync(path.join(sessions, `${id}.jsonl`), 1000, 1000);
  }
  let currentA = 'live-a';
  let failureStatus = 1;
  let failureSignal = null;
  let extraOwner = '';
  const original = childProcess.execFileSync;
  t.mock.method(childProcess, 'execFileSync', (file, args, options) => {
    if (path.basename(file) === 'ps') return '101 1\n111 101\n201 1\n211 201\n999 1\n';
    if (path.basename(file) === 'lsof') {
      assert.ok(args.includes('-a'), 'combine directory and process restrictions');
      assert.ok(!args.includes('+D'), 'do not recursively scan the lock cache or mounted filesystems');
      assert.ok(args.includes('-b'), 'avoid blocking stat/readlink calls on mounted volumes');
      const pids = args[args.indexOf('-p') + 1].split(',');
      assert.ok(!pids.includes('999'), 'do not scan another app');
      assert.ok(!(pids.includes('111') && pids.includes('211')), 'scan only one PTY tree');
      // Like a mounted Time Machine volume warning: stdout is valid even
      // though the command reports exit 1. An unrelated app must stay excluded.
      const stdout = `p111\nn${locks}/${currentA}.lock\nn${root}/unrelated.lock\nn${locks}/.coordination.lock\np211\nn${locks}/live-b.lock\np999\nn${locks}/other-app.lock\n${extraOwner}`;
      throw Object.assign(new Error('cannot stat mounted filesystem'), {
        status: failureStatus, signal: failureSignal, stdout,
      });
    }
    return original(file, args, options);
  });
  const resolve = pid => resolveSessionId('codex', root, Date.now(), 'codex', pid, { CODEX_HOME: root });
  assert.equal(resolve(101)?.sessionId, 'live-a');
  assert.equal(resolve(201)?.sessionId, 'live-b');
  assert.equal(resolve(301), null, 'never select another PTY or app');
  failureStatus = 2;
  assert.equal(resolve(101), null, 'other command failures stay closed');
  failureStatus = 1;
  failureSignal = 'SIGTERM';
  assert.equal(resolve(101), null, 'timed out output is not accepted');
  failureSignal = null;
  extraOwner = `p111\nn${locks}/ambiguous.lock\n`;
  assert.equal(resolve(101), null, 'multiple threads belonging to one PTY are ambiguous');
  extraOwner = '';

  process.env.DUOCLI_REMOTE_PORT = '0';
  process.env.DUOCLI_REMOTE_HOST = '127.0.0.1';
  process.env.DUOCLI_REMOTE_CONFIG_DIR = root;
  const { startRemoteServer } = await import('../dist/main/remote-server.js');
  const manager = new PtyManager({ onData() {}, onTitleUpdate() {}, onExit() {} });
  for (const [id, pid] of [['a', 101], ['b', 201]]) {
    manager.sessions.set(id, { id, cliKind: 'codex', cwd: root, createdAt: Date.now(),
      presetCommand: 'codex', resumeId: id === 'a' ? 'old-a' : null,
      ptyProcess: { pid }, cliStorageEnv: { CODEX_HOME: root }, submissions: new Map() });
  }
  let server;
  const info = await new Promise(resolve => { server = startRemoteServer(manager, undefined, undefined, resolve); });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const chat = async (id, query = '') => (await fetch(`http://127.0.0.1:${info.port}/api/sessions/${id}/chat${query}`, {
    headers: { Authorization: `Bearer ${info.token}` },
  })).json();
  const first = await chat('a');
  assert.equal(first.ready, true);
  assert.equal(first.sessionId, 'live-a', 'replace an old binding even when its transcript exists');
  assert.equal(first.totalMessages, 2);
  assert.equal(first.messages.at(-1).blocks[0].text, 'answer live-a');
  const second = await chat('b');
  assert.equal(second.sessionId, 'live-b', 'recover an unbound running terminal');
  assert.equal(second.messages.at(-1).blocks[0].text, 'answer live-b');
  currentA = 'next-a';
  manager.getSession('a').resumeLookupAt = Date.now() - 8001;
  const changed = await chat('a', `?revision=${encodeURIComponent(first.revision)}`);
  assert.notEqual(changed.revision, first.revision, 'equal file size and mtime cannot hide a thread change');
  assert.equal(changed.sessionId, 'next-a');
  assert.equal(changed.messages.at(-1).blocks[0].text, 'answer next-a');
  assert.equal((await chat('b')).sessionId, 'live-b', 'thread changes never cross terminals');
});
