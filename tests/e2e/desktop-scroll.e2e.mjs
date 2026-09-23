import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
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
    res.setHeader('Content-Type', 'text/javascript');
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
  assert.deepEqual(errors, [], 'browser errors');
  assert.deepEqual(failures, [], 'failed scroll scenarios');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
