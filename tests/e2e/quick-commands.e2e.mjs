import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { resolveChromeExecutable } from './chrome-path.mjs';
import { QuickCommandStore } from '../../dist/main/quick-commands.js';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'duocli-quick-e2e-'));
const store = new QuickCommandStore(path.join(temp, 'commands.json'));
await build({ entryPoints: ['src/renderer/terminal-manager.ts'], bundle: true, format: 'iife', globalName: 'DuoTerminal', outfile: path.join(temp, 'bundle.js') });
const server = http.createServer((req, res) => {
  if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(path.join(temp, 'bundle.js'))); return; }
  if (req.url === '/styles.css') { res.setHeader('Content-Type', 'text/css'); res.end(fs.readFileSync(path.join(root, 'src/renderer/styles.css'))); return; }
  if (req.url === '/xterm.css') { res.setHeader('Content-Type', 'text/css'); res.end(fs.readFileSync(path.join(root, 'node_modules/@xterm/xterm/css/xterm.css'))); return; }
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/xterm.css"><style>#area{position:relative;width:900px;height:600px}body{display:block}</style><div id="area"></div><script src="/bundle.js"></script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true, args: ['--no-sandbox'] });
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const submissions = [];
  const pages = [];
  for (let i = 0; i < 2; i++) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ width: 960, height: 700 });
    await page.exposeFunction('readCommands', () => store.read());
    await page.exposeFunction('editCommands', operation => store.update(operation));
    await page.exposeFunction('submitDraft', (id, submissionId, text) => { submissions.push({ id, text }); });
    await page.goto(origin);
    await page.evaluate(() => {
      window.duocli = { getQuickCommands: readCommands, updateQuickCommands: editCommands, submitPty: submitDraft };
      window.manager = new DuoTerminal.TerminalManager(document.getElementById('area'));
      manager.create('s1', 'vscode-dark', '/tmp', () => { throw new Error('Shortcut wrote directly to PTY'); });
      manager.mountTo('s1', document.getElementById('area'));
    });
    await page.waitForSelector('.desktop-quick-commands button');
    pages.push(page);
  }
  const [first, second] = pages;
  await first.evaluate(() => [...document.querySelectorAll('.desktop-quick-commands button')].find(button => button.textContent === '+ 添加').click());
  await first.type('.quick-command-editor input', '检查代码');
  await first.click('.quick-command-editor button');
  await second.waitForFunction(() => [...document.querySelectorAll('.desktop-quick-commands button')].some(button => button.textContent === '检查代码'));
  await second.evaluate(() => {
    const input = document.querySelector('.terminal-compose-row textarea');
    input.value = '前文后文'; input.focus(); input.setSelectionRange(2, 2);
  });
  const button = await second.evaluateHandle(() => [...document.querySelectorAll('.desktop-quick-commands button')].find(button => button.textContent === '检查代码'));
  await button.asElement().click();
  assert.deepEqual(await second.evaluate(() => {
    const input = document.querySelector('.terminal-compose-row textarea');
    return { text: input.value, caret: input.selectionStart, focused: document.activeElement === input };
  }), { text: '前文检查代码后文', caret: 6, focused: true });
  assert.equal(submissions.length, 0);
  await second.keyboard.press('Enter');
  assert.equal(submissions.length, 0);
  await second.click('.compose-send');
  await second.waitForFunction(() => document.querySelector('.terminal-compose-row textarea').value === '');
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].text, '前文检查代码\n后文');
  store.update({ action: 'remove', command: '检查代码' });
  for (const page of pages) await page.waitForFunction(() => ![...document.querySelectorAll('.desktop-quick-commands button')].some(button => button.textContent === '检查代码'));
  await first.screenshot({ path: '/tmp/duocli-desktop-quick-commands.png' });
  console.log('PASS: isolated clients share persisted additions/deletions; cursor insertion does not submit; explicit Send submits once.');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
