import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { closeTestBrowser } from './browser-cleanup.mjs';
import { resolveChromeExecutable } from './chrome-path.mjs';
import { PtyManager } from '../../dist/main/pty-manager.js';

process.env.DUOCLI_REMOTE_PORT = '0';
process.env.DUOCLI_REMOTE_HOST = '127.0.0.1';
process.env.DUOCLI_REMOTE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'duocli-token-test-'));
const { startRemoteServer } = await import('../../dist/main/remote-server.js');
const manager = new PtyManager({ onData() {}, onTitleUpdate() {}, onExit() {}, onResize() {} });
let server;
const info = await new Promise(resolve => { server = startRemoteServer(manager, undefined, undefined, resolve); });
const origin = `http://127.0.0.1:${info.port}`;
const browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true, args: ['--no-sandbox'] });

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 760, isMobile: true, hasTouch: true });
  await page.goto(origin, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#login-page.active');
  assert.equal((await page.$$('#login-page input')).length, 1);
  assert.equal(await page.$('#server-info'), null);
  await page.screenshot({ path: path.join(process.env.DUOCLI_REMOTE_CONFIG_DIR, 'login.png') });

  await page.goto(`${origin}/?token=${info.token}`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#main-page.active');
  const denied = await fetch(`${origin}/api/access-token`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token' },
    body: JSON.stringify({ token: 'unauthorized-token-123' }),
  });
  assert.equal(denied.status, 401);
  await page.click('#access-token-btn');
  await page.type('#new-access-token', 'replacement-token-123');
  await page.waitForFunction(() => document.getElementById('access-token-save').getBoundingClientRect().bottom <= innerHeight);
  await page.screenshot({ path: path.join(process.env.DUOCLI_REMOTE_CONFIG_DIR, 'edit-token.png') });
  await page.click('#access-token-save');
  await page.waitForFunction(() => localStorage.getItem('duocli_token') === 'replacement-token-123');
  assert.equal(await page.$eval('#access-token-modal', el => el.classList.contains('active')), false);
  const checkAuth = async token => {
    const response = await fetch(`${origin}/api/auth`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
    });
    return response.status;
  };
  assert.equal(await checkAuth(info.token), 401);
  assert.equal(await checkAuth('replacement-token-123'), 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(process.env.DUOCLI_REMOTE_CONFIG_DIR, 'config.json'), 'utf8')).token,
    'replacement-token-123');
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#main-page.active');

  const stalePage = await browser.newPage();
  await stalePage.setViewport({ width: 390, height: 760, isMobile: true, hasTouch: true });
  await stalePage.goto(origin, { waitUntil: 'domcontentloaded' });
  await stalePage.evaluate(oldToken => localStorage.setItem('duocli_token', oldToken), info.token);
  await stalePage.reload({ waitUntil: 'networkidle2' });
  await stalePage.waitForSelector('#login-page.active');
  assert.equal(await stalePage.$eval('#token-input', el => el.value), info.token);
  assert.match(await stalePage.$eval('#login-error', el => el.textContent), /Token 已失效/);
  await stalePage.$eval('#token-input', el => { el.value = ''; });
  await stalePage.type('#token-input', 'replacement-token-123');
  await stalePage.click('#login-btn');
  await stalePage.waitForSelector('#main-page.active');
  console.log('PASS mobile login prefill and access Token rotation');
} finally {
  await closeTestBrowser(browser);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
