import test from 'node:test';
import assert from 'node:assert/strict';
import { getDisplayName } from '../dist/main/pty-manager.js';
import { BUILTIN_PRESETS } from '../dist/main/cli-detect.js';

test('getDisplayName returns friendly names for exact preset commands', () => {
  assert.equal(getDisplayName('agent --force --approve-mcps'), 'Cursor全自动');
  assert.equal(getDisplayName('opencode'), 'OpenCode');
  assert.equal(getDisplayName(''), '终端');
});

test('includes the international Qoder full-auto preset', () => {
  assert.deepEqual(
    BUILTIN_PRESETS.find(p => p.value === 'qodercli --dangerously-skip-permissions'),
    { value: 'qodercli --dangerously-skip-permissions', label: 'Qoder (全自动)' },
  );
});

test('getDisplayName infers CLI name when preset flags vary slightly', () => {
  assert.equal(
    getDisplayName('codex -c sandbox_mode="danger-full-access" -c approval="never" -c network="enabled"'),
    'Codex全自动',
  );
  assert.equal(
    getDisplayName('codex -c sandbox_mode="danger-full-access" -c approval="never"'),
    'Codex全自动',
  );
  assert.equal(getDisplayName('codex --full-auto'), 'Codex全自动');
  assert.equal(getDisplayName('codex'), 'Codex');
  assert.equal(getDisplayName('claude --dangerously-skip-permissions'), 'Claude全自动');
  assert.equal(getDisplayName('qodercli --dangerously-skip-permissions'), 'Qoder全自动');
  assert.equal(getDisplayName('qodercli --permission-mode bypass_permissions'), 'Qoder全自动');
});

// 内置预设下拉与显示名映射是两份手写列表，漏一个就会在会话列表里显示成“终端”
test('每个内置预设的显示名与下拉标签一致', () => {
  for (const preset of BUILTIN_PRESETS) {
    if (!preset.value) {
      assert.equal(getDisplayName(preset.value), '终端', preset.label);
      continue;
    }
    assert.equal(
      getDisplayName(preset.value),
      preset.label.replace(' (全自动)', '全自动'),
      `缺少显示名映射: ${preset.value}`,
    );
  }
});
