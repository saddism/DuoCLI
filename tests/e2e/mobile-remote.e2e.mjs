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
page.on('pageerror', e => { errors.push(e.message); console.error('BROWSER_ERROR', e.stack || e.message); });
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
  return { lines: Array.from({ length: term.rows }, (_, i) => b.getLine(b.baseY + i).translateToString(true)), cursor: [b.cursorX, b.cursorY], cols: term.cols, rows: term.rows };
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
  await check('embedded RFB is available without standalone noVNC UI startup', async () => {
    assert.deepEqual(await page.evaluate(() => [typeof window.RFB, typeof window.NoVNC?.RFB]), ['function', 'function']);
  });
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
    await check(`${name}: live screen equals canonical terminal`, async () => {
      // Recordings were captured at 43x33. Keep all parsers at that geometry.
      // Negotiate through the actual browser protocol. A direct manager call
      // cannot stand in for the current resize ACK/snapshot handshake.
      await page.evaluate(() => {
        lastSentCols = 43; lastSentRows = 33;
        wsSend({ type: 'resize', cols: 43, rows: 33 });
      });
      await page.waitForFunction(() => term.cols === 43 && term.rows === 33);
      await page.evaluate(() => terminalWriteQueue);
      output('\x1bc');
      const fixture = JSON.parse(fs.readFileSync(new URL(`../fixtures/terminal/${name}.json`, import.meta.url)));
      for (const chunk of fixture.chunks) { output(chunk.data); await sleep(2); }
      await settle();
      assert.deepEqual(await page.evaluate(readBuffer => {
        const b = term.buffer.active;
        return { lines: Array.from({ length: term.rows }, (_, i) => b.getLine(b.baseY + i).translateToString(true)), cursor: [b.cursorX, b.cursorY], cols: term.cols, rows: term.rows };
      }), readBuffer(state.terminal));
    });
  }
  await check('reconnect preserves the history anchor and delivers every output line exactly once', async () => {
    output('\x1bc' + 'history 中文\r\n'.repeat(150));
    await settle();
    await page.evaluate(() => enterTerminalHistory());
    await page.waitForFunction(() => terminalHistoryLayer?.getItems().length > 0 && !terminalHistoryLoading);
    const previous = await page.evaluate(() => {
      const scroller = terminalHistoryLayer.root.querySelector('.terminal-history-scroller');
      scroller.scrollTop = 180;
      const anchor = terminalHistoryLayer.captureAnchor();
      connectWebSocket(currentSessionId);
      return anchor;
    });
    for (let i = 0; i < 60; i++) output('line ' + i + String.fromCharCode(13, 10));
    await sleep(400);
    await settle();
    const current = await page.evaluate(() => terminalHistoryLayer.captureAnchor());
    assert.equal(current.lineId, previous.lineId);
    assert.ok(Math.abs(current.pixelOffset - previous.pixelOffset) < 2);
    // Compare the current screen, not an intentionally discarded xterm
    // scrollback. Verify the older part separately through real pagination.
    assert.deepEqual(await page.evaluate(() => {
      const b = term.buffer.active;
      return { lines: Array.from({ length: term.rows }, (_, i) => b.getLine(b.baseY + i).translateToString(true)),
        cursor: [b.cursorX, b.cursorY], cols: term.cols, rows: term.rows };
    }), readBuffer(state.terminal));
    await page.evaluate(() => { exitTerminalHistory(); enterTerminalHistory(); });
    await page.waitForFunction(() => terminalHistoryLayer?.getItems().length > 0 && !terminalHistoryLoading);
    const delivered = await page.evaluate(() => {
      const b = term.buffer.active;
      const visible = Array.from({ length: term.rows }, (_, i) => b.getLine(b.baseY + i).translateToString(true));
      return [...terminalHistoryLayer.getItems().map(item => item.text), ...visible]
        .filter(line => /^line \d+$/.test(line)).map(line => Number(line.slice(5)));
    });
    assert.deepEqual(delivered, Array.from({ length: 60 }, (_, i) => i));
  });
  await check('canvas recreation preserves the paged history line and pixel anchor', async () => {
    const previous = await page.evaluate(() => {
      window.__previousTerm = term;
      terminalHistoryLayer.root.querySelector('.terminal-history-scroller').scrollTop = 180;
      return terminalHistoryLayer.captureAnchor();
    });
    assert.ok(previous);
    await page.evaluate(() => forceTerminalRecreate());
    await page.waitForFunction(() => term !== window.__previousTerm && terminalSequence >= 0);
    await sleep(350);
    await page.evaluate(() => terminalWriteQueue);
    const current = await page.evaluate(() => ({ visible: terminalHistoryLayer.isVisible(), anchor: terminalHistoryLayer.captureAnchor() }));
    assert.equal(current.visible, true);
    assert.equal(current.anchor.lineId, previous.lineId);
    assert.ok(Math.abs(current.anchor.pixelOffset - previous.pixelOffset) < 2);
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
    await page.evaluate(() => exitTerminalHistory());
    output('wheel prelude\r\n'.repeat(20)); await settle();
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
    console.log('RESIZE_DIAGNOSTIC', JSON.stringify({ backend: [state.terminal.cols, state.terminal.rows],
      browser: await page.evaluate(() => ({ size: [term.cols, term.rows], sent: [lastSentCols, lastSentRows],
        proposed: fitAddon.proposeDimensions(), timer: resizeSendTimer !== null,
        state: ws?.readyState, visibility: document.visibilityState,
        pending: document.getElementById('terminal-container').classList.contains('terminal-reveal-pending') })) }));
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
  await check('WebSocket rejects a submission for a session other than its subscription', async () => {
    inputs.length = 0;
    await page.evaluate(() => wsSend({ type: 'submit', sessionId: 'other-session', id: 'wrong-target', text: 'must not run' }));
    await sleep(100);
    assert.deepEqual(inputs, []);
  });
  await check('quick command inserts a draft and explicit send submits once', async () => {
    output('\x1b[?2004h'); await settle();
    inputs.length = 0;
    const label = await page.evaluate(() => {
      const btn = document.querySelector('.qcmd-btn[data-command]');
      const pointer = { bubbles: true, button: 0, clientX: 8, clientY: 8, pointerId: 1, pointerType: 'mouse', isPrimary: true };
      btn.dispatchEvent(new PointerEvent('pointerdown', pointer));
      btn.dispatchEvent(new PointerEvent('pointerup', pointer));
      return btn.dataset.command;
    });
    await page.waitForSelector('#mobile-confirm-dialog [data-confirm="yes"]');
    await page.click('#mobile-confirm-dialog [data-confirm="yes"]');
    assert.deepEqual(inputs, []);
    assert.equal(await page.$eval('#msg-input', input => input.value), label);
    await page.click('#send-btn');
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
