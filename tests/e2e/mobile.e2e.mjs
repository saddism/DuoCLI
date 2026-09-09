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

  // ===== Test 10: 会话列表左滑关闭（需二次确认） =====
  // 前面的视口切换会把应用留在会话列表页，这里直接回到列表并刷新。
  await page.evaluate(() => { showPage('main-page'); return refreshSessions(); });
  await page.waitForFunction(() => document.querySelector('.session-card[data-id="s1"]'), { timeout: 5000 });
  const cardPoint = await page.evaluate(() => {
    const body = document.querySelector('.session-card[data-id="s1"] .session-card-body');
    const r = body.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.touchscreen.touchStart(cardPoint.x, cardPoint.y);
  await page.touchscreen.touchMove(cardPoint.x - 40, cardPoint.y);
  await page.touchscreen.touchMove(cardPoint.x - 110, cardPoint.y);
  await page.touchscreen.touchEnd();
  await sleep(300);
  const swipeState = await page.evaluate(() => {
    const card = document.querySelector('.session-card[data-id="s1"]');
    const button = card.querySelector('.session-close-action');
    const r = button.getBoundingClientRect();
    return {
      swiped: card.classList.contains('swiped'),
      transform: getComputedStyle(card.querySelector('.session-card-body')).transform,
      buttonOnTop: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === button,
      detailOpen: document.getElementById('detail-page').classList.contains('active'),
      status: card.querySelector('.status-dot').className,
    };
  });
  check('左滑会话卡片露出关闭按钮，且不误打开会话',
    swipeState.swiped && swipeState.transform.includes('-84') && swipeState.buttonOnTop && !swipeState.detailOpen,
    JSON.stringify(swipeState));
  check('左滑本身不会关闭会话', receivedDeletes.length === 0, `deletes=${JSON.stringify(receivedDeletes)}`);

  // 列表随时可能被 SSE 重建，滑开状态必须跟着新节点恢复
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
  check('列表被 SSE 重建后滑开状态保留',
    pushed && swipeState.status !== afterRerender.status && afterRerender.status.includes('idle')
      && afterRerender.swiped && afterRerender.transform.includes('-84'),
    `before=${swipeState.status} ${JSON.stringify(afterRerender)}`);

  const cardStillThere = async () => page.evaluate(() => !!document.querySelector('.session-card[data-id="s1"]'));
  page.once('dialog', dialog => dialog.dismiss());
  await page.click('.session-card[data-id="s1"] .session-close-action');
  await sleep(300);
  check('取消确认后会话保持打开', receivedDeletes.length === 0 && await cardStillThere(),
    `deletes=${JSON.stringify(receivedDeletes)}`);

  page.once('dialog', dialog => dialog.accept());
  await page.click('.session-card[data-id="s1"] .session-close-action');
  await sleep(400);
  check('确认后关闭会话并从列表移除',
    receivedDeletes.length === 1 && receivedDeletes[0] === 's1' && !(await cardStillThere()),
    `deletes=${JSON.stringify(receivedDeletes)} cardLeft=${!(await cardStillThere())}`);

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

  await browser.close();
  server.close();

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
