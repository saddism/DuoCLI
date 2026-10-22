// Two real browser origins (HTTPS public / HTTP LAN) share one real backend.
// Only terminal execution and network outages are fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { resolveChromeExecutable } from './chrome-path.mjs';
import { PtyManager } from '../../dist/main/pty-manager.js';
import { TerminalState } from '../../dist/main/terminal-state.js';

const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duocli-network-switch-'));
const lanIp = Object.values(os.networkInterfaces()).flat().find(iface => iface?.family === 'IPv4' && !iface.internal && /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(iface.address))?.address;
if (!lanIp) throw new Error('A private IPv4 interface is needed for this LAN/public browser test');
process.env.DUOCLI_REMOTE_PORT = '0';
process.env.DUOCLI_REMOTE_HOST = '0.0.0.0';
process.env.DUOCLI_REMOTE_CONFIG_DIR = artifactDir;
const { startRemoteServer } = await import('../../dist/main/remote-server.js');
const manager = new PtyManager({ onData() {}, onTitleUpdate() {}, onExit() {} });
const state = new TerminalState();
const inputs = [];
const session = { id: 'network-test', title: 'network switch', presetCommand: 'qoder', cwd: os.tmpdir(),
  ptyProcess: { pid: process.pid, resize() {} }, terminalState: state,
  rawBuffer: '', lastSequence: 0, submissions: new Map(), submitQueue: Promise.resolve(), currentCols: 80, currentRows: 24,
  sizeBySource: { desktop: null, mobile: null }, sizeOwner: null, lastInputAt: { desktop: 0, mobile: 0 } };
manager.sessions.set(session.id, session);
manager.write = (_id, text) => inputs.push(text);
let backend;
const info = await new Promise(resolve => { backend = startRemoteServer(manager, undefined, undefined, resolve); });
const lanOrigin = `http://${lanIp}:${info.port}`;
const key = path.join(artifactDir, 'key.pem');
const cert = path.join(artifactDir, 'cert.pem');
execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-subj', '/CN=localhost', '-days', '1'], { stdio: 'ignore' });
const publicServer = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
  const upstream = http.request({ hostname: '127.0.0.1', port: info.port, path: req.url, method: req.method, headers: req.headers }, response => {
    res.writeHead(response.statusCode, response.headers);
    response.pipe(res);
  });
  upstream.on('error', () => { res.statusCode = 502; res.end(); });
  req.pipe(upstream);
});
const upgradeSockets = new Set();
publicServer.on('upgrade', (req, socket, head) => {
  const upstream = net.connect({ host: '127.0.0.1', port: info.port }, () => {
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${req.rawHeaders.reduce((headers, value, i) => headers + (i % 2 ? `${value}\r\n` : `${value}: `), '')}\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream); upstream.pipe(socket);
  });
  for (const connection of [socket, upstream]) {
    upgradeSockets.add(connection);
    connection.on('error', () => connection.destroy());
    connection.on('close', () => upgradeSockets.delete(connection));
  }
  socket.on('close', () => upstream.destroy());
  upstream.on('close', () => socket.destroy());
});
await new Promise(resolve => publicServer.listen(0, '127.0.0.1', resolve));
const publicOrigin = `https://127.0.0.1:${publicServer.address().port}`;
const browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true, ignoreHTTPSErrors: true,
  args: ['--no-sandbox', '--no-proxy-server', '--ignore-certificate-errors'] });
const page = await browser.newPage();
const browserErrors = [];
page.on('pageerror', error => browserErrors.push(error.message));
let blockLan = false;
await page.setRequestInterception(true);
page.on('request', request => {
  if (blockLan && request.url().startsWith(lanOrigin) && /\/api\/network-(check|handoff)/.test(request.url())) void request.abort();
  else void request.continue();
});
const cdp = await page.createCDPSession();
try {
  await cdp.send('Browser.setPermission', { permission: { name: 'local-network-access' }, setting: 'granted', origin: publicOrigin });
  await page.setViewport({ width: 390, height: 760, isMobile: true, hasTouch: true });
  await page.goto(`${publicOrigin}/?token=${info.token}`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.session-card');
  await page.click('#net-mode-btn');
  await page.waitForSelector('#network-mode-modal.active');
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.deepEqual(await page.$$eval('[data-network]', buttons => buttons.map(button => button.textContent.trim().split('固定')[0])), [
    '自动切换优先可用的局域网，离开后回到公网', '强制局域网', '强制公网',
  ]);
  await page.screenshot({ path: path.join(artifactDir, 'network-choice.png') });
  await page.click('[data-network="cf"]');
  assert.equal(await page.evaluate(() => localStorage.getItem('duocli_network_preference')), 'cf');
  await page.click('#net-mode-btn');
  await page.waitForSelector('#network-mode-modal.active');
  await new Promise(resolve => setTimeout(resolve, 350));
  await page.click('[data-network="auto"]');
  await page.click('.session-card');
  await page.waitForFunction(() => terminalInputReady && currentSessionId === 'network-test');
  await page.evaluate(() => { document.getElementById('msg-input').value = '自动切换前的草稿'; saveCurrentMobileDraft(); });
  await page.waitForFunction(origin => location.origin === origin && terminalInputReady && document.getElementById('msg-input').value === '自动切换前的草稿', { timeout: 20_000 }, lanOrigin);
  console.log('PASS automatic HTTPS -> LAN keeps session, draft and ready terminal');

  // Simulate an already executed submission whose acknowledgement was lost.
  await manager.submit(session.id, 'same-network-submission', 'unconfirmed prompt');
  await page.evaluate(() => {
    mobilePendingSubmissions.set(currentSessionId, { id: 'same-network-submission', sessionId: currentSessionId, text: 'unconfirmed prompt', retryCount: 1 });
    document.getElementById('msg-input').value = 'unconfirmed prompt';
    saveCurrentMobileDraft(); saveMobilePendingSubmissions();
  });
  blockLan = true;
  await page.evaluate(() => LanSwitcher.probeNow());
  await page.evaluate(() => LanSwitcher.probeNow());
  await page.waitForFunction(origin => location.origin === origin && terminalInputReady && document.getElementById('msg-input').value === 'unconfirmed prompt', { timeout: 15_000 }, publicOrigin);
  assert.equal(await page.evaluate(() => mobilePendingSubmissions.get(currentSessionId)?.id), 'same-network-submission');
  await page.click('#send-btn');
  await page.waitForFunction(() => !composerSubmissions.size && !mobilePendingSubmissions.has(currentSessionId));
  assert.equal(inputs.filter(text => text === 'unconfirmed prompt').length, 1, 'retry after handoff must not execute twice');
  await page.evaluate(() => { document.getElementById('msg-input').value = 'new prompt after switching'; });
  await page.click('#send-btn');
  await page.waitForFunction(() => !composerSubmissions.size);
  assert.equal(inputs.filter(text => text === 'new prompt after switching').length, 1);
  console.log('PASS LAN failure -> HTTPS transfers state through the reachable route; retry is deduplicated');

  blockLan = false;
  await page.evaluate(() => LanSwitcher.select('cf'));
  await page.evaluate(() => LanSwitcher.probeNow());
  assert.equal(page.url().startsWith(publicOrigin), true);
  assert.equal(await page.evaluate(() => localStorage.getItem('duocli_network_preference')), 'cf');
  console.log('PASS manual public selection remains pinned when LAN is available');
  await page.evaluate(() => LanSwitcher.select('lan'));
  await page.waitForFunction(origin => location.origin === origin && terminalInputReady && localStorage.getItem('duocli_network_preference') === 'lan', { timeout: 15_000 }, lanOrigin);
  blockLan = true;
  await page.evaluate(() => LanSwitcher.probeNow());
  assert.equal(page.url().startsWith(lanOrigin), true);
  console.log('PASS forced LAN remains pinned even when automatic probes fail');
  await page.evaluate(() => LanSwitcher.select('cf'));
  await page.waitForFunction(origin => location.origin === origin && terminalInputReady, { timeout: 15_000 }, publicOrigin);
  await page.evaluate(() => LanSwitcher.select('auto'));
  assert.equal(await page.evaluate(() => localStorage.getItem('duocli_network_preference')), 'auto');
  await page.setOfflineMode(true);
  await page.evaluate(() => LanSwitcher.probeNow());
  assert.equal(page.url().startsWith(publicOrigin), true);
  await page.setOfflineMode(false);
  assert.deepEqual(browserErrors, []);
  console.log(`PASS restoring automatic mode and total-offline behavior; artifacts: ${artifactDir}`);
} finally {
  await browser.close();
  for (const socket of upgradeSockets) socket.destroy();
  publicServer.closeAllConnections();
  await new Promise(resolve => publicServer.close(resolve));
  state.dispose();
  backend.closeAllConnections();
  await new Promise(resolve => backend.close(resolve));
}
