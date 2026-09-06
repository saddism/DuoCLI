// 移动端 e2e：mock HTTP/WS 后端 + headless Chrome 真实驱动 mobile/client 页面
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import puppeteer from 'puppeteer-core';
import { resolveChromeExecutable } from './chrome-path.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.resolve(__dirname, '../../mobile/client');
const PORT = 8931;
const ORIGIN = `http://localhost:${PORT}`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

// 记录服务端收到的输入，供断言
const receivedInputs = [];
const receivedSubmissions = [];
let wsClient = null;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, ORIGIN);
  const p = url.pathname;

  if (p === '/ping.png') {
    res.setHeader('Content-Type', 'image/png');
    res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    return;
  }
  if (p === '/api/sessions') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify([{
      id: 's1', title: 'e2e-session', status: 'running',
      cwd: '/tmp/e2e-proj', presetCommand: 'claude', createdAt: Date.now(),
    }]));
    return;
  }
  if (p === '/api/events') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.write(': ok\n\n');
    const t = setInterval(() => res.write(': ping\n\n'), 5000);
    req.on('close', () => clearInterval(t));
    return;
  }
  if (p.startsWith('/api/sessions/') && p.endsWith('/file-preview')) {
    const reqPath = url.searchParams.get('path') || '';
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ name: reqPath.split('/').pop() || reqPath, path: reqPath, content: 'e2e file content' }));
    return;
  }
  if (p.startsWith('/api/sessions/') && p.endsWith('/auto-continue')) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ enabled: false }));
    return;
  }
  if (p.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // 静态文件
  const file = p === '/' ? '/index.html' : p;
  const full = path.join(CLIENT_DIR, file);
  if (!full.startsWith(CLIENT_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.statusCode = 404; res.end('not found'); return;
  }
  res.setHeader('Content-Type', MIME[path.extname(full)] || 'application/octet-stream');
  res.end(fs.readFileSync(full));
});

// 模拟真实后端：维护会话 buffer，subscribe 时回放全量。
// 播种一个非空提示符，避免「空 replay」触发前端的重新订阅重试循环
// （该循环每次 term.reset() 会擦掉测试推入的内容）。
let sessionBuffer = '\x1b[1;32me2e-shell\x1b[0m $ ';

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (sock) => {
  wsClient = sock;
  sock.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'subscribe') {
      sock.send(JSON.stringify({ type: 'replay', data: sessionBuffer }));
    } else if (msg.type === 'ping') {
      sock.send(JSON.stringify({ type: 'pong' }));
    } else if (msg.type === 'input_b64') {
      receivedInputs.push(Buffer.from(msg.data, 'base64').toString('utf8'));
    } else if (msg.type === 'submit') {
      receivedSubmissions.push(msg.text);
      sock.send(JSON.stringify({ type: 'submitted', id: msg.id }));
    }
  });
});

function pushOutput(data) {
  sessionBuffer += data;
  if (wsClient && wsClient.readyState === 1) {
    wsClient.send(JSON.stringify({ type: 'output', data }));
  }
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  await new Promise(r => server.listen(PORT, r));

  const browser = await puppeteer.launch({
    executablePath: resolveChromeExecutable(),
    headless: true,
    args: ['--no-sandbox', '--window-size=400,800'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 760, isMobile: true, hasTouch: true });
  await page.browserContext().overridePermissions(ORIGIN, ['clipboard-read', 'clipboard-write']);
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));

  await page.goto(`${ORIGIN}/index.html?token=e2e`, { waitUntil: 'networkidle2' });

  // 进入会话详情页
  await page.waitForFunction(() => document.querySelector('.session-card'), { timeout: 8000 });
  await page.click('.session-card');
  await page.waitForFunction(() => term && term.cols > 0, { timeout: 8000 });
  await sleep(500);

  const cols = await page.evaluate(() => term.cols);
  console.log(`terminal cols = ${cols}`);

  // ===== Test 1: spinner wrap 不累积空白行 =====
  // CLI must move back over wrapped rows before repainting. Erase-line alone
  // cannot erase a previous physical row; filtering that stream hides data.
  const longSpinnerText = '⠋ Running task ' + 'x'.repeat(Math.max(10, cols + 20));
  const spinnerRows = Math.ceil(('⠋ frame00 ' + longSpinnerText).length / cols);
  const before = await page.evaluate(() => term.buffer.active.length);
  for (let i = 0; i < 25; i++) {
    pushOutput((i ? `\x1b[${spinnerRows - 1}A` : '') + `\r\x1b[J⠋ frame${String(i).padStart(2, '0')} ` + longSpinnerText);
    await sleep(30);
  }
  await sleep(400);
  const after = await page.evaluate(() => term.buffer.active.length);
  const growth = after - before;
  check('spinner 25 帧后 buffer 增长受控（不累积空白行）', growth <= 4, `growth=${growth} lines`);

  // ===== Test 2: 长按复制得到连贯逻辑行 =====
  const logical = 'FIRSTPART-' + 'A'.repeat(cols + 15) + '-SECONDPART-' + 'B'.repeat(cols + 15) + '-THIRDPART';
  pushOutput('\r\n' + logical + '\r\n');
  await sleep(400);
  await page.evaluate(() => { term.scrollToBottom(); });
  await sleep(300);

  // 找到该逻辑行第一视觉行的视口位置并长按
  const tapY = await page.evaluate(() => {
    const buf = term.buffer.active;
    const container = document.getElementById('terminal-container');
    const rect = container.getBoundingClientRect();
    const rowsEl = container.querySelector('.xterm-rows');
    const rowHeight = rowsEl.children[0].getBoundingClientRect().height;
    for (let i = buf.length - 1; i >= 0; i--) {
      const t = buf.getLine(i).translateToString(true);
      if (t.includes('FIRSTPART-')) {
        const visual = i - buf.viewportY;
        const y = rect.top + visual * rowHeight + rowHeight / 2;
        return Math.min(Math.max(y, rect.top + rowHeight / 2), rect.bottom - rowHeight / 2);
      }
    }
    return rect.top + 100;
  });

  const box = await page.evaluate(() => {
    const r = document.getElementById('terminal-container').getBoundingClientRect();
    return { x: r.left + r.width / 2, top: r.top };
  });
  await page.touchscreen.touchStart(box.x, tapY);
  await sleep(600);
  await page.touchscreen.touchEnd();
  await sleep(300);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  const toast = await page.evaluate(() => (document.getElementById('copy-toast') || {}).textContent || '');
  const visiblySelected = await page.evaluate(() => term.hasSelection());
  check('长按选中并复制完整连贯逻辑行', visiblySelected && clip.includes('FIRSTPART-') && clip.includes('-THIRDPART') && !clip.includes('\n'), `len=${clip.length} selected=${visiblySelected} toast="${toast}"`);

  // ===== Test 3: 点击 wrap 到第二行的文件路径 =====
  const pad = 'y'.repeat(Math.max(5, cols - 22));
  pushOutput('\r\n' + pad + ' src/components/deep/nested/PreviewTarget.tsx\r\n');
  await sleep(400);
  const pathPos = await page.evaluate(() => {
    const buf = term.buffer.active;
    const container = document.getElementById('terminal-container');
    const rect = container.getBoundingClientRect();
    const rowsEl = container.querySelector('.xterm-rows');
    const rowHeight = rowsEl.children[0].getBoundingClientRect().height;
    const rowWidth = rowsEl.getBoundingClientRect().width;
    const colWidth = rowWidth / term.cols;
    for (let i = buf.length - 1; i >= 0; i--) {
      const t = buf.getLine(i).translateToString(true);
      const idx = t.indexOf('PreviewTarget.tsx');
      if (idx >= 0) {
        const visual = i - buf.viewportY;
        return { x: rect.left + Math.min(idx + 3, term.cols - 2) * colWidth, y: rect.top + visual * rowHeight + rowHeight / 2 };
      }
    }
    return null;
  });
  if (!pathPos) {
    check('定位 wrap 行上的文件路径', false, 'path not found in buffer');
  } else {
    await page.touchscreen.tap(pathPos.x, pathPos.y);
    await sleep(600);
    const previewActive = await page.evaluate(() =>
      document.getElementById('file-preview-page').classList.contains('active'));
    const previewTitle = await page.evaluate(() =>
      document.getElementById('file-preview-title').textContent);
    const mobilePreviewTitle = await page.evaluate(() =>
      document.getElementById('mobile-file-preview-title').textContent);
    check('点击 wrap 行文件路径打开预览',
      previewActive && previewTitle.includes('PreviewTarget.tsx') && mobilePreviewTitle.includes('PreviewTarget.tsx'),
      `title=${previewTitle} mobileTitle=${mobilePreviewTitle}`);
    // 竖屏设备页的返回按钮应回到原终端，而不是会话列表。
    await page.click('#device-back-btn');
    await sleep(200);
    const previewBackPage = await page.evaluate(() => ({
      detail: document.getElementById('detail-page').classList.contains('active'),
      main: document.getElementById('main-page').classList.contains('active'),
    }));
    check('竖屏文件预览返回原终端', previewBackPage.detail && !previewBackPage.main, JSON.stringify(previewBackPage));
  }

  // ===== Test 4: TUI 手动画出的视觉换行复制为自然段落 =====
  pushOutput('\r\n\r\n  这是输入测试，不要读文件，不要调用\r\n  工具，只回复“CURSOR_SE\r\n  ND_OK”。\r\n\r\n');
  await sleep(400);
  const tuiCopyY = await page.evaluate(() => {
    term.clearSelection(); term.scrollToBottom();
    const buffer = term.buffer.active;
    const container = document.getElementById('terminal-container');
    const rect = container.getBoundingClientRect();
    const rows = container.querySelector('.xterm-rows');
    const rowHeight = rows.children[0].getBoundingClientRect().height;
    for (let row = buffer.length - 1; row >= 0; row--) {
      if (buffer.getLine(row).translateToString(true).includes('工具，只回复')) {
        return rect.top + (row - buffer.viewportY + 0.5) * rowHeight;
      }
    }
    return null;
  });
  if (tuiCopyY == null) {
    check('手机长按复制：定位 TUI 视觉换行段落', false, 'row not found');
  } else {
    await page.touchscreen.touchStart(box.x, tuiCopyY);
    await sleep(600);
    await page.touchscreen.touchEnd();
    await sleep(250);
    const tuiClip = await page.evaluate(() => navigator.clipboard.readText());
    check('手机长按复制：TUI 视觉换行恢复为自然段落',
      tuiClip === '这是输入测试，不要读文件，不要调用工具，只回复“CURSOR_SEND_OK”。',
      `copied=${JSON.stringify(tuiClip)}`);
  }

  // ===== Test 5: 跨 TUI 硬行的带空格路径仍可点击 =====
  const hardPrefix = '  ' + 'x'.repeat(Math.max(1, cols - 18));
  pushOutput(`\r\n${hardPrefix} "src/My Fi\r\n  le.ts":12:3\r\n`);
  await sleep(400);
  const hardPathPos = await page.evaluate(() => {
    term.scrollToBottom();
    const buffer = term.buffer.active;
    const container = document.getElementById('terminal-container');
    const rect = container.getBoundingClientRect();
    const rows = container.querySelector('.xterm-rows');
    const rowHeight = rows.children[0].getBoundingClientRect().height;
    const colWidth = rows.getBoundingClientRect().width / term.cols;
    for (let row = buffer.length - 1; row >= 0; row--) {
      if (buffer.getLine(row).translateToString(true).includes('le.ts')) {
        return { x: rect.left + 5 * colWidth, y: rect.top + (row - buffer.viewportY + 0.5) * rowHeight };
      }
    }
    return null;
  });
  if (!hardPathPos) {
    check('手机链接：定位跨视觉换行路径', false, 'path not found');
  } else {
    await page.touchscreen.tap(hardPathPos.x, hardPathPos.y);
    await sleep(500);
    const hardTitle = await page.evaluate(() => document.getElementById('file-preview-title').textContent);
    const mobileHardTitle = await page.evaluate(() => document.getElementById('mobile-file-preview-title').textContent);
  check('手机链接：跨视觉换行的带空格路径作为一个链接打开',
      hardTitle === 'My File.ts' && mobileHardTitle === 'My File.ts',
      `title=${hardTitle} mobileTitle=${mobileHardTitle}`);
    await page.evaluate(() => showPage('detail-page'));
    await sleep(200);
  }

  // ===== Test 6: 终端重连时禁止发送但保留草稿 =====
  receivedSubmissions.length = 0;
  wsClient.close();
  await page.waitForFunction(() => document.getElementById('send-btn').disabled, { timeout: 3000 });
  await page.click('#msg-input');
  await page.type('#msg-input', 'draft while reconnecting');
  await page.keyboard.press('Enter');
  await sleep(200);
  const reconnectDraft = await page.evaluate(() => ({
    value: document.getElementById('msg-input').value,
    disabled: document.getElementById('send-btn').disabled,
  }));
  check('终端重连时不发送且保留输入草稿',
    reconnectDraft.value === 'draft while reconnecting'
      && reconnectDraft.disabled
      && receivedSubmissions.length === 0,
    JSON.stringify(reconnectDraft));
  await page.waitForFunction(() => !document.getElementById('send-btn').disabled, { timeout: 8000 });
  await page.evaluate(() => { document.getElementById('msg-input').value = ''; });

  // ===== Test 7: 发送后输入框清空且只发一次 =====
  receivedInputs.length = 0;
  receivedSubmissions.length = 0;
  await page.click('#msg-input');
  await page.type('#msg-input', 'e2e message body');
  await page.click('#send-btn');
  await sleep(400);
  const inputVal = await page.evaluate(() => document.getElementById('msg-input').value);
  const submitted = receivedSubmissions.join('');
  check('发送后输入框为空', inputVal === '', `value="${inputVal}"`);
  check('消息只发送一次', submitted === 'e2e message body' && receivedSubmissions.length === 1, `received=${JSON.stringify(submitted)}`);

  // ===== Test 8: 竖屏恢复手机模式，不显示左右侧栏菜单 =====
  await page.evaluate(() => showPage('detail-page'));
  const portraitDrawer = await page.evaluate(() => ({
    sessionsButton: getComputedStyle(document.querySelector('#detail-header .landscape-sessions-toggle')).display,
    deviceButton: getComputedStyle(document.querySelector('#detail-header .landscape-device-toggle')).display,
    backButton: getComputedStyle(document.querySelector('#back-btn')).display,
  }));
  check('竖屏对话页隐藏左右侧栏菜单，保留返回按钮',
    portraitDrawer.sessionsButton === 'none'
      && portraitDrawer.deviceButton === 'none'
      && portraitDrawer.backButton !== 'none',
    JSON.stringify(portraitDrawer));

  await page.setViewport({ width: 1024, height: 700, isMobile: false, hasTouch: true });
  await sleep(200);
  const landscapeDrawer = await page.evaluate(() => ({
    sessionsButton: getComputedStyle(document.querySelector('#detail-header .landscape-sessions-toggle')).display,
    deviceButton: getComputedStyle(document.querySelector('#detail-header .landscape-device-toggle')).display,
  }));
  check('电脑横屏对话页显示左右侧栏菜单',
    landscapeDrawer.sessionsButton !== 'none'
      && landscapeDrawer.deviceButton !== 'none',
    JSON.stringify(landscapeDrawer));

  await page.setViewport({ width: 884, height: 1104, isMobile: true, hasTouch: true, isLandscape: false });
  await sleep(200);
  const foldPortrait = await page.evaluate(() => ({
    sessionsButton: getComputedStyle(document.querySelector('#detail-header .landscape-sessions-toggle')).display,
    deviceButton: getComputedStyle(document.querySelector('#detail-header .landscape-device-toggle')).display,
  }));
  check('高分屏手机竖屏仍隐藏左右侧栏菜单',
    foldPortrait.sessionsButton === 'none'
      && foldPortrait.deviceButton === 'none',
    JSON.stringify(foldPortrait));
  await page.setViewport({ width: 390, height: 760, isMobile: true, hasTouch: true });

  // ===== Test 9: xterm 调试映射不再返回 404 =====
  const sourceMapStatuses = await page.evaluate(async () =>
    Promise.all(['addon-fit.js.map', 'xterm.js.map', 'addon-unicode11.js.map'].map(async name => ({
      name,
      status: (await fetch(name)).status,
    }))));
  check('xterm 调试映射均可读取', sourceMapStatuses.every(({ status }) => status === 200), JSON.stringify(sourceMapStatuses));

  await browser.close();
  server.close();

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
