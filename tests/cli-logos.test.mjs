import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const {
  hasLogo,
  getLogoUrl,
  resolveLogoFile,
  getDefaultLogoUrl,
  getLetterLogoUrl,
  firstLogoLetter,
  logoNeedsInvert,
} = createRequire(import.meta.url)('../mobile/client/cli-logos.js');

test('matches session display names without spaces or parentheses', () => {
  assert.equal(resolveLogoFile('Claude全自动'), 'claude-color');
  assert.equal(resolveLogoFile('Claude (全自动)'), 'claude-color');
  assert.equal(resolveLogoFile('Codex全自动'), 'codex-color');
  assert.equal(resolveLogoFile('Cursor全自动'), 'cursor');
  assert.equal(hasLogo('Claude全自动'), true);
  assert.equal(hasLogo('空终端'), false);
  assert.equal(hasLogo('终端'), false);
  assert.ok(getLogoUrl('Kimi (全自动)').includes('kimi-color.svg'));
  assert.equal(getLogoUrl('空终端'), getDefaultLogoUrl());
  assert.equal(getLogoUrl('终端'), getDefaultLogoUrl());
  assert.ok(getLogoUrl('我的自定义 CLI').startsWith('data:image/svg+xml'));
  assert.notEqual(getLogoUrl('Aider'), getDefaultLogoUrl());
  assert.equal(getLogoUrl('Aider'), getLetterLogoUrl('Aider'));
});

test('无品牌图标时用首字母大写，纯终端仍用默认终端图标', () => {
  assert.equal(firstLogoLetter('aider'), 'A');
  assert.equal(firstLogoLetter('ollama'), 'O');
  assert.equal(firstLogoLetter('我的助手'), '我');
  assert.equal(firstLogoLetter('空终端'), '');
  assert.equal(firstLogoLetter('终端'), '');
  assert.ok(decodeURIComponent(getLetterLogoUrl('aider')).includes('>A</text>'));
  assert.ok(decodeURIComponent(getLetterLogoUrl('我的助手')).includes('>我</text>'));
  assert.equal(getLetterLogoUrl('空终端'), getDefaultLogoUrl());
  assert.equal(getLogoUrl('空终端'), getDefaultLogoUrl());
});

test('Kiro 用 Kiro 自己的图标，不再借用 Cursor 的', () => {
  assert.equal(resolveLogoFile('Kiro'), 'kiro-color');
  assert.equal(resolveLogoFile('Kiro (全自动)'), 'kiro-color');
  assert.equal(resolveLogoFile('Kiro全自动'), 'kiro-color');
  assert.ok(getLogoUrl('Kiro (全自动)').includes('kiro-color.svg'));
});

test('ZCode 使用智谱图标', () => {
  assert.equal(resolveLogoFile('ZCode'), 'zhipu-color');
  assert.equal(hasLogo('ZCode'), true);
  assert.ok(getLogoUrl('ZCode').includes('zhipu-color.svg'));
  assert.equal(logoNeedsInvert('ZCode'), false);
});

test('DSH 相关预设使用内嵌的 DSH 图标', () => {
  assert.ok(resolveLogoFile('DSH-TUI').startsWith('data:image/png;base64,'));
  assert.equal(hasLogo('DSH-TUI'), true);
  assert.ok(getLogoUrl('DSH-TUI').startsWith('data:image/png;base64,'));
});

test('黑色官方图标在深色底上需要反色，彩色稿和内嵌图不反', () => {
  assert.equal(logoNeedsInvert('Cursor'), true);
  assert.equal(logoNeedsInvert('Cursor (全自动)'), true);
  assert.equal(logoNeedsInvert('Antigravity'), true);
  assert.equal(logoNeedsInvert('Antigravity全自动'), true);
  assert.equal(logoNeedsInvert('Claude'), false);
  assert.equal(logoNeedsInvert('Kiro'), false);
  assert.equal(logoNeedsInvert('DSH-TUI'), false);
  assert.equal(logoNeedsInvert('空终端'), false);
});

test('带 cc 的 CLI（Claude Code 兼容实现）统一显示 Claude 图标', () => {
  assert.equal(resolveLogoFile('ds-cc'), 'claude-color');
  assert.equal(resolveLogoFile('dss-cc'), 'claude-color');
  assert.equal(resolveLogoFile('OLLAMA-CC'), 'claude-color');
  assert.ok(getLogoUrl('ds-cc').includes('claude-color.svg'));
  assert.equal(hasLogo('ds-cc'), true);
});
