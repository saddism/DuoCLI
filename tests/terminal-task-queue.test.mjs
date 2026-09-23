import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TerminalActivityTracker } from '../dist/main/terminal-activity-tracker.js';
import { TerminalTaskStore } from '../dist/main/terminal-task-store.js';
import { TerminalTaskScheduler } from '../dist/main/terminal-task-scheduler.js';

function waitFor(check, timeoutMs = 1500) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (check()) { resolve(); return; }
      if (Date.now() - startedAt >= timeoutMs) { reject(new Error('condition timed out')); return; }
      setTimeout(poll, 10);
    };
    poll();
  });
}

class FakeActivity {
  states = new Map();
  listeners = new Set();
  onChange(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  get(id) { return this.states.get(id); }
  arm(id, quietMs) {
    const state = { sessionId: id, status: 'running', generation: (this.states.get(id)?.generation || 0) + 1, revision: 1, lastContentAt: Date.now(), quietMs };
    this.states.set(id, state);
    return state;
  }
  stop(id) {
    const previous = this.states.get(id);
    const state = { ...previous, status: 'stopped', revision: previous.revision + 1, stoppedAt: Date.now() };
    this.states.set(id, state);
    for (const listener of this.listeners) listener(state);
  }
}

test('terminal activity ignores control-only output and stops after the quiet threshold', async () => {
  const tracker = new TerminalActivityTracker(1000);
  const changes = [];
  tracker.onChange(state => changes.push(state.status));
  tracker.noteData('term-1', '\x1b[?25h\x1b[0m');
  assert.deepEqual(changes, []);
  tracker.noteData('term-1', 'working\n');
  assert.deepEqual(changes, ['running']);
  await waitFor(() => changes.includes('stopped'), 1400);
  assert.deepEqual(changes, ['running', 'stopped']);
  tracker.stop();
});

test('task scheduler persists and runs an A to B dependency chain once', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duocli-task-test-'));
  const store = new TerminalTaskStore(path.join(tempDir, 'tasks.json'));
  const activity = new FakeActivity();
  const launches = [];
  const submissions = [];
  const launcher = {
    async create(task) { const sessionId = `session-${launches.length + 1}`; launches.push({ task: task.name, sessionId }); return { sessionId }; },
    async submit(sessionId, instruction, submissionId) { submissions.push({ sessionId, instruction, submissionId }); },
    async cancel() {},
    hasSession() { return true; },
  };
  const scheduler = new TerminalTaskScheduler(store, activity, launcher);
  const a = scheduler.create({ requestId: 'a', name: 'A', cwd: tempDir, instruction: 'run-a', quietMs: 1000 });
  const b = scheduler.create({ requestId: 'b', name: 'B', cwd: tempDir, instruction: 'run-b', dependsOnTaskId: a.id, quietMs: 1000 });
  await waitFor(() => scheduler.snapshot().tasks.find(task => task.id === a.id)?.status === 'running');
  assert.equal(launches.length, 1);
  activity.stop('session-1');
  await waitFor(() => scheduler.snapshot().tasks.find(task => task.id === b.id)?.status === 'running');
  assert.deepEqual(launches.map(item => item.task), ['A', 'B']);
  assert.deepEqual(submissions.map(item => item.instruction), ['run-a', 'run-b']);
  activity.stop('session-2');
  await waitFor(() => scheduler.snapshot().tasks.every(task => task.status === 'completed'));
  assert.deepEqual(new TerminalTaskStore(path.join(tempDir, 'tasks.json')).snapshot().tasks.map(task => task.status), ['completed', 'completed']);
  scheduler.stop();
});

test('duplicate request ids are idempotent only for the same task body', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duocli-task-idempotency-'));
  const store = new TerminalTaskStore(path.join(tempDir, 'tasks.json'));
  const activity = new FakeActivity();
  let launches = 0;
  const scheduler = new TerminalTaskScheduler(store, activity, {
    async create() { launches += 1; return { sessionId: 'session-only' }; },
    async submit() {}, async cancel() {}, hasSession() { return true; },
  });
  const first = scheduler.create({ requestId: 'same', name: 'one', cwd: tempDir, instruction: 'go' });
  const second = scheduler.create({ requestId: 'same', name: 'one', cwd: tempDir, instruction: 'go' });
  assert.equal(first.id, second.id);
  assert.throws(
    () => scheduler.create({ requestId: 'same', name: 'different', cwd: tempDir, instruction: 'different' }),
    /另一个任务/,
  );
  await waitFor(() => scheduler.snapshot().tasks[0]?.status === 'running');
  assert.equal(launches, 1);
  scheduler.stop();
});

test('a corrupt task file is preserved and blocks writes instead of being replaced', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duocli-task-corrupt-'));
  const filePath = path.join(tempDir, 'tasks.json');
  fs.writeFileSync(filePath, '{broken', 'utf8');
  const store = new TerminalTaskStore(filePath);
  assert.deepEqual(store.snapshot().tasks, []);
  assert.throws(() => store.replace([]), /原文件已保留/);
  assert.equal(fs.readFileSync(filePath, 'utf8'), '{broken');
});

test('desktop and mobile new-session forms expose scheduling and queue controls', () => {
  const desktop = fs.readFileSync('src/renderer/index.html', 'utf8');
  const mobile = fs.readFileSync('mobile/client/index.html', 'utf8');
  for (const html of [desktop, mobile]) {
    assert.match(html, /task-queue/);
    assert.match(html, /静止完成/);
    assert.match(html, /前置任务/);
    assert.match(html, /value="10"/);
  }
});

test('task queue can pause, run immediately, and delete waiting tasks', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duocli-task-manage-'));
  const store = new TerminalTaskStore(path.join(tempDir, 'tasks.json'));
  const activity = new FakeActivity();
  const launches = [];
  const scheduler = new TerminalTaskScheduler(store, activity, {
    async create(task) { const sessionId = `session-${launches.length + 1}`; launches.push(task.name); return { sessionId }; },
    async submit() {}, async cancel() {}, hasSession() { return true; },
  });
  const later = Date.now() + 60_000;
  const waiting = scheduler.create({ requestId: 'wait', name: 'Wait', cwd: tempDir, instruction: 'later', notBefore: later, quietMs: 1000 });
  const follower = scheduler.create({ requestId: 'follow', name: 'Follow', cwd: tempDir, instruction: 'after', dependsOnTaskId: waiting.id, quietMs: 1000 });
  scheduler.pause(waiting.id);
  assert.equal(scheduler.snapshot().tasks.find(task => task.id === waiting.id)?.status, 'paused');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(launches.length, 0);
  scheduler.runNow(waiting.id);
  await waitFor(() => scheduler.snapshot().tasks.find(task => task.id === waiting.id)?.status === 'running');
  assert.deepEqual(launches, ['Wait']);
  activity.stop('session-1');
  await waitFor(() => scheduler.snapshot().tasks.find(task => task.id === follower.id)?.status === 'running');
  scheduler.remove(follower.id);
  assert.equal(scheduler.snapshot().tasks.some(task => task.id === follower.id), false);
  scheduler.stop();
});

test('deleting an unfinished predecessor blocks dependents', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duocli-task-delete-'));
  const store = new TerminalTaskStore(path.join(tempDir, 'tasks.json'));
  const activity = new FakeActivity();
  const scheduler = new TerminalTaskScheduler(store, activity, {
    async create() { return { sessionId: 'unused' }; },
    async submit() {}, async cancel() {}, hasSession() { return true; },
  });
  const later = Date.now() + 60_000;
  const first = scheduler.create({ requestId: 'first', name: 'First', cwd: tempDir, instruction: 'one', notBefore: later, quietMs: 1000 });
  const second = scheduler.create({ requestId: 'second', name: 'Second', cwd: tempDir, instruction: 'two', dependsOnTaskId: first.id, quietMs: 1000 });
  scheduler.remove(first.id);
  const leftover = scheduler.snapshot().tasks.find(task => task.id === second.id);
  assert.equal(leftover?.status, 'blocked');
  assert.match(String(leftover?.error || ''), /已删除/);
  scheduler.stop();
});
