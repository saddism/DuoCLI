import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { closeTestBrowser } from './browser-cleanup.mjs';
import { resolveChromeExecutable } from './chrome-path.mjs';

const { LIVE_TERMINAL_SCROLLBACK } = createRequire(import.meta.url)('../../mobile/client/terminal-scroll-helpers.js');

// Bundle the shipped manager in memory; no generated files or cleanup deletion.
const bundle = await build({
  stdin: { contents: "export * from './src/renderer/terminal-manager'; export * from './src/renderer/pane-workspace';", resolveDir: process.cwd() },
  bundle: true, write: false,
  format: 'iife', globalName: 'DuoTerminal', platform: 'browser',
});
const css = readFileSync('node_modules/@xterm/xterm/css/xterm.css');
const server = http.createServer((req, res) => {
  if (req.url === '/bundle.js') {
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    return res.end(bundle.outputFiles[0].text);
  }
  if (req.url === '/styles.css') {
    res.setHeader('Content-Type', 'text/css');
    return res.end(readFileSync('src/renderer/styles.css'));
  }
  if (req.url === '/xterm.css') {
    res.setHeader('Content-Type', 'text/css');
    return res.end(css);
  }
  if (req.url === '/workspace') {
    res.setHeader('Content-Type', 'text/html');
    return res.end(readFileSync('src/renderer/index.html', 'utf8')
      .replace('../../node_modules/@xterm/xterm/css/xterm.css', '/xterm.css')
      .replace('src="app.js"', 'src="/bundle.js"'));
  }
  res.end(`<!doctype html><link rel="stylesheet" href="/xterm.css"><link rel="stylesheet" href="/styles.css">
    <style>#area{position:relative;width:820px;height:420px}</style>
    <div id="area"></div><script src="/bundle.js"></script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
const failures = [];
try {
  browser = await puppeteer.launch({
    executablePath: resolveChromeExecutable(),
    headless: true,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const run = async (name, scenario) => {
    if (process.env.DUOCLI_DESKTOP_SCENARIO && !name.includes(process.env.DUOCLI_DESKTOP_SCENARIO)) return;
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(async (liveScrollback) => {
      window.duocli = { filewatcherOpen() {} };
      window.mgr = new DuoTerminal.TerminalManager(document.getElementById('area'), () => {});
      mgr.create('t1', 'vscode-dark', '/tmp', () => {});
      mgr.mountTo('t1', document.getElementById('area'));
      window.t = mgr.instances.get('t1').terminal;
      if (t.options.scrollback !== liveScrollback) throw new Error(`live scrollback=${t.options.scrollback}`);
      window.frames = async (count = 5) => {
        for (let i = 0; i < count; i++) await new Promise(requestAnimationFrame);
      };
      window.wheel = (deltaY, target = '.xterm-screen') => {
        document.querySelector(target).dispatchEvent(new WheelEvent('wheel', {
          deltaY, bubbles: true, cancelable: true,
        }));
      };
      window.write = async data => {
        mgr.write('t1', data);
        await new Promise(resolve => t.write('', resolve));
        await frames();
      };
      await new Promise(resolve => setTimeout(resolve, 160));
      await write(Array.from({ length: 200 }, (_, i) => `line ${i}\r\n`).join(''));
    }, LIVE_TERMINAL_SCROLLBACK);
    try {
      await scenario(page);
      console.log(`PASS ${name}`);
    } catch (error) {
      failures.push(name);
      console.error(`FAIL ${name}: ${error.message}`);
    }
  };
  await run('first desktop reveal hydrates output produced before the renderer exists', async page => {
    const result = await page.evaluate(async () => {
      window.duocli.snapshotPty = async id => ({
        data: id === 't2' ? 'EARLY_OUTPUT\r\nREADY' : '',
        sequence: 4, epoch: 1, cols: 80, rows: 24,
      });
      mgr.create('t2', 'vscode-dark', '/tmp', () => {});
      const instance = mgr.instances.get('t2');
      await instance.revealPromise;
      const visible = Array.from({ length: instance.terminal.rows }, (_, i) =>
        instance.terminal.buffer.active.getLine(i)?.translateToString(true) || '').join('\n');
      return { visible, sequence: instance.appliedSeq, pending: instance.container.classList.contains('terminal-reveal-pending') };
    });
    assert.ok(result.visible.includes('EARLY_OUTPUT'), JSON.stringify(result));
    assert.ok(result.visible.includes('READY'), JSON.stringify(result));
    assert.equal(result.sequence, 4);
    assert.equal(result.pending, false);
  });
  await run('following after scrollback clear never briefly reads recycled history', async page => {
    const result = await page.evaluate(async () => {
      // Public operations reproduce a TUI clearing scrollback while xterm still
      // carries its user-scrolling flag from the previous viewport.
      t.scrollLines(-8);
      return await new Promise(resolve => t.write('\x1b[3J', () => {
        mgr.followSession('t1');
        resolve({ distance: t.buffer.active.baseY - t.buffer.active.viewportY,
          userScrolling: t._core._bufferService.isUserScrolling });
      }));
    });
    assert.equal(result.distance, 0);
    // Checking both is essential: a zero distance can still leave xterm in
    // history mode until a later DOM scroll event happens to clear it.
    assert.equal(result.userScrolling, false, JSON.stringify(result));
  });
  await run('prompt and composer height changes refit the actual terminal surface', async page => {
    const result = await page.evaluate(async () => {
      const inst = mgr.instances.get('t1');
      const containerHeight = inst.container.clientHeight;
      const before = t.rows;
      const composer = inst.container.querySelector('.terminal-composer');
      composer.style.height = `${composer.offsetHeight + 90}px`;
      await frames(8);
      const shrunk = t.rows;
      const expected = inst.fitAddon.proposeDimensions().rows;
      composer.style.height = '';
      await frames(8);
      return { before, shrunk, expected, restored: t.rows,
        sameContainer: containerHeight === inst.container.clientHeight,
        distance: t.buffer.active.baseY - t.buffer.active.viewportY };
    });
    assert.equal(result.sameContainer, true);
    assert.ok(result.shrunk < result.before, JSON.stringify(result));
    assert.equal(result.shrunk, result.expected);
    assert.equal(result.restored, result.before);
    assert.equal(result.distance, 0);
  });
  await run('restored taller snapshots keep the CLI input above the quick commands', async page => {
    const result = await page.evaluate(async () => {
      const inst = mgr.instances.get('t1');
      const expected = inst.fitAddon.proposeDimensions();
      const snapshotRows = expected.rows + 12;
      window.duocli.snapshotPty = async () => ({
        cols: t.cols, rows: snapshotRows, epoch: 1, sequence: 0,
        data: `\x1b[${snapshotRows};1HCLI_INPUT_NOT_HIDDEN`,
      });
      inst.needsResync = true;
      mgr.followSession('t1');
      await inst.revealPromise;
      await frames();
      const screen = t.element.querySelector('.xterm-screen').getBoundingClientRect();
      const surface = t.element.parentElement.getBoundingClientRect();
      const composer = inst.container.querySelector('.terminal-composer').getBoundingClientRect();
      const inputRow = [...t.element.querySelectorAll('.xterm-rows > div')]
        .find(row => row.textContent.includes('CLI_INPUT_NOT_HIDDEN'));
      return { rows: t.rows, expectedRows: expected.rows, screenBottom: screen.bottom,
        surfaceBottom: surface.bottom, composerTop: composer.top,
        inputBottom: inputRow?.getBoundingClientRect().bottom };
    });
    assert.equal(result.rows, result.expectedRows, JSON.stringify(result));
    assert.ok(result.screenBottom <= result.surfaceBottom + 1, JSON.stringify(result));
    assert.ok(result.inputBottom <= result.composerTop, JSON.stringify(result));
  });
  await run('changed character metrics refit rows even when the pane dimensions stay unchanged', async page => {
    const result = await page.evaluate(async () => {
      const inst = mgr.instances.get('t1');
      t.options.fontSize = 22;
      await frames();
      mgr.fitActive();
      await frames();
      const screen = t.element.querySelector('.xterm-screen').getBoundingClientRect();
      return { rows: t.rows, expectedRows: inst.fitAddon.proposeDimensions().rows,
        screenBottom: screen.bottom,
        composerTop: inst.container.querySelector('.terminal-composer').getBoundingClientRect().top };
    });
    assert.equal(result.rows, result.expectedRows, JSON.stringify(result));
    assert.ok(result.screenBottom <= result.composerTop, JSON.stringify(result));
  });
  await run('scrolling prompt text or quick commands does not change terminal scroll intent', async page => {
    const result = await page.evaluate(async () => {
      const inst = mgr.instances.get('t1');
      mgr.noteUserPrompt('t1', 'Long prompt '.repeat(80));
      const before = inst.scroll.gestureVersion();
      wheel(-80, '.user-prompt-text');
      wheel(30, '.desktop-quick-commands');
      document.querySelector('.xterm-screen').dispatchEvent(new WheelEvent('wheel', {
        deltaY: -80, shiftKey: true, bubbles: true, cancelable: true,
      }));
      await frames();
      return { before, after: inst.scroll.gestureVersion() };
    });
    assert.equal(result.after, result.before);
  });
  await run('repeated TUI redraw stays at the live edge on every rendered frame', async page => {
    const result = await page.evaluate(async () => {
      const samples = [];
      const sub = t.onRender(() => {
        const b = t.buffer.active;
        samples.push({ distance: b.baseY - b.viewportY,
          footer: t.element.querySelector('.xterm-rows')?.lastElementChild?.textContent });
      });
      for (let revision = 0; revision < 25; revision++) {
        const lines = Array.from({ length: t.rows }, (_, i) => (
          i === t.rows - 1 ? 'Add a follow-up | ctrl+c to stop' : `tool output row ${i} revision ${revision}`
        ));
        await write('\x1b[3J\x1b[H' + lines.join('\r\n'));
      }
      sub.dispose();
      return { count: samples.length, wrong: samples.filter(s => s.distance !== 0
        || !s.footer?.includes('Add a follow-up')), pageScroll: document.scrollingElement.scrollTop };
    });
    assert.ok(result.count >= 25, JSON.stringify(result));
    assert.deepEqual(result.wrong, []);
    assert.equal(result.pageScroll, 0);
  });
  await run('programmatic viewport drift does not disable output following', async page => {
    const result = await page.evaluate(async () => {
      // Reproduce a temporary viewport displacement during layout/buffer refresh.
      t.scrollLines(-8);
      await write('LATEST\r\n');
      return t.buffer.active.baseY - t.buffer.active.viewportY;
    });
    assert.equal(result, 0);
  });
  await run('queued output respects a newer upward wheel gesture', async page => {
    const result = await page.evaluate(async () => {
      const originalWrite = t.write.bind(t);
      let queued;
      t.write = (...args) => { queued = args; };
      mgr.write('t1', 'queued output\r\n');
      t.write = originalWrite;
      wheel(-180);
      await frames();
      t.scrollLines(-10);
      originalWrite(...queued);
      await new Promise(resolve => t.write('', resolve));
      await frames();
      return t.buffer.active.baseY - t.buffer.active.viewportY;
    });
    assert.ok(result >= 10, `distance=${result}`);
  });
  await run('reading just above the latest row is not cancelled by a tiny downward wheel', async page => {
    const result = await page.evaluate(async () => {
      wheel(-180);
      await frames();
      t.scrollToLine(t.buffer.active.baseY - 2);
      await frames();
      wheel(0.1);
      await frames();
      await write('LATEST\r\n');
      const held = t.buffer.active.baseY - t.buffer.active.viewportY;
      t.scrollToLine(t.buffer.active.baseY);
      await frames();
      wheel(40);
      await frames();
      await write('FOLLOW\r\n');
      return { held, followed: t.buffer.active.baseY - t.buffer.active.viewportY };
    });
    assert.ok(result.held >= 2, JSON.stringify(result));
    assert.equal(result.followed, 0);
  });
  await run('a downward snap callback cannot override a newer upward gesture', async page => {
    const result = await page.evaluate(async () => {
      wheel(-180);
      t.scrollLines(-10);
      wheel(1, '.xterm-viewport');
      wheel(-1, '.xterm-viewport');
      t.scrollToLine(t.buffer.active.baseY - 2);
      await frames();
      return t.buffer.active.baseY - t.buffer.active.viewportY;
    });
    assert.ok(result > 0, `distance=${result}`);
  });
  await run('streaming output, resize and alternate buffer return remain at bottom', async page => {
    const result = await page.evaluate(async () => {
      for (let i = 0; i < 20; i++) mgr.write('t1', `${'long output '.repeat(30)}\r\n`);
      document.getElementById('area').style.width = '560px';
      mgr.fitActive();
      await write('\x1b[?1049hworking\x1b[?1049lLATEST\r\n');
      return t.buffer.active.baseY - t.buffer.active.viewportY;
    });
    assert.equal(result, 0);
  });
  await run('reading history survives output and resize; bottom button resumes following', async page => {
    const result = await page.evaluate(async () => {
      wheel(-180);
      await frames();
      t.scrollLines(-20);
      await frames();
      const before = t.buffer.active.viewportY;
      await write('new output\r\n');
      const afterWrite = t.buffer.active.viewportY;
      document.getElementById('area').style.height = '360px';
      mgr.fitActive();
      await frames();
      const historyDistance = t.buffer.active.baseY - t.buffer.active.viewportY;
      document.querySelector('.scroll-bottom-btn').click();
      await write('LATEST\r\n');
      return { before, afterWrite, historyDistance, distance: t.buffer.active.baseY - t.buffer.active.viewportY };
    });
    // A full live buffer may recycle one row; the reader must stay in history.
    assert.ok(Math.abs(result.afterWrite - result.before) <= 1, JSON.stringify(result));
    assert.ok(result.historyDistance >= 20);
    assert.equal(result.distance, 0);
  });
  await run('real mouse wheel pauses history and resumes at the bottom', async page => {
    await page.mouse.move(200, 180);
    await page.mouse.wheel({ deltaY: -260 });
    await page.waitForFunction(() => t.buffer.active.baseY - t.buffer.active.viewportY > 5);
    const history = await page.evaluate(async () => {
      await frames();
      const before = t.buffer.active.viewportY;
      await write('output while reading\r\n');
      return {
        before,
        after: t.buffer.active.viewportY,
        baseY: t.buffer.active.baseY,
      };
    });
    assert.ok(history.after < history.baseY, JSON.stringify(history));
    assert.ok(Math.abs(history.after - history.before) <= 1, JSON.stringify(history));
    await page.mouse.wheel({ deltaY: 2000 });
    await page.waitForFunction(() => t.buffer.active.baseY === t.buffer.active.viewportY);
    assert.equal(await page.evaluate(async () => {
      await frames();
      await write('LATEST\r\n');
      return t.buffer.active.baseY - t.buffer.active.viewportY;
    }), 0);
  });
  await run('buffer switching does not turn history reading into following', async page => {
    const distance = await page.evaluate(async () => {
      wheel(-180);
      await frames();
      await write('\x1b[?1049hworking');
      await write('\x1b[?1049lback to normal\r\n');
      return t.buffer.active.baseY - t.buffer.active.viewportY;
    });
    assert.ok(distance > 5);
  });
  await run('input resumes output following and pending frames are safe on close', async page => {
    const distance = await page.evaluate(async () => {
      wheel(-180);
      await frames();
      mgr.notifyInput('t1');
      await write('input echoed\r\n');
      const distance = t.buffer.active.baseY - t.buffer.active.viewportY;
      wheel(1);
      mgr.destroy('t1');
      await frames();
      return distance;
    });
    assert.equal(distance, 0);
  });
  await run('remount stays covered until queued output is at the latest line', async page => {
    const result = await page.evaluate(async () => {
      mgr.detach('t1');
      mgr.write('t1', Array.from({ length: 80 }, (_, i) => `queued ${i}\r\n`).join(''));
      const host = document.createElement('div');
      host.style.cssText = 'position:absolute;inset:0';
      document.getElementById('area').appendChild(host);
      const inst = mgr.instances.get('t1');
      mgr.mountTo('t1', host);
      const pendingImmediately = inst.container.classList.contains('terminal-reveal-pending');
      await new Promise(resolve => setTimeout(resolve, 200));
      const visible = Array.from({ length: t.rows }, (_, i) => (
        t.buffer.active.getLine(t.buffer.active.viewportY + i)?.translateToString(true) || ''
      )).join('\n');
      return {
        pendingImmediately,
        revealed: !inst.container.classList.contains('terminal-reveal-pending'),
        distance: t.buffer.active.baseY - t.buffer.active.viewportY,
        visible,
      };
    });
    assert.equal(result.pendingImmediately, true);
    assert.equal(result.revealed, true);
    assert.equal(result.distance, 0);
    assert.match(result.visible, /queued 79/);
  });
  await run('switching to a detached session scrolls to latest output', async page => {
    const distance = await page.evaluate(async () => {
      mgr.create('t2', 'vscode-dark', '/tmp', () => {});
      wheel(-180);
      await frames();
      t.scrollLines(-20);
      await frames();
      mgr.detach('t1');
      for (let i = 0; i < 40; i++) mgr.write('t1', `hidden ${i}\r\n`);
      await new Promise(resolve => t.write('', resolve));
      await frames();
      const host = document.createElement('div');
      host.style.cssText = 'position:absolute;inset:0';
      document.getElementById('area').appendChild(host);
      mgr.mountTo('t1', host);
      mgr.switchTo('t1');
      await frames(8);
      await new Promise(resolve => setTimeout(resolve, 120));
      return t.buffer.active.baseY - t.buffer.active.viewportY;
    });
    assert.equal(distance, 0);
  });
  await run('switching panes while holding the mouse follows on release', async page => {
    const result = await page.evaluate(async () => {
      wheel(-180);
      await frames();
      t.scrollLines(-40);
      t.select(0, 10, 5);
      mgr.create('t2', 'vscode-dark', '/tmp', () => {});
      await new Promise(resolve => setTimeout(resolve, 160));
      // Pane focus runs on pointerdown, after the scroll controller pauses.
      mgr.instances.get('t1').container.querySelector('.xterm-screen')
        .dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
      mgr.switchTo('t1');
      await new Promise(resolve => setTimeout(resolve, 200));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      await frames();
      const afterRelease = t.buffer.active.baseY - t.buffer.active.viewportY;
      await write('latest after switching\r\n');
      return { afterRelease, afterWrite: t.buffer.active.baseY - t.buffer.active.viewportY };
    });
    assert.equal(result.afterRelease, 0);
    assert.equal(result.afterWrite, 0);
  });
  await run('a newer history gesture wins over delayed switch layout', async page => {
    const distance = await page.evaluate(async () => {
      mgr.create('t2', 'vscode-dark', '/tmp', () => {});
      mgr.switchTo('t1');
      wheel(-180);
      t.scrollLines(-30);
      await new Promise(resolve => setTimeout(resolve, 200));
      return t.buffer.active.baseY - t.buffer.active.viewportY;
    });
    // Fit may change the number of visible rows, but must retain history.
    assert.ok(distance > 0, `distance=${distance}`);
  });
  await run('drag selection scrolls across screens and stays in history on release', async page => {
    const point = await page.evaluate(async () => {
      // Mirror PaneWorkspace's bubbling focus callback for every pointerdown.
      document.getElementById('area').addEventListener('pointerdown', () => mgr.switchTo('t1'));
      wheel(-180);
      await frames();
      t.scrollToLine(20);
      await frames();
      const rect = t.element.querySelector('.xterm-screen').getBoundingClientRect();
      return { x: rect.left + 8, y: rect.top + 12, bottom: rect.bottom + 40 };
    });
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 70, point.bottom, { steps: 8 });
    await page.waitForFunction(() => {
      const pos = t.getSelectionPosition();
      return pos && pos.end.y - pos.start.y > t.rows;
    });
    await page.mouse.up();
    const result = await page.evaluate(async () => {
      await frames();
      const before = t.buffer.active.viewportY;
      const selection = t.getSelection();
      await write('output after selection\r\n');
      return { before, after: t.buffer.active.viewportY, selection, afterSelection: t.getSelection(),
        distance: t.buffer.active.baseY - t.buffer.active.viewportY };
    });
    assert.ok(result.distance > 0);
    assert.ok(Math.abs(result.after - result.before) <= 1, JSON.stringify(result));
    assert.ok(result.selection.length > 10, `selection=${JSON.stringify(result.selection)}`);
    assert.ok(result.afterSelection.length > 0);
  });
  await run('rapid switches keep keyboard focus on the last session', async page => {
    const result = await page.evaluate(async () => {
      const focusCalls = [];
      const originalFocus = t.focus.bind(t);
      t.focus = () => { focusCalls.push('t1'); originalFocus(); };
      mgr.create('t2', 'vscode-dark', '/tmp', () => {});
      mgr.switchTo('t1');
      mgr.destroy('t2');
      // An old delayed switch must not steal focus after the active id changes.
      mgr.create('t3', 'vscode-dark', '/tmp', () => {});
      await new Promise(resolve => setTimeout(resolve, 200));
      const current = mgr.instances.get('t3');
      const rect = current.container.getBoundingClientRect();
      return { staleFocusCalls: focusCalls, focused: current.container.contains(document.activeElement),
        activeId: mgr.activeId, classes: current.container.className,
        parent: current.container.parentElement.className, size: [rect.width, rect.height],
        activeElement: document.activeElement?.outerHTML.slice(0, 160) };
    });
    assert.deepEqual(result.staleFocusCalls, []);
    assert.equal(result.focused, true, JSON.stringify(result));
  });
  await run('desktop page keeps sidebar scrolling separate and fits the visible pane', async page => {
    await page.setViewport({ width: 1300, height: 900 });
    await page.goto(`http://127.0.0.1:${server.address().port}/workspace`);
    await page.evaluate(async () => {
      window.duocli = { filewatcherOpen() {} };
      const root = document.getElementById('pane-workspace');
      window.mgr = new DuoTerminal.TerminalManager(root, () => {});
      window.workspace = new DuoTerminal.PaneWorkspace(root, '/tmp', {
        onContentMount: (_id, content, body) => {
          if (content.kind === 'terminal') mgr.mountTo(content.sessionId, body);
        },
        onFocus: (_id, content) => {
          if (content.kind === 'terminal') mgr.switchTo(content.sessionId);
        },
      });
      mgr.create('full', 'vscode-dark', '/tmp', () => {});
      workspace.openContent({ kind: 'terminal', sessionId: 'full', label: '终端滚动回归' });
      window.inst = mgr.instances.get('full');
      window.t = inst.terminal;
      await inst.revealPromise;
      mgr.noteUserPrompt('full', '最新输出应稳定显示；只有主动向上滚动才进入历史。');
      await new Promise(resolve => setTimeout(resolve, 120));
      await new Promise(resolve => t.write(Array.from({ length: 180 }, (_, i) => `Live output ${i}\r\n`).join(''), resolve));
      const list = document.getElementById('session-list');
      list.replaceChildren(...Array.from({ length: 40 }, (_, i) => {
        const item = document.createElement('div'); item.className = 'session-item';
        item.textContent = `会话 ${i + 1}`; item.style.height = '70px'; return item;
      }));
      window.gestureBefore = inst.scroll.gestureVersion();
    });
    const sidebar = await page.$eval('#session-list', el => {
      const r = el.getBoundingClientRect(); return { x: r.left + 40, y: r.top + 60 };
    });
    await page.mouse.move(sidebar.x, sidebar.y);
    await page.mouse.wheel({ deltaY: 500 });
    await page.waitForFunction(() => document.getElementById('session-list').scrollTop > 0);
    const result = await page.evaluate(() => ({
      pageTop: document.scrollingElement.scrollTop,
      terminalTop: document.getElementById('terminal-area').scrollTop,
      gestureBefore, gestureAfter: inst.scroll.gestureVersion(),
      distance: t.buffer.active.baseY - t.buffer.active.viewportY,
      rows: t.rows, expectedRows: inst.fitAddon.proposeDimensions().rows,
    }));
    assert.equal(result.pageTop, 0);
    assert.equal(result.terminalTop, 0);
    assert.equal(result.gestureAfter, result.gestureBefore);
    assert.equal(result.distance, 0);
    assert.equal(result.rows, result.expectedRows);
    mkdirSync('tests/.artifacts/desktop-scroll', { recursive: true });
    await page.screenshot({ path: 'tests/.artifacts/desktop-scroll/workspace.png' });
  });
  await run('a collapsed file tree has no visible or draggable resize gutter', async page => {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const result = await page.evaluate(() => {
      const main = document.createElement('div');
      main.id = 'main';
      const tree = document.createElement('div');
      tree.id = 'file-tree-panel';
      tree.className = 'collapsed';
      const gutter = document.createElement('div');
      gutter.id = 'file-tree-resizer';
      gutter.className = 'resizer';
      gutter.hidden = true;
      main.append(tree, gutter);
      document.body.append(main);
      const style = getComputedStyle(gutter);
      const rect = gutter.getBoundingClientRect();
      return { display: style.display, cursor: style.cursor, width: rect.width, visible: gutter.checkVisibility() };
    });
    assert.equal(result.display, 'none');
    assert.equal(result.width, 0);
    assert.equal(result.visible, false);
  });
  await run('Codex alternate screen wheel pages the transcript without a copy button', async page => {
    const result = await page.evaluate(async () => {
      const sent = [];
      mgr.create('alt', 'vscode-dark', '/tmp', data => sent.push(data));
      mgr.mountTo('alt', document.getElementById('area'));
      const instance = mgr.instances.get('alt');
      const alt = instance.terminal;
      await new Promise(resolve => alt.write('\x1b[?1049h\x1b[?1000h\x1b[?1006hvisible codex line\r\n', resolve));
      await frames();
      const surface = instance.container.querySelector('.terminal-surface');
      const screen = surface.querySelector('.xterm-screen');
      screen.dispatchEvent(new WheelEvent('wheel', { deltaY: 240, bubbles: true, cancelable: true }));
      screen.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, bubbles: true, cancelable: true }));
      await new Promise(resolve => setTimeout(resolve, 130));
      sent.length = 0;
      screen.dispatchEvent(new WheelEvent('wheel', { deltaY: -50, bubbles: true, cancelable: true }));
      await new Promise(resolve => setTimeout(resolve, 130));
      screen.dispatchEvent(new WheelEvent('wheel', { deltaY: 50, bubbles: true, cancelable: true }));
      await new Promise(resolve => setTimeout(resolve, 130));
      return {
        type: alt.buffer.active.type,
        alternate: surface.classList.contains('is-alternate-screen'),
        sent: sent.join(''),
        buttons: [...surface.querySelectorAll('.terminal-alt-controls button')].map(button => button.textContent),
      };
    });
    assert.equal(result.type, 'alternate');
    assert.equal(result.alternate, true);
    assert.ok(result.sent.includes('\u001b[6~'), JSON.stringify(result));
    assert.ok(result.sent.includes('\u001b[5~'), JSON.stringify(result));
    assert.equal(result.sent.includes('\u001b[A') || result.sent.includes('\u001b[B') || result.sent.includes('\u001b[<'), false);
    assert.deepEqual(result.buttons, []);
  });
  await run('selecting at the live edge keeps the viewport still during new output', async page => {
    const result = await page.evaluate(async () => {
      t.scrollToBottom();
      t.select(0, t.buffer.active.viewportY + 2, 7);
      await frames(2);
      const before = t.buffer.active.viewportY;
      const selection = t.getSelection();
      await write('new output while copying\r\n'.repeat(8));
      return { before, after: t.buffer.active.viewportY, selection, afterSelection: t.getSelection() };
    });
    assert.equal(result.after, result.before, JSON.stringify(result));
    assert.equal(result.afterSelection, result.selection);
    assert.ok(result.selection.length > 0);
  });
  await run('a full row keeps its last glyph inside the pane', async page => {
    const result = await page.evaluate(async () => {
      mgr.fitActive();
      await frames(2);
      const line = 'W'.repeat(t.cols);
      await new Promise(resolve => t.write(`\r\n${line}\r\n`, resolve));
      await frames(2);
      const row = [...t.element.querySelectorAll('.xterm-rows > div')].reverse()
        .find(el => el.textContent.includes('W'));
      const span = row?.querySelector('span:last-of-type');
      const range = document.createRange();
      range.selectNodeContents(span);
      const glyph = range.getBoundingClientRect();
      const surface = t.element.parentElement.getBoundingClientRect();
      const cell = surface.width / t.cols;
      return {
        letter: getComputedStyle(t.element.querySelector('.xterm-rows')).letterSpacing,
        overflow: glyph.right - surface.right,
        unused: surface.right - glyph.right,
        cell,
        cols: t.cols,
        glyphs: span.textContent.length,
      };
    });
    assert.ok(Math.abs(parseFloat(result.letter)) < 1, JSON.stringify(result));
    assert.ok(result.overflow <= 0.5, JSON.stringify(result));
    assert.ok(result.unused < result.cell, JSON.stringify(result));
    assert.equal(result.glyphs, result.cols);
  });
  await run('desktop Codex tools fold by default while the native input remains available', async page => {
    await page.evaluate(async () => {
      document.getElementById('area').style.height = '700px';
      mgr.fitActive();
      await frames();
      t.reset();
      const rows = t.rows;
      await write('\x1b[?1049h\x1b[2J\x1b[H' +
        '• Viewed image desktop-active-session.png\r\n\r\n' +
        '• Explored\r\n  └ Read src/audit.log\r\n\r\n' +
        '• Edited test.js (+4 -0)\r\n  109 + new line\r\n  + Show details\r\n\r\n' +
        '• Ran npm test\r\n  └ PASS checks\r\n  + Show details\r\n\r\n' +
        '• Failed (exit 1) npm check\r\n  └ error detail\r\n\r\n' +
        '• Used computer · 3 actions\r\n  └ 检查窗口\r\n  + Show details\r\n\r\n' +
        '• 已修复，正文保持可见。' + `\x1b[${rows - 3};1H› Ask Codex to do anything` +
        `\x1b[${rows - 1};1HGPT-6.1-Sol high\x1b[${rows};1H? for shortcuts\x1b[${rows - 3};3H`);
      window.typed = [];
      t.onData(data => typed.push(data));
    });
    await page.waitForFunction(() => !document.querySelector('.terminal-activity-view').hidden);
    const result = await page.evaluate(() => {
      const root = document.querySelector('.terminal-activity-view');
      const native = t.element.querySelector('.xterm-screen').getBoundingClientRect();
      const promptTop = native.top + (t.rows - 4) * native.height / t.rows;
      return { labels: [...root.querySelectorAll('summary .terminal-activity-label')].map(node => node.textContent),
        closed: [...root.querySelectorAll('details')].every(node => !node.open),
        bodyVisible: root.querySelector('.terminal-activity-plain')?.textContent.includes('正文保持可见'),
        promptDuplicated: root.textContent.includes('Ask Codex'),
        inputExposed: root.getBoundingClientRect().bottom <= promptTop + 1,
        original: t.buffer.active.getLine(6).translateToString(true) };
    });
    assert.deepEqual(result.labels, ['Viewed image', 'Explored', 'Edited', 'Ran', 'Failed', 'Used computer']);
    assert.equal(await page.$eval('.terminal-activity-status', node => node.textContent), 'exit 1');
    assert.equal(result.closed && result.bodyVisible && result.inputExposed, true, JSON.stringify(result));
    assert.equal(result.promptDuplicated, false);
    assert.match(result.original, /109 \+ new line/);
    await page.evaluate(() => t.focus());
    await page.keyboard.type('hello');
    assert.equal(await page.evaluate(() => typed.join('')), 'hello');
    await page.click('.terminal-activity-group summary');
    await page.evaluate(async () => { await write(''); });
    assert.equal(await page.$eval('.terminal-activity-group', node => node.open), true);
    await page.evaluate(() => {
      window.opened = [];
      window.duocli.filewatcherOpen = filePath => opened.push(filePath);
    });
    await page.$$eval('.terminal-activity-group', nodes => { nodes[1].open = true; });
    await page.click('[data-terminal-file="src/audit.log"]');
    assert.deepEqual(await page.evaluate(() => opened), ['/tmp/src/audit.log']);
    await page.$$eval('.terminal-activity-group', nodes => { nodes[1].open = false; });
    assert.equal(await page.$('.terminal-activity-toolbar'), null);
    assert.equal(await page.$('.terminal-activity-reopen'), null);
    await page.evaluate(() => mgr.setActivitiesExpanded('t1', true));
    assert.equal(await page.$$eval('.terminal-activity-group', nodes => nodes.every(node => node.open)), true);
    await page.evaluate(() => mgr.setActivitiesExpanded('t1', false));
    assert.equal(await page.$$eval('.terminal-activity-group', nodes => nodes.every(node => !node.open)), true);
    await page.$eval('.terminal-activity-scroller', node => {
      node.scrollTop = 0;
      node.dispatchEvent(new WheelEvent('wheel', { deltaY: -60, bubbles: true, cancelable: true }));
    });
    assert.equal(await page.$eval('.terminal-activity-view', node => node.hidden), false);
    await page.click('.terminal-activity-group summary');
    mkdirSync('tests/.artifacts/desktop-scroll', { recursive: true });
    await page.screenshot({ path: 'tests/.artifacts/desktop-scroll/codex-folded-tools.png' });
  });

  await run('folded live output follows growth and sidebar reselect resumes paused records', async page => {
    await page.evaluate(async () => {
      mgr.switchTo('t1');
      await mgr.instances.get('t1').revealPromise;
      await write('\r\n• Ran inspect-report\r\n  details\r\n\r\n' +
        Array.from({ length: 36 }, (_, i) => `正文 ${i}\r\n`).join(''));
      mgr.instances.get('t1').activityView.refresh();
    });
    const distance = () => page.$eval('#tc-t1 .terminal-activity-scroller', el =>
      el.scrollHeight - el.clientHeight - el.scrollTop);
    assert.ok(await distance() <= 2, 'the first folded projection starts at the latest content');
    await page.evaluate(async () => {
      await write(Array.from({ length: 12 }, (_, i) => `新增 ${i}\r\n`).join(''));
      mgr.instances.get('t1').activityView.refresh();
    });
    assert.ok(await distance() <= 2, 'a large append must not turn following off');
    await page.click('#tc-t1 .terminal-activity-scroller', { offset: { x: 600, y: 200 } });
    await page.evaluate(async () => {
      await write('普通点击后继续输出\r\n');
      mgr.instances.get('t1').activityView.refresh();
    });
    assert.ok(await distance() <= 2, 'a plain click at the live edge must not pause following');
    await page.click('#tc-t1 .terminal-activity-group summary');
    await page.$eval('#tc-t1 .terminal-activity-scroller', el => {
      el.scrollTop = (el.scrollHeight - el.clientHeight) / 3;
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }));
    });
    await page.evaluate(async () => {
      await write('暂停时到达的最终答复\r\n');
      await new Promise(resolve => setTimeout(resolve, 250));
      mgr.instances.get('t1').activityView.refresh();
    });
    assert.ok(await distance() > 100, 'reading older records preserves the reading position');
    await page.waitForSelector('#tc-t1 .terminal-activity-latest', { visible: true });
    await page.click('#tc-t1 .terminal-activity-latest');
    assert.ok(await distance() <= 2, 'local latest works without sending Escape to an idle CLI');
    assert.equal(await page.$eval('#tc-t1 details', el => el.open), true);
    await page.evaluate(async () => {
      await write('记录仍展开时继续输出\r\n');
      mgr.instances.get('t1').activityView.refresh();
    });
    assert.ok(await distance() <= 2, 'explicit follow remains active with an expanded record');
    await page.$eval('#tc-t1 .terminal-activity-scroller', el => {
      el.scrollTop = (el.scrollHeight - el.clientHeight) / 3;
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }));
    });
    await page.evaluate(() => mgr.followSession('t1'));
    assert.ok(await distance() <= 2, 'sidebar reselect follows the folded scroller too');
    mkdirSync('tests/.artifacts/desktop-scroll', { recursive: true });
    await page.screenshot({ path: 'tests/.artifacts/desktop-scroll/folded-live-latest.png' });
  });
  await run('folded Codex history scrolls forward and returns to the conclusion without another message', async page => {
    await page.evaluate(async () => {
      window.historyKeys = [];
      const frame = latest => '\x1b[?1049h\x1b[2J\x1b[H' +
        '• Explored\r\n  └ Read report.json\r\n\r\n' +
        (latest ? '• 六个主题都跑完了，结论现在可见。\r\n' : '• 正在查看较早的工具记录。\r\n') +
        `\x1b[${historyTerminal.rows - 3};1H› Ask Codex to do anything` +
        `\x1b[${historyTerminal.rows - 1};1H` +
        (latest ? 'GPT-6 · ? shortcuts' : 'New activity · enter/esc latest · ? shortcuts') +
        `\x1b[${historyTerminal.rows - 3};3H`;
      mgr.create('codex-history', 'vscode-dark', '/tmp', data => {
        historyKeys.push(data);
        if (data === '\x1b[6~' || data === '\x1b') mgr.write('codex-history', frame(true));
      });
      mgr.mountTo('codex-history', document.getElementById('area'));
      mgr.switchTo('codex-history');
      await mgr.instances.get('codex-history').revealPromise;
      window.historyTerminal = mgr.instances.get('codex-history').terminal;
      window.showCodexHistory = async () => {
        mgr.write('codex-history', frame(false));
        await new Promise(resolve => historyTerminal.write('', resolve));
        await new Promise(resolve => setTimeout(resolve, 200));
      };
      await showCodexHistory();
      const scroller = document.querySelector('#tc-codex-history .terminal-activity-scroller');
      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => historyKeys.includes('\x1b[6~'), { timeout: 1500 });
    await page.waitForFunction(() => document.querySelector('#tc-codex-history .terminal-activity-plain')?.textContent.includes('结论现在可见'));
    await page.evaluate(() => showCodexHistory());
    await page.waitForSelector('#tc-codex-history .terminal-activity-latest', { visible: true });
    await page.click('#tc-codex-history .terminal-activity-latest');
    await page.waitForFunction(() => document.querySelector('#tc-codex-history .terminal-activity-plain')?.textContent.includes('结论现在可见'));
    assert.deepEqual(await page.evaluate(() => historyKeys), ['\x1b[6~', '\x1b']);
    assert.equal(await page.$eval('#tc-codex-history .terminal-activity-group', node => node.open), false);
    assert.equal(await page.$eval('#tc-codex-history .terminal-activity-latest', node => node.hidden), true);
    mkdirSync('tests/.artifacts/desktop-scroll', { recursive: true });
    await page.screenshot({ path: 'tests/.artifacts/desktop-scroll/codex-conclusion-latest.png' });
  });
  await run('Codex folding preserves history state and prose across redraws without paging on collapse', async page => {
    await page.evaluate(async () => {
      window.reviewKeys = [];
      mgr.create('fold-review', 'vscode-dark', '/tmp', data => reviewKeys.push(data));
      mgr.mountTo('fold-review', document.getElementById('area'));
      mgr.switchTo('fold-review');
      await mgr.instances.get('fold-review').revealPromise;
      window.reviewTerm = mgr.instances.get('fold-review').terminal;
      window.reviewFold = mgr.instances.get('fold-review').activityView;
      window.reviewFrame = async (body, history = true, footerCaret = false) => {
        mgr.write('fold-review', '\x1b[?1049h\x1b[2J\x1b[H' + body +
          `\x1b[${reviewTerm.rows - 4};1H` + (history ? 'New activity · ↓ Back to bottom · esc' : '') +
          `\x1b[${reviewTerm.rows - 3};1H› Ask Codex to do anything` +
          `\x1b[${reviewTerm.rows - 1};1H` + (history ? 'enter/esc latest' : '? shortcuts') +
          `\x1b[${footerCaret ? reviewTerm.rows - 1 : reviewTerm.rows - 3};3H`);
        await new Promise(resolve => reviewTerm.write('', resolve));
        await new Promise(resolve => setTimeout(resolve, 220));
      };
      await reviewFrame('• Explored\r\n  └ Read early-report.json\r\n\r\n  早期说明仍然可见。\r\n');
    });
    await page.click('#tc-fold-review .terminal-activity-group summary');
    assert.equal(await page.$eval('#tc-fold-review details', node => node.open), true);
    const earlyText = await page.$eval('#tc-fold-review .terminal-activity-scroller', node => node.textContent);
    await page.evaluate(() => reviewFrame('• Explored\r\n  └ Read later-report.json\r\n\r\n  后续说明仍然可见。\r\n'));
    assert.equal(await page.$eval('#tc-fold-review details', node => node.open), false, 'a different generic heading must not inherit the open state');
    await page.evaluate(() => reviewFrame('• Explored\r\n  └ Read early-report.json\r\n\r\n  早期说明仍然可见。\r\n'));
    assert.equal(await page.$eval('#tc-fold-review details', node => node.open), true, 'returning to the earlier record restores its state');
    assert.equal(await page.$eval('#tc-fold-review .terminal-activity-scroller', node => node.textContent), earlyText);
    await page.evaluate(() => {
      for (let i = 0; i < 12; i++) reviewFold.setExpanded(i % 2 === 0);
    });
    assert.deepEqual(await page.evaluate(() => reviewKeys), []);
    assert.equal(await page.$eval('#tc-fold-review .terminal-activity-scroller', node => node.textContent), earlyText);
    assert.doesNotMatch(earlyText, /Back to bottom|Ask Codex/);
    assert.equal(await page.$eval('#tc-fold-review .terminal-activity-view', root =>
      root.querySelector('.terminal-activity-latest').getBoundingClientRect().bottom <=
      root.querySelector('.terminal-activity-scroller').getBoundingClientRect().top + 1), true,
    'return-to-latest must not cover the first record or its count');
    assert.match(await page.$eval('#tc-fold-review .terminal-activity-plain', node => node.textContent), /早期说明/);
    await page.evaluate(() => reviewFrame('  这一页只有正文，也必须继续显示。\r\n', true, true));
    assert.equal(await page.$eval('#tc-fold-review .terminal-activity-view', node => node.hidden), false);
    assert.equal(await page.$eval('#tc-fold-review .terminal-activity-history-hint', node => node.hidden), false);
    assert.match(await page.$eval('#tc-fold-review .terminal-activity-plain', node => node.textContent), /只有正文/);
    await page.evaluate(() => reviewFrame('• Ran npm test\r\n  └ PASS\r\n\r\n  最新结论仍然可见。\r\n', false));
    await page.$eval('#tc-fold-review .terminal-activity-scroller', node => {
      node.scrollTop = node.scrollHeight;
      for (let i = 0; i < 20; i++) node.dispatchEvent(new WheelEvent('wheel', { deltaY: 60, bubbles: true, cancelable: true }));
    });
    assert.deepEqual(await page.evaluate(() => reviewKeys), [], 'the latest screen must not receive PageDown');
    await page.evaluate(() => reviewFrame('• Explored\r\n  └ Read early-report.json\r\n\r\n  历史正文。\r\n'));
    await page.$eval('#tc-fold-review .terminal-activity-scroller', node => {
      node.scrollTop = 0;
      for (let i = 0; i < 20; i++) node.dispatchEvent(new WheelEvent('wheel', { deltaY: -60, bubbles: true, cancelable: true }));
    });
    assert.deepEqual(await page.evaluate(() => reviewKeys), ['\x1b[5~'], 'one gesture burst must not skip many history pages');
    mkdirSync('tests/.artifacts/desktop-scroll', { recursive: true });
    await page.screenshot({ path: 'tests/.artifacts/desktop-scroll/fold-history-review.png' });
  });
  await run('folded history does not lose later prose when redraw leaves the caret on an old prompt', async page => {
    await page.evaluate(async () => {
      await write('\x1b[?1049h\x1b[2J\x1b[H' +
        '• Ran check\r\n  └ PASS\r\n\r\n' +
        '› 历史里的用户问题\r\n\r\n• 后续回答必须立即可见。\r\n' +
        `\x1b[${t.rows - 4};1H↓ Back to bottom · esc` +
        `\x1b[${t.rows - 3};1H› Ask Codex to do anything` +
        `\x1b[${t.rows - 1};1Henter/esc latest\x1b[4;3H`);
    });
    await page.waitForFunction(() => !document.querySelector('.terminal-activity-view').hidden);
    await new Promise(resolve => setTimeout(resolve, 240));
    const result = await page.evaluate(() => {
      const root = document.querySelector('.terminal-activity-view');
      const screen = t.element.querySelector('.xterm-screen').getBoundingClientRect();
      return { text: root.querySelector('.terminal-activity-scroller').textContent,
        bottom: root.getBoundingClientRect().bottom,
        promptTop: screen.top + (t.rows - 4) * screen.height / t.rows };
    });
    assert.match(result.text, /后续回答必须立即可见/);
    assert.doesNotMatch(result.text, /Ask Codex/);
    assert.ok(Math.abs(result.bottom - result.promptTop) <= 1, JSON.stringify(result));
    mkdirSync('tests/.artifacts/desktop-scroll', { recursive: true });
    await page.screenshot({ path: 'tests/.artifacts/desktop-scroll/folded-redraw-caret.png' });
  });

  await run('folded input boundary updates after font layout without output or a terminal resize', async page => {
    await page.evaluate(async () => {
      await write('\x1b[?1049h\x1b[2J\x1b[H• Ran check\r\n  └ PASS\r\n\r\n• 正文。' +
        `\x1b[${t.rows - 3};1H› Ask Codex to do anything\x1b[${t.rows - 3};3H`);
    });
    await page.waitForFunction(() => !document.querySelector('.terminal-activity-view').hidden);
    await page.evaluate(async () => {
      window.geometryBefore = { rows: t.rows, cols: t.cols };
      t.options.fontSize = 11;
      await frames();
    });
    await new Promise(resolve => setTimeout(resolve, 240));
    const result = await page.evaluate(() => {
      const root = document.querySelector('.terminal-activity-view');
      const screen = t.element.querySelector('.xterm-screen').getBoundingClientRect();
      return { before: geometryBefore, after: { rows: t.rows, cols: t.cols },
        bottom: root.getBoundingClientRect().bottom,
        promptTop: screen.top + (t.rows - 4) * screen.height / t.rows };
    });
    assert.deepEqual(result.before, result.after);
    assert.ok(Math.abs(result.bottom - result.promptTop) <= 1, JSON.stringify(result));
    mkdirSync('tests/.artifacts/desktop-scroll', { recursive: true });
    await page.screenshot({ path: 'tests/.artifacts/desktop-scroll/folded-layout-refresh.png' });
  });

  await run('folded prose uses the full pane width and follows fitted terminal font metrics', async page => {
    await page.evaluate(async () => {
      window.duocli.onPtyGeometry = () => {};
      window.duocli.snapshotPty = async () => ({ cols: 100, rows: 32, sequence: 10, epoch: 1,
        data: '\x1b[?1049h\x1b[2J\x1b[H• Explored\r\n  └ Read src/audit.log\r\n\r\n'
          + '折叠后的正文应该利用整个终端宽度，保持与原终端一致的字号，不在右侧留下多余空白。'.repeat(3)
          + '\x1b[29;1H› Ask Codex to do anything\x1b[29;3H' });
      const instance = mgr.instances.get('t1');
      instance.needsResync = true;
      mgr.followSession('t1');
      await instance.revealPromise;
    });
    for (const width of [820, 520]) {
      const result = await page.evaluate(async width => {
        document.getElementById('area').style.width = `${width}px`;
        mgr.fitActive();
        await frames();
        const instance = mgr.instances.get('t1');
        instance.activityView.refresh();
        const root = instance.activityView.root;
        const plain = root.querySelector('.terminal-activity-plain');
        const scroller = root.querySelector('.terminal-activity-scroller');
        return { font: parseFloat(getComputedStyle(root).fontSize), terminalFont: t.options.fontSize,
          bodyWidth: plain.getBoundingClientRect().width, paneWidth: root.getBoundingClientRect().width,
          overflow: scroller.scrollWidth > scroller.clientWidth + 1,
          controls: root.querySelector('.terminal-activity-toolbar'), text: plain.textContent };
      }, width);
      assert.ok(Math.abs(result.font - result.terminalFont) < 0.01, JSON.stringify(result));
      assert.ok(result.bodyWidth >= result.paneWidth - 20, JSON.stringify(result));
      assert.equal(result.overflow, false, JSON.stringify(result));
      assert.equal(result.controls, null);
      assert.match(result.text, /利用整个终端宽度/);
      mkdirSync('tests/.artifacts/desktop-scroll', { recursive: true });
      await page.screenshot({ path: `tests/.artifacts/desktop-scroll/folded-width-${width}.png` });
    }
  });

  await run('wide shared PTY output remains readable at the right edge of a smaller pane', async page => {
    await page.setViewport({ width: 1000, height: 800 });
    const result = await page.evaluate(async () => {
      const inst = mgr.instances.get('t1');
      const desired = inst.fitAddon.proposeDimensions();
      const cols = desired.cols + 60;
      window.reportedSizes = [];
      mgr.onResize = (_id, cols, rows) => reportedSizes.push({ cols, rows });
      inst.lastReportedSize = null;
      window.duocli.onPtyGeometry = () => {};
      window.duocli.snapshotPty = async () => ({ cols, rows: desired.rows, sequence: 10, epoch: 1,
        data: '\x1b[?1049h\x1b[2J\x1b[H' + 'X'.repeat(cols - 10) + 'RIGHT_EDGE' +
          `\x1b[${desired.rows - 3};1H› Ask Codex to do anything\x1b[${desired.rows - 3};3H` });
      inst.needsResync = true;
      mgr.followSession('t1');
      await inst.revealPromise;
      await frames();
      const host = t.element.parentElement;
      const screen = t.element.querySelector('.xterm-screen').getBoundingClientRect();
      const bounds = host.getBoundingClientRect();
      const row = t.element.querySelector('.xterm-rows > div').getBoundingClientRect();
      for (let i = 0; i < 5; i++) mgr.fitActive();
      return { cols: t.cols, sourceCols: cols, screenWidth: screen.width, hostWidth: bounds.width,
        clientWidth: host.clientWidth, scrollWidth: host.scrollWidth, rowRight: row.right, hostRight: bounds.right,
        reports: reportedSizes.length,
        selectStart: { x: screen.left + (cols - 9.9) * screen.width / cols, y: screen.top + screen.height / t.rows / 2 },
        selectEnd: { x: screen.right - 0.1, y: screen.top + screen.height / t.rows / 2 } };
    });
    assert.equal(result.cols, result.sourceCols);
    assert.ok(result.screenWidth <= result.hostWidth + 1, JSON.stringify(result));
    assert.equal(result.reports, 1, 'fitted glyph size must not feed back into repeated PTY resizing');
    await page.mouse.move(result.selectStart.x, result.selectStart.y);
    await page.mouse.down();
    await page.mouse.move(result.selectEnd.x, result.selectEnd.y, { steps: 8 });
    await page.mouse.up();
    assert.equal(await page.evaluate(() => t.getSelection().trim()), 'RIGHT_EDGE');
    const resized = await page.evaluate(async () => {
      t.clearSelection();
      const area = document.getElementById('area');
      area.style.width = '640px';
      await frames(8);
      const host = t.element.parentElement.getBoundingClientRect();
      const screen = t.element.querySelector('.xterm-screen').getBoundingClientRect();
      const narrowFits = screen.right <= host.right + 1;
      area.style.width = '1600px';
      await frames(8);
      return { narrowFits, restoredFont: t.options.fontSize, cols: t.cols,
        line: t.buffer.active.getLine(0).translateToString(true) };
    });
    assert.equal(resized.narrowFits, true);
    assert.equal(resized.restoredFont, 14);
    assert.equal(resized.cols, result.sourceCols);
    assert.match(resized.line, /RIGHT_EDGE$/);
    await page.evaluate(async () => {
      document.getElementById('area').style.width = '820px';
      await frames(8);
    });
    mkdirSync('tests/.artifacts/desktop-scroll', { recursive: true });
    await page.screenshot({ path: 'tests/.artifacts/desktop-scroll/wide-pty-right-edge.png' });
    await page.setViewport({ width: 800, height: 600 });
  });

  await run('restore geometry churn retries automatically after layout settles', async page => {
    const result = await page.evaluate(async () => {
      const inst = mgr.instances.get('t1');
      let snapshots = 0;
      window.duocli.onPtyGeometry = () => {};
      window.duocli.snapshotPty = async () => {
        snapshots++;
        if (snapshots <= 3) mgr.applyPtyGeometry('t1');
        return { cols: t.cols, rows: t.rows, sequence: 10, epoch: 1,
          data: 'RESTORE_SETTLED' };
      };
      inst.needsResync = true;
      mgr.followSession('t1');
      await inst.revealPromise;
      return { snapshots, needsResync: inst.needsResync,
        pending: inst.container.classList.contains('terminal-reveal-pending'),
        restored: t.buffer.active.getLine(0).translateToString(true) };
    });
    assert.equal(result.snapshots, 4, JSON.stringify(result));
    assert.equal(result.needsResync, false);
    assert.equal(result.pending, false);
    assert.match(result.restored, /RESTORE_SETTLED/);
  });

  await run('legacy resize acknowledgement recovers geometry without leaving input pending', async page => {
    const result = await page.evaluate(async () => {
      const inst = mgr.instances.get('t1');
      const desired = inst.fitAddon.proposeDimensions();
      let geometry = { cols: desired.cols, rows: desired.rows + 12 };
      let sequence = 20;
      let snapshots = 0;
      window.duocli.onPtyGeometry = () => {};
      window.duocli.snapshotPty = async () => {
        snapshots++;
        const captured = { ...geometry, sequence, epoch: 1,
          data: `\x1b[?1049h\x1b[2J\x1b[${geometry.rows - 3};1H› Ask Codex to do anything\x1b[${geometry.rows - 3};3H` };
        await frames(2);
        return captured;
      };
      mgr.onResize = (_id, cols, rows) => {
        geometry = { cols, rows };
        sequence++;
        // Existing Electron processes reply true, without the new dimensions.
        Promise.resolve(true).then(() => mgr.applyPtyGeometry('t1'));
      };
      inst.lastReportedSize = undefined;
      inst.needsResync = true;
      mgr.followSession('t1');
      await inst.revealPromise;
      await frames(12);
      await inst.revealPromise;
      return { snapshots, needsResync: inst.needsResync,
        pending: inst.container.classList.contains('terminal-reveal-pending'),
        rows: t.rows, sourceRows: geometry.rows,
        prompts: Array.from({ length: t.buffer.active.length }, (_, row) => t.buffer.active.getLine(row)?.translateToString(true) || '')
          .filter(line => line.includes('Ask Codex')).length };
    });
    assert.ok(result.snapshots >= 2, JSON.stringify(result));
    assert.equal(result.needsResync, false, JSON.stringify(result));
    assert.equal(result.pending, false, JSON.stringify(result));
    assert.equal(result.rows, result.sourceRows);
    assert.equal(result.prompts, 1);
  });

  await run('shared PTY geometry keeps partial TUI redraws from leaving duplicated input rows', async page => {
    const result = await page.evaluate(async () => {
      const inst = mgr.instances.get('t1');
      const desired = inst.fitAddon.proposeDimensions();
      let sourceRows = desired.rows + 12;
      let sequence = 10;
      const screen = () => '\x1b[?1049h\x1b[2J\x1b[HTranscript' +
        `\x1b[${sourceRows - 3};1H› Ask Codex to do anything` +
        `\x1b[${sourceRows};1H? for shortcuts\x1b[${sourceRows - 3};3H`;
      // Without a geometry notification, a taller producer addresses the old
      // client's last row and leaves its previous prompt behind.
      const stale = new t.constructor({ cols: desired.cols, rows: desired.rows });
      await new Promise(resolve => stale.write(`\x1b[?1049h\x1b[2J\x1b[${desired.rows - 3};1H› Ask Codex to do anything`, resolve));
      await new Promise(resolve => stale.write(`\x1b[${sourceRows - 3};1H\x1b[2K› Ask Codex to do anything`, resolve));
      const stalePrompts = Array.from({ length: stale.buffer.active.length }, (_, row) => stale.buffer.active.getLine(row)?.translateToString(true) || '')
        .filter(line => line.includes('Ask Codex')).length;
      stale.dispose();
      window.duocli.onPtyGeometry = () => {};
      window.duocli.snapshotPty = async () => ({ cols: desired.cols, rows: sourceRows, sequence, epoch: 1, data: screen() });
      inst.needsResync = true;
      mgr.followSession('t1');
      await inst.revealPromise;
      mgr.fitActive();
      const firstRows = t.rows;
      mgr.applyParsed('t1', `\x1b[${sourceRows - 3};1H\x1b[2K› Ask Codex to do anything\x1b[${sourceRows};1H\x1b[2K? for shortcuts`, ++sequence);
      await new Promise(resolve => t.write('', resolve));
      const countPrompts = () => Array.from({ length: t.buffer.active.length }, (_, row) => t.buffer.active.getLine(row)?.translateToString(true) || '')
        .filter(line => line.includes('Ask Codex')).length;
      const afterRedraw = countPrompts();
      sourceRows -= 5;
      sequence++;
      mgr.applyPtyGeometry('t1', { cols: desired.cols, rows: sourceRows });
      await inst.revealPromise;
      mgr.applyParsed('t1', `\x1b[${sourceRows - 3};1H\x1b[2K› Ask Codex to do anything`, ++sequence);
      await new Promise(resolve => t.write('', resolve));
      const native = t.element.querySelector('.xterm-screen').getBoundingClientRect();
      const host = t.element.parentElement.getBoundingClientRect();
      const promptTop = native.top + (sourceRows - 4) * native.height / t.rows;
      return { stalePrompts, firstRows, originalRows: desired.rows + 12, rows: t.rows, sourceRows, afterRedraw,
        afterResize: countPrompts(), inputExposed: promptTop >= host.top && promptTop < host.bottom };
    });
    assert.equal(result.firstRows, result.originalRows, JSON.stringify(result));
    assert.equal(result.stalePrompts, 2, JSON.stringify(result));
    assert.equal(result.rows, result.sourceRows);
    assert.equal(result.afterRedraw, 1);
    assert.equal(result.afterResize, 1);
    assert.equal(result.inputExposed, true, JSON.stringify(result));
  });
  assert.deepEqual(errors, [], 'browser errors');
  assert.deepEqual(failures, [], 'failed scroll scenarios');
} finally {
  await closeTestBrowser(browser);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
