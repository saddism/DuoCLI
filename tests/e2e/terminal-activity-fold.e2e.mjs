import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { closeTestBrowser } from './browser-cleanup.mjs';
import { resolveChromeExecutable } from './chrome-path.mjs';

const client = path.resolve('mobile/client');
const files = new Map([
  ['/xterm.js', 'text/javascript'],
  ['/terminal-history-layer.js', 'text/javascript'],
  ['/terminal-content-helpers.js', 'text/javascript'],
  ['/file-preview-helpers.js', 'text/javascript'],
  ['/terminal-activity-fold.js', 'text/javascript'],
  ['/xterm.css', 'text/css'],
  ['/style.css', 'text/css'],
]);
const server = http.createServer((req, res) => {
  if (files.has(req.url)) {
    res.setHeader('Content-Type', `${files.get(req.url)}; charset=utf-8`);
    res.end(readFileSync(path.join(client, req.url.slice(1))));
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><link rel="stylesheet" href="/xterm.css"><link rel="stylesheet" href="/style.css">
    <style>#terminal-container{width:440px;height:600px}</style>
    <div id="terminal-container"></div><script src="/xterm.js"></script>
    <script src="/terminal-history-layer.js"></script><script src="/terminal-content-helpers.js"></script>
    <script src="/file-preview-helpers.js"></script><script src="/terminal-activity-fold.js"></script>`);
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    window.term = new Terminal({ cols: 42, rows: 20, scrollback: 100 });
    term.open(document.getElementById('terminal-container'));
    window.olderClicks = 0;
    window.fold = DuoTerminalActivityFold.createView(term, document.getElementById('terminal-container'), {
      onOlder: () => { window.olderClicks++; },
    });
    await new Promise(resolve => term.write('Before\r\n• Explored\r\n  Read src/auth.js\r\n• Ran ssh example\r\n\x1b[32m  output\x1b[0m\r\n• Edited src/auth.js (+4 -7)\r\n  3566 + await writeAudit()\r\n  3574 - await oldAudit()\r\n› Type here', resolve));
    fold.refresh();
  });
  assert.equal(await page.$eval('.terminal-activity-view', el => el.hidden), false);
  assert.equal(await page.$$eval('.terminal-activity-group', nodes => nodes.length), 3);
  assert.equal(await page.$eval('.terminal-activity-group:nth-of-type(3)', el => el.open), false);
  assert.equal(await page.$eval('.terminal-activity-group:nth-of-type(3) pre', el => el.textContent.includes('3566 + await writeAudit()')), true);
  assert.equal(await page.$eval('.terminal-activity-group', el => el.open), false);
  assert.equal(await page.$eval('.terminal-activity-group summary', el => el.textContent.includes('auth.js')), false);
  assert.match(await page.$eval('.terminal-activity-group pre', el => el.textContent), /Read src\/auth\.js/);
  assert.equal(await page.$eval('.terminal-activity-group pre', el => el.textContent.split('\n')[1]), '  Read src/auth.js');
  assert.equal(await page.$eval('.terminal-activity-group:nth-of-type(2) pre', el => Boolean(el.querySelector('span[style*="color"]'))), true);
  await page.$eval('.terminal-activity-scroller', el => {
    el.scrollTop = 0;
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -60, bubbles: true, cancelable: true }));
  });
  assert.equal(await page.evaluate(() => window.olderClicks), 1);
  assert.equal(await page.$eval('.terminal-activity-view', el => el.hidden), true);
  await page.evaluate(() => fold.returnFromOlder());
  assert.equal(await page.$eval('.terminal-activity-view', el => el.hidden), false);
  await page.$eval('.terminal-activity-scroller', el => {
    const touch = y => new Touch({ identifier: 1, target: el, clientX: 120, clientY: y });
    el.scrollTop = 0;
    el.dispatchEvent(new TouchEvent('touchstart', { touches: [touch(100)], bubbles: true }));
    el.dispatchEvent(new TouchEvent('touchmove', { touches: [touch(140)], bubbles: true, cancelable: true }));
    el.dispatchEvent(new TouchEvent('touchend', { touches: [], bubbles: true }));
  });
  assert.equal(await page.evaluate(() => window.olderClicks), 2);
  await page.evaluate(() => fold.returnFromOlder());
  if (process.env.DUOCLI_FOLD_SCREENSHOT) await page.screenshot({ path: process.env.DUOCLI_FOLD_SCREENSHOT });
  await page.click('.terminal-activity-group summary');
  assert.equal(await page.$eval('.terminal-activity-group', el => el.open), true);
  await page.evaluate(() => {
    window.clickedFile = null;
    fold.root.addEventListener('duocli-terminal-file', event => { window.clickedFile = event.detail.path; });
  });
  await page.click('.terminal-activity-group [data-terminal-file]');
  assert.equal(await page.evaluate(() => window.clickedFile), 'src/auth.js');
  await page.evaluate(async () => {
    window.firstActivityNode = document.querySelector('.terminal-activity-group');
    await new Promise(resolve => term.write('\r\nnext output', resolve));
    fold.refresh();
  });
  assert.equal(await page.$eval('.terminal-activity-group', el => el.open), true);
  assert.equal(await page.evaluate(() => document.querySelector('.terminal-activity-group') === firstActivityNode), true);
  const selection = await page.evaluate(async () => {
    const text = document.querySelector('.terminal-activity-group pre').firstChild;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 3);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    const before = document.querySelector('.terminal-activity-scroller').innerHTML;
    await new Promise(resolve => term.write('\r\nmore output', resolve));
    fold.refresh();
    return { preserved: document.querySelector('.terminal-activity-scroller').innerHTML === before,
      selected: window.getSelection().toString(), anchored: document.querySelector('.terminal-activity-scroller').contains(window.getSelection().anchorNode) };
  });
  assert.equal(selection.preserved, true, JSON.stringify(selection));
  assert.equal(selection.selected.length, 3);
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await page.waitForFunction(() => document.querySelector('.terminal-activity-scroller').textContent.includes('more output'));
  const readingPosition = await page.evaluate(async () => {
    await new Promise(resolve => term.write('\r\n' + Array.from({ length: 48 }, (_, i) => `plain ${i}\r\n`).join(''), resolve));
    fold.refresh();
    const scroller = document.querySelector('.terminal-activity-scroller');
    scroller.scrollTop = scroller.scrollHeight;
    const before = scroller.scrollTop;
    await new Promise(resolve => term.write('one more line', resolve));
    fold.refresh();
    return { before, after: scroller.scrollTop, open: document.querySelector('.terminal-activity-group').open };
  });
  assert.equal(readingPosition.open, true);
  assert.equal(readingPosition.after, readingPosition.before);
  await page.click('.terminal-activity-toolbar button:last-child');
  assert.equal(await page.$eval('.terminal-activity-view', el => el.hidden), true);
  const rawReads = await page.evaluate(() => {
    const buffer = term.buffer.active;
    const getLine = buffer.getLine.bind(buffer);
    let reads = 0;
    buffer.getLine = (...args) => { reads++; return getLine(...args); };
    fold.refresh();
    fold.refresh();
    buffer.getLine = getLine;
    return reads;
  });
  assert.equal(rawReads, 0, 'the hidden fold view must not rescan history while reading raw output');
  assert.equal(await page.$eval('.terminal-activity-reopen', el => el.hidden), false);
  await page.click('.terminal-activity-reopen');
  assert.equal(await page.$eval('.terminal-activity-view', el => el.hidden), false);
  await page.click('.terminal-activity-toolbar button:first-of-type');
  assert.equal(await page.evaluate(() => window.olderClicks), 3);
  assert.equal(await page.$eval('.terminal-activity-view', el => el.hidden), true);
  await page.evaluate(() => fold.returnFromOlder());
  assert.equal(await page.$eval('.terminal-activity-view', el => el.hidden), false);
  await page.click('.terminal-activity-toolbar button:last-child');
  await page.evaluate(() => fold.returnFromOlder());
  assert.equal(await page.$eval('.terminal-activity-view', el => el.hidden), true);
  const terminalText = await page.evaluate(() => Array.from({ length: term.buffer.normal.length }, (_, row) =>
    term.buffer.normal.getLine(row)?.translateToString(true) || '').join('\n'));
  assert.match(terminalText, /Read src\/auth\.js/);
  assert.match(terminalText, /ssh example/);
  await page.click('.terminal-activity-reopen');
  await page.evaluate(async () => {
    term.reset();
    await new Promise(resolve => term.write('$ python3 check.py\r\n  import os exit 1\r\n  traceback detail\r\n\r\n  Grepped, globbed 5 greps\r\n  Globbed "**/*.pem"\r\n\r\n结论：配置缺失。', resolve));
    fold.refresh();
  });
  assert.deepEqual(await page.$$eval('.terminal-activity-group summary', nodes => nodes.map(node => node.children[1].textContent)),
    ['Command', 'Grepped, globbed']);
  assert.equal(await page.$eval('.terminal-activity-status', el => el.textContent), 'exit 1');
  assert.match(await page.$eval('.terminal-activity-scroller', el => el.textContent), /结论：配置缺失/);
  const retainedAfterTrim = await page.evaluate(async () => {
    term.reset();
    term.options.scrollback = 30;
    const prefix = Array.from({ length: 25 }, (_, i) => `prefix ${i}`).join('\r\n');
    const tail = Array.from({ length: 20 }, (_, i) => `tail ${i}`).join('\r\n');
    await new Promise(resolve => term.write(`${prefix}\r\n• Edited src/a.js (+1 -1)\r\n  + new\r\n  - old\r\n\r\nConclusion\r\n${tail}`, resolve));
    fold.refresh();
    const edited = [...document.querySelectorAll('.terminal-activity-group')]
      .find(node => node.querySelector('summary')?.textContent.includes('Edited'));
    edited.open = true;
    await new Promise(resolve => term.write('\r\n' + Array.from({ length: 12 }, (_, i) => `more ${i}`).join('\r\n'), resolve));
    fold.refresh();
    return { sameNode: edited === [...document.querySelectorAll('.terminal-activity-group')]
      .find(node => node.querySelector('summary')?.textContent.includes('Edited')),
    open: edited.open, baseY: term.buffer.normal.baseY };
  });
  assert.equal(retainedAfterTrim.sameNode && retainedAfterTrim.open && retainedAfterTrim.baseY > 0,
    true, JSON.stringify(retainedAfterTrim));
  for (const heading of ['⏺ Read(audit.txt)', '● Bash(cat audit.txt)', '✔ ReadFile audit.txt', '│ ✓ run_shell_command: cat audit.txt', '• Called read_file']) {
    await page.evaluate(async heading => {
      term.reset();
      await new Promise(resolve => term.write(`${heading}\r\n  42\r\n\r\n最终答案：42`, resolve));
      fold.refresh();
    }, heading);
    assert.equal(await page.$$eval('.terminal-activity-group', nodes => nodes.length), 1, heading);
    assert.equal(await page.$eval('.terminal-activity-group', node => node.open), false, heading);
    assert.match(await page.$eval('.terminal-activity-plain', node => node.textContent), /最终答案：42/, heading);
  }
  await page.evaluate(async () => {
    fold.dispose(); fold.root.remove();
    term.reset();
    fold = DuoTerminalActivityFold.createView(term, document.getElementById('terminal-container'), { cli: 'pi' });
    await new Promise(resolve => term.write('\x1b[48;5;236m \x1b[1mread\x1b[22m audit.txt\r\n 42\x1b[0m\r\n\r\n最终答案：42', resolve));
    fold.refresh();
  });
  assert.equal(await page.$$eval('.terminal-activity-group', nodes => nodes.length), 1);
  assert.match(await page.$eval('.terminal-activity-group pre', node => node.textContent), /42/);
  assert.match(await page.$eval('.terminal-activity-plain', node => node.textContent), /最终答案：42/);
  await page.evaluate(async () => {
    fold.dispose(); fold.root.remove();
    document.querySelectorAll('.terminal-activity-reopen').forEach(node => node.remove());
    term.reset();
    fold = DuoTerminalActivityFold.createView(term, document.getElementById('terminal-container'), { showControls: false });
    await new Promise(resolve => term.write('• Explored\r\n  Read src/a.ts\r\n\r\n正文仍然可见。', resolve));
    fold.refresh();
  });
  assert.equal(await page.$('.terminal-activity-toolbar'), null);
  assert.equal(await page.$('.terminal-activity-reopen'), null);
  assert.equal(await page.$eval('.terminal-activity-group', node => node.open), false);
  await page.evaluate(async () => {
    fold.setExpanded(true);
    await new Promise(resolve => term.write('\r\n• Ran npm test\r\n  PASS checks', resolve));
    fold.refresh();
  });
  assert.equal(await page.$$eval('.terminal-activity-group', nodes => nodes.length === 2 && nodes.every(node => node.open)), true);
  await page.evaluate(() => fold.setExpanded(false));
  assert.equal(await page.$$eval('.terminal-activity-group', nodes => nodes.every(node => !node.open)), true);
  await page.click('.terminal-activity-group summary');
  await page.evaluate(() => { term.options.fontSize = 11; fold.refresh(); });
  assert.equal(await page.$eval('.terminal-activity-view', node => getComputedStyle(node).fontSize), '11px');
  assert.equal(await page.$eval('.terminal-activity-group', node => node.open), true);
  assert.match(await page.$eval('.terminal-activity-plain', node => node.textContent), /正文仍然可见/);

  const collapseReadingPosition = await page.evaluate(async () => {
    term.reset();
    term.options.scrollback = 1000;
    await new Promise(resolve => term.write(Array.from({ length: 32 }, (_, i) =>
      `• Ran inspect-file-${i}.js\r\n${Array.from({ length: 8 }, (_, j) => `  output ${i}/${j}`).join('\r\n')}\r\n`).join('') +
      '\r\n  所有记录后的正文必须保留。', resolve));
    fold.refresh();
    fold.setExpanded(true);
    const scroller = fold.root.querySelector('.terminal-activity-scroller');
    const record = scroller.querySelectorAll('details')[12];
    scroller.scrollTop += record.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    const before = record.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    const original = scroller.textContent;
    fold.setExpanded(false);
    const after = record.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    for (let i = 0; i < 12; i++) fold.setExpanded(i % 2 === 0);
    return { before, after, preserved: original === scroller.textContent,
      count: scroller.querySelectorAll('details').length,
      prose: [...scroller.querySelectorAll('.terminal-activity-plain')].some(node => node.textContent.includes('正文必须保留')) };
  });
  assert.ok(Math.abs(collapseReadingPosition.before - collapseReadingPosition.after) <= 1, JSON.stringify(collapseReadingPosition));
  assert.equal(collapseReadingPosition.preserved && collapseReadingPosition.prose, true, JSON.stringify(collapseReadingPosition));
  assert.equal(collapseReadingPosition.count, 32);
  console.log('PASS repeated expand/collapse preserves every record, indented prose and the reading anchor');
  await page.evaluate(() => fold.dispose());
  assert.equal(await page.$('.terminal-activity-view'), null);
  assert.equal(await page.$('.terminal-activity-reopen'), null);
  console.log('PASS terminal activity folding keeps the original buffer and toggles in the browser');
} finally {
  if (browser) await closeTestBrowser(browser);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
