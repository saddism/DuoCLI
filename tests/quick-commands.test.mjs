import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QuickCommandStore, DEFAULT_QUICK_COMMANDS } from '../dist/main/quick-commands.js';

function store() {
  return new QuickCommandStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'duocli-quick-')), 'commands.json'));
}

test('commands persist across restart, with incremental edits from multiple clients', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'duocli-quick-')), 'commands.json');
  const desktop = new QuickCommandStore(file);
  const phone = new QuickCommandStore(file);
  assert.deepEqual(desktop.read(), { initialized: false, commands: DEFAULT_QUICK_COMMANDS });
  desktop.update({ action: 'add', command: '检查代码' });
  phone.update({ action: 'add', command: '/review' });
  assert.deepEqual(new QuickCommandStore(file).read().commands, [...DEFAULT_QUICK_COMMANDS, '检查代码', '/review']);
  phone.update({ action: 'remove', command: '检查代码' });
  assert.equal(desktop.read().commands.includes('检查代码'), false);
  desktop.update({ action: 'add', command: '/review' });
  assert.equal(phone.read().commands.filter(item => item === '/review').length, 1);
});

test('legacy migration is one-time and does not resurrect deletions or an empty list', () => {
  const saved = store();
  saved.update({ action: 'migrate', commands: ['自定义', '/help'] });
  saved.update({ action: 'remove', command: '自定义' });
  saved.update({ action: 'remove', command: '/help' });
  assert.deepEqual(saved.update({ action: 'migrate', commands: ['自定义', '/help'] }), { initialized: true, commands: [] });
});

test('invalid edits preserve persisted configuration', () => {
  const saved = store();
  saved.update({ action: 'add', command: '合法' });
  const before = saved.read();
  for (const operation of [{ action: 'add', command: '' }, { action: 'add', command: 'x'.repeat(10001) }, { action: 'overwrite' }, { action: 'remove' }]) {
    assert.throws(() => saved.update(operation));
    assert.deepEqual(saved.read(), before);
  }
});
