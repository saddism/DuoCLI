import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MIN_INPUT_AGE_MS,
  NOTIFY_COOLDOWN_MS,
  canNotifyAttention,
  classifyAttention,
  delayUntilNotify,
} from '../dist/main/attention-notify.js';

test('markdown quotes and Chinese body text do not look like a prompt', () => {
  const tail = [
    '# 结论复查',
    '本次实际核查是否继续执行，请选择更稳妥的方案。',
    '文件已经完成了写入。',
    '> 本文件修订 FINDINGS.md 的证据解释',
  ].join('\n');
  assert.equal(classifyAttention(tail), null);
});

test('generic success words do not mean the task is done', () => {
  const tail = 'successfully wrote RECHECK.md\ncompleted the export\nall set for review\n$ ';
  assert.equal(classifyAttention(tail), 'waiting');
});

test('a real idle prompt after explicit completion is done', () => {
  assert.equal(classifyAttention('检查结束。\n任务已完成\n❯ '), 'done');
  assert.equal(classifyAttention('All done.\n$ '), 'done');
});

test('working spinners suppress notifications', () => {
  assert.equal(classifyAttention('Reading files…\nWorking… (12s)\n$ '), null);
  assert.equal(classifyAttention('thinking\nesc to interrupt\n> '), null);
  assert.equal(classifyAttention('⠋ compiling\n$ '), null);
});

test('permission prompts are decisions even without a shell prompt', () => {
  const tail = [
    'Allow Claude to run npm test?',
    '  1. Yes',
    '  2. Yes, and don\'t ask again',
    '  3. No',
    '',
    '❯ 1.',
  ].join('\n');
  assert.equal(classifyAttention(tail), 'decision');
  assert.equal(classifyAttention('Do you want to make this edit?\nEnter to confirm · Esc to cancel'), 'decision');
  assert.equal(classifyAttention('Overwrite file? [y/n]'), 'decision');
});

test('bare 是否 in generated markdown is not a decision', () => {
  assert.equal(classifyAttention('需要确认这次改动是否合理。\n继续写下一节。'), null);
  assert.equal(classifyAttention('是否继续？\n[y/n]'), 'decision');
});

test('waiting and done require a recent user turn, decisions do not', () => {
  const now = 100_000;
  assert.equal(canNotifyAttention({
    kind: 'waiting',
    armed: true,
    now,
    lastInputAt: now - MIN_INPUT_AGE_MS,
    lastNotifyAt: 0,
  }), true);
  assert.equal(canNotifyAttention({
    kind: 'waiting',
    armed: false,
    now,
    lastInputAt: now - MIN_INPUT_AGE_MS,
    lastNotifyAt: 0,
  }), false);
  assert.equal(canNotifyAttention({
    kind: 'decision',
    armed: false,
    now,
    lastInputAt: now - 500,
    lastNotifyAt: 0,
  }), true);
  assert.equal(canNotifyAttention({
    kind: 'done',
    armed: true,
    now,
    lastInputAt: now - 1_000,
    lastNotifyAt: 0,
  }), false);
  assert.equal(canNotifyAttention({
    kind: 'waiting',
    armed: true,
    now,
    lastInputAt: now - MIN_INPUT_AGE_MS,
    lastNotifyAt: now - (NOTIFY_COOLDOWN_MS - 1),
  }), false);
});

test('idle notify waits for both settle and input age', () => {
  assert.equal(delayUntilNotify('decision', 20_000, 19_000), 2_000);
  assert.equal(delayUntilNotify('waiting', 20_000, 19_000), MIN_INPUT_AGE_MS - 1_000);
  assert.equal(delayUntilNotify('done', 30_000, 10_000), 5_000);
});
