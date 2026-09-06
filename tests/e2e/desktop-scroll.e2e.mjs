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
  if (req.url === '/xterm.css') {
    res.setHeader('Content-Type', 'text/css');
    return res.end(css);
  }
  res.end(`<!doctype html><link rel="stylesheet" href="/xterm.css">
    <style>#area{position:relative;width:820px;height:420px}
    .terminal-container{position:absolute;inset:0;display:none;padding:4px}
    .terminal-container.active{display:block}.xterm{height:100%}</style>
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
  assert.deepEqual(errors, [], 'browser errors');
  assert.deepEqual(failures, [], 'failed scroll scenarios');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
