import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { closeTestBrowser } from './browser-cleanup.mjs';
import { resolveChromeExecutable } from './chrome-path.mjs';

const bundle = await build({ entryPoints: ['src/renderer/terminal-manager.ts'], bundle: true,
  write: false, format: 'iife', globalName: 'DuoTerminal', platform: 'browser' });
const server = http.createServer((req, res) => {
  const files = { '/history.js': 'mobile/client/terminal-history-layer.js',
    '/xterm.js': 'mobile/client/xterm.js',
    '/mobile.css': 'mobile/client/style.css', '/desktop.css': 'src/renderer/styles.css',
    '/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css' };
  if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(bundle.outputFiles[0].text); }
  if (files[req.url]) { res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript'); return res.end(readFileSync(files[req.url])); }
  res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="/xterm.css"><link rel="stylesheet" href="/${req.url?.includes('mobile') ? 'mobile' : 'desktop'}.css">
    <style>html,body{margin:0;width:100%;height:100%;overflow:hidden}#terminal-container,#area{position:relative;width:100%;height:460px;flex:none}</style>
    <div id="terminal-container"></div><div id="area" hidden></div><script src="/xterm.js"></script><script src="/history.js"></script><script src="/bundle.js"></script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
const failures = [];
const checks = [];
try {
  browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const run = async (name, scenario) => {
    try { await scenario(); checks.push(name); console.log(`PASS ${name}`); }
    catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack}`); }
  };
  const setup = async (mobile = false) => {
    await page.setViewport({ width: mobile ? 390 : 900, height: 844, isMobile: mobile, hasTouch: mobile });
    await page.goto(`http://127.0.0.1:${server.address().port}/${mobile ? 'mobile' : 'desktop'}`);
    await page.evaluate(() => {
      window.frames = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(requestAnimationFrame); };
      window.requests = [];
      window.layer = DuoTerminalHistoryLayer.createHistoryLayer({ cols: 80, onRequest: query => requests.push(query) });
      document.getElementById('terminal-container').appendChild(layer.root);
      window.scroller = layer.root.querySelector('.terminal-history-scroller');
      window.pageOf = (first, last, hasMore = true, text) => ({
        epoch: 1, requestId: requests.at(-1)?.requestId, hasMore, nextCursor: `1:${first}`,
        items: Array.from({ length: last - first + 1 }, (_, i) => ({ epoch: 1, lineId: first + i,
          part: 0, text: text ? `${first + i}: ${text}` : `history line ${first + i}`, wraps: [], styles: [] })),
      });
      layer.show({ hasMore: true, nextCursor: '1:161' });
      layer.prepend(pageOf(81, 160));
    });
    await page.evaluate(() => frames());
  };
  await run('history page prepend preserves the visible line and never paints a blank window', async () => {
    await setup();
    const result = await page.evaluate(async () => {
      scroller.scrollTop = 150; await frames();
      const before = layer.captureAnchor();
      layer.requestMore(); layer.prepend(pageOf(1, 80, false)); await frames();
      const after = layer.captureAnchor();
      const rect = scroller.getBoundingClientRect();
      const visible = [...layer.root.querySelectorAll('.terminal-history-row')].filter(node => {
        const r = node.getBoundingClientRect(); return r.bottom > rect.top && r.top < rect.bottom;
      });
      return { before, after, visible: visible.length, mounted: layer.root.querySelectorAll('.terminal-history-row').length, requests: requests.length };
    });
    assert.equal(result.after.lineId, result.before.lineId);
    assert.ok(Math.abs(result.after.pixelOffset - result.before.pixelOffset) < 2, JSON.stringify(result));
    assert.ok(result.visible > 10 && result.mounted < 65, JSON.stringify(result));
    assert.equal(result.requests, 2);
  });
  await run('reopening history does not rewind its cursor; a new live boundary refreshes it', async () => {
    await setup();
    const result = await page.evaluate(() => {
      layer.show({ hasMore: true, nextCursor: '1:999' });
      const whileVisible = layer.state.nextCursor;
      layer.hide(); layer.show({ hasMore: true, nextCursor: '1:161' });
      const reopened = layer.state.nextCursor;
      layer.requestMore(); const request = requests.at(-1);
      layer.prepend(pageOf(1, 80, false));
      layer.hide(); layer.show({ hasMore: true, nextCursor: '1:181' });
      return { whileVisible, reopened, request, fresh: requests.at(-1), oldCount: layer.getItems().length };
    });
    assert.equal(result.whileVisible, '1:81'); assert.equal(result.reopened, '1:81');
    assert.equal(result.request.beforeCursor, '1:81'); assert.equal(result.fresh.beforeCursor, '1:181');
    assert.equal(result.oldCount, 0);
  });
  await run('live terminal reuses loaded history until output advances', async () => {
    await setup(true);
    const result = await page.evaluate(async () => {
      layer.root.remove();
      window.live = new Terminal({ cols: 60, rows: 20, scrollback: 120 });
      live.open(document.getElementById('terminal-container'));
      await new Promise(resolve => live.write(Array.from({ length: 60 }, (_, i) => `line ${i}\r\n`).join(''), resolve));
      live.scrollToLine(0);
      window.layer = DuoTerminalHistoryLayer.createHistoryLayer({
        cols: 60, getTerminal: () => live, onRequest: query => requests.push(query),
      });
      document.getElementById('terminal-container').appendChild(layer.root);
      layer.show({ hasMore: true, nextCursor: '1:61', revision: 1, deltaY: -30 });
      const firstRequest = requests.at(-1);
      const native = Array.from({ length: live.buffer.normal.baseY }, (_, i) =>
        live.buffer.normal.getLine(i).translateToString(true));
      layer.prepend({ requestId: firstRequest.requestId, hasMore: false, nextCursor: '1:1',
        items: ['older A', 'older B', ...native].map((text, i) => ({
          epoch: 1, lineId: i + 1, part: 0, text, wraps: [], styles: [],
        })) });
      const count = layer.getItems().length;
      const requestsBefore = requests.length;
      layer.hide();
      layer.show({ hasMore: true, nextCursor: '1:61', revision: 1, deltaY: -30 });
      const reused = { count: layer.getItems().length, requests: requests.length };
      layer.hide();
      layer.show({ hasMore: true, nextCursor: '1:61', revision: 2, deltaY: -30 });
      return { firstCursor: firstRequest.beforeCursor, count, requestsBefore, reused,
        refreshed: { count: layer.getItems().length, beforeCursor: requests.at(-1).beforeCursor,
          requests: requests.length } };
    });
    assert.equal(result.firstCursor, null, JSON.stringify(result));
    assert.equal(result.count, 2, JSON.stringify(result));
    assert.deepEqual(result.reused, { count: 2, requests: result.requestsBefore });
    assert.equal(result.refreshed.count, 0);
    assert.equal(result.refreshed.beforeCursor, null);
    assert.equal(result.refreshed.requests, result.requestsBefore + 1);
  });
  await run('late history responses cannot populate a reset view or clear a newer request', async () => {
    await setup();
    const result = await page.evaluate(() => {
      layer.requestMore(); const old = pageOf(1, 80, false);
      layer.reset(); layer.show({ hasMore: true, nextCursor: '1:201' });
      const rejected = layer.prepend(old);
      return { rejected, count: layer.getItems().length, loading: layer.state.loading };
    });
    assert.equal(result.rejected.applied, false); assert.equal(result.count, 0); assert.equal(result.loading, true);
  });
  await run('mobile CJK wrapping is measured without overlapping rows or thousands of DOM nodes', async () => {
    await setup(true);
    const result = await page.evaluate(async () => {
      layer.reset(); layer.show({ hasMore: true, nextCursor: '1:801' });
      layer.prepend(pageOf(1, 800, false, '中文终端历史内容用于验证手机窄屏换行。'.repeat(3)));
      await frames(10);
      const rows = [...layer.root.querySelectorAll('.terminal-history-row')].map(node => ({ top: node.getBoundingClientRect().top, bottom: node.getBoundingClientRect().bottom }));
      return { mounted: rows.length, overlaps: rows.slice(1).filter((row, i) => row.top < rows[i].bottom - 1).length,
        available: scroller.scrollHeight > scroller.clientHeight, viewport: scroller.clientHeight };
    });
    assert.ok(result.mounted < 65 && result.mounted > 0, JSON.stringify(result));
    assert.equal(result.overlaps, 0); assert.equal(result.available, true); assert.ok(result.viewport > 100);
  });
  await run('prepending long mobile history keeps the same visible line after layout settles', async () => {
    await setup(true);
    const result = await page.evaluate(async () => {
      const text = '中文历史内容与较长路径 backend/admin/admin-http-routes.js '.repeat(4);
      layer.reset(); layer.show({ hasMore: true, nextCursor: '1:401' });
      layer.prepend(pageOf(201, 400, true, text));
      scroller.scrollTop = 180;
      await frames(8);
      const before = layer.captureAnchor();
      layer.requestMore(); layer.prepend(pageOf(1, 200, false, text));
      const immediate = layer.captureAnchor();
      await frames(12);
      const settled = layer.captureAnchor();
      return { before, immediate, settled };
    });
    assert.equal(result.immediate.lineId, result.before.lineId, JSON.stringify(result));
    assert.equal(result.settled.lineId, result.before.lineId, JSON.stringify(result));
    assert.ok(Math.abs(result.settled.pixelOffset - result.before.pixelOffset) < 3, JSON.stringify(result));
  });
  await run('real mobile touch scrolls the history layer beyond one screen', async () => {
    await setup(true);
    const before = await page.evaluate(() => scroller.scrollTop);
    const session = await page.createCDPSession();
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 180, y: 120 }] });
    for (let i = 1; i <= 12; i++) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 180, y: 120 + i * 20 }] });
      await new Promise(resolve => setTimeout(resolve, 16));
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await session.detach();
    await page.evaluate(() => frames(8));
    const after = await page.evaluate(() => scroller.scrollTop);
    assert.ok(before - after > 100, JSON.stringify({ before, after }));
    mkdirSync('tests/.artifacts/terminal-audit', { recursive: true });
    await page.screenshot({ path: 'tests/.artifacts/terminal-audit/mobile-history.png' });
  });
  await run('native text selection survives a small history scroll', async () => {
    await setup();
    const result = await page.evaluate(async () => {
      const row = layer.root.querySelectorAll('.terminal-history-row')[10];
      const range = document.createRange(); range.selectNodeContents(row);
      getSelection().removeAllRanges(); getSelection().addRange(range);
      const before = getSelection().toString(); scroller.scrollTop -= 18; await frames();
      return { before, after: getSelection().toString() };
    });
    assert.ok(result.before.length > 0); assert.equal(result.after, result.before);
  });
  await run('desktop history text can be selected and copied', async () => {
    await setup();
    const result = await page.evaluate(async () => {
      let focuses = 0;
      const next = DuoTerminalHistoryLayer.createHistoryLayer({
        cols: 80,
        getTerminal: () => ({ focus() { focuses++; }, clearSelection() {}, element: null }),
        onRequest: query => requests.push(query),
      });
      document.getElementById('terminal-container').appendChild(next.root);
      next.show({ hasMore: true, nextCursor: '1:161' });
      next.prepend(pageOf(81, 160));
      await frames();
      const row = next.root.querySelector('.terminal-history-row');
      const style = getComputedStyle(row);
      row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
      const range = document.createRange();
      range.selectNodeContents(row);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      let copied = '';
      const copyEvent = new Event('copy', { bubbles: true, cancelable: true });
      Object.defineProperty(copyEvent, 'clipboardData', {
        value: { setData(_type, value) { copied = value; } },
      });
      document.dispatchEvent(copyEvent);
      return {
        focuses,
        userSelect: style.userSelect,
        cursor: style.cursor,
        selected: getSelection().toString(),
        api: next.getSelectionText(),
        copied,
        defaultPrevented: copyEvent.defaultPrevented,
      };
    });
    assert.equal(result.focuses, 0, JSON.stringify(result));
    assert.equal(result.userSelect, 'text');
    assert.equal(result.cursor, 'text');
    assert.ok(result.selected.length > 0, JSON.stringify(result));
    assert.equal(result.api, result.selected);
    assert.equal(result.copied, result.selected);
    assert.equal(result.defaultPrevented, true);
  });
  const setupManager = async () => {
    await setup();
    await page.evaluate(async () => {
      document.getElementById('terminal-container').hidden = true;
      document.getElementById('area').hidden = false;
      window.duocli = { filewatcherOpen() {} };
      window.mgr = new DuoTerminal.TerminalManager(document.getElementById('area'));
      window.desktopInputs = [];
      mgr.create('t1', 'vscode-dark', '/tmp', data => desktopInputs.push(data));
      window.inst = mgr.instances.get('t1'); window.t = inst.terminal;
      await inst.revealPromise;
      window.textOf = () => Array.from({ length: t.buffer.active.length }, (_, i) => t.buffer.active.getLine(i)?.translateToString(true) || '').join('\n');
    });
  };
  await run('desktop parsed output is displayed once and duplicate sequence packets are ignored', async () => {
    await setupManager();
    const result = await page.evaluate(async () => {
      mgr.applyParsed('t1', 'SEQ_ONE\r\n', 1); mgr.applyParsed('t1', 'SEQ_ONE\r\n', 1);
      mgr.applyParsed('t1', 'SEQ_TWO\r\n', 2);
      await new Promise(resolve => t.write('', resolve));
      return { text: textOf(), sequence: inst.appliedSeq };
    });
    assert.equal((result.text.match(/SEQ_ONE/g) || []).length, 1);
    assert.match(result.text, /SEQ_TWO/); assert.equal(result.sequence, 2);
  });
  await run('desktop input stays blocked while a missing output sequence is being recovered', async () => {
    await setupManager();
    await page.evaluate(() => {
      window.duocli.snapshotPty = () => new Promise(resolve => { window.releaseDesktopSnapshot = resolve; });
      mgr.applyParsed('t1', 'missing sequence one', 2);
      t._core.coreService.triggerDataEvent('UNSAFE_DURING_RESYNC');
    });
    await page.waitForFunction(() => typeof releaseDesktopSnapshot === 'function');
    const during = await page.evaluate(() => desktopInputs.slice());
    await page.evaluate(async () => {
      releaseDesktopSnapshot({ sequence: 2, epoch: 1, cols: 80, rows: 24, data: 'RECOVERED\r\n' });
      await inst.revealPromise;
      t._core.coreService.triggerDataEvent('SAFE_AFTER_RESYNC');
    });
    assert.deepEqual(during, []);
    assert.deepEqual(await page.evaluate(() => desktopInputs), ['SAFE_AFTER_RESYNC']);
  });
  await run('rapid switches leave the last terminal visible and keyboard-focused', async () => {
    await setupManager();
    const result = await page.evaluate(async () => {
      mgr.create('t2', 'vscode-dark', '/tmp', () => {});
      mgr.switchTo('t1'); mgr.destroy('t2');
      mgr.create('t3', 'vscode-dark', '/tmp', () => {});
      const current = mgr.instances.get('t3');
      let focusCalls = 0;
      const original = current.terminal.focus.bind(current.terminal);
      current.terminal.focus = () => { focusCalls++; original(); };
      await new Promise(resolve => setTimeout(resolve, 220));
      const rect = current.container.getBoundingClientRect();
      const css = getComputedStyle(current.container);
      return { focused: current.container.contains(document.activeElement), focusCalls,
        activeId: mgr.activeId, classes: current.container.className, parent: current.container.parentElement.className,
        size: [rect.width, rect.height], visibility: css.visibility, display: css.display,
        textarea: current.terminal.textarea?.outerHTML, activeElement: document.activeElement?.outerHTML.slice(0, 180) };
    });
    assert.equal(result.focused, true, JSON.stringify(result));
  });
  await run('output arriving during snapshot tail parsing is drained without loss', async () => {
    await setupManager();
    const result = await page.evaluate(async () => {
      window.duocli.snapshotPty = async () => ({ sequence: 10, epoch: 1, cols: 80, rows: 24, data: 'SNAPSHOT\r\n' });
      inst.needsResync = true;
      mgr.applyParsed('t1', 'TAIL_ELEVEN\r\n', 11);
      const original = t.write.bind(t);
      t.write = (data, callback) => original(data, () => {
        if (String(data).includes('TAIL_ELEVEN')) mgr.applyParsed('t1', 'TAIL_TWELVE\r\n', 12);
        callback?.();
      });
      await mgr.resyncFromSnapshot(inst); t.write = original;
      return { text: textOf(), seq: inst.appliedSeq, remaining: inst.liveTail.length, needsResync: inst.needsResync };
    });
    assert.match(result.text, /TAIL_ELEVEN/); assert.match(result.text, /TAIL_TWELVE/);
    assert.equal(result.seq, 12); assert.equal(result.remaining, 0); assert.equal(result.needsResync, false);
  });
  await run('an evicted output tail triggers a fresh snapshot instead of silently skipping lines', async () => {
    await setupManager();
    const result = await page.evaluate(async () => {
      inst.needsResync = true;
      for (let seq = 11; seq <= 60; seq++) mgr.applyParsed('t1', `packet ${seq} ${'x'.repeat(1200)}\r\n`, seq);
      let snapshots = 0;
      window.duocli.snapshotPty = async () => ({ sequence: ++snapshots === 1 ? 10 : 60,
        epoch: 1, cols: 80, rows: 24, data: snapshots === 1 ? 'OLD\r\n' : 'LATEST_SIXTY\r\n' });
      await mgr.resyncFromSnapshot(inst);
      return { snapshots, seq: inst.appliedSeq, text: textOf(), needsResync: inst.needsResync };
    });
    assert.equal(result.snapshots, 2); assert.equal(result.seq, 60);
    assert.match(result.text, /LATEST_SIXTY/); assert.equal(result.needsResync, false);
  });
  assert.deepEqual(errors, [], 'browser exceptions');
  assert.deepEqual(failures, [], 'terminal history regressions');
  console.log(JSON.stringify({ passed: checks.length, failed: failures.length }));
} finally {
  if (browser) await closeTestBrowser(browser);
  await new Promise(resolve => server.close(resolve));
}
