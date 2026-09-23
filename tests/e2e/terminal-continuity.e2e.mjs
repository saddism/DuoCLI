import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { resolveChromeExecutable } from './chrome-path.mjs';

const { LIVE_TERMINAL_SCROLLBACK } = createRequire(import.meta.url)('../../mobile/client/terminal-scroll-helpers.js');

const bundle = await build({ stdin: { contents: `import {Terminal} from '@xterm/xterm';
  import {TerminalManager} from './src/renderer/terminal-manager'; window.TestTerminal = Terminal;
  window.TestManager = TerminalManager;`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, platform: 'browser', format: 'iife' });
const server = http.createServer((req, res) => {
  if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(bundle.outputFiles[0].text); }
  const files = { '/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css', '/desktop.css': 'src/renderer/styles.css', '/mobile.css': 'mobile/client/style.css' };
  if (files[req.url]) { res.setHeader('Content-Type', 'text/css'); return res.end(readFileSync(files[req.url])); }
  res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/xterm.css">
    <link rel="stylesheet" href="/${req.url?.includes('mobile') ? 'mobile' : 'desktop'}.css">
    <style>html,body{margin:0;height:100%;overflow:hidden}#host{position:relative;width:600px;height:240px;display:block;inset:auto;padding:0}
    #host .xterm{height:100%}</style><div id="host" class="terminal-container active"></div><script src="/bundle.js"></script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const failures = [];
let passed = 0;
let browser;
try {
  browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  async function setup({ background = '#1a1a2e', localHistory = true, mobile = false, repeated = false } = {}) {
    await page.setViewport({ width: mobile ? 390 : 900, height: 700, isMobile: mobile, hasTouch: mobile });
    await page.goto(`http://127.0.0.1:${server.address().port}/${mobile ? 'mobile' : 'desktop'}`);
    await page.evaluate(async ({ background, localHistory, mobile, repeated }) => {
      const host = document.getElementById('host');
      if (mobile) host.style.width = '390px';
      window.t = new TestTerminal({ cols: 40, rows: 12, scrollback: 80, fontSize: 14,
        fontFamily: 'Menlo, monospace', allowProposedApi: true, theme: { background, foreground: '#838a94' } });
      t.open(host);
      window.frames = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise(requestAnimationFrame); };
      await new Promise(resolve => t.write(Array.from({ length: localHistory ? 160 : 8 }, (_, i) => `${repeated ? 'identical' : 'line-' + i}\r\n`).join(''), resolve));
      t.scrollToTop(); await frames();
      window.requests = []; window.resumes = []; window.clicks = 0;
      window.layer = DuoTerminalHistoryLayer.createHistoryLayer({ getTerminal: () => t,
        onRequest: query => requests.push(query),
        onResumeLive: position => { resumes.push(position); t.scrollToLine(position.viewportY + Math.ceil(position.deltaY / position.rowHeight)); },
        onBackToLive: () => { clicks++; layer.hide(); t.scrollToBottom(); } });
      host.appendChild(layer.root);
      const count = localHistory ? 160 - t.rows + 1 : 100;
      window.archive = Array.from({ length: count }, (_, i) => ({ epoch: 1, lineId: i + 1, part: 0,
        text: repeated ? 'identical' : localHistory ? 'line-' + i : 'older-' + i, wraps: [], styles: [] }));
      window.reply = () => {
        const request = requests.at(-1);
        const before = Number(request.beforeCursor?.split(':')[1]) || archive.length + 1;
        const end = Math.min(archive.length, before - 1);
        const start = Math.max(0, end - 80);
        return layer.prepend({ requestId: request.requestId, epoch: 1, items: archive.slice(start, end),
          nextCursor: `1:${start + 1}`, hasMore: start > 0, stale: false });
      };
      window.load = async () => {
        for (let i = 0; layer.state.loading && i < 5; i++) { reply(); await frames(); }
      };
      window.scroller = layer.root.querySelector('.terminal-history-scroller');
    }, { background, localHistory, mobile, repeated });
  }
  async function run(name, callback) {
    try { await callback(); passed++; console.log('PASS ' + name); }
    catch (error) { failures.push(name); console.error('FAIL ' + name + ': ' + error.stack); }
  }

  for (const background of ['#1a1a2e', '#fafafa']) await run(`slow history request keeps the current screen and follows the wheel ${background}`, async () => {
    await setup({ background, localHistory: false });
    const result = await page.evaluate(async () => {
      const before = t.element.querySelector('.xterm-rows').getBoundingClientRect();
      const text = t.buffer.active.getLine(0).translateToString(true);
      layer.show({ hasMore: true, nextCursor: '1:101', deltaY: -18 }); await frames();
      const preview = layer.root.querySelector('.terminal-history-preview');
      const after = preview?.querySelector('.xterm-rows')?.getBoundingClientRect();
      return { preview: Boolean(preview), visibleText: preview?.textContent.includes(text),
        offset: after ? after.top - before.top : null,
        background: getComputedStyle(layer.root).backgroundColor,
        liveBackground: getComputedStyle(t.element.querySelector('.xterm-viewport')).backgroundColor,
        capsuleHidden: layer.root.querySelector('.terminal-history-live-btn').hidden };
    });
    assert.equal(result.preview, true); assert.equal(result.visibleText, true);
    assert.ok(Math.abs(result.offset - 18) <= 2, JSON.stringify(result));
    assert.equal(result.background, result.liveBackground);
    assert.equal(result.capsuleHidden, true);
  });

  await run('first history page moves by the wheel distance, not a whole screen', async () => {
    await setup({ localHistory: false });
    const result = await page.evaluate(async () => {
      const before = t.element.querySelector('.xterm-rows').getBoundingClientRect().top;
      layer.show({ hasMore: true, nextCursor: '1:101', deltaY: -18 });
      await load();
      const previewTop = layer.root.querySelector('.terminal-history-preview .xterm-rows')?.getBoundingClientRect().top;
      return { shift: previewTop - before, capsuleHidden: layer.root.querySelector('.terminal-history-live-btn').hidden,
        count: layer.getItems().length, scroll: scroller.scrollTop };
    });
    assert.ok(result.count > 0); assert.ok(Math.abs(result.shift - 18) <= 1, JSON.stringify(result));
    assert.equal(result.capsuleHidden, true);
  });

  await run('real downward mouse wheel returns to latest without clicking a capsule', async () => {
    await setup({ localHistory: false });
    await page.evaluate(async () => { layer.show({ hasMore: true, nextCursor: '1:101', deltaY: -60 }); await load(); });
    await page.mouse.move(140, 100); await page.mouse.wheel({ deltaY: 100 });
    await page.waitForFunction(() => !layer.isVisible(), { timeout: 1500 });
    const result = await page.evaluate(() => ({ resumes: resumes.length, clicks, distance: t.buffer.active.baseY - t.buffer.active.viewportY }));
    assert.deepEqual(result, { resumes: 1, clicks: 0, distance: 0 });
  });

  for (const repeated of [false, true]) await run(`native scrollback is not duplicated at the archive seam (${repeated ? 'repeated' : 'numbered'} rows)`, async () => {
    await setup({ repeated });
    const result = await page.evaluate(async () => {
      const localFirst = t.buffer.active.getLine(t.buffer.active.viewportY).translateToString(true);
      layer.show({ hasMore: true, nextCursor: `1:${archive.length + 1}`, deltaY: -32 }); await load();
      const expected = archive.length - t.buffer.active.baseY;
      return { count: layer.getItems().length, expected, last: layer.getItems().at(-1)?.text, localFirst, requests: requests.length };
    });
    assert.equal(result.count, result.expected, JSON.stringify(result));
    assert.ok(result.requests <= 3);
    if (!repeated) assert.equal(Number(result.last.slice(5)) + 1, Number(result.localFirst.slice(5)));
  });

  await run('downward handoff resumes native scrollback instead of jumping past it', async () => {
    await setup();
    const result = await page.evaluate(async () => {
      layer.show({ hasMore: true, nextCursor: `1:${archive.length + 1}`, deltaY: -32 }); await load();
      layer.scrollByPixels(48);
      return { visible: layer.isVisible(), viewport: t.buffer.active.viewportY, base: t.buffer.active.baseY, clicks, resumes: resumes.length };
    });
    assert.equal(result.visible, false); assert.equal(result.clicks, 0); assert.equal(result.resumes, 1);
    assert.ok(result.viewport > 0 && result.viewport < result.base, JSON.stringify(result));
  });

  await run('a small reverse while history is loading keeps the current screen', async () => {
    await setup({ localHistory: false });
    const result = await page.evaluate(async () => {
      layer.show({ hasMore: true, nextCursor: '1:101', deltaY: -80 });
      layer.scrollByPixels(24);
      return {
        visible: layer.isVisible(),
        preview: Boolean(layer.root.querySelector('.terminal-history-preview')),
        resumes: resumes.length,
      };
    });
    assert.deepEqual(result, { visible: true, preview: true, resumes: 0 });
  });

  await run('reversing direction during a slow request cancels the visual transition', async () => {
    await setup({ localHistory: false });
    const result = await page.evaluate(async () => {
      layer.show({ hasMore: true, nextCursor: '1:101', deltaY: -30 });
      layer.scrollByPixels(35); reply(); await frames();
      return { visible: layer.isVisible(), preview: Boolean(layer.root.querySelector('.terminal-history-preview')), clicks, resumes: resumes.length };
    });
    assert.deepEqual(result, { visible: false, preview: false, clicks: 0, resumes: 1 });
  });

  await run('new output refreshes the visible live edge and leaves archived reading in place', async () => {
    await setup({ localHistory: false });
    const result = await page.evaluate(async () => {
      layer.show({ hasMore: true, nextCursor: '1:101', deltaY: -20 });
      await load();
      const onEdge = layer.viewingLiveEdge();
      await new Promise(resolve => t.write('EDGE_UPDATE\r\n', resolve));
      layer.noteLiveOutput();
      await frames(4);
      const edgeText = layer.root.querySelector('.terminal-history-preview')?.textContent || '';
      scroller.scrollTop = 0;
      layer.noteLiveOutput();
      await frames(4);
      return {
        onEdge,
        edgeText: edgeText.includes('EDGE_UPDATE'),
        parked: scroller.scrollTop,
        unread: layer.state.liveUnread,
        visible: layer.isVisible(),
        resumes: resumes.length,
      };
    });
    assert.equal(result.onEdge, true, JSON.stringify(result));
    assert.equal(result.edgeText, true, JSON.stringify(result));
    assert.equal(result.visible, true);
    assert.equal(result.parked, 0, JSON.stringify(result));
    assert.equal(result.unread, true, JSON.stringify(result));
    assert.equal(result.resumes, 0);
  });

  await run('new output while reading does not cause an automatic jump to latest', async () => {
    await setup({ localHistory: false });
    const result = await page.evaluate(async () => {
      layer.show({ hasMore: true, nextCursor: '1:101', deltaY: -70 }); await load();
      const before = scroller.scrollTop;
      await new Promise(resolve => t.write('NEW LIVE OUTPUT\r\n', resolve));
      layer.setLiveUnread(true); await frames();
      return { before, after: scroller.scrollTop, visible: layer.isVisible(), resumes: resumes.length };
    });
    assert.equal(result.after, result.before); assert.equal(result.visible, true); assert.equal(result.resumes, 0);
  });

  await run('touch can cross back into live output without a button', async () => {
    await setup({ localHistory: false, mobile: true });
    const result = await page.evaluate(async () => {
      layer.show({ hasMore: true, nextCursor: '1:101', deltaY: -40 }); await load();
      for (const [type, y] of [['touchstart', 180], ['touchmove', 120]]) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'touches', { value: [{ clientY: y }] }); scroller.dispatchEvent(event);
      }
      return { visible: layer.isVisible(), clicks, resumes: resumes.length };
    });
    assert.deepEqual(result, { visible: false, clicks: 0, resumes: 1 });
  });

  await run('desktop manager routes a real up/down wheel gesture continuously through both buffers', async () => {
    await setup();
    await page.evaluate(async () => {
      layer.reset(); t.dispose();
      const host = document.getElementById('host'); host.textContent = ''; host.className = '';
      window.duocli = { filewatcherOpen() {},
        historyMetaPty: async () => ({ epoch: 1, historyCursor: `1:${archive.length + 1}`, historyHasMore: true }),
        historyBeforePty: async (_, query) => {
          const end = Number(query.beforeCursor?.split(':')[1]) - 1 || archive.length;
          const start = Math.max(0, end - 80);
          return { requestId: query.requestId, epoch: 1, items: archive.slice(start, end),
            nextCursor: `1:${start + 1}`, hasMore: start > 0, stale: false };
        } };
      window.manager = new TestManager(host); manager.create('actual', 'vscode-dark', '/tmp', () => {});
      manager.mountTo('actual', host);
      window.instance = manager.instances.get('actual'); window.t = instance.terminal;
      await instance.revealPromise;
      await new Promise(resolve => t.write(Array.from({ length: 240 }, (_, i) => `line-${i}\r\n`).join(''), resolve));
      const count = 240 - t.rows + 1;
      archive = Array.from({ length: count }, (_, i) => ({ epoch: 1, lineId: i + 1, part: 0, text: 'line-' + i, wraps: [], styles: [] }));
      window.layer = instance.historyLayer;
      instance.scroll.stopFollowing();
      t.scrollToTop(); await frames(4);
    });
    await page.mouse.move(120, 75); await page.mouse.wheel({ deltaY: -36 });
    await page.waitForFunction(() => layer.isVisible() && layer.getItems().length > 0 && !layer.state.loading, { timeout: 2500 });
    await page.mouse.wheel({ deltaY: 80 });
    await page.waitForFunction(() => !layer.isVisible(), { timeout: 1500 });
    const middle = await page.evaluate(() => t.buffer.active.viewportY);
    assert.ok(middle > 0, 'handoff must continue through cached native rows');
    await page.mouse.wheel({ deltaY: 2000 });
    await page.evaluate(async () => { await frames(6); manager.write('actual', 'FOLLOWING_AGAIN\r\n'); await new Promise(resolve => t.write('', resolve)); await frames(4); });
    assert.equal(await page.evaluate(() => t.buffer.active.baseY - t.buffer.active.viewportY), 0);
    await page.evaluate(() => manager.destroy('actual'));
  });

  await run('a delayed metadata response does not cancel upward intent at a one-screen live buffer', async () => {
    await setup({ localHistory: false });
    await page.evaluate(async () => {
      layer.reset(); t.dispose();
      const host = document.getElementById('host'); host.textContent = ''; host.className = '';
      window.duocli = { filewatcherOpen() {},
        historyMetaPty: () => new Promise(resolve => setTimeout(() => resolve({ epoch: 1, historyCursor: '1:101', historyHasMore: true }), 160)),
        historyBeforePty: async (_, query) => ({ requestId: query.requestId, epoch: 1, items: archive.slice(-80), nextCursor: '1:21', hasMore: true, stale: false }) };
      window.manager = new TestManager(host); manager.create('slow', 'vscode-dark', '/tmp', () => {});
      manager.mountTo('slow', host);
      window.instance = manager.instances.get('slow'); window.t = instance.terminal; window.layer = instance.historyLayer;
      await instance.revealPromise; await new Promise(resolve => t.write('LIVE_SCREEN\r\n', resolve)); await frames(4);
    });
    await page.mouse.move(120, 55); await page.mouse.wheel({ deltaY: -24 });
    await page.waitForFunction(() => layer.isVisible() && layer.getItems().length > 0, { timeout: 2500 });
    assert.equal(await page.evaluate(() => Boolean(layer.root.querySelector('.terminal-history-preview'))), true);
    await page.mouse.wheel({ deltaY: 100 });
    await page.waitForFunction(() => !layer.isVisible(), { timeout: 1500 });
    await page.evaluate(() => manager.destroy('slow'));
  });

  await run('a reconnect refreshes the live edge without moving the archived reading position', async () => {
    await setup({ localHistory: false });
    const result = await page.evaluate(async () => {
      layer.show({ hasMore: true, nextCursor: '1:101', deltaY: -100 }); await load();
      const before = layer.captureAnchor();
      t.reset(); await new Promise(resolve => t.write('RECONNECTED_LIVE\r\n', resolve));
      layer.refreshLivePreview(); await frames(4);
      return { before, after: layer.captureAnchor(), liveText: layer.root.querySelector('.terminal-history-preview')?.textContent, visible: layer.isVisible() };
    });
    assert.equal(result.visible, true); assert.equal(result.after.lineId, result.before.lineId);
    assert.equal(result.after.pixelOffset, result.before.pixelOffset);
    assert.match(result.liveText, /RECONNECTED_LIVE/);
  });

  await run('small upward wheel stays in native live scrollback for two to three screens', async () => {
    await setup({ localHistory: true });
    await page.evaluate(async () => {
      layer.reset(); t.dispose();
      const host = document.getElementById('host'); host.textContent = ''; host.className = '';
      window.duocli = { filewatcherOpen() {},
        historyMetaPty: async () => ({ epoch: 1, historyCursor: '1:101', historyHasMore: true }),
        historyBeforePty: async (_, query) => ({ requestId: query.requestId, epoch: 1, items: archive.slice(-80), nextCursor: '1:21', hasMore: true, stale: false }) };
      window.manager = new TestManager(host); manager.create('live', 'vscode-dark', '/tmp', () => {});
      manager.mountTo('live', host);
      window.instance = manager.instances.get('live'); window.t = instance.terminal; window.layer = instance.historyLayer;
      await instance.revealPromise;
      await new Promise(resolve => t.write(Array.from({ length: 160 }, (_, i) => `line-${i}\r\n`).join(''), resolve));
      await frames(4);
    });
    await page.mouse.move(120, 55);
    await page.mouse.wheel({ deltaY: -48 });
    await page.evaluate(async () => { await frames(8); });
    const result = await page.evaluate(() => ({
      visible: layer.isVisible(),
      viewportY: t.buffer.active.viewportY,
      baseY: t.buffer.active.baseY,
      scrollback: t.options.scrollback,
    }));
    assert.equal(result.scrollback, LIVE_TERMINAL_SCROLLBACK, JSON.stringify(result));
    assert.equal(result.visible, false, JSON.stringify(result));
    assert.ok(result.viewportY < result.baseY, JSON.stringify(result));
    assert.ok(result.viewportY > 3, JSON.stringify(result));
    await page.evaluate(() => manager.destroy('live'));
  });

  await run('history overlay keeps live typing available', async () => {
    await setup({ localHistory: false });
    await page.evaluate(async () => {
      window.typed = [];
      t.onData(data => window.typed.push(data));
      layer.show({ hasMore: true, nextCursor: '1:101', deltaY: -40 });
      await load();
    });
    const box = await page.evaluate(() => {
      const scroller = layer.root.querySelector('.terminal-history-scroller');
      const rect = scroller.getBoundingClientRect();
      return { x: rect.left + 40, y: rect.top + 24, tabIndex: scroller.tabIndex };
    });
    assert.equal(box.tabIndex, -1);
    await page.mouse.click(box.x, box.y);
    await page.keyboard.type('hello');
    const result = await page.evaluate(() => ({
      typed: window.typed.join(''),
      overlay: layer.isVisible(),
    }));
    assert.equal(result.overlay, true);
    assert.equal(result.typed, 'hello', JSON.stringify(result));
  });

  mkdirSync('tests/.artifacts/terminal-continuity', { recursive: true });
  await setup({ localHistory: false });
  await page.evaluate(async () => { layer.show({ hasMore: true, nextCursor: '1:101', deltaY: -72 }); await load(); });
  await page.screenshot({ path: 'tests/.artifacts/terminal-continuity/continuous-seam.png' });
  await page.screenshot({ path: 'tests/.artifacts/terminal-continuity/continuous-seam.jpg', type: 'jpeg', quality: 40, clip: { x: 0, y: 0, width: 600, height: 240 } });
  assert.deepEqual(errors, [], 'browser errors');
  console.log(JSON.stringify({ passed, failed: failures.length, failures }));
  if (failures.length) process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
