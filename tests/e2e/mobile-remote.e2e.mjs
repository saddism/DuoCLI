// Real remote HTTP/WS backend and real mobile page; only the PTY is a fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { closeTestBrowser } from './browser-cleanup.mjs';
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
  await check('an empty reconnect snapshot clears the obsolete screen after the CLI reset while offline', async () => {
    output('\x1bcOLD_SCREEN_BEFORE_DISCONNECT'); await settle();
    await page.evaluate(() => closeWebSocket());
    output('\x1bc');
    let snapshot;
    await state.snapshot(value => { snapshot = value; });
    assert.equal(snapshot.data, '');
    await page.evaluate(() => connectWebSocket(currentSessionId));
    await page.waitForFunction(sequence => terminalSequence >= sequence && terminalInputReady, {}, snapshot.sequence);
    await page.evaluate(() => terminalWriteQueue);
    assert.deepEqual(await page.evaluate(() => {
      const b = term.buffer.active;
      return { lines: Array.from({ length: term.rows }, (_, i) => b.getLine(b.baseY + i).translateToString(true)),
        cursor: [b.cursorX, b.cursorY], cols: term.cols, rows: term.rows };
    }), readBuffer(state.terminal));
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
  await check('a send tapped during a brief replay waits and submits once', async () => {
    inputs.length = 0;
    await page.evaluate(() => {
      document.getElementById('msg-input').value = 'send after replay';
      setTerminalInputReady(false);
      window.pendingReplaySend = sendMessage();
    });
    await sleep(80);
    assert.deepEqual(inputs, []);
    await page.evaluate(() => setTerminalInputReady(true));
    await page.evaluate(() => window.pendingReplaySend);
    assert.deepEqual(inputs, ['\x1b[200~send after replay\x1b[201~', '\r']);
  });
  await check('send button stays clickable for a draft during brief replay', async () => {
    inputs.length = 0;
    const enabled = await page.evaluate(() => {
      document.getElementById('msg-input').value = 'send from button';
      setTerminalInputReady(false);
      return !document.getElementById('send-btn').disabled;
    });
    assert.equal(enabled, true);
    await page.click('#send-btn');
    await sleep(80);
    await page.evaluate(() => setTerminalInputReady(true));
    await page.waitForFunction(() => document.getElementById('msg-input').value === '', { timeout: 5000 });
    await sleep(100);
    assert.deepEqual(inputs, ['\x1b[200~send from button\x1b[201~', '\r']);
  });
  await check('editing a draft cancels a queued replay send', async () => {
    inputs.length = 0;
    await page.evaluate(() => {
      document.getElementById('msg-input').value = 'old draft';
      setTerminalInputReady(false);
      window.pendingReplaySend = sendMessage();
      document.getElementById('msg-input').value = 'edited draft';
      setTerminalInputReady(true);
    });
    await page.evaluate(() => window.pendingReplaySend);
    assert.deepEqual(inputs, []);
    assert.equal(await page.$eval('#msg-input', input => input.value), 'edited draft');
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
      await page.waitForFunction(() => terminalInputReady && !document.getElementById('send-btn').disabled,
        { timeout: 3000 });
      await page.evaluate(() => {
        term.scrollToBottom();
        isUserScrolling = false;
        document.getElementById('msg-input').value = '';
      });
      inputs.length = 0;
      await page.type('#msg-input', scenario.command);
      await page.click('#send-btn');
      await page.waitForFunction(() => !composerSubmission && !document.getElementById('send-btn').disabled, { timeout: 3000 });
      const sendState = await page.evaluate(() => ({
        value: document.getElementById('msg-input').value,
        ready: terminalInputReady,
        hasSubmission: composerSubmissions.has(currentSessionId),
        pending: Boolean(composerSubmission),
        wsReady: ws?.readyState === WebSocket.OPEN,
        currentSessionId, wsSessionId, online: navigator.onLine, inputReady: isTerminalInputReady(),
        toast: document.getElementById('copy-toast')?.textContent,
      }));
      assert.deepEqual(inputs, [`\x1b[200~${scenario.command}\x1b[201~`, '\r'], JSON.stringify(sendState));

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
  await check('three lost acknowledgements and a restored pending send still write only once', async () => {
    inputs.length = 0;
    const result = await page.evaluate(async () => {
      const original = requestSubmission;
      const input = document.getElementById('msg-input');
      const ids = [];
      try {
        requestSubmission = async (sessionId, text, id, source) => {
          ids.push(id);
          await original(sessionId, text, id, source);
          if (ids.length <= 3) throw new Error('fixture lost acknowledgement');
        };
        input.value = 'retry must not execute twice';
        for (let i = 0; i < 4; i++) {
          if (i === 2) {
            mobilePendingSubmissions.clear();
            loadMobilePendingSubmissions();
            restoreMobileDraft(currentSessionId);
          }
          await sendMessage();
        }
        return { ids, draft: input.value, pending: mobilePendingSubmissions.has(currentSessionId) };
      } finally { requestSubmission = original; }
    });
    assert.equal(result.ids.length, 4);
    assert.equal(new Set(result.ids).size, 1);
    assert.deepEqual(inputs, ['\x1b[200~retry must not execute twice\x1b[201~', '\r']);
    assert.equal(result.draft, '');
    assert.equal(result.pending, false);
  });
  await check('a deliberately repeated message after acknowledgement remains a new send', async () => {
    inputs.length = 0;
    await page.evaluate(async () => {
      const input = document.getElementById('msg-input');
      input.value = 'continue again';
      await sendMessage();
      input.value = 'continue again';
      await sendMessage();
    });
    assert.deepEqual(inputs, ['\x1b[200~continue again\x1b[201~', '\r', '\x1b[200~continue again\x1b[201~', '\r']);
  });
  await check('HTTP fallback keeps its original target after the visible session changes', async () => {
    inputs.length = 0;
    await page.evaluate(async () => {
      const socket = ws;
      const id = currentSessionId;
      try {
        ws = null;
        currentSessionId = 'another-visible-session';
        await requestSubmission(id, 'original target', 'fixture-fallback-target', 'terminal');
      } finally { ws = socket; currentSessionId = id; }
    });
    assert.deepEqual(inputs, ['\x1b[200~original target\x1b[201~', '\r']);
  });
  await check('synthetic click after a failed touch send does not resubmit its restored draft', async () => {
    const result = await page.evaluate(async () => {
      const original = requestSubmission;
      let sends = 0;
      const input = document.getElementById('msg-input');
      const button = document.getElementById('send-btn');
      try {
        requestSubmission = async () => { sends++; throw new Error('fixture offline'); };
        input.value = 'touch once';
        button.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
        await new Promise(resolve => setTimeout(resolve, 50));
        button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
        await new Promise(resolve => setTimeout(resolve, 50));
        return { sends, text: input.value };
      } finally {
        requestSubmission = original;
        mobilePendingSubmissions.delete(currentSessionId);
        saveMobilePendingSubmissions();
        input.value = '';
        saveCurrentMobileDraft();
        suppressSendClickUntil = 0;
      }
    });
    assert.deepEqual(result, { sends: 1, text: 'touch once' });
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
  await check('missing session replay returns to the list without enabling input', async () => {
    await page.evaluate(() => connectWebSocket('missing-session'));
    await page.waitForFunction(() => currentSessionId === null, { timeout: 5000 });
    assert.deepEqual(await page.evaluate(() => ({ ready: terminalInputReady,
      detailVisible: document.getElementById('detail-page').classList.contains('active') })),
    { ready: false, detailVisible: false });
  });

  await check('current Cursor tools fold through the mobile session profile while the answer stays visible', async () => {
    session.cliKind = 'cursor';
    await page.evaluate(async () => {
      activeSessionsCache = await api('/api/sessions');
      await openSession('test');
    });
    await page.waitForFunction(() => terminalInputReady);
    output('\x1bc  I will read audit.txt.\r\n\r\n    Globbed, read 1 glob, 1 file\r\n    Read audit.txt\r\n\r\n  DUOCLI_AUDIT_OK_42\r\n\r\n  → Add a follow-up');
    await settle();
    await page.waitForFunction(() => terminalFoldView?.isVisible(), { timeout: 5000 }).catch(async error => {
      console.log('FOLD_SCROLL_DIAGNOSTIC', JSON.stringify(await page.evaluate(() => ({
        touchActive: terminalTouchActive, momentumActive: panMomentumRunner?.active(),
        bufferType: term.buffer.active.type, cli: activeSessionsCache.find(s => s.id === currentSessionId)?.cli,
        pending: document.getElementById('terminal-container').classList.contains('terminal-reveal-pending'),
        hidden: terminalFoldView?.root.hidden,
        rows: Array.from({ length: term.buffer.active.length }, (_, i) => term.buffer.active.getLine(i)?.translateToString(true)),
      }))));
      throw error;
    });
    assert.equal(await page.$$eval('.terminal-activity-group', nodes => nodes.length), 1);
    assert.doesNotMatch(await page.$eval('.terminal-activity-group pre', node => node.textContent), /DUOCLI_AUDIT_OK/);
    assert.match(await page.$$eval('.terminal-activity-plain', nodes => nodes.map(node => node.textContent).join('\n')), /DUOCLI_AUDIT_OK_42/);
  });

  // Real transcript file -> remote HTTP wait -> shipped mobile renderer.
  process.env.CLAUDE_CONFIG_DIR = process.env.DUOCLI_REMOTE_CONFIG_DIR;
  const project = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', session.cwd.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(project, { recursive: true });
  const transcript = path.join(project, 'mobile-live-chat.jsonl');
  const record = (id, text, role = 'assistant') => JSON.stringify({ type: role, uuid: id, message: { content: text } }) + '\n';
  fs.writeFileSync(transcript, Array.from({ length: 20 }, (_, index) => record(`history-${index}`,
    index % 2 === 0 ? '帮我检查手机端对话的更新。' : '正在检查消息同步与阅读位置。\n新的回复会出现在对话底部。', index % 2 === 0 ? 'user' : 'assistant')).join(''));
  session.cliKind = 'claude';
  session.resumeId = 'mobile-live-chat';
  await check('transcript changes reach mobile chat through the waiting request', async () => {
    await page.evaluate(async () => {
      activeSessionsCache = await api('/api/sessions');
      await openSession('test');
    });
    await page.waitForFunction(() => terminalInputReady);
    await page.click('#detail-more-btn');
    await Promise.all([
      page.waitForRequest(request => request.url().includes('/chat?') && request.url().includes('wait=10000'), { timeout: 5000 }),
      page.click('#terminal-return-chat'),
    ]);
    await sleep(250);
    const writtenAt = Date.now();
    fs.appendFileSync(transcript, record('live-answer', '新的回复已到达手机。'));
    await page.waitForFunction(() => document.getElementById('chat-transcript').textContent.includes('新的回复已到达手机。'), { polling: 'mutation', timeout: 2000 });
    const latency = Date.now() - writtenAt;
    assert.ok(latency < 1500, `append-to-render took ${latency}ms`);
    assert.equal(await page.evaluate(() => isChatPinnedToBottom()), true);
    console.log(`chat transcript append to mobile render: ${latency}ms`);
  });
  await check('same-message changes notify readers without moving their history position', async () => {
    const before = await page.evaluate(() => {
      const scroller = document.getElementById('chat-transcript');
      scroller.scrollTop = 150;
      return scroller.scrollTop;
    });
    fs.appendFileSync(transcript, record('live-answer', '新的回复已到达手机。\n同一条消息现在补充了验证结果。'));
    await page.waitForFunction(() => !document.getElementById('chat-new-messages').hidden, { timeout: 2000 });
    assert.ok(Math.abs(await page.$eval('#chat-transcript', el => el.scrollTop) - before) < 2);
    await page.click('#chat-new-messages');
    assert.equal(await page.evaluate(() => isChatPinnedToBottom()), true);
  });
  await check('copying a complete message preserves its original markdown and code without button labels', async () => {
    const text = '# 验证结果\n\n- 保留原文\n\n```sh\nprintf "hello"\n```';
    fs.appendFileSync(transcript, record('copy-original', text));
    await page.waitForFunction(() => document.querySelector('.native-chat-msg:last-child .native-chat-code'));
    await page.evaluate(() => {
      window.__chatCopies = [];
      window.__clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
      Object.defineProperty(navigator, 'clipboard', { configurable: true,
        value: { writeText: async text => { window.__chatCopies.push(text); } } });
    });
    try {
      await page.click('.native-chat-msg:last-child .native-chat-copy-msg');
      assert.deepEqual(await page.evaluate(() => window.__chatCopies), [text]);
      await page.click('.native-chat-msg:last-child .native-chat-copy');
      assert.deepEqual(await page.evaluate(() => window.__chatCopies), [text, 'printf "hello"\n']);
    } finally {
      await page.evaluate(() => {
        if (window.__clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', window.__clipboardDescriptor);
        else delete navigator.clipboard;
      });
    }
  });
  await check('LAN chat copying falls back when Clipboard API is unavailable and reports actual failure', async () => {
    await page.evaluate(() => {
      window.__clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
      window.__originalExecCommand = document.execCommand;
      window.__fallbackCopies = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
      document.execCommand = command => {
        if (command === 'copy') window.__fallbackCopies.push(document.querySelector('textarea[readonly]')?.value);
        return true;
      };
    });
    try {
      await page.click('.native-chat-msg:last-child .native-chat-copy');
      await page.waitForFunction(() => window.__fallbackCopies.length === 1, { timeout: 1000 });
      assert.deepEqual(await page.evaluate(() => window.__fallbackCopies), ['printf "hello"\n']);
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', { configurable: true,
          value: { writeText: async () => { throw new Error('clipboard denied'); } } });
        document.execCommand = () => false;
      });
      await page.click('.native-chat-msg:last-child .native-chat-copy-msg');
      await page.waitForFunction(() => document.getElementById('copy-toast')?.textContent === '复制失败', { timeout: 1000 });
    } finally {
      await page.evaluate(() => {
        document.execCommand = window.__originalExecCommand;
        if (window.__clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', window.__clipboardDescriptor);
        else delete navigator.clipboard;
      });
    }
  });
  await check('returning from background resumes chat immediately', async () => {
    const other = await browser.newPage();
    try {
      await other.bringToFront();
      await page.waitForFunction(() => document.hidden && !chatRefreshController);
      fs.appendFileSync(transcript, record('background-answer', '回到前台后已同步。'));
      await page.bringToFront();
      await page.waitForFunction(() => document.getElementById('chat-transcript').textContent.includes('回到前台后已同步。'), { timeout: 2000 });
    } finally { await other.close(); }
  });
  await check('switching the native thread discards expanded history from the previous conversation', async () => {
    await page.evaluate(() => stopNativeChatPolling());
    fs.appendFileSync(transcript, Array.from({ length: 360 }, (_, index) =>
      record(`old-thread-${index}`, `OLD_THREAD_HISTORY_${index}`)).join(''));
    await page.evaluate(() => startNativeChatPolling('test'));
    await page.waitForFunction(() => chatSnapshots.get('test')?.hasMore === true);
    await page.evaluate(() => loadOlderChatMessages('test'));
    await page.waitForFunction(() => chatSnapshots.get('test')?.startIndex === 0);
    const nextId = 'mobile-next-chat';
    fs.writeFileSync(path.join(project, `${nextId}.jsonl`), Array.from({ length: 360 }, (_, index) =>
      record(`new-thread-${index}`, `NEW_THREAD_HISTORY_${index}`)).join(''));
    session.resumeId = nextId;
    await page.evaluate(() => startNativeChatPolling('test'));
    await page.waitForFunction(id => chatSnapshots.get('test')?.sessionId === id, {}, nextId);
    const snapshot = await page.evaluate(() => chatSnapshots.get('test'));
    assert.equal(snapshot.startIndex, 60);
    assert.equal(snapshot.messages.length, 300);
    assert.ok(snapshot.messages.every(message => message.blocks[0].text.startsWith('NEW_THREAD_HISTORY_')));
    assert.doesNotMatch(await page.$eval('#chat-transcript', node => node.textContent), /OLD_THREAD_HISTORY_/);
  });
  await check('rewinding the same conversation never retains history from an abandoned branch', async () => {
    await page.evaluate(() => loadOlderChatMessages('test'));
    await page.waitForFunction(() => chatSnapshots.get('test')?.startIndex === 0);
    fs.writeFileSync(path.join(project, 'mobile-next-chat.jsonl'), Array.from({ length: 360 }, (_, index) =>
      record(`rew-thread-${index}`, `REW_THREAD_HISTORY_${index}`)).join(''));
    await page.waitForFunction(() => chatSnapshots.get('test')?.messages.at(-1)?.id === 'rew-thread-359');
    const snapshot = await page.evaluate(() => chatSnapshots.get('test'));
    assert.equal(snapshot.startIndex, 60);
    assert.equal(snapshot.messages.length, 300);
    assert.ok(snapshot.messages.every(message => message.blocks[0].text.startsWith('REW_THREAD_HISTORY_')));
    assert.doesNotMatch(await page.$eval('#chat-transcript', node => node.textContent), /NEW_THREAD_HISTORY_/);
  });
  await check('temporarily unavailable histories preserve already rendered messages', async () => {
    const file = path.join(project, 'mobile-next-chat.jsonl');
    fs.renameSync(file, `${file}.unavailable`);
    try {
      await page.waitForFunction(() => document.getElementById('chat-status').dataset.state === 'error');
      assert.match(await page.$eval('#chat-transcript', node => node.textContent), /REW_THREAD_HISTORY_359/);
      assert.equal(await page.$('.native-chat-empty'), null);
    } finally { fs.renameSync(`${file}.unavailable`, file); }
    await page.waitForFunction(() => document.getElementById('chat-status').hidden);
  });
  await check('small screens keep updates, long status messages and composer controls separate', async () => {
    await page.waitForFunction(() => !document.getElementById('copy-toast')
      || getComputedStyle(document.getElementById('copy-toast')).opacity === '0');
    await page.evaluate(() => {
      stopNativeChatPolling();
      setChatStatus('同步暂时中断，正在重试。已显示的消息会保留，可以点击同步重新连接。', 'error');
      document.getElementById('chat-transcript').scrollTop = 100;
      document.getElementById('chat-new-messages').hidden = false;
      document.getElementById('msg-input').value = '';
      resizeComposer();
    });
    for (const [width, height] of [[320, 568], [390, 760], [390, 430]]) {
      await page.setViewport({ width, height, isMobile: true, hasTouch: true });
      const layout = await page.evaluate(() => {
        const box = selector => document.querySelector(selector).getBoundingClientRect();
        const badge = box('#chat-new-messages');
        const footer = box('.native-chat-footer');
        const send = box('#send-btn');
        const transcript = box('#chat-transcript');
        return { fits: document.body.scrollWidth <= innerWidth && send.bottom <= innerHeight && send.right <= innerWidth,
          separated: badge.bottom <= footer.top && transcript.height > 100,
          statusFits: document.getElementById('chat-status').scrollWidth <= box('#chat-status').width + 1 };
      });
      assert.ok(layout.fits && layout.separated && layout.statusFits, JSON.stringify({ width, height, ...layout }));
      await page.screenshot({ path: path.join(process.env.DUOCLI_REMOTE_CONFIG_DIR, `chat-sync-${width}-${height}.png`) });
    }
  });
  await page.screenshot({ path: path.join(process.env.DUOCLI_REMOTE_CONFIG_DIR, 'mobile-regression.png') });
  assert.deepEqual(errors, []);
} finally {
  await closeTestBrowser(browser);
  state.dispose();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
console.log(`${results.filter(Boolean).length}/${results.length} passed; artifacts: ${process.env.DUOCLI_REMOTE_CONFIG_DIR}`);
process.exit(results.every(Boolean) ? 0 : 1);
