import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobileHtml = fs.readFileSync(path.join(here, '..', 'mobile', 'client', 'index.html'), 'utf8');
const composerSrc = fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'quick-command-composer.ts'), 'utf8');

test('mobile shortcut bar puts Ctrl+O last', () => {
  const bar = mobileHtml.match(/<div id="shortcut-bar">([\s\S]*?)<\/div>/);
  assert.ok(bar);
  const ids = [...bar[1].matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.at(-1), 'ctrl-o-key');
  assert.match(bar[1], /data-key="\\x0f"/);
});

test('desktop shortcut bar puts Ctrl+O last', () => {
  const keys = composerSrc.match(/id: '([^']+)'/g);
  assert.ok(keys);
  assert.equal(keys.at(-1), "id: 'ctrl-o-key'");
  assert.match(composerSrc, /key: '\\x0f'/);
});

function formatMobileQuickCommandLabel(command) {
  const text = String(command || '');
  if (text.length <= 10) return text;
  return `${text.slice(0, 10)}…`;
}

test('quick command capsules keep a short prefix and confirm before send', () => {
  assert.equal(formatMobileQuickCommandLabel('/new'), '/new');
  assert.equal(formatMobileQuickCommandLabel('/compact'), '/compact');
  assert.equal(formatMobileQuickCommandLabel('/uniapp-dev'), '/uniapp-de…');
  assert.equal(formatMobileQuickCommandLabel('/unicloud-log-viewer'), '/unicloud-…');
  assert.equal(formatMobileQuickCommandLabel('这是一条很长的快捷命令用来测试截断'), '这是一条很长的快捷命…');
  assert.match(composerSrc, /LONG_PRESS_MS/);
  assert.match(composerSrc, /是否将以下内容发送到当前工作区/);
  const mobileSrc = fs.readFileSync(path.join(here, '..', 'mobile', 'client', 'app.js'), 'utf8');
  assert.match(mobileSrc, /text\.slice\(0, 10\)/);
  assert.match(mobileSrc, /QCMD_LONG_PRESS_MS/);
  assert.match(mobileSrc, /是否将以下内容发送到当前会话/);
});
