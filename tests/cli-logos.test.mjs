import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { hasLogo, getLogoUrl, resolveLogoFile, getDefaultLogoUrl } = createRequire(import.meta.url)('../mobile/client/cli-logos.js');

test('matches session display names without spaces or parentheses', () => {
  assert.equal(resolveLogoFile('Claude全自动'), 'claude-color');
  assert.equal(resolveLogoFile('Claude (全自动)'), 'claude-color');
  assert.equal(resolveLogoFile('Codex全自动'), 'codex-color');
  assert.equal(resolveLogoFile('Cursor全自动'), 'cursor');
  assert.equal(hasLogo('Claude全自动'), true);
  assert.equal(hasLogo('空终端'), false);
  assert.equal(hasLogo('终端'), false);
  assert.ok(getLogoUrl('Kimi (全自动)').includes('kimi-color.svg'));
  assert.ok(getLogoUrl('空终端').startsWith('data:image/svg+xml'));
  assert.ok(getLogoUrl('我的自定义 CLI').startsWith('data:image/svg+xml'));
  assert.equal(getLogoUrl('Aider'), getDefaultLogoUrl());
});

test('Kiro 用 Kiro 自己的图标，不再借用 Cursor 的', () => {
  assert.equal(resolveLogoFile('Kiro'), 'kiro-color');
  assert.equal(resolveLogoFile('Kiro (全自动)'), 'kiro-color');
  assert.equal(resolveLogoFile('Kiro全自动'), 'kiro-color');
  assert.ok(getLogoUrl('Kiro (全自动)').includes('kiro-color.svg'));
});

test('DSH 相关预设使用内嵌的 DSH 图标', () => {
  assert.ok(resolveLogoFile('DSH-TUI').startsWith('data:image/png;base64,'));
  assert.equal(hasLogo('DSH-TUI'), true);
  assert.ok(getLogoUrl('DSH-TUI').startsWith('data:image/png;base64,'));
});

test('带 cc 的 CLI（Claude Code 兼容实现）统一显示 Claude 图标', () => {
  assert.equal(resolveLogoFile('ds-cc'), 'claude-color');
  assert.equal(resolveLogoFile('dss-cc'), 'claude-color');
  assert.equal(resolveLogoFile('OLLAMA-CC'), 'claude-color');
  assert.ok(getLogoUrl('ds-cc').includes('claude-color.svg'));
  assert.equal(hasLogo('ds-cc'), true);
});
