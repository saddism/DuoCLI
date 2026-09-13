import os from 'node:os';
import { QuickCommandStore } from '../../dist/main/quick-commands.js';
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
const receivedDeletes = [];
const quickCommandStore = new QuickCommandStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'duocli-mobile-quick-')), 'commands.json'));
let wsClient = null;
let sseClient = null;

function pushSessionsEvent() {
  if (!sseClient) return false;
  sseClient.write(`event: sessions\ndata: ${JSON.stringify(mockSessions)}\n\n`);
  return true;
}

let mockSessions = [{
  id: 's1', title: 'e2e-session', status: 'running',
  cwd: '/tmp/e2e-proj', presetCommand: 'claude', createdAt: Date.now(),
}];

// 新建会话面板的数据源：内置预制 / 自定义预设 / 最近目录 / 预设使用次数
const mockBuiltinPresets = [
  { value: '', label: '空终端' },
  { value: 'claude --dangerously-skip-permissions', label: 'Claude (全自动)' },
  { value: 'opencode', label: 'OpenCode' },
];
let mockCustomPresets = [{ id: 'custom-5', name: 'ds-cc', command: 'ds-cc', autoFlag: '' }];
const mockRecentCwds = ['/tmp/e2e-proj', '/Users/e2e/Documents/demo'];
const mockPresetUsage = { opencode: 5, '': 2 };
const receivedPresetPuts = [];

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || 'null')); } catch { resolve(null); }
    });
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, ORIGIN);
  const p = url.pathname;

  if (p === '/api/quick-commands') {
    const respond = (state) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(state));
      if (sseClient) sseClient.write(`event: quick-commands\ndata: ${JSON.stringify(state)}\n\n`);
    };
    if (req.method === 'POST') void readJsonBody(req).then(operation => respond(quickCommandStore.update(operation)));
    else respond(quickCommandStore.read());
    return;
  }
  if (p === '/ping.png') {
    res.setHeader('Content-Type', 'image/png');
    res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    return;
  }
  if (p === '/api/sessions' && req.method !== 'DELETE') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(mockSessions));
    return;
  }
  if (p.startsWith('/api/sessions/') && req.method === 'DELETE') {
    const id = decodeURIComponent(p.slice('/api/sessions/'.length));
    receivedDeletes.push(id);
    mockSessions = mockSessions.filter(s => s.id !== id);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (p === '/api/events') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.write(': ok\n\n');
    sseClient = res;
    const t = setInterval(() => res.write(': ping\n\n'), 5000);
    req.on('close', () => { clearInterval(t); if (sseClient === res) sseClient = null; });
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
  if (p === '/api/builtin-presets') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(mockBuiltinPresets));
    return;
  }
  if (p === '/api/preset-usage') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      items: Object.entries(mockPresetUsage).map(([command, count]) => ({ command, count })),
    }));
    return;
  }
  if (p === '/api/recent-cwds') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ items: mockRecentCwds }));
    return;
  }
  if (p === '/api/custom-presets' && req.method === 'PUT') {
    void readJsonBody(req).then((list) => {
      if (Array.isArray(list)) {
        mockCustomPresets = list;
        receivedPresetPuts.push(list);
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  if (p === '/api/custom-presets') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(mockCustomPresets));
    return;
  }
  if (p === '/api/android/devices') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ devices: [] }));
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

  // ===== Test 0: 长回放在平滑滚动配置下也必须瞬时到末尾 =====
  // 某些移动端/缓存中的 xterm 会把公开 scrollToBottom() 变成平滑动画。
  // 这个场景模拟已有长历史后重新跟尾，确保 jumpTerminalToLatest 不会沿着
  // 数千行逐帧播放。
  const replayScroll = await page.evaluate(async () => {
    const history = Array.from({ length: 700 }, (_, i) => `replay-${i} ${'x'.repeat(40)}\r\n`).join('');
    await new Promise(resolve => term.write(`\r\n${history}`, resolve));
    term.options.smoothScrollDuration = 1200;
    term._core._viewport.scrollToLine(0, true);
    term.scrollToBottom();
    const animated = {
      viewportY: term.buffer.active.viewportY,
      baseY: term.buffer.active.baseY,
    };
    jumpTerminalToLatest();
    await new Promise(resolve => requestAnimationFrame(resolve));
    const jumped = {
      viewportY: term.buffer.active.viewportY,
      baseY: term.buffer.active.baseY,
      smoothScrollDuration: term.options.smoothScrollDuration,
    };
    return { animated, jumped };
  });
  check('长回放跟尾在一帧内到达最新输出',
    replayScroll.jumped.viewportY === replayScroll.jumped.baseY
      && replayScroll.jumped.smoothScrollDuration === 0,
    JSON.stringify(replayScroll));

  const snapshotScroll = await page.evaluate(async () => {
    const history = Array.from({ length: 500 }, (_, i) => `snap-${i} ${'y'.repeat(24)}\r\n`).join('');
    isUserScrolling = true;
    restoreTerminalSnapshot({ data: `\r\n${history}` });
    await terminalWriteQueue;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      viewportY: term.buffer.active.viewportY,
      baseY: term.buffer.active.baseY,
    };
  });
  check('切换会话回放后立刻停在最新输出',
    snapshotScroll.viewportY === snapshotScroll.baseY,
    JSON.stringify(snapshotScroll));

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

  // ===== Test 2: 长按锚定后拖拽跨软换行选中完整逻辑行并复制 =====
  const logical = 'FIRSTPART-' + 'A'.repeat(cols + 15) + ' -SECONDPART- ' + 'B'.repeat(cols + 15) + '-THIRDPART';
  pushOutput('\r\n' + logical + '\r\n');
  await sleep(400);
  await page.evaluate(() => { term.clearSelection(); term.scrollToBottom(); });
  await sleep(300);

  // 逻辑行被软换行拆成多个视觉行，从第一行行首拖到最后一行行尾才是完整选区
  const drag = await page.evaluate(() => {
    const buf = term.buffer.active;
    const grid = document.getElementById('terminal-container').querySelector('.xterm-rows').getBoundingClientRect();
    const rowHeight = grid.height / term.rows;
    const colWidth = grid.width / term.cols;
    let first = -1;
    let last = -1;
    for (let i = buf.length - 1; i >= 0; i--) {
      const t = buf.getLine(i).translateToString(true);
      if (t.includes('FIRSTPART-')) first = i;
      if (t.includes('-THIRDPART')) last = i;
    }
    if (first < 0 || last < 0) return null;
    const y = row => grid.top + (row - buf.viewportY + 0.5) * rowHeight;
    return {
      startX: grid.left + 0.5 * colWidth,
      startY: y(first),
      endX: grid.left + (term.cols - 0.5) * colWidth,
      endY: y(last),
      rows: last - first + 1,
    };
  });
  if (!drag) {
    check('定位可拖拽复制的逻辑行', false, 'line not found');
  } else {
    // 长按先锚定手指下的词，再拖到行尾扩选（没长按的拖动是滚动，见 Test 4b）
    await page.touchscreen.touchStart(drag.startX, drag.startY);
    await sleep(700);
    const anchored = await page.evaluate(() => term.getSelection());
    await page.touchscreen.touchMove(drag.endX, drag.endY);
    await page.touchscreen.touchEnd();
    await sleep(200);
    const selected = await page.evaluate(() => term.hasSelection());
    await page.click('#terminal-copy-selection-btn');
    await sleep(300);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    check('长按后拖拽选中并复制完整连贯逻辑行',
      selected && !anchored.includes('-THIRDPART')
        && clip.includes('FIRSTPART-') && clip.includes('-THIRDPART') && !clip.includes('\n'),
      `rows=${drag.rows} anchored=${anchored.length} selected=${selected} len=${clip.length}`);
  }

  // ===== Test 3: 点击 wrap 到第二行的文件路径 =====
  const pad = 'y'.repeat(Math.max(5, cols - 22));
  pushOutput('\r\n' + pad + ' src/components/deep/nested/PreviewTarget.tsx\r\n');
  await sleep(400);
  const pathPos = await page.evaluate(() => {
    const buf = term.buffer.active;
    const container = document.getElementById('terminal-container');
    const rowsEl = container.querySelector('.xterm-rows');
    const grid = rowsEl.getBoundingClientRect();
    const rowHeight = grid.height / term.rows;
    const colWidth = grid.width / term.cols;
    for (let i = buf.length - 1; i >= 0; i--) {
      const t = buf.getLine(i).translateToString(true);
      const idx = t.indexOf('PreviewTarget.tsx');
      if (idx >= 0) {
        const visual = i - buf.viewportY;
        return { x: grid.left + Math.min(idx + 3, term.cols - 2) * colWidth, y: grid.top + visual * rowHeight + rowHeight / 2 };
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

  // ===== Test 4: 长按选词 + 拖手柄扩选，TUI 视觉换行复制为自然段落 =====
  pushOutput('\r\n\r\n  这是输入测试，不要读文件，不要调用\r\n  工具，只回复“CURSOR_SE\r\n  ND_OK”。\r\n\r\n');
  await sleep(400);
  const tui = await page.evaluate(() => {
    term.clearSelection(); term.scrollToBottom();
    const buffer = term.buffer.active;
    const container = document.getElementById('terminal-container');
    const grid = container.querySelector('.xterm-rows').getBoundingClientRect();
    const rowHeight = grid.height / term.rows;
    const colWidth = grid.width / term.cols;
    const point = (row, col) => ({
      x: grid.left + (col + 0.5) * colWidth,
      y: grid.top + (row - buffer.viewportY + 0.5) * rowHeight,
    });
    let first = -1; let middle = -1; let last = -1;
    for (let row = buffer.length - 1; row >= 0; row--) {
      const text = buffer.getLine(row).translateToString(true);
      if (text.includes('这是输入测试')) first = row;
      if (text.includes('工具，只回复')) middle = row;
      if (text.includes('ND_OK')) last = row;
    }
    if (first < 0 || middle < 0 || last < 0) return null;
    return {
      press: point(middle, 2),
      paragraphStart: point(first, 2),
      paragraphEnd: point(last, term.cols - 1),
    };
  });
  if (!tui) {
    check('手机长按选词：定位 TUI 视觉换行段落', false, 'row not found');
  } else {
    const clipBefore = await page.evaluate(() => navigator.clipboard.readText());
    await page.touchscreen.touchStart(tui.press.x, tui.press.y);
    await sleep(600);
    const pressed = await page.evaluate(() => ({
      text: term.getSelection(),
      handles: [...document.querySelectorAll('.terminal-select-handle')].filter(el => !el.hidden).length,
      copyButton: !document.getElementById('terminal-copy-selection-btn').hidden,
    }));
    await page.touchscreen.touchEnd();
    await sleep(250);
    const clipAfterPress = await page.evaluate(() => navigator.clipboard.readText());
    check('长按只选中手指下的字，并给出复制入口',
      pressed.text === '工' && pressed.handles === 2 && pressed.copyButton,
      `selected=${JSON.stringify(pressed.text)} handles=${pressed.handles} copyButton=${pressed.copyButton}`);
    check('长按不再自动写剪贴板', clipAfterPress === clipBefore, `clip=${JSON.stringify(clipAfterPress)}`);

    for (const [which, target] of [['start', tui.paragraphStart], ['end', tui.paragraphEnd]]) {
      const handle = await page.evaluate((side) => {
        const el = document.querySelector(`.terminal-select-handle[data-handle="${side}"]`);
        if (!el || el.hidden) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, which);
      if (!handle) {
        check(`拖动${which === 'start' ? '起点' : '终点'}手柄扩选`, false, 'handle not visible');
        continue;
      }
      await page.touchscreen.touchStart(handle.x, handle.y);
      await page.touchscreen.touchMove(target.x, target.y);
      await page.touchscreen.touchEnd();
      await sleep(200);
    }
    const expanded = await page.evaluate(() => getUnwrappedSelection());
    check('拖手柄可把选区从起点扩到终点', expanded.startsWith('这是输入测试') && expanded.endsWith('ND_OK”。'),
      `selection=${JSON.stringify(expanded)}`);

    await page.click('#terminal-copy-selection-btn');
    await sleep(400);
    const afterCopy = await page.evaluate(async () => {
      const toast = document.getElementById('copy-toast');
      return {
        clip: await navigator.clipboard.readText(),
        toastShown: toast ? toast.classList.contains('show') && toast.textContent : 'none',
        selected: term.hasSelection(),
      };
    });
    const tuiClip = afterCopy.clip;
    check('手机复制：TUI 视觉换行恢复为自然段落',
      tuiClip === '这是输入测试，不要读文件，不要调用工具，只回复“CURSOR_SEND_OK”。',
      `copied=${JSON.stringify(tuiClip)} toast="${afterCopy.toastShown}" cleared=${!afterCopy.selected}`);
  }

  // ===== Test 4b: 未长按的单指拖动＝回看滚动，不能被抢成选区 =====
  pushOutput('\r\n' + Array.from({ length: 80 }, (_, i) => `scrollback-line-${i}`).join('\r\n') + '\r\n');
  await sleep(400);
  const pan = await page.evaluate(() => {
    term.clearSelection();
    term.scrollToBottom();
    const grid = document.getElementById('terminal-container').querySelector('.xterm-rows').getBoundingClientRect();
    return {
      x: grid.left + grid.width / 2,
      y: grid.top + grid.height * 0.4,
      viewportY: term.buffer.active.viewportY,
      length: term.buffer.active.length,
      rows: term.rows,
    };
  });
  await page.touchscreen.touchStart(pan.x, pan.y);
  // 分段快速下拉：每段都远超长按判定位移，但整段耗时远小于长按阈值
  for (let i = 1; i <= 6; i++) {
    await page.touchscreen.touchMove(pan.x, pan.y + i * 30);
  }
  await page.touchscreen.touchEnd();
  await sleep(300);
  const panResult = await page.evaluate(() => ({
    selected: term.hasSelection(),
    text: term.getSelection(),
    handles: [...document.querySelectorAll('.terminal-select-handle')].filter(el => !el.hidden).length,
    viewportY: term.buffer.active.viewportY,
  }));
  check('未长按的单指拖动只滚动，不触发选中',
    !panResult.selected && panResult.handles === 0 && panResult.viewportY < pan.viewportY,
    `viewportY ${pan.viewportY}->${panResult.viewportY} buf=${pan.length}/${pan.rows} selected=${JSON.stringify(panResult.text)} handles=${panResult.handles}`);

  // ===== Test 5: 跨 TUI 硬行的带空格路径仍可点击 =====
  const hardPrefix = '  ' + 'x'.repeat(Math.max(1, cols - 18));
  pushOutput(`\r\n${hardPrefix} "src/My Fi\r\n  le.ts":12:3\r\n`);
  await sleep(400);
  const hardPathPos = await page.evaluate(() => {
    term.scrollToBottom();
    const buffer = term.buffer.active;
    const container = document.getElementById('terminal-container');
    const grid = container.querySelector('.xterm-rows').getBoundingClientRect();
    const rowHeight = grid.height / term.rows;
    const colWidth = grid.width / term.cols;
    for (let row = buffer.length - 1; row >= 0; row--) {
      if (buffer.getLine(row).translateToString(true).includes('le.ts')) {
        return { x: grid.left + 5 * colWidth, y: grid.top + (row - buffer.viewportY + 0.5) * rowHeight };
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

  // ===== Test 5.5: 详情页「更多」下拉入口 =====
  await page.click('#detail-more-btn');
  await sleep(150);
  const menuState = await page.evaluate(() => {
    const menu = document.getElementById('detail-more-menu');
    return {
      hidden: menu.hidden,
      items: [...menu.querySelectorAll('button')].map(b => b.textContent).join(','),
      expanded: document.getElementById('detail-more-btn').getAttribute('aria-expanded'),
    };
  });
  check('详情页更多入口展开三项菜单',
    !menuState.hidden && menuState.items === '项目文件,计划设置,手机设备' && menuState.expanded === 'true',
    JSON.stringify(menuState));

  await page.click('#detail-menu-plan-btn');
  await sleep(200);
  const planOpen = await page.evaluate(() => ({
    modal: document.getElementById('auto-continue-modal').classList.contains('active'),
    menuHidden: document.getElementById('detail-more-menu').hidden,
  }));
  check('更多菜单可打开计划设置', planOpen.modal && planOpen.menuHidden, JSON.stringify(planOpen));
  await page.click('#ac-cancel');
  await sleep(150);

  await page.click('#detail-more-btn');
  await sleep(150);
  await page.click('#detail-menu-files-btn');
  await sleep(300);
  const filesOpen = await page.evaluate(() => document.getElementById('media-browse-page').classList.contains('active'));
  check('更多菜单可打开项目文件', filesOpen, `active=${filesOpen}`);
  await page.click('#media-browse-back-btn');
  await sleep(200);

  await page.click('#detail-more-btn');
  await sleep(150);
  await page.click('#detail-menu-device-btn');
  await sleep(300);
  const deviceOpen = await page.evaluate(() => document.getElementById('device-page').classList.contains('active'));
  check('更多菜单可打开手机设备', deviceOpen, `active=${deviceOpen}`);
  await page.click('#device-back-btn');
  await sleep(200);

  await page.click('#detail-more-btn');
  await sleep(150);
  await page.click('#terminal-container');
  await sleep(150);
  const menuClosed = await page.evaluate(() => document.getElementById('detail-more-menu').hidden);
  check('点击菜单外部收起更多菜单', menuClosed, `hidden=${menuClosed}`);

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

  // ===== Test 6b: Option + ↑ 作为一个组合键发送 =====
  receivedInputs.length = 0;
  await page.click('#option-up-key');
  await sleep(200);
  check('Option + ↑ 只发送组合键序列',
    receivedInputs.length === 1 && receivedInputs[0] === '\x1b[1;3A',
    `received=${JSON.stringify(receivedInputs)}`);
  const lastShortcutId = await page.evaluate(() => document.getElementById('shortcut-bar').lastElementChild?.id);
  check('Option + ↑ 位于快捷键栏最后', lastShortcutId === 'option-up-key', `last=${lastShortcutId}`);

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
    pickerButton: getComputedStyle(document.querySelector('#detail-session-picker-btn')).display,
    backButton: getComputedStyle(document.querySelector('#back-btn')).display,
  }));
  check('竖屏对话页隐藏左右侧栏菜单，保留返回按钮',
    portraitDrawer.sessionsButton === 'none'
      && portraitDrawer.deviceButton === 'none'
      && portraitDrawer.pickerButton === 'none'
      && portraitDrawer.backButton !== 'none',
    JSON.stringify(portraitDrawer));

  await page.setViewport({ width: 1024, height: 700, isMobile: false, hasTouch: true });
  await sleep(200);
  const landscapeDrawer = await page.evaluate(() => ({
    workspace: document.body.classList.contains('landscape-workspace'),
    detail: document.getElementById('detail-page').classList.contains('active'),
    listPage: document.getElementById('main-page').classList.contains('active'),
    sessionsOpen: document.getElementById('main-page').classList.contains('landscape-drawer-open'),
    backButton: getComputedStyle(document.querySelector('#back-btn')).display,
    pickerButton: getComputedStyle(document.querySelector('#detail-session-picker-btn')).display,
    sessionsButton: getComputedStyle(document.querySelector('#detail-header .landscape-sessions-toggle')).display,
    deviceButton: getComputedStyle(document.querySelector('#detail-header .landscape-device-toggle')).display,
    devicePull: getComputedStyle(document.getElementById('landscape-device-pull')).display,
  }));
  check('电脑横屏默认左侧列表 + 中间 CLI，不进入独立会话页',
    landscapeDrawer.workspace
      && landscapeDrawer.detail
      && !landscapeDrawer.listPage
      && landscapeDrawer.sessionsOpen
      && landscapeDrawer.backButton === 'none'
      && landscapeDrawer.pickerButton === 'none'
      && landscapeDrawer.sessionsButton === 'none'
      && landscapeDrawer.deviceButton !== 'none'
      && landscapeDrawer.devicePull === 'none',
    JSON.stringify(landscapeDrawer));
  await page.click('#detail-header .landscape-device-toggle');
  await sleep(200);
  const devicePulled = await page.evaluate(() => ({
    open: document.getElementById('device-page').classList.contains('landscape-drawer-open'),
    fullscreen: document.getElementById('fullscreen-overlay').style.display,
  }));
  check('电脑横屏右侧可拉入手机界面，不进入全屏',
    devicePulled.open && devicePulled.fullscreen === 'none',
    JSON.stringify(devicePulled));
  await page.click('#device-back-btn');
  await sleep(200);

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

  // ===== Test 10: 会话列表左滑关闭（需二次确认） =====
  // 前面的视口切换会把应用留在会话列表页，这里直接回到列表并刷新。
  await page.evaluate(() => { showPage('main-page'); return refreshSessions(); });
  await page.waitForFunction(() => document.querySelector('.session-card[data-id="s1"]'), { timeout: 5000 });
  const cardPoint = await page.evaluate(() => {
    const body = document.querySelector('.session-card[data-id="s1"] .session-card-body');
    const r = body.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const cardSwiped = () => page.evaluate(() => {
    const card = document.querySelector('.session-card[data-id="s1"]');
    return {
      swiped: card.classList.contains('swiped'),
      transform: getComputedStyle(card.querySelector('.session-card-body')).transform,
    };
  });
  await page.touchscreen.touchStart(cardPoint.x, cardPoint.y);
  await page.touchscreen.touchMove(cardPoint.x - 30, cardPoint.y);
  await page.touchscreen.touchEnd();
  await sleep(200);
  const shortSwipe = await cardSwiped();
  check('短距离左滑不会露出关闭',
    !shortSwipe.swiped && (!shortSwipe.transform || shortSwipe.transform === 'none'),
    JSON.stringify(shortSwipe));
  await page.touchscreen.touchStart(cardPoint.x, cardPoint.y);
  await page.touchscreen.touchMove(cardPoint.x - 36, cardPoint.y + 50);
  await page.touchscreen.touchEnd();
  await sleep(200);
  const diagonalSwipe = await cardSwiped();
  check('斜向下滑不会露出关闭',
    !diagonalSwipe.swiped && (!diagonalSwipe.transform || diagonalSwipe.transform === 'none'),
    JSON.stringify(diagonalSwipe));
  await page.touchscreen.touchStart(cardPoint.x, cardPoint.y);
  await page.touchscreen.touchMove(cardPoint.x - 40, cardPoint.y);
  await page.touchscreen.touchMove(cardPoint.x - 180, cardPoint.y);
  await page.touchscreen.touchEnd();
  await sleep(300);
  const swipeState = await page.evaluate(() => {
    const card = document.querySelector('.session-card[data-id="s1"]');
    const button = card.querySelector('.session-close-action');
    const pin = card.querySelector('.session-pin-action');
    const r = button.getBoundingClientRect();
    return {
      swiped: card.classList.contains('swiped'),
      transform: getComputedStyle(card.querySelector('.session-card-body')).transform,
      buttonOnTop: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === button,
      hasPin: !!pin,
      pinLabel: pin?.textContent?.trim() || '',
      detailOpen: document.getElementById('detail-page').classList.contains('active'),
      status: card.querySelector('.status-dot').className,
    };
  });
  check('左滑会话卡片露出置顶和关闭按钮，且不误打开会话',
    swipeState.swiped && swipeState.transform.includes('-156') && swipeState.buttonOnTop
      && swipeState.hasPin && swipeState.pinLabel.includes('置顶') && !swipeState.detailOpen,
    JSON.stringify(swipeState));
  check('左滑本身不会关闭会话', receivedDeletes.length === 0, `deletes=${JSON.stringify(receivedDeletes)}`);

  const pinPoint = await page.evaluate(() => {
    const button = document.querySelector('.session-card[data-id="s1"] .session-pin-action');
    const r = button.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.touchscreen.touchStart(pinPoint.x, pinPoint.y);
  await page.touchscreen.touchEnd();
  await sleep(300);
  const afterPin = await page.evaluate(() => {
    const card = document.querySelector('.session-card[data-id="s1"]');
    const pin = card?.querySelector('.session-pin-action');
    return {
      pinned: card?.classList.contains('is-pinned') || false,
      badge: !!card?.querySelector('.session-pin-badge'),
      pinLabel: pin?.textContent?.trim() || '',
      firstId: document.querySelector('.session-card[data-id]')?.dataset.id || '',
      swiped: card?.classList.contains('swiped') || false,
    };
  });
  check('点置顶后会话置顶到列表顶部并可再取消',
    afterPin.pinned && afterPin.badge && afterPin.pinLabel.includes('取消')
      && afterPin.firstId === 's1' && !afterPin.swiped,
    JSON.stringify(afterPin));

  // 列表随时可能被 SSE 重建；红色关闭不能在用户没再滑动时自己弹回来。
  mockSessions = mockSessions.map(s => ({ ...s, status: 'idle' }));
  const pushed = pushSessionsEvent();
  await sleep(300);
  const afterRerender = await page.evaluate(() => {
    const card = document.querySelector('.session-card[data-id="s1"]');
    return {
      status: card.querySelector('.status-dot').className,
      swiped: card.classList.contains('swiped'),
      transform: getComputedStyle(card.querySelector('.session-card-body')).transform,
    };
  });
  check('列表被 SSE 重建后不再露出关闭',
    pushed && swipeState.status !== afterRerender.status && afterRerender.status.includes('idle')
      && !afterRerender.swiped && (!afterRerender.transform || afterRerender.transform === 'none'),
    `before=${swipeState.status} ${JSON.stringify(afterRerender)}`);

  const swipeOpenClose = async () => {
    const point = await page.evaluate(() => {
      const body = document.querySelector('.session-card[data-id="s1"] .session-card-body');
      const r = body.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.touchscreen.touchStart(point.x, point.y);
    await page.touchscreen.touchMove(point.x - 40, point.y);
    await page.touchscreen.touchMove(point.x - 180, point.y);
    await page.touchscreen.touchEnd();
    await sleep(250);
  };
  const answerCloseConfirm = async (accept) => {
    await page.waitForSelector('#mobile-confirm-dialog [data-confirm]', { timeout: 3000 });
    await page.$eval(
      `#mobile-confirm-dialog [data-confirm="${accept ? 'yes' : 'no'}"]`,
      (el) => el.click()
    );
  };
  await swipeOpenClose();
  const cardStillThere = async () => page.evaluate(() => !!document.querySelector('.session-card[data-id="s1"]'));

  // 真实手机是 touch，不是鼠标 click；原先卡片 touchend 会先收起左滑并吞掉关闭。
  const closePoint = await page.evaluate(() => {
    const button = document.querySelector('.session-card[data-id="s1"] .session-close-action');
    const r = button.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.touchscreen.touchStart(closePoint.x, closePoint.y);
  await page.touchscreen.touchEnd();
  await answerCloseConfirm(false);
  await sleep(300);
  check('触摸点关闭后取消确认，会话仍在且仍保持滑开或可再滑开',
    receivedDeletes.length === 0 && await cardStillThere(),
    `deletes=${JSON.stringify(receivedDeletes)}`);

  await swipeOpenClose();
  await page.click('.session-card[data-id="s1"] .session-close-action');
  await answerCloseConfirm(false);
  await sleep(300);
  check('取消确认后会话保持打开', receivedDeletes.length === 0 && await cardStillThere(),
    `deletes=${JSON.stringify(receivedDeletes)}`);

  await swipeOpenClose();
  await page.touchscreen.touchStart(closePoint.x, closePoint.y);
  await page.touchscreen.touchEnd();
  await answerCloseConfirm(true);
  await sleep(400);
  check('触摸确认后关闭会话并从列表移除',
    receivedDeletes.length === 1 && receivedDeletes[0] === 's1' && !(await cardStillThere()),
    `deletes=${JSON.stringify(receivedDeletes)} cardLeft=${!(await cardStillThere())}`);

  // 再测一次鼠标 click 路径（桌面调试）
  mockSessions = [
    { id: 's1', title: '测试会话', status: 'running', createdAt: Date.now() - 60000, cwd: '/tmp/demo', displayName: 'Claude' },
  ];
  receivedDeletes.length = 0;
  pushSessionsEvent();
  await page.evaluate(() => { showPage('main-page'); return refreshSessions(); });
  await page.waitForFunction(() => document.querySelector('.session-card[data-id="s1"]'), { timeout: 5000 });
  await swipeOpenClose();
  await page.click('.session-card[data-id="s1"] .session-close-action');
  await answerCloseConfirm(true);
  await sleep(400);
  check('确认后关闭会话并从列表移除',
    receivedDeletes.length === 1 && receivedDeletes[0] === 's1' && !(await cardStillThere()),
    `deletes=${JSON.stringify(receivedDeletes)} cardLeft=${!(await cardStillThere())}`);

  mockSessions = [
    { id: 's1', title: '测试会话', status: 'running', createdAt: Date.now() - 60000, cwd: '/tmp/demo', displayName: 'Claude' },
  ];
  receivedDeletes.length = 0;
  pushSessionsEvent();
  await page.evaluate(() => openSession('s1'));
  await page.waitForFunction(
    () => document.getElementById('detail-page')?.classList.contains('active')
      && document.getElementById('detail-name')?.textContent,
    { timeout: 5000 }
  );
  await page.click('#delete-btn');
  await answerCloseConfirm(false);
  await sleep(300);
  check('对话页关闭取消后仍停留在当前会话',
    receivedDeletes.length === 0
      && await page.evaluate(() => document.getElementById('detail-page')?.classList.contains('active')),
    `deletes=${JSON.stringify(receivedDeletes)}`);
  await page.click('#delete-btn');
  await answerCloseConfirm(true);
  await sleep(400);
  check('对话页右上角关闭确认后结束会话',
    receivedDeletes.length === 1 && receivedDeletes[0] === 's1'
      && await page.evaluate(() => document.getElementById('main-page')?.classList.contains('active')),
    `deletes=${JSON.stringify(receivedDeletes)}`);

  // ===== Test 10b: 空列表欢迎屏居中，按钮与右上角新建相同 =====
  await page.evaluate(() => {
    activeSessionsCache = [];
    closedSessions = [];
    showPage('main-page');
    renderSessionList();
  });
  await page.waitForFunction(() => {
    const empty = document.getElementById('empty-state');
    return empty && empty.style.display === 'flex';
  }, { timeout: 5000 });
  const splash = await page.evaluate(() => {
    const empty = document.getElementById('empty-state');
    const list = document.getElementById('session-list');
    const header = document.getElementById('header');
    const emptyRect = empty.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const contentTop = headerRect.bottom;
    const contentH = window.innerHeight - contentTop;
    return {
      listHidden: list.hidden || getComputedStyle(list).display === 'none',
      emptyHeightRatio: contentH ? emptyRect.height / contentH : 0,
      hasBtn: !!document.getElementById('empty-new-session-btn'),
    };
  });
  check('空列表欢迎屏铺满剩余高度并显示新建按钮',
    splash.listHidden && splash.emptyHeightRatio > 0.9 && splash.hasBtn,
    JSON.stringify(splash));
  await page.click('#empty-new-session-btn');
  await page.waitForFunction(
    () => document.getElementById('new-session-modal').classList.contains('active'),
    { timeout: 5000 }
  );
  check('欢迎屏新建按钮打开与右上角相同的新建会话面板',
    await page.evaluate(() => document.getElementById('new-session-modal').classList.contains('active')));
  await page.evaluate(() => document.getElementById('new-session-modal').classList.remove('active'));

  // ===== Test 11: 新建会话面板与电脑端同步 =====
  await page.evaluate(() => {
    showPage('main-page');
    // custom-2 曾同步过、已被电脑端删掉；custom-9 是本地新建还没推上去的
    localStorage.setItem('duocli_custom_presets', JSON.stringify([
      { id: 'custom-2', name: 'GLM-CC', command: 'glm-cc', autoFlag: '' },
      { id: 'custom-9', name: '本地新增', command: 'local-cli', autoFlag: '' },
    ]));
    localStorage.setItem('duocli_custom_presets_synced', JSON.stringify(['custom-2']));
  });
  receivedPresetPuts.length = 0;
  await page.click('#new-session-btn');
  await page.waitForFunction(
    () => document.getElementById('new-session-modal').classList.contains('active'),
    { timeout: 5000 }
  );
  const sheet = await page.evaluate(() => ({
    presetValues: [...document.querySelectorAll('#new-preset option')].map(o => o.value),
    presetLabels: [...document.querySelectorAll('#new-preset option')].map(o => o.textContent),
    cwds: [...document.querySelectorAll('#new-cwd option')].map(o => o.value),
    synced: JSON.parse(localStorage.getItem('duocli_custom_presets_synced') || '[]'),
  }));
  check('电脑端删掉的预设不复活，本地未推送的保留',
    !sheet.presetValues.includes('glm-cc') && sheet.presetValues.includes('ds-cc')
      && sheet.presetValues.includes('local-cli'),
    JSON.stringify(sheet.presetValues));
  check('本地未推送的预设回推服务端，并记为已同步',
    receivedPresetPuts.some(list => list.some(p => p.id === 'custom-9') && !list.some(p => p.id === 'custom-2'))
      && sheet.synced.includes('custom-9') && !sheet.synced.includes('custom-2'),
    `puts=${JSON.stringify(receivedPresetPuts.map(l => l.map(p => p.id)))} synced=${JSON.stringify(sheet.synced)}`);
  check('预设下拉按使用频率排序，用得多的靠上',
    sheet.presetValues.slice(0, 3).join('|') === 'opencode||claude --dangerously-skip-permissions',
    JSON.stringify(sheet.presetLabels));
  check('最近目录取自服务端目录池',
    sheet.cwds.slice(1).join('|') === mockRecentCwds.join('|'),
    JSON.stringify(sheet.cwds));
  await page.evaluate(() => {
    document.querySelectorAll('.modal.active').forEach((modal) => modal.classList.remove('active'));
  });

  // Real browser pointer capture / touch arbitration against the production
  // handlers. Only the Android transport is replaced by an input recorder.
  await page.evaluate(() => {
    window.__androidInputs = [];
    androidMirrorDevice = 'pointer-test';
    androidMirror = {
      isController: true, hasFrame: true, geometryVersion: 1, controlEpoch: 1, width: 400, height: 800,
      connectionGeneration: 1, isReady: () => true,
      claimControl() { setTimeout(() => { this.isController = true; }, 80); },
      sendInput(input) { window.__androidInputs.push({ ...input, at: performance.now() }); return window.__androidInputs.length; },
      sendEmergencyInput(input) { return this.sendInput(input); },
      waitForAck: () => Promise.resolve({ ok: true }),
    };
    const canvas = document.createElement('canvas');
    canvas.id = 'android-pointer-test';
    canvas.width = 400;
    canvas.height = 800;
    canvas.style.cssText = 'position:fixed;left:40px;top:80px;width:200px;height:400px;z-index:2147483647;background:#222';
    document.body.appendChild(canvas);
    bindAndroidPointerSurface(canvas, true);
  });
  await page.mouse.move(100, 160);
  await page.mouse.down();
  await sleep(650);
  const held = await page.evaluate(() => window.__androidInputs.map(input => input.action));
  check('Android 鼠标长按在松手前已发送 DOWN', held.join('|') === 'down', held.join('|'));
  await page.mouse.move(200, 320, { steps: 5 });
  await page.mouse.up();
  await sleep(50);
  const androidDrag = await page.evaluate(() => window.__androidInputs);
  check('Android 鼠标长按拖拽保留持续时间和最后坐标',
    androidDrag[0]?.action === 'down' && androidDrag.at(-1)?.action === 'up'
      && androidDrag.some(input => input.action === 'move')
      && androidDrag.at(-1).at - androidDrag[0].at >= 600
      && androidDrag.at(-1).x === 319 && androidDrag.at(-1).y === 479, JSON.stringify(androidDrag));

  await page.evaluate(async () => {
    window.__androidInputs = [];
    androidMirror.isController = false;
    androidMirror.hasFrame = false;
    const canvas = document.getElementById('android-pointer-test');
    const image = new Image();
    image.style.cssText = canvas.style.cssText;
    image.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="2000"/>';
    await image.decode();
    Object.assign(image.dataset, { fallbackDeviceWidth: '1000', fallbackDeviceHeight: '2000' });
    canvas.hidden = true;
    document.body.appendChild(image);
    bindAndroidPointerSurface(image, true);
  });
  const touch = await page.createCDPSession();
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 100, y: 160 }] });
  await sleep(160);
  const claimed = await page.evaluate(() => window.__androidInputs.map(input => input.action));
  check('Android 兼容画面首次触摸在取得控制权后立即开始', claimed.join('|') === 'down', claimed.join('|'));
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 300, y: 550 }] });
  await sleep(50);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(180);
  const edge = await page.evaluate(() => window.__androidInputs);
  check('Android 手指拖出画面边缘后仍收到 MOVE 和 UP',
    edge[0]?.action === 'down' && edge.at(-1)?.action === 'up'
      && edge.some(input => input.action === 'move' && input.x === 399 && input.y === 799), JSON.stringify(edge));
  await touch.detach();

  await page.evaluate(() => {
    window.__androidInputs = [];
    androidMirrorDevice = 'pointer-test';
    androidMirror = {
      isController: true,
      isReady: () => true,
      geometryVersion: 1,
      controlEpoch: 1,
      sendInput(input) {
        window.__androidInputs.push({ ...input });
        return window.__androidInputs.length;
      },
      waitForAck: () => Promise.resolve({ ok: true }),
      claimControl() {},
    };
    document.getElementById('fullscreen-overlay').style.display = 'none';
    showPage('device-page');
  });
  const navLabels = await page.evaluate(() => ({
    device: [...document.querySelectorAll('#device-page .android-nav-btn[data-android-key]')].map((button) => button.getAttribute('aria-label')).join(','),
    fullscreen: [...document.querySelectorAll('#fullscreen-overlay .android-nav-btn[data-android-key]')].map((button) => button.getAttribute('aria-label')).join(','),
  }));
  check('镜像画面侧面有返回/主屏/菜单',
    navLabels.device === '返回,主屏,菜单' && navLabels.fullscreen === '返回,主屏,菜单',
    JSON.stringify(navLabels));
  const deviceChrome = await page.evaluate(() => {
    const chrome = document.querySelector('#device-page .device-side-chrome');
    const hint = document.getElementById('device-hint');
    const header = document.querySelector('#device-page header');
    const nav = document.querySelector('#device-page .android-nav-keys');
    const textBtn = document.getElementById('device-text-btn');
    const screen = document.getElementById('device-screen');
    const workspace = document.querySelector('#device-page .device-workspace');
    const fullscreenChrome = document.querySelector('#fullscreen-overlay .device-side-chrome');
    return {
      hintInChrome: Boolean(chrome && hint && chrome.contains(hint)),
      headerInChrome: Boolean(chrome && header && chrome.contains(header)),
      navInChrome: Boolean(chrome && nav && chrome.contains(nav)),
      textInChrome: Boolean(chrome && textBtn && chrome.contains(textBtn)),
      fullscreenTextInChrome: Boolean(fullscreenChrome?.contains(document.getElementById('fullscreen-text-btn'))),
      noBottomToolbar: !document.getElementById('fullscreen-toolbar'),
      screenInWorkspace: Boolean(workspace && screen && workspace.contains(screen) && !chrome.contains(screen)),
    };
  });
  check('设备页顶栏和提示都在右侧操作栏',
    deviceChrome.hintInChrome && deviceChrome.headerInChrome && deviceChrome.navInChrome && deviceChrome.screenInWorkspace,
    JSON.stringify(deviceChrome));
  check('输入按钮在右侧操作栏，全屏不再使用底部工具条',
    deviceChrome.textInChrome && deviceChrome.fullscreenTextInChrome && deviceChrome.noBottomToolbar,
    JSON.stringify(deviceChrome));
  await page.evaluate(() => document.getElementById('device-text-btn')?.click());
  const textModal = await page.evaluate(() => document.getElementById('input-text-modal').classList.contains('active'));
  check('右侧输入按钮打开文字输入', textModal, `active=${textModal}`);
  await page.evaluate(() => document.getElementById('input-text-modal').classList.remove('active'));

  await page.evaluate(() => {
    window.__androidInputs = [];
    androidMirrorDevice = 'pointer-test';
    androidMirror = {
      isController: true,
      hasFrame: true,
      geometryVersion: 1,
      controlEpoch: 1,
      width: 1080,
      height: 2400,
      connectionGeneration: 1,
      isReady: () => true,
      claimControl() {},
      sendInput(input) {
        window.__androidInputs.push({ ...input });
        return window.__androidInputs.length;
      },
      sendEmergencyInput(input) { return this.sendInput(input); },
      waitForAck: () => Promise.resolve({ ok: true }),
    };
    document.getElementById('android-pointer-test')?.remove();
    for (const el of [...document.body.children]) {
      if (el.tagName === 'CANVAS' || el.tagName === 'IMG') el.remove();
    }
    document.getElementById('fullscreen-overlay').style.display = 'none';
    showPage('device-page');
    const canvas = document.getElementById('device-video');
    canvas.hidden = false;
    canvas.width = 1080;
    canvas.height = 2400;
    document.getElementById('device-preview-empty').style.display = 'none';
    document.getElementById('device-preview').style.display = 'none';
    fitAndroidSurfaces();
  });
  const deviceHit = await page.evaluate(() => {
    const screen = document.getElementById('device-screen');
    const canvas = document.getElementById('device-video');
    const r = (canvas && !canvas.hidden ? canvas : screen).getBoundingClientRect();
    return { w: r.width, h: r.height, x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  check('非全屏手机画面有可点区域', deviceHit.w > 120 && deviceHit.h > 200, JSON.stringify(deviceHit));
  await page.mouse.click(deviceHit.x, deviceHit.y);
  await sleep(150);
  const afterDeviceTap = await page.evaluate(() => ({
    overlay: document.getElementById('fullscreen-overlay').style.display,
    actions: window.__androidInputs.map(input => input.action).filter(Boolean),
  }));
  check('非全屏点击操控不会误进全屏', afterDeviceTap.overlay === 'none', JSON.stringify(afterDeviceTap));
  check('非全屏点击会发送触摸', afterDeviceTap.actions.includes('down'), JSON.stringify(afterDeviceTap.actions));

  await page.evaluate(() => {
    window.__androidInputs = [];
    const full = document.getElementById('fullscreen-video');
    full.hidden = false;
    full.width = 1080;
    full.height = 2400;
    document.getElementById('fullscreen-preview').style.display = 'none';
    openAndroidFullscreen();
    fitAndroidSurfaces();
  });
  await sleep(80);
  const fullHit = await page.evaluate(() => {
    const overlay = document.getElementById('fullscreen-overlay');
    const screen = document.getElementById('fullscreen-screen');
    const canvas = document.getElementById('fullscreen-video');
    const r = (canvas && !canvas.hidden ? canvas : screen).getBoundingClientRect();
    return {
      display: overlay.style.display,
      w: r.width,
      h: r.height,
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
    };
  });
  check('全屏手机画面铺满可点', fullHit.display === 'flex' && fullHit.w > 200 && fullHit.h > 300, JSON.stringify(fullHit));
  await page.mouse.click(fullHit.x, fullHit.y);
  await sleep(150);
  const fullTap = await page.evaluate(() => window.__androidInputs.map(input => input.action).filter(Boolean));
  check('全屏点击会发送触摸', fullTap.includes('down'), JSON.stringify(fullTap));
  await page.evaluate(() => {
    document.getElementById('fullscreen-overlay').style.display = 'none';
    window.__androidInputs = [];
  });

  await page.evaluate(() => {
    for (const key of ['back', 'home', 'recents']) {
      document.querySelector(`#device-page [data-android-key="${key}"]`)?.click();
    }
  });
  await sleep(80);
  const navKeys = await page.evaluate(() => window.__androidInputs);
  check('侧面导航键发送返回/主屏/菜单 down-up',
    JSON.stringify(navKeys) === JSON.stringify([
      { type: 'back', keyAction: 'down' },
      { type: 'back', keyAction: 'up' },
      { type: 'key', keyCode: 3, keyAction: 'down' },
      { type: 'key', keyCode: 3, keyAction: 'up' },
      { type: 'key', keyCode: 187, keyAction: 'down' },
      { type: 'key', keyCode: 187, keyAction: 'up' },
    ]),
    JSON.stringify(navKeys));

  const quickResult = await page.evaluate(async () => {
    currentSessionId = 's1';
    localStorage.setItem(QCMD_STORAGE_KEY, JSON.stringify(['/迁移', '/help']));
    await syncQuickCommands();
    await updateQuickCommands({ action: 'add', command: '/review' });
    const input = document.getElementById('msg-input');
    input.value = '前文后文';
    input.focus();
    input.setSelectionRange(2, 2);
    let submissions = 0;
    const original = requestSubmission;
    requestSubmission = () => { submissions++; return Promise.resolve(); };
    try {
      [...document.querySelectorAll('#quick-commands button')].find(button => button.textContent === '/review').click();
    } finally { requestSubmission = original; }
    return { value: input.value, cursor: input.selectionStart, submissions, commands: (await api('/api/quick-commands')).commands };
  });
  check('快捷命令迁移到服务端并插入光标位置，不发送',
    quickResult.value === '前文/review后文' && quickResult.cursor === 9 && quickResult.submissions === 0
      && quickResult.commands.includes('/迁移') && quickResult.commands.includes('/review'), JSON.stringify(quickResult));
  quickCommandStore.update({ action: 'remove', command: '/review' });
  if (sseClient) sseClient.write(`event: quick-commands\ndata: ${JSON.stringify(quickCommandStore.read())}\n\n`);
  await page.waitForFunction(() => ![...document.querySelectorAll('#quick-commands button')].some(button => button.textContent === '/review'));
  check('其他终端删除快捷命令通过 SSE 更新当前手机', true);
  await page.evaluate(() => { showPage('detail-page'); });
  await page.screenshot({ path: '/tmp/duocli-mobile-quick-commands.png' });

  const viewportResult = await page.evaluate(() => {
    const smallFields = [...document.querySelectorAll('input, select, textarea')]
      .filter(field => parseFloat(getComputedStyle(field).fontSize) < 16)
      .map(field => field.id || field.className);
    const viewport = window.visualViewport;
    const names = ['scale', 'height', 'offsetTop'];
    const descriptors = names.map(name => Object.getOwnPropertyDescriptor(viewport, name));
    const setViewport = (scale, height, offsetTop = 0) => {
      Object.defineProperties(viewport, {
        scale: { configurable: true, value: scale },
        height: { configurable: true, value: height },
        offsetTop: { configurable: true, value: offsetTop },
      });
      viewport.dispatchEvent(new Event('resize'));
    };
    const detail = document.getElementById('detail-page');
    resetMobileKeyboardLayout();
    let zoomInset, keyboardInset, restoredInset;
    try {
      setViewport(2, innerHeight / 2, 30);
      zoomInset = detail.style.bottom;
      setViewport(1, innerHeight - 300);
      keyboardInset = detail.style.bottom;
      setViewport(1, innerHeight);
      restoredInset = detail.style.bottom;
    } finally {
      names.forEach((name, index) => {
        if (descriptors[index]) Object.defineProperty(viewport, name, descriptors[index]);
        else delete viewport[name];
      });
    }
    const header = document.getElementById('detail-header').getBoundingClientRect();
    return { smallFields, zoomInset, keyboardInset, restoredInset,
      touchAction: getComputedStyle(document.body).touchAction,
      headerVisible: header.top >= 0 && header.bottom <= innerHeight };
  });
  check('手机表单字号至少 16px，页面阻止意外缩放', viewportResult.smallFields.length === 0
    && viewportResult.touchAction === 'pan-x pan-y', JSON.stringify(viewportResult));
  check('页面缩放不误判为键盘，键盘收起后导航仍可见', viewportResult.zoomInset === ''
    && viewportResult.keyboardInset === '300px' && viewportResult.restoredInset === ''
    && viewportResult.headerVisible, JSON.stringify(viewportResult));
  await page.screenshot({ path: '/tmp/duocli-mobile-viewport.png' });

  const downloadClick = await page.evaluate(() => {
    currentSessionId = 's1';
    const original = HTMLAnchorElement.prototype.click;
    let captured;
    HTMLAnchorElement.prototype.click = function () {
      captured = { href: this.href, download: this.download, attached: this.isConnected };
    };
    try {
      openFilePreview('data-store/Artifacts/家长糖宣传图-V7.zip');
    } finally {
      HTMLAnchorElement.prototype.click = original;
    }
    const url = new URL(captured.href);
    return { ...captured, path: url.searchParams.get('path'), authenticated: url.searchParams.get('token') === token };
  });
  check('ZIP 点击生成带认证的下载入口',
    downloadClick.href.includes('/api/sessions/s1/file-download?')
      && downloadClick.path === 'data-store/Artifacts/家长糖宣传图-V7.zip'
      && downloadClick.download === '家长糖宣传图-V7.zip'
      && downloadClick.attached && downloadClick.authenticated, JSON.stringify(downloadClick));

  await browser.close();
  server.close();

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
