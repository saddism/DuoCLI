import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import puppeteer from 'puppeteer-core';
import { closeTestBrowser } from './browser-cleanup.mjs';
import { resolveChromeExecutable } from './chrome-path.mjs';

const require = createRequire(import.meta.url);
const { TerminalState } = require('../../dist/main/terminal-state.js');
const state = new TerminalState();
const write = data => new Promise(resolve => state.write(data, resolve));
const resize = async (cols, rows) => { state.resize(cols, rows); await state.snapshot(() => {}); };
const server = http.createServer((req, res) => {
  const files = {
    '/history.js': 'mobile/client/terminal-history-layer.js',
    '/xterm.js': 'mobile/client/xterm.js',
    '/style.css': 'mobile/client/style.css',
    '/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  };
  if (files[req.url]) {
    res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript');
    return res.end(readFileSync(files[req.url]));
  }
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="/xterm.css"><link rel="stylesheet" href="/style.css">
    <style>html,body{margin:0;width:100%;height:100%;overflow:hidden}
      #terminal-container{position:relative;width:100%;height:680px;flex:none}</style>
    <div id="terminal-container"></div><script src="/xterm.js"></script><script src="/history.js"></script>`);
});
let browser;
try {
  await resize(100, 24);
  await write([
    'Claude Code v2.1.165',
    'deepseek-ai/DeepSeek-V4-Pro with max effort',
    'API Usage Billing', '~/AITrendAPP', '', '1 setup issue: MCP /doctor',
    '> /model', 'Set model to deepseek-ai/DeepSeek-V4-Flash and saved as your default for new sessions',
    ...Array.from({ length: 50 }, (_, i) => `output-${i}: ${'content '.repeat(10)}`),
  ].join('\r\n') + '\r\n');
  await resize(30, 10);
  // Widening brings previously archived rows back into the live viewport.
  await resize(100, 40);
  await resize(30, 10);
  let snapshot;
  await state.snapshot(value => { snapshot = value; }, { scrollback: 80 });
  let history = await state.historyBefore({ limitRows: 200 });
  for (let pages = 1; history.hasMore && pages < 20; pages++) {
    const older = await state.historyBefore({ beforeCursor: history.nextCursor, limitRows: 200 });
    history = { ...older, items: older.items.concat(history.items) };
  }
  assert.equal(history.hasMore, false);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result = await page.evaluate(async ({ snapshot, history }) => {
    const host = document.getElementById('terminal-container');
    const terminal = new Terminal({ cols: snapshot.cols, rows: snapshot.rows, scrollback: 120,
      fontSize: 13, theme: { background: '#1a192d', foreground: '#ccc' } });
    terminal.open(host);
    await new Promise(resolve => terminal.write(snapshot.data, resolve));
    terminal.scrollToLine(0);
    const layer = DuoTerminalHistoryLayer.createHistoryLayer({ cols: terminal.cols, getTerminal: () => terminal });
    host.appendChild(layer.root);
    layer.show({ hasMore: true, nextCursor: snapshot.historyCursor, deltaY: -60 });
    layer.prepend({ ...history, requestId: undefined });
    const scroller = layer.root.querySelector('.terminal-history-scroller');
    scroller.scrollTop = 0;
    for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame);
    const native = [];
    for (let row = 0; row < terminal.buffer.normal.length; row++) {
      const line = terminal.buffer.normal.getLine(row);
      if (line.isWrapped && native.length) native[native.length - 1] += line.translateToString(true);
      else native.push(line.translateToString(true));
    }
    const combined = layer.getItems().map(line => line.text).concat(native);
    return {
      welcomeCount: combined.filter(text => text === 'Claude Code v2.1.165').length,
      modelCount: combined.filter(text => text === '> /model').length,
      mountedWelcomeCount: [...layer.root.querySelectorAll('.terminal-history-row')]
        .filter(node => node.textContent === 'Claude Code v2.1.165').length,
      archiveCount: layer.getItems().length,
    };
  }, { snapshot, history });
  mkdirSync('tests/.artifacts/claude-mobile-history', { recursive: true });
  await page.screenshot({ path: 'tests/.artifacts/claude-mobile-history/after.png' });
  assert.equal(result.welcomeCount, 1, JSON.stringify(result));
  assert.equal(result.modelCount, 1, JSON.stringify(result));
  assert.equal(result.mountedWelcomeCount, 1, JSON.stringify(result));
  assert.ok(result.archiveCount > 0);
  assert.deepEqual(errors, []);
  console.log('PASS Claude mobile history renders one welcome and one model command after repeated reflow');
} finally {
  state.dispose();
  if (browser) await closeTestBrowser(browser);
  await new Promise(resolve => server.close(resolve));
}
