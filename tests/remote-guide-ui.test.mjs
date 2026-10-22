import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'index.html'), 'utf8');
const mobileHtml = fs.readFileSync(path.join(here, '..', 'mobile', 'client', 'index.html'), 'utf8');

test('desktop remote card and guide overlay explain LAN and public setup', () => {
  assert.match(html, /id="remote-guide-overlay"/);
  assert.match(html, /class="remote-info-guide"/);
  assert.match(html, /id="empty-remote-guide-btn"/);
  assert.match(html, /固定公网地址/);
  assert.match(html, /id="remote-guide-prepare-config"/);
  assert.match(html, /id="remote-guide-copy-login"/);
});

test('mobile login page tells users where to find the Token', () => {
  assert.match(mobileHtml, /login-token-hint/);
  assert.match(mobileHtml, /手机远程同步/);
});
