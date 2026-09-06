// Real remote HTTP/WS backend and real mobile page; only the PTY is a fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { resolveChromeExecutable } from './chrome-path.mjs';
import { PtyManager } from '../../dist/main/pty-manager.js';
import { TerminalState } from '../../dist/main/terminal-state.js';

process.env.DUOCLI_REMOTE_PORT = '0';
process.env.DUOCLI_REMOTE_HOST = '127.0.0.1';
process.env.DUOCLI_REMOTE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'duocli-remote-test-'));
const { startRemoteServer, pushRawDataToRemote } = await import('../../dist/main/remote-server.js');
const manager = new PtyManager({ onData() {}, onTitleUpdate() {}, onExit() {},
  onResize(id, cols, rows) { pushRawDataToRemote(id, '', undefined, { cols, rows }); } });
const state = new TerminalState();
const session = { id: 'test', title: 'terminal regression', presetCommand: 'qoder', cwd: os.tmpdir(),
  ptyProcess: { pid: process.pid, resize() {} }, terminalState: state,
  rawBuffer: '', lastSequence: 0,
  submissions: new Map(), submitQueue: Promise.resolve(), currentCols: 80, currentRows: 24,
  sizeBySource: { desktop: null, mobile: null }, sizeOwner: null, lastInputAt: { desktop: 0, mobile: 0 } };
manager.sessions.set('test', session);
const inputs = [];
manager.write = (_id, data) => inputs.push(data);
let server;
const info = await new Promise(resolve => { server = startRemoteServer(manager, undefined, undefined, resolve); });
const origin = `http://127.0.0.1:${info.port}`;
const browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const output = data => {
  // Match the real PTY callback order: rawBuffer is updated only after the
  // parsed terminal state publishes its sequence.
  state.write(data, seq => {
    session.rawBuffer += data;
    session.lastSequence = seq;
    pushRawDataToRemote('test', data, seq);
  });
};
const settle = async () => {
  let seq;
  await state.snapshot(value => { seq = value.sequence; });
  await page.waitForFunction(value => terminalSequence === value, {}, seq);
  await page.evaluate(() => terminalWriteQueue);
};
const readBuffer = term => {
  const b = term.buffer.active;
  return { lines: Array.from({ length: b.length }, (_, i) => b.getLine(i).translateToString(true)), cursor: [b.cursorX, b.cursorY], cols: term.cols, rows: term.rows };
};
const results = [];
async function check(name, run) {
  try { await run(); results.push(true); console.log('PASS', name); }
  catch (e) { results.push(false); console.error('FAIL', name, e.message.slice(0, 800)); }
}
try {
  await page.setViewport({ width: 390, height: 760, isMobile: true, hasTouch: true });
  await page.goto(`${origin}/?token=${info.token}`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.session-card');
  await page.click('.session-card');
  await page.waitForFunction(() => term && terminalSequence >= 0);
  await sleep(600);
  await check('initial geometry is acknowledged by the backend', async () => {
    assert.deepEqual(await page.evaluate(() => [term.cols, term.rows]), [state.terminal.cols, state.terminal.rows]);
  });
  await check('standalone spinner redraw is not discarded', async () => {
    output('\x1bcREADY'); await settle();
    output('\r\x1b[2K⠋ 正在处理'); await settle();
    assert.equal(await page.evaluate(() => term.buffer.active.getLine(0).translateToString(true)),
      state.terminal.buffer.active.getLine(0).translateToString(true));
  });
  for (const name of ['qoder-cn', 'cursor', 'antigravity', 'codex']) {
    await check(`${name}: live output equals canonical terminal`, async () => {
      // Recordings were captured at 43x33. Keep all parsers at that geometry.
      manager.resize('test', 43, 33, 'mobile', true);
      output('\x1bc');
      const fixture = JSON.parse(fs.readFileSync(new URL(`../fixtures/terminal/${name}.json`, import.meta.url)));
      for (const chunk of fixture.chunks) { output(chunk.data); await sleep(2); }
      await settle();
      assert.deepEqual(await page.evaluate(readBuffer => {
        const b = term.buffer.active;
        return { lines: Array.from({ length: b.length }, (_, i) => b.getLine(i).translateToString(true)), cursor: [b.cursorX, b.cursorY], cols: term.cols, rows: term.rows };
      }), readBuffer(state.terminal));
    });
  }
  await check('reconnect during output neither loses nor duplicates history', async () => {
    output('\x1bc' + 'history 中文\r\n'.repeat(150));
    await settle();
    await page.evaluate(() => { term.scrollToLine(20); isUserScrolling = true; connectWebSocket(currentSessionId); });
    for (let i = 0; i < 60; i++) output(`line ${i}\r\n`);
    await sleep(400);
    await settle();
    assert.deepEqual(await page.evaluate(() => {
      const b = term.buffer.active;
      return { lines: Array.from({ length: b.length }, (_, i) => b.getLine(i).translateToString(true)), cursor: [b.cursorX, b.cursorY], cols: term.cols, rows: term.rows };
    }), readBuffer(state.terminal));
    assert.equal(await page.evaluate(() => term.buffer.active.viewportY), 20);
  });
  await check('canvas recreation preserves a history-reading viewport', async () => {
    const previous = await page.evaluate(() => {
      window.__previousTerm = term;
      term.scrollToLine(18); isUserScrolling = true;
      return term.buffer.active.viewportY;
    });
    assert.equal(previous, 18);
    await page.evaluate(() => forceTerminalRecreate());
    await page.waitForFunction(() => term !== window.__previousTerm && terminalSequence >= 0);
    await sleep(350);
    await page.evaluate(() => terminalWriteQueue);
    assert.equal(await page.evaluate(() => term.buffer.active.viewportY), 18);
  });
  await check('healthy BFCache pageshow refreshes without recreating the terminal', async () => {
    const same = await page.evaluate(async () => {
      const before = term;
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      await new Promise(resolve => setTimeout(resolve, 450));
      return term === before;
    });
    assert.equal(same, true);
  });
  await check('a wheel gesture cancels a pending follow-to-bottom frame', async () => {
    await page.evaluate(() => {
      term.scrollToBottom();
      scrollTerminalToBottom();
      document.getElementById('terminal-container').dispatchEvent(new WheelEvent('wheel', { deltaY: -160, bubbles: true }));
      term.scrollLines(-6);
    });
    output('new while reading\r\n'); await settle();
    assert.ok(await page.evaluate(() => term.buffer.active.baseY - term.buffer.active.viewportY) >= 6);
  });
  await check('keyboard-height resize matches backend rows and columns', async () => {
    await page.setViewport({ width: 390, height: 500, isMobile: true, hasTouch: true });
    await sleep(900);
    assert.deepEqual(await page.evaluate(() => [term.cols, term.rows]), [state.terminal.cols, state.terminal.rows]);
    assert.ok(state.terminal.rows < 33);
  });
  await check('double tap submits once; an empty send emits no Enter', async () => {
    output('\x1b[?2004h'); await settle();
    inputs.length = 0;
    await page.type('#msg-input', '你好 Cursor');
    await page.evaluate(() => { sendMessage(); sendMessage(); });
    await sleep(250);
    await page.evaluate(() => sendMessage());
    assert.deepEqual(inputs, ['\x1b[200~你好 Cursor\x1b[201~', '\r']);
  });
  await check('quick command button submits one paste and one Enter', async () => {
    output('\x1b[?2004h'); await settle();
    inputs.length = 0;
    const label = await page.evaluate(() => {
      const real = window.confirm;
      window.confirm = () => true;
      const btn = document.querySelector('.qcmd-btn');
      btn.click();
      window.confirm = real;
      return btn.textContent;
    });
    await sleep(250);
    assert.deepEqual(inputs, [`\x1b[200~${label}\x1b[201~`, '\r']);
  });
  for (const scenario of [
    {
      name: 'Cursor',
      command: 'repair the stale prompt',
      initial: '\x1bc\x1b[?2004h\x1b[2K\r› previous command',
      result: '\x1b[2K\r› repair the stale prompt\r\nCURSOR_EXECUTED\r\n› ',
      marker: 'CURSOR_EXECUTED',
    },
    {
      name: 'Codex',
      command: 'run the requested change',
      initial: '\x1bc\x1b[?2004h\x1b[2K\r› previous command',
      result: '\x1b[2K\r› run the requested change\r\nCODEX_EXECUTED\r\n› ',
      marker: 'CODEX_EXECUTED',
    },
  ]) {
    await check(`${scenario.name}: one click replaces the old prompt and executes once`, async () => {
      // These are representative TUI prompt redraws: the old input is erased
      // before the new prompt and completion line are painted.
      output(scenario.initial); await settle();
      await page.evaluate(() => {
        term.scrollToBottom();
        isUserScrolling = false;
        document.getElementById('msg-input').value = '';
      });
      inputs.length = 0;
      await page.type('#msg-input', scenario.command);
      await page.click('#send-btn');
      await page.waitForFunction(() => !composerSubmission && !document.getElementById('send-btn').disabled, { timeout: 3000 });
      assert.deepEqual(inputs, [`\x1b[200~${scenario.command}\x1b[201~`, '\r']);

      output(scenario.result); await settle();
      const screen = await page.evaluate(() => Array.from(
        { length: term.buffer.active.length },
        (_, index) => term.buffer.active.getLine(index).translateToString(true),
      ).join('\n'));
      assert.equal((screen.match(new RegExp(scenario.marker, 'g')) || []).length, 1);
      assert.match(screen, new RegExp(scenario.command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.doesNotMatch(screen, /previous command/);
    });
  }
  await check('HTTP retry shares WebSocket submission deduplication', async () => {
    inputs.length = 0;
    await manager.submit('test', 'retry-test', 'same request');
    const response = await fetch(`${origin}/api/sessions/test/input?token=${info.token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ submissionId: 'retry-test', input: 'same request' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(inputs, ['\x1b[200~same request\x1b[201~', '\r']);
  });
  await check('Shift+Enter keeps a multiline draft without submitting', async () => {
    inputs.length = 0;
    await page.focus('#msg-input');
    await page.type('#msg-input', 'first');
    await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift');
    await page.type('#msg-input', 'second');
    await sleep(200);
    assert.equal(await page.$eval('#msg-input', el => el.value), 'first\nsecond');
    assert.equal(inputs.length, 0);
  });
  await check('IME confirmation Enter does not submit the composition', async () => {
    inputs.length = 0;
    await page.$eval('#msg-input', el => {
      el.value = '';
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      el.value = '中文输入';
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }));
      el.dispatchEvent(new CompositionEvent('compositionend', { data: '中文输入', bubbles: true }));
      el.dispatchEvent(new InputEvent('input', { data: '中文输入', inputType: 'insertCompositionText', bubbles: true }));
    });
    await sleep(150);
    assert.equal(inputs.length, 0);
    assert.equal(await page.$eval('#msg-input', el => el.value), '中文输入');
    await page.click('#send-btn'); await sleep(250);
    assert.deepEqual(inputs, ['\x1b[200~中文输入\x1b[201~', '\r']);
  });
  await page.screenshot({ path: path.join(process.env.DUOCLI_REMOTE_CONFIG_DIR, 'mobile-regression.png') });
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  state.dispose();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
console.log(`${results.filter(Boolean).length}/${results.length} passed; artifacts: ${process.env.DUOCLI_REMOTE_CONFIG_DIR}`);
process.exit(results.every(Boolean) ? 0 : 1);
