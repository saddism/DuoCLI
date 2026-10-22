// 桌面端 e2e：esbuild 打包真实的 terminal-manager.ts，在 headless Chrome 里
// 建真 xterm 实例，写入软换行文本，用 xterm 选区 API 选中跨 wrap 行的范围，
// 派发带 DataTransfer 的真实 copy 事件，断言 shipped 复制处理器把 isWrapped
// 软换行合并成连贯文本（wrap 处不加 \n，真实换行处保留 \n）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { closeTestBrowser } from './browser-cleanup.mjs';
import { resolveChromeExecutable } from './chrome-path.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PORT = 8932;
const ORIGIN = `http://localhost:${PORT}`;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'duocli-desktop-e2e-'));
const XTERM_CSS = path.join(ROOT, 'node_modules/@xterm/xterm/css/xterm.css');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const HTML = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/xterm.css"><link rel="stylesheet" href="/styles.css">
<style>html,body{margin:0;height:100%;background:#1e1e1e}#area{position:relative;width:820px;height:420px}</style>
</head><body><div id="area"></div><script src="/bundle.js"></script></body></html>`;

const server = http.createServer((req, res) => {
  const p = new URL(req.url, ORIGIN).pathname;
  if (p === '/' || p === '/index.html') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(HTML); return;
  }
  if (p === '/bundle.js') {
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.end(fs.readFileSync(path.join(TMP, 'bundle.js'))); return;
  }
  if (p === '/styles.css') {
    res.setHeader('Content-Type', 'text/css'); res.end(fs.readFileSync(path.join(ROOT, 'src/renderer/styles.css'))); return;
  }
  if (p === '/xterm.css') {
    res.setHeader('Content-Type', 'text/css; charset=utf-8');
    res.end(fs.readFileSync(XTERM_CSS)); return;
  }
  res.statusCode = 404; res.end('not found');
});

async function main() {
  // 1) 打包真实的 terminal-manager.ts（含 shipped copy 处理器）
  await build({
    entryPoints: [path.join(ROOT, 'src/renderer/terminal-manager.ts')],
    bundle: true,
    format: 'iife',
    globalName: 'DuoTerminal',
    platform: 'browser',
    target: 'chrome120',
    outfile: path.join(TMP, 'bundle.js'),
    logLevel: 'silent',
  });

  await new Promise(r => server.listen(PORT, r));

  const browser = await puppeteer.launch({
    executablePath: resolveChromeExecutable(),
    headless: true,
    args: ['--no-sandbox', '--window-size=900,600'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 600 });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));

  await page.goto(`${ORIGIN}/index.html`, { waitUntil: 'networkidle2' });

  // 2) 建真终端实例
  await page.evaluate(() => {
    window.__opened = [];
    window.__inputs = [];
    window.duocli = { filewatcherOpen: (value) => window.__opened.push(value) };
    const area = document.getElementById('area');
    const mgr = new DuoTerminal.TerminalManager(area);
    window.__mgr = mgr;
    mgr.create('t1', 'vscode-dark', '/tmp/proj', data => window.__inputs.push(data));
    mgr.mountTo('t1', area);
    const inst = mgr.instances.get('t1');
    window.__t = inst.terminal;
    window.__c = inst.container;
  });
  await page.waitForFunction(() => window.__t && window.__t.cols > 0, { timeout: 8000 });
  await sleep(300);

  const cols = await page.evaluate(() => window.__t.cols);
  console.log(`terminal cols = ${cols}`);

  // 在页面内构造软换行文本、选中、派发 copy，返回实际复制结果。
  // kind: 'single' = 一条软换行逻辑行；'two' = 两条逻辑行用真实 \r\n 分隔。
  async function copyScenario(kind) {
    return page.evaluate(async (k) => {
      const t = window.__t, c = window.__c;
      t.reset();
      const cols = t.cols;
      let text;
      if (k === 'single') {
        text = 'PART1-' + 'A'.repeat(cols + 12) + '-PART2-' + 'B'.repeat(cols + 12) + '-PART3';
      } else {
        const l1 = 'X1-' + 'C'.repeat(cols + 12) + '-X1END';
        const l2 = 'Y1-' + 'D'.repeat(cols + 12) + '-Y1END';
        text = l1 + '\r\n' + l2;
      }
      await new Promise(r => t.write(text, r));
      await new Promise(r => requestAnimationFrame(() => r()));
      // 按行范围选中（含软换行与真实换行）。selectLines 选整行，
      // 处理器用 translateToString(true) 逐行 trim 掉右侧空白补齐格。
      const buf = t.buffer.active;
      let lastRow = 0;
      for (let i = buf.length - 1; i >= 0; i--) {
        if (buf.getLine(i).translateToString(true).length > 0) { lastRow = i; break; }
      }
      t.selectLines(0, lastRow);
      const dt = new DataTransfer();
      const ev = new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true });
      c.dispatchEvent(ev);
      const pos = t.getSelectionPosition();
      return {
        copied: dt.getData('text/plain'),
        text,
        cols,
        hasSel: t.hasSelection(),
        startRow: pos ? pos.start.y : null,
        endRow: pos ? pos.end.y : null,
      };
    }, kind);
  }

  // ===== Test 1: 单条软换行逻辑行 → 合并为连贯文本，无 \n =====
  const s1 = await copyScenario('single');
  const expect1 = s1.text;
  check(
    '桌面端复制：跨 wrap 行的单逻辑行合并为连贯文本（无多余换行）',
    s1.hasSel && s1.endRow > s1.startRow && s1.copied === expect1 && !s1.copied.includes('\n'),
    `rows ${s1.startRow}->${s1.endRow} copied.len=${s1.copied.length} expected.len=${expect1.length}`,
  );

  // ===== Test 2: 两条逻辑行（真实 \r\n 分隔）→ 只在真实换行处保留一个 \n =====
  const s2 = await copyScenario('two');
  const expect2 = s2.text.replace('\r\n', '\n');
  const newlineCount = (s2.copied.match(/\n/g) || []).length;
  check(
    '桌面端复制：真实换行保留、软换行合并（恰一个 \\n 分隔两逻辑行）',
    s2.copied === expect2 && newlineCount === 1,
    `newlines=${newlineCount} copied.len=${s2.copied.length} expected.len=${expect2.length}`,
  );

  // ===== Test 3: Cursor 等 TUI 手动画出的视觉换行 =====
  const tuiCopy = await page.evaluate(async () => {
    const t = window.__t, c = window.__c;
    t.reset();
    t.resize(43, 8);
    await new Promise(resolve => t.write(
      '  这是输入测试，不要读文件，不要调用\r\n  工具，只回复“CURSOR_SE\r\n  ND_OK”。', resolve));
    t.selectLines(0, 2);
    const dt = new DataTransfer();
    c.dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }));
    return dt.getData('text/plain');
  });
  check(
    '桌面端复制：TUI 手动视觉换行恢复为自然段落',
    tuiCopy === '  这是输入测试，不要读文件，不要调用工具，只回复“CURSOR_SEND_OK”。',
    `copied=${JSON.stringify(tuiCopy)}`,
  );

  // ===== Test 4: 跨 TUI 硬行的带空格路径可点击 =====
  const linkPoint = await page.evaluate(async () => {
    const t = window.__t;
    t.reset(); window.__opened.length = 0;
    const prefix = '  ' + 'x'.repeat(t.cols - 18);
    await new Promise(resolve => t.write(prefix + ' "src/My Fi\r\n  le.ts":12:3', resolve));
    const rows = window.__c.querySelector('.xterm-rows');
    const rect = rows.getBoundingClientRect();
    const rowHeight = rows.children[0].getBoundingClientRect().height;
    return { x: rect.left + 5 * (rect.width / t.cols), y: rect.top + 1.5 * rowHeight };
  });
  await page.mouse.move(linkPoint.x, linkPoint.y);
  await sleep(250);
  await page.mouse.click(linkPoint.x, linkPoint.y);
  await sleep(200);
  const opened = await page.evaluate(() => window.__opened.slice());
  check(
    '桌面端链接：跨视觉换行的带空格路径仍是一个可点击链接',
    opened.length === 1 && opened[0] === '/tmp/proj/src/My File.ts',
    `opened=${JSON.stringify(opened)}`,
  );

  for (const filePath of [
    'work/material-audit-v1/海南中央半岛别墅预算02/image130.png',
    'output/预算02-建模可用信息-20260912.md',
  ]) {
    const point = await page.evaluate(async filePath => {
      const t = window.__t;
      t.reset();
      t.resize(100, 20);
      window.__opened.length = 0;
      await new Promise(resolve => t.write(`  └ ${filePath}`, resolve));
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      const rect = t.element.querySelector('.xterm-screen').getBoundingClientRect();
      return { x: rect.left + 10.5 * rect.width / t.cols, y: rect.top + 0.5 * rect.height / t.rows };
    }, filePath);
    // Each screen was rewritten under the cursor. Re-enter it so xterm runs
    // its hover lookup even when successive links occupy the same coordinates.
    await page.mouse.move(0, 0);
    await page.mouse.move(point.x, point.y);
    await sleep(250);
    await page.mouse.click(point.x, point.y);
    await sleep(100);
    const opened = await page.evaluate(() => window.__opened.slice());
    check('截图中的中文文件路径可点击', opened[0] === `/tmp/proj/${filePath}`, JSON.stringify(opened));
  }

  await browser.defaultBrowserContext().overridePermissions(ORIGIN, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
  await page.evaluate(async () => {
    const t = window.__t;
    t.reset();
    await new Promise(resolve => t.write(
      Array.from({ length: 100 }, (_, i) => `history ${i}\r\n`).join('') + 'COPY-LATEST', resolve));
    t.focus();
  });
  await page.keyboard.down('Shift');
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.up('Shift');
  const selected = await page.evaluate(() => window.__t.getSelection());
  check('键盘选区：存在滚动历史时选中当前光标旁的文本', selected === 'LATEST', `selected=${JSON.stringify(selected)}`);
  await page.evaluate(() => navigator.clipboard.writeText('before-copy'));
  await page.keyboard.down('Meta');
  await page.keyboard.press('c');
  await page.keyboard.up('Meta');
  await sleep(150);
  const copiedByShortcut = await page.evaluate(() => navigator.clipboard.readText());
  check('Command+C：将终端选区写入剪贴板', copiedByShortcut === 'LATEST', `copied=${JSON.stringify(copiedByShortcut)}`);

  await page.evaluate(async () => {
    const t = window.__t;
    t.reset();
    await new Promise(resolve => t.write('CODEX-COPY-TEXT\x1b[?1002h\x1b[?1006h', resolve));
    t.clearSelection();
    window.__inputs.length = 0;
  });
  const drag = await page.evaluate(() => {
    const rows = window.__t.element.querySelector('.xterm-rows');
    const box = rows.getBoundingClientRect();
    const rowHeight = rows.children[0].getBoundingClientRect().height || 17;
    const y = box.top + rowHeight / 2;
    return { x: box.left + 4, y, x2: box.left + 90, y2: y };
  });
  await page.mouse.move(drag.x, drag.y);
  await page.mouse.down();
  await page.mouse.move(drag.x2, drag.y2);
  await page.mouse.up();
  const dragged = await page.evaluate(() => window.__t.getSelection());
  check('Codex 鼠标上报时普通拖动直接选中文字', dragged.includes('CODEX'), `selected=${JSON.stringify(dragged)}`);
  check('普通拖选不会向 CLI 发送鼠标输入', await page.evaluate(() => window.__inputs.length === 0));
  check('普通终端选中文字后不显示复制按钮', await page.$('.terminal-alt-controls') === null);
  await page.keyboard.down('Meta');
  await page.keyboard.press('c');
  await page.keyboard.up('Meta');
  const dragCopy = await page.evaluate(() => ({ text: window.__t.getSelection(), copied: null }));
  dragCopy.copied = await page.evaluate(() => navigator.clipboard.readText());
  check('普通终端快捷键只复制选区并保留高亮', dragCopy.text === dragged && dragCopy.copied === dragged,
    JSON.stringify(dragCopy));
  await page.screenshot({ path: path.join(TMP, 'terminal-selection-copy.png') });

  await page.evaluate(() => { window.__t.clearSelection(); window.__inputs.length = 0; });
  await page.keyboard.down('Meta');
  await page.mouse.click(drag.x, drag.y);
  await page.keyboard.up('Meta');
  const cliClick = await page.evaluate(() => ({ selected: window.__t.getSelection(), inputs: window.__inputs.slice() }));
  check('Command+点击仍能交给 CLI 鼠标处理', cliClick.selected === '' && cliClick.inputs.length > 0, JSON.stringify(cliClick));

  await page.mouse.click(drag.x + 35, drag.y, { clickCount: 2 });
  const wordSelection = await page.evaluate(() => window.__t.getSelection());
  check('鼠标模式下双击仍可选词', wordSelection.includes('CODEX'), JSON.stringify(wordSelection));
  await page.mouse.click(drag.x + 35, drag.y, { clickCount: 3 });
  const lineSelection = await page.evaluate(() => window.__t.getSelection());
  check('鼠标模式下三击可选整行', lineSelection.trim() === 'CODEX-COPY-TEXT', JSON.stringify(lineSelection));
  const forced = await page.evaluate(() => {
    const t = window.__t;
    const rows = t.element.querySelector('.xterm-rows');
    const box = rows.getBoundingClientRect();
    const fire = (type, x, buttons) => {
      const event = new MouseEvent(type, {
        bubbles: true, cancelable: true, view: window, button: 0, buttons, detail: 1,
        clientX: x, clientY: box.top + (rows.children[0].getBoundingClientRect().height || 17) / 2, shiftKey: true,
      });
      (type === 'mousedown' ? t.element : document).dispatchEvent(event);
    };
    fire('mousedown', box.left + 4, 1);
    fire('mousemove', box.left + 90, 1);
    fire('mouseup', box.left + 90, 0);
    return t.getSelection();
  });
  check('Codex 鼠标上报时按住 Shift 可以选中文字', forced.includes('CODEX'), `selected=${JSON.stringify(forced)}`);

  await page.evaluate(async () => {
    const t = window.__t;
    t.reset();
    await new Promise(resolve => t.write('\x1b[?1049hSCREEN-COPY-TEXT', resolve));
    t.select(7, 0, 4);
    t.focus();
  });
  check('全屏终端不显示复制按钮', await page.$('.terminal-alt-controls') === null);
  await page.keyboard.down('Meta');
  await page.keyboard.press('c');
  await page.keyboard.up('Meta');
  check('全屏终端有选区时只复制选中的文字',
    await page.evaluate(() => navigator.clipboard.readText()) === 'COPY');
  await page.evaluate(() => window.__t.clearSelection());

  await page.evaluate(async () => {
    const t = window.__t;
    t.reset();
    await new Promise(resolve => t.write('• Explored\r\n  Read src/a.ts\r\n\r\n需要复制的回答内容\r\n› ', resolve));
    window.__mgr.instances.get('t1').activityView.refresh();
    // A previous xterm selection must not replace the DOM selection's text.
    t.select(0, 0, 3);
    t.focus();
    const plain = window.__c.querySelector('.terminal-activity-plain');
    const range = document.createRange();
    range.selectNodeContents(plain);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    window.__expectedDomCopy = window.getSelection().toString();
  });
  const domCopy = await page.evaluate(() => {
    const data = new DataTransfer();
    window.__c.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
    return { copied: data.getData('text/plain'), expected: window.__expectedDomCopy };
  });
  check('折叠记录复制当前文字选区，不被旧终端选区覆盖', domCopy.copied === domCopy.expected
    && domCopy.copied.includes('需要复制的回答内容'), JSON.stringify(domCopy));
  await page.evaluate(() => navigator.clipboard.writeText('before-dom-copy'));
  await page.keyboard.down('Meta');
  await page.keyboard.press('c');
  await page.keyboard.up('Meta');
  check('Command+C 复制折叠记录中的文字选区', await page.evaluate(async () =>
    await navigator.clipboard.readText() === window.__expectedDomCopy));
  check('折叠记录快捷键保留并复制文字选区', await page.evaluate(async () =>
    await navigator.clipboard.readText() === window.__expectedDomCopy
      && window.getSelection().toString() === window.__expectedDomCopy));
  await page.evaluate(async () => {
    window.__clipboard = navigator.clipboard;
    await navigator.clipboard.writeText('before-fallback-copy');
    Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: async () => { throw new Error('clipboard unavailable'); } } });
  });
  await page.keyboard.down('Meta');
  await page.keyboard.press('c');
  await page.keyboard.up('Meta');
  await page.waitForFunction(async () => await window.__clipboard.readText() === window.__expectedDomCopy);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: window.__clipboard }));
  check('剪贴板备用复制仍写入正确内容并保留文字选区', await page.evaluate(async () =>
    await navigator.clipboard.readText() === window.__expectedDomCopy
      && window.getSelection().toString() === window.__expectedDomCopy));
  await page.evaluate(() => {
    window.getSelection().removeAllRanges();
    window.__t.clearSelection();
  });

  if (process.env.DUOCLI_INPUT_AUDIT === '1') {
    const paste = await page.evaluate(async () => {
      window.__inputs.length = 0;
      window.duocli.clipboardGetFilePath = async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
        return '/tmp/audit file.txt';
      };
      const data = new DataTransfer();
      data.setData('text/plain', '/tmp/audit file.txt');
      const target = window.__c.querySelector('.xterm-helper-textarea');
      target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      await new Promise(resolve => setTimeout(resolve, 50));
      return { id: 'INPUT-05', writes: window.__inputs.slice() };
    });
    console.log('DESKTOP_INPUT_AUDIT', JSON.stringify(paste));
    check('桌面文件粘贴只写入一次转义路径',
      paste.writes.length === 1 && paste.writes[0] === "'/tmp/audit file.txt' ",
      JSON.stringify(paste));
  }

  const quotedPaste = await page.evaluate(async () => {
    window.__inputs.length = 0;
    const filePath = "/tmp/parent's $(printf BAD) `printf BAD` $value.txt";
    window.duocli.clipboardGetFilePath = async () => filePath;
    const data = new DataTransfer();
    data.setData('text/plain', filePath);
    window.__c.querySelector('.xterm-helper-textarea').dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: data, bubbles: true, cancelable: true,
    }));
    await new Promise(resolve => setTimeout(resolve, 30));
    return window.__inputs.slice();
  });
  check('带单引号和 shell 字符的文件路径仍作为一个字面参数粘贴',
    quotedPaste.length === 1 && quotedPaste[0] === "'/tmp/parent'\"'\"'s $(printf BAD) `printf BAD` $value.txt' ",
    JSON.stringify(quotedPaste));

  for (const kind of ['file', 'text', 'image']) {
    const revisitedPaste = await page.evaluate(async kind => {
      window.__inputs.length = 0;
      let release;
      const pending = () => new Promise(resolve => { release = resolve; });
      window.duocli.clipboardGetFilePath = pending;
      window.duocli.clipboardSaveImage = pending;
      const data = new DataTransfer();
      data.setData('text/plain', 'old visit draft');
      if (kind === 'image') data.items.add(new File(['fixture'], 'fixture.png', { type: 'image/png' }));
      window.__c.querySelector('.xterm-helper-textarea').dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: data, bubbles: true, cancelable: true,
      }));
      window.__mgr.detach('t1');
      window.__mgr.mountTo('t1', document.getElementById('area'));
      await window.__mgr.instances.get('t1').revealPromise;
      release(kind === 'text' ? null : '/tmp/old-visit-file.png');
      await new Promise(resolve => setTimeout(resolve, 30));
      return window.__inputs.slice();
    }, kind);
    check(`切离再返回同一终端后拒绝上一轮迟到的 ${kind} 粘贴`,
      revisitedPaste.length === 0, JSON.stringify(revisitedPaste));
  }

  const closedPaste = await page.evaluate(async () => {
    window.__inputs.length = 0;
    let release;
    window.duocli.clipboardGetFilePath = () => new Promise(resolve => { release = resolve; });
    const data = new DataTransfer();
    data.setData('text/plain', 'old terminal paste');
    window.__c.querySelector('.xterm-helper-textarea').dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: data, bubbles: true, cancelable: true,
    }));
    window.__mgr.destroy('t1');
    release('/tmp/late-file.txt');
    await new Promise(resolve => setTimeout(resolve, 30));
    return window.__inputs.slice();
  });
  check('终端关闭后迟到的原生剪贴板结果不会继续写入', closedPaste.length === 0, JSON.stringify(closedPaste));

  await closeTestBrowser(browser);
  server.close();
  console.log(`test artifacts: ${TMP}`);

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
