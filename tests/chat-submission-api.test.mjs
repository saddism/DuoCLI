import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PtyManager } from '../dist/main/pty-manager.js';

test('chat revision changes when an unchanged transcript gains a submission acknowledgement', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duocli-chat-ack-'));
  process.env.DUOCLI_REMOTE_PORT = '0';
  process.env.DUOCLI_REMOTE_HOST = '127.0.0.1';
  process.env.DUOCLI_REMOTE_CONFIG_DIR = root;
  process.env.CLAUDE_CONFIG_DIR = root;
  const project = path.join(root, 'projects', root.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'fixture-chat.jsonl'), JSON.stringify({
    type: 'user', uuid: 'message-one', timestamp: new Date(2000).toISOString(),
    message: { content: '继续' },
  }) + '\n');
  const { startRemoteServer } = await import('../dist/main/remote-server.js');
  const manager = new PtyManager({ onData() {}, onTitleUpdate() {}, onExit() {} });
  const entry = { text: '继续', createdAt: 1000, phase: 'text' };
  manager.sessions.set('fixture', { id: 'fixture', cliKind: 'claude', resumeId: 'fixture-chat',
    cwd: root, submissions: new Map([['send-one', entry]]) });
  let server;
  const info = await new Promise(resolve => { server = startRemoteServer(manager, undefined, undefined, resolve); });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const endpoint = `http://127.0.0.1:${info.port}/api/sessions/fixture/chat?token=${info.token}`;
  const first = await (await fetch(endpoint)).json();
  assert.equal(first.messages.length, 1);
  assert.equal(first.messages[0].submissionId, undefined);
  entry.phase = 'entered';
  const acknowledged = await (await fetch(`${endpoint}&revision=${encodeURIComponent(first.revision)}`)).json();
  assert.notEqual(acknowledged.revision, first.revision);
  assert.equal(acknowledged.messages[0].submissionId, 'send-one');
  const unchanged = await (await fetch(`${endpoint}&revision=${encodeURIComponent(acknowledged.revision)}`)).json();
  assert.equal(unchanged.unchanged, true);

  await t.test('waits for transcript changes and never renders a partial record', async () => {
    let settled = false;
    const pending = fetch(`${endpoint}&revision=${encodeURIComponent(acknowledged.revision)}&wait=3000`)
      .then(async response => {
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const value = await response.json();
        settled = true;
        return value;
      });
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(settled, false, 'an unchanged revision should keep the request open');
    const record = JSON.stringify({ type: 'assistant', uuid: 'live-answer', message: { content: '新回复' } });
    fs.appendFileSync(path.join(project, 'fixture-chat.jsonl'), record.slice(0, 20));
    await new Promise(resolve => setTimeout(resolve, 250));
    // A partial record can change the revision, but must never become a message.
    const partial = await pending;
    assert.equal(partial.messages.length, 1);
    const update = fetch(`${endpoint}&revision=${encodeURIComponent(partial.revision)}&wait=3000`);
    const writtenAt = Date.now();
    fs.appendFileSync(path.join(project, 'fixture-chat.jsonl'), record.slice(20) + '\n');
    const latest = await (await update).json();
    assert.equal(latest.messages.at(-1).blocks[0].text, '新回复');
    assert.equal(latest.waitSupported, true);
    assert.ok(Date.now() - writtenAt < 1500, 'must return before the long-poll deadline');
    console.log(`chat append to HTTP response: ${Date.now() - writtenAt}ms`);
  });

  await t.test('idle wait expires, cancellation stops reads, and legacy requests stay immediate', async () => {
    const latest = await (await fetch(endpoint)).json();
    const since = `&revision=${encodeURIComponent(latest.revision)}`;
    const began = Date.now();
    const timeout = await (await fetch(`${endpoint}${since}&wait=350`)).json();
    assert.equal(timeout.unchanged, true);
    assert.ok(Date.now() - began >= 300);
    const legacy = await (await fetch(`${endpoint}${since}`)).json();
    assert.equal(legacy.unchanged, true);

    let reads = 0;
    const original = manager.ensureResumeId.bind(manager);
    manager.ensureResumeId = (...args) => { reads++; return original(...args); };
    const controller = new AbortController();
    const cancelled = fetch(`${endpoint}${since}&wait=10000`, { signal: controller.signal });
    const rejection = assert.rejects(cancelled, { name: 'AbortError' });
    await new Promise(resolve => setTimeout(resolve, 250));
    controller.abort();
    await rejection;
    await new Promise(resolve => setTimeout(resolve, 100));
    const afterAbort = reads;
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.equal(reads, afterAbort, 'disconnected phones must not leave a polling loop');
    manager.ensureResumeId = original;
  });
});
