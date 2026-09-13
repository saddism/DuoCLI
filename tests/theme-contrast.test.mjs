import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';

const entry = path.resolve('src/renderer/theme-contrast.ts');
const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

test('light backgrounds get dark foreground and dark selection', () => {
  const theme = mod.buildContrastingTerminalTheme('#ffffff', '#ffffff');
  assert.equal(theme.background, '#ffffff');
  assert.equal(theme.foreground, '#0a0a0a');
  assert.equal(theme.cursor, '#0a0a0a');
  assert.match(theme.selectionBackground, /^rgba\(0, 0, 0/);
});

test('dark backgrounds get light foreground and light selection', () => {
  const theme = mod.buildContrastingTerminalTheme('#000000', '#000000');
  assert.equal(theme.background, '#000000');
  assert.equal(theme.foreground, '#f5f5f5');
  assert.equal(theme.cursor, '#f5f5f5');
  assert.match(theme.selectionBackground, /^rgba\(255, 255, 255/);
});

test('preferred foreground is kept when contrast is already enough', () => {
  assert.equal(mod.pickContrastingForeground('#1a1a1a', '#ffd700'), '#ffd700');
  assert.equal(mod.pickContrastingForeground('#39ff14', '#0a0a0a'), '#0a0a0a');
});

test('mid-dark accents keep configured light text when still readable', () => {
  assert.equal(mod.pickContrastingForeground('#228b22', '#f5f5f5'), '#f5f5f5');
  assert.equal(mod.pickContrastingForeground('#bf00ff', '#f5f5f5'), '#f5f5f5');
});
