import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { resolveChromeExecutable } from './chrome-path.mjs';

// Real browser/DOM and shipped modules; simulated IPC makes parser races deterministic.
const bundle = await build({ entryPoints: ['src/renderer/terminal-manager.ts'], bundle: true,
  write: false, format: 'iife', globalName: 'DuoTerminal', platform: 'browser' });
const server = http.createServer((req, res) => {
  if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(bundle.outputFiles[0].text); }
  if (req.url === '/styles.css') { res.setHeader('Content-Type', 'text/css'); return res.end(readFileSync('src/renderer/styles.css')); }
  res.end(`<!doctype html><link rel="stylesheet" href="/styles.css"><style>
    #host { position:relative; width:420px; height:260px; font:14px monospace; }
    .terminal-history-layer { position:absolute; inset:0; display:flex; flex-direction:column; }
    .terminal-history-layer[hidden] { display:none; }
    .terminal-history-scroller { position:relative; flex:1; min-height:0; overflow:auto; }
    </style><div id="host"></div><script src="/bundle.js"></script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
const failures = [];
try {
  browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true });
  const page = await browser.newPage();
  const run = async (name, scenario) => {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(() => {
      window.frames = async (count = 3) => { for (let i = 0; i < count; i++) await new Promise(requestAnimationFrame); };
      window.requests = [];
      window.layer = DuoTerminalHistoryLayer.createHistoryLayer({ onRequest: query => requests.push(query) });
      document.getElementById('host').appendChild(layer.root);
      window.scroller = layer.root.querySelector('.terminal-history-scroller');
      window.historyPage = (id, requestId, hasMore = true) => ({
        requestId, epoch: 1, hasMore, nextCursor: `1:${id}`, stale: false, truncated: false,
        items: [{ epoch: 1, lineId: id, part: 0, partCount: 1, text: `line ${id}`, wraps: [], styles: [], order: id }],
      });
      window.shortHistory = async () => {
        layer.show({ hasMore: true, nextCursor: '1:10' });
        layer.prepend(historyPage(9, requests[0].requestId));
        await frames();
      };
    });
    try { await scenario(page); console.log(`PASS ${name}`); }
    catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack || error}`); }
  };

  await run('short history page does not auto-drain all pages; upward wheel requests the next page', async page => {
    const result = await page.evaluate(async () => {
      await shortHistory();
      const before = requests.length;
      const fits = scroller.scrollHeight <= scroller.clientHeight;
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -60, bubbles: true, cancelable: true }));
      return { before, after: requests.length, fits, cursor: requests[1]?.beforeCursor };
    });
    assert.equal(result.before, 1);
    assert.equal(result.fits, true);
    assert.equal(result.after, 2);
    assert.equal(result.cursor, '1:9');
  });

  await run('touch gesture at a non-scrollable history boundary loads older output', async page => {
    const result = await page.evaluate(async () => {
      await shortHistory();
      for (const [type, y] of [['touchstart', 100], ['touchmove', 135], ['touchend', 135]]) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [{ clientY: y }] });
        scroller.dispatchEvent(event);
      }
      return requests.length;
    });
    assert.equal(result, 2);
  });

  await run('direct history pan at the boundary loads older output without a native scroll event', async page => {
    const result = await page.evaluate(async () => { await shortHistory(); layer.scrollByPixels(-60); return requests.length; });
    assert.equal(result, 2);
  });

  await run('reset rejects the previous request without corrupting the new cursor', async page => {
    const result = await page.evaluate(() => {
      layer.show({ hasMore: true, nextCursor: '1:10' });
      const previous = requests[0].requestId;
      layer.reset();
      layer.show({ hasMore: true, nextCursor: '1:20' });
      const outcome = layer.prepend(historyPage(9, previous, false));
      return { applied: outcome.applied, items: layer.getItems().length, cursor: layer.state.nextCursor, loading: layer.state.loading };
    });
    assert.equal(result.applied, false); assert.equal(result.items, 0);
    assert.equal(result.cursor, '1:20'); assert.equal(result.loading, true);
  });

  await run('reopening the same live boundary preserves the older-page cursor', async page => {
    const result = await page.evaluate(async () => {
      await shortHistory(); layer.hide(); layer.show({ hasMore: true, nextCursor: '1:10' });
      layer.requestMore(); return { count: requests.length, cursor: requests.at(-1)?.beforeCursor };
    });
    assert.deepEqual(result, { count: 2, cursor: '1:9' });
  });

  await run('snapshot recovery drains output arriving during both snapshot and tail writes exactly once', async page => {
    const result = await page.evaluate(async () => {
      const manager = Object.create(DuoTerminal.TerminalManager.prototype);
      const writes = [];
      const instance = { id: 'race', epoch: 1, appliedSeq: 0, receivedSeq: 10,
        needsResync: true, resyncing: false, hiddenQueued: [], hiddenBytes: 0, liveTail: [],
        historyLayer: { reset() {}, isVisible: () => false },
        terminal: { reset() {}, resize() {}, write(data, done) {
          if (data) writes.push(data);
          if (data === 'SNAP') manager.applyParsed('race', 'FIRST', 11);
          if (data === 'FIRST') manager.applyParsed('race', 'SECOND', 12);
          queueMicrotask(done);
        } },
      };
      manager.instances = new Map([['race', instance]]);
      window.duocli = { snapshotPty: async () => ({ data: 'SNAP', sequence: 10, epoch: 1, cols: 80, rows: 24 }) };
      await manager.resyncFromSnapshot(instance);
      return { writes, sequence: instance.appliedSeq, tail: instance.liveTail.length, needsResync: instance.needsResync };
    });
    assert.deepEqual(result, { writes: ['SNAP', 'FIRST', 'SECOND'], sequence: 12, tail: 0, needsResync: false });
  });

  await run('late history metadata cannot reopen history after the user returns to latest', async page => {
    const result = await page.evaluate(async () => {
      const manager = Object.create(DuoTerminal.TerminalManager.prototype);
      let revision = 1, opened = 0, deliver;
      const instance = { id: 'intent', epoch: 1, revealGeneration: 1,
        container: { classList: { contains: () => false }, querySelector: () => null },
        historyLayer: { isVisible: () => false, show: () => opened++, setCols() {} },
        scroll: { gestureVersion: () => revision, stopFollowing: () => revision++, follow: () => revision++ },
        terminal: { cols: 80, buffer: { active: { type: 'normal', baseY: 0, viewportY: 0 } } },
      };
      manager.instances = new Map([['intent', instance]]); manager.activeId = 'intent';
      window.duocli = { historyMetaPty: () => new Promise(resolve => { deliver = resolve; }) };
      const work = manager.maybeEnterHistoryAsync('intent');
      revision++; // A newer user action has explicitly selected latest output.
      deliver({ epoch: 1, historyCursor: '1:10', historyHasMore: true });
      await work;
      return opened;
    });
    assert.equal(result, 0);
  });

  await run('desktop history timeout unlocks retry and ignores a late timed-out response', async page => {
    const result = await page.evaluate(async () => {
      const manager = Object.create(DuoTerminal.TerminalManager.prototype);
      const loading = [], applied = [], queries = [], resolvers = [], hints = [];
      const instance = { id: 'timeout', epoch: 1, historyRequestId: 0, historyCursor: '1:99',
        historyLayer: { setLoading: value => loading.push(value), prepend: page => applied.push(page.requestId) } };
      manager.instances = new Map([['timeout', instance]]);
      manager.showJumpMiss = (_, message) => hints.push(message);
      window.duocli = { historyBeforePty: (_, query) => {
        queries.push(query); return new Promise(resolve => resolvers.push(resolve));
      } };
      const originalTimeout = window.setTimeout;
      window.setTimeout = (callback, delay, ...args) => originalTimeout(callback, delay === 10000 ? 20 : delay, ...args);
      try {
        await manager.requestHistory('timeout', { requestId: 'h1', beforeCursor: null });
        const second = manager.requestHistory('timeout', { requestId: 'h2', beforeCursor: '1:50' });
        resolvers[0]({ requestId: 'h1', items: [] });
        resolvers[1]({ requestId: 'h2', items: [] });
        await second;
      } finally { window.setTimeout = originalTimeout; }
      return { loading, applied, hints: hints.length, firstCursor: queries[0].beforeCursor };
    });
    assert.deepEqual(result, { loading: [false], applied: ['h2'], hints: 1, firstCursor: null });
  });

  await run('failure from an older history request cannot unlock a newer in-flight request', async page => {
    const result = await page.evaluate(async () => {
      const manager = Object.create(DuoTerminal.TerminalManager.prototype);
      const loading = [], applied = [], pending = [];
      const instance = { id: 'overlap', epoch: 1, historyRequestId: 0, historyCursor: '1:99',
        historyLayer: { setLoading: value => loading.push(value), prepend: page => applied.push(page.requestId) } };
      manager.instances = new Map([['overlap', instance]]); manager.showJumpMiss = () => {};
      window.duocli = { historyBeforePty: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) };
      const first = manager.requestHistory('overlap', { requestId: 'h1' });
      const second = manager.requestHistory('overlap', { requestId: 'h2' });
      pending[0].reject(new Error('old transport failed'));
      await first;
      pending[1].resolve({ requestId: 'h2', items: [] });
      await second;
      return { loading, applied };
    });
    assert.deepEqual(result, { loading: [], applied: ['h2'] });
  });

  await run('reselecting a session retries a failed snapshot instead of leaving output permanently paused', async page => {
    const result = await page.evaluate(() => {
      const manager = Object.create(DuoTerminal.TerminalManager.prototype);
      let reveals = 0, follows = 0;
      const instance = { id: 'retry', needsResync: true,
        container: { classList: { contains: () => false } }, scroll: { follow: () => follows++ } };
      manager.instances = new Map([['retry', instance]]); manager.activeId = 'retry';
      manager.revealLatest = async () => { reveals++; };
      manager.followSession('retry');
      return { reveals, follows };
    });
    assert.deepEqual(result, { reveals: 1, follows: 0 });
  });

  await run('prompt jump loads older history pages until the text is visible', async page => {
    const result = await page.evaluate(async () => {
      await shortHistory();
      const started = requests.length;
      const pending = layer.seekText('line 3');
      const afterSeek = requests.length;
      layer.prepend(historyPage(3, requests.at(-1).requestId, false));
      await frames();
      const index = await pending;
      return {
        started,
        afterSeek,
        index,
        scrollTop: scroller.scrollTop,
        rowTop: layer.state.layout[index]?.top,
        seeking: layer.isSeeking(),
      };
    });
    assert.equal(result.started, 1);
    assert.equal(result.afterSeek, 2);
    assert.equal(result.index, 0);
    assert.equal(result.scrollTop, result.rowTop);
    assert.equal(result.seeking, false);
  });

  await run('prompt jump does not keep paging after the text is already loaded', async page => {
    const result = await page.evaluate(async () => {
      await shortHistory();
      const before = requests.length;
      const index = await layer.seekText('line 9');
      return { before, after: requests.length, index, seeking: layer.isSeeking() };
    });
    assert.equal(result.before, 1);
    assert.equal(result.after, 1);
    assert.equal(result.index, 0);
    assert.equal(result.seeking, false);
  });

  console.log(`SUMMARY ${12 - failures.length}/12 terminal history/recovery scenarios passed`);
  if (failures.length) process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
