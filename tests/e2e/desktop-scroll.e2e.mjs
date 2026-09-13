import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { resolveChromeExecutable } from './chrome-path.mjs';

// Bundle the shipped manager in memory; no generated files or cleanup deletion.
const bundle = await build({
  entryPoints: ['src/renderer/terminal-manager.ts'], bundle: true, write: false,
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
    await page.evaluate(async () => {
      window.duocli = { filewatcherOpen() {} };
      window.mgr = new DuoTerminal.TerminalManager(document.getElementById('area'));
      mgr.create('t1', 'vscode-dark', '/tmp', () => {});
      mgr.mountTo('t1', document.getElementById('area'));
      window.t = mgr.instances.get('t1').terminal;
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
    });
    try {
      await scenario(page);
      console.log(`PASS ${name}`);
    } catch (error) {
      failures.push(name);
      console.error(`FAIL ${name}: ${error.message}`);
    }
  };
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
  await run('downward wheel over rendered text snaps near bottom and resumes following', async page => {
    const result = await page.evaluate(async () => {
      wheel(-180);
      await frames();
      t.scrollToLine(t.buffer.active.baseY - 2);
      await frames();
      wheel(0.1);
      await frames();
      await write('LATEST\r\n');
      return t.buffer.active.baseY - t.buffer.active.viewportY;
    });
    assert.equal(result, 0);
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
    assert.equal(result.afterWrite, result.before);
    // xterm may shift the top row when height changes to preserve the bottom
    // visible row. It must still leave the reader in history, away from output.
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
      return { before, after: t.buffer.active.viewportY };
    });
    assert.equal(history.after, history.before);
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
    assert.equal(result.after, result.before);
    assert.ok(result.selection.includes('line 21'));
    assert.equal(result.afterSelection, result.selection);
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
      return { staleFocusCalls: focusCalls, focused: mgr.instances.get('t3').container.contains(document.activeElement) };
    });
    assert.deepEqual(result.staleFocusCalls, []);
    assert.equal(result.focused, true);
  });
  assert.deepEqual(errors, [], 'browser errors');
  assert.deepEqual(failures, [], 'failed scroll scenarios');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
