import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { AutoContinueManager } from '../dist/main/auto-continue-manager.js';

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function makePath(label) {
  return path.join(os.tmpdir(), `duocli-auto-continue-${label}-${process.pid}-${Date.now()}.json`);
}

test('auto-continue manager persists configs and runs outside renderer', async () => {
  const filePath = makePath('run');
  const submitted = [];
  const ptyManager = {
    getSession: (id) => id === 'session-1' ? {} : undefined,
    submit: async (id, submissionId, text) => {
      submitted.push({ id, submissionId, text });
    },
  };
  const manager = new AutoContinueManager(ptyManager, filePath);
  manager.syncAll({
    'session-1': {
      enabled: true,
      messages: ['继续'],
      intervalMs: 60_000,
      commandIntervalMs: 0,
      sendDelaySec: 0,
      maxLoops: 1,
      nextRunAt: Date.now(),
    },
  });

  await wait(1_150);
  manager.stop();

  assert.equal(submitted.length, 1);
  assert.equal(manager.hasPersistedState(), true);
  assert.equal(submitted[0].id, 'session-1');
  assert.equal(submitted[0].text, '继续');
  assert.equal(manager.get('session-1').enabled, false);

  const restored = new AutoContinueManager(ptyManager, filePath);
  assert.equal(restored.get('session-1').enabled, false);
  assert.equal(restored.hasPersistedState(), true);
  restored.stop();
});

test('manual input postpones a scheduled cycle', async () => {
  const filePath = makePath('manual');
  const submitted = [];
  const ptyManager = {
    getSession: () => ({}),
    submit: async (...args) => { submitted.push(args); },
  };
  const manager = new AutoContinueManager(ptyManager, filePath);
  manager.syncAll({
    session: {
      enabled: true,
      messages: ['继续'],
      intervalMs: 60_000,
      loopCount: 1,
      nextRunAt: Date.now() + 1_100,
    },
  });
  manager.noteManualInput('session');

  await wait(1_250);
  manager.stop();
  assert.equal(submitted.length, 0);
});

test('auto-agree remains active when the renderer is unavailable', async () => {
  const filePath = makePath('agree');
  const submitted = [];
  const ptyManager = {
    getSession: () => ({}),
    submit: async (...args) => { submitted.push(args); },
  };
  const manager = new AutoContinueManager(ptyManager, filePath);
  manager.syncAll({
    session: {
      enabled: true,
      autoAgree: true,
      autoAgreeDelaySec: 0,
      messages: ['继续'],
      nextRunAt: Date.now() + 60_000,
    },
  });
  manager.observeOutput('session', 'Do you want to make this edit?\n  1. Yes\n  2. No\n');
  await wait(25);
  manager.stop();
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0][0], 'session');
  assert.equal(submitted[0][2], '1');
});
