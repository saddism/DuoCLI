import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ClosedSessionsManager,
  closedSessionUpdatedAt,
  sortClosedSessionsByUpdatedAt,
} from '../dist/main/closed-sessions.js';

function userData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'duocli-closed-'));
}

test('closed sessions sort by last update time, not close time', () => {
  assert.deepEqual(
    sortClosedSessionsByUpdatedAt([
      { id: 'old-active', closedAt: 300, updatedAt: 100 },
      { id: 'recent', closedAt: 200, updatedAt: 250 },
      { id: 'legacy', closedAt: 180 },
    ]).map(item => item.id),
    ['recent', 'legacy', 'old-active'],
  );
  assert.equal(closedSessionUpdatedAt({
    closedAt: 9,
    contextHistory: [{ role: 'user', content: 'hi', timestamp: 42 }],
  }), 42);
});

test('list returns the most recently updated session first', () => {
  const store = new ClosedSessionsManager(userData());
  store.add({
    title: '先关但更晚才用过',
    cwd: '/tmp/a',
    presetCommand: 'codex',
    resumeId: 'resume-old-close',
    resumeCommand: 'codex resume resume-old-close',
    updatedAt: 1000,
  });
  store.add({
    title: '后关但更早用过',
    cwd: '/tmp/b',
    presetCommand: 'codex',
    resumeId: 'resume-new-close',
    resumeCommand: 'codex resume resume-new-close',
    updatedAt: 500,
  });

  const listed = store.list();
  assert.equal(listed[0].resumeId, 'resume-old-close');
  assert.equal(listed[1].resumeId, 'resume-new-close');
  assert.ok(listed[0].updatedAt > listed[1].updatedAt);
});

test('backfill writes session file mtime onto records that only have closedAt', () => {
  const dir = userData();
  fs.writeFileSync(path.join(dir, 'closed-sessions.json'), JSON.stringify([
    {
      id: 'closed-old',
      title: '较早活动但后关',
      cwd: '/tmp/c',
      presetCommand: 'codex',
      resumeId: 'resume-early',
      resumeCommand: 'codex resume resume-early',
      displayName: 'Codex',
      closedAt: Date.now() - 1000,
      cli: 'codex',
      state: 'closed',
    },
    {
      id: 'closed-new',
      title: '较晚活动但先关',
      cwd: '/tmp/d',
      presetCommand: 'codex',
      resumeId: 'resume-late',
      resumeCommand: 'codex resume resume-late',
      displayName: 'Codex',
      closedAt: Date.now() - 2000,
      cli: 'codex',
      state: 'closed',
    },
  ], null, 2));

  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duocli-sessions-'));
  const earlyFile = path.join(sessionsDir, 'rollout-resume-early.jsonl');
  const lateFile = path.join(sessionsDir, 'nested', 'rollout-resume-late.jsonl');
  fs.writeFileSync(earlyFile, 'early');
  fs.mkdirSync(path.dirname(lateFile), { recursive: true });
  fs.writeFileSync(lateFile, 'late');
  fs.utimesSync(earlyFile, 1, 1);
  fs.utimesSync(lateFile, 3, 3);

  const store = new ClosedSessionsManager(dir);
  const listed = store.backfillUpdatedAtFromLocalSessions(sessionsDir);
  assert.equal(listed[0].resumeId, 'resume-late');
  assert.equal(listed[1].resumeId, 'resume-early');
  assert.ok(listed[0].updatedAt > listed[1].updatedAt);
});
