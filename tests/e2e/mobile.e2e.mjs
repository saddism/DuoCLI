import os from 'node:os';
import { QuickCommandStore } from '../../dist/main/quick-commands.js';
// 移动端 e2e：mock HTTP/WS 后端 + headless Chrome 真实驱动 mobile/client 页面
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import puppeteer from 'puppeteer-core';
import { closeTestBrowser } from './browser-cleanup.mjs';
import { resolveChromeExecutable } from './chrome-path.mjs';
import { runInputChatAudit } from './input-chat-audit-probes.mjs';
import { createRequire } from 'node:module';

const { LIVE_TERMINAL_SCROLLBACK } = createRequire(import.meta.url)('../../mobile/client/terminal-scroll-helpers.js');

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
const receivedHistoryRequests = [];
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
  lastUserPrompt: '修好远程镜像交互',
}];
let mockChatById = {};
let mockChatInputDelay = 0;
let mockChatInputFailure = false;

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
  if (p === '/api/lan-info') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ lanIps: ['127.0.0.1'], port: PORT, hostname: 'e2e' }));
    return;
  }
  if (p === '/api/sessions' && req.method !== 'DELETE') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(mockSessions));
    return;
  }
  if (p.startsWith('/api/sessions/') && p.endsWith('/seen') && req.method === 'POST') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
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
  if (p.startsWith('/api/sessions/') && p.includes('/file-download')) {
    const reqPath = url.searchParams.get('path') || 'download.bin';
    const filename = reqPath.split(/[\\/]/).pop() || 'download.bin';
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="download.bin"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.end(Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]));
    return;
  }
  if (p.startsWith('/api/sessions/') && p.endsWith('/chat')) {
    const id = decodeURIComponent(p.slice('/api/sessions/'.length, -'/chat'.length));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(mockChatById[id] || { supported: false, ready: false, messages: [] }));
    return;
  }
  if (p.startsWith('/api/sessions/') && p.endsWith('/input') && req.method === 'POST') {
    void readJsonBody(req).then(body => {
      receivedSubmissions.push(body.input);
      setTimeout(() => {
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = mockChatInputFailure ? 503 : 200;
        res.end(JSON.stringify(mockChatInputFailure ? { error: 'test offline' } : { ok: true }));
      }, mockChatInputDelay);
    });
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
  if (p === '/api/mac-desktop/screenshot') {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('X-DuoCLI-Device-Width', '100');
    res.setHeader('X-DuoCLI-Device-Height', '100');
    res.end(Buffer.from(
      '/9j/4AAQSkZJRgABAQAAAQABAAD/2wAAAAD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQARAAAPwP/Z',
      'base64',
    ));
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
  let subscribedSessionId = null;
  sock.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'subscribe') {
      subscribedSessionId = msg.sessionId;
      sock.send(JSON.stringify({
        type: 'replay',
        data: sessionBuffer,
        capabilityVersion: 2,
        historyHasMore: true,
        hasMoreHistory: false,
        historyCursor: '1:100',
        epoch: 1,
        scrollback: 0,
      }));
    } else if (msg.type === 'historyBefore') {
      receivedHistoryRequests.push(msg);
      const items = Array.from({ length: 24 }, (_, i) => ({
        epoch: 1,
        lineId: 70 + i,
        part: 0,
        text: `history-line-${70 + i} older-output`,
        wraps: [],
        styles: [],
      }));
      sock.send(JSON.stringify({
        type: 'historyPage',
        items,
        nextCursor: '1:70',
        hasMore: true,
        stale: false,
        requestId: msg.requestId || '',
        epoch: 1,
      }));
    } else if (msg.type === 'ping') {
      sock.send(JSON.stringify({ type: 'pong' }));
    } else if (msg.type === 'input_b64') {
      receivedInputs.push(Buffer.from(msg.data, 'base64').toString('utf8'));
    } else if (msg.type === 'submit') {
      if (msg.sessionId !== subscribedSessionId) {
        sock.send(JSON.stringify({ type: 'submitted', id: msg.id, error: 'wrong session' }));
        return;
      }
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
  const clickDetailMenuItem = async selector => {
    if (await page.$eval('#detail-more-menu', menu => menu.hidden)) await page.click('#detail-more-btn');
    await page.click(selector);
  };
  await page.setViewport({ width: 390, height: 760, isMobile: true, hasTouch: true });
  await page.browserContext().overridePermissions(ORIGIN, ['clipboard-read', 'clipboard-write']);
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));

  await page.goto(`${ORIGIN}/index.html?token=e2e`, { waitUntil: 'networkidle2' });

  // 进入会话详情页
  await page.waitForFunction(() => document.querySelector('.session-card'), { timeout: 8000 });
  await page.type('#session-search', 'e2e-proj');
  check('工作区搜索支持项目目录', await page.$$eval('.session-card', cards => cards.length === 1));
  await page.keyboard.press('Escape');
  await page.type('#session-search', 'no-such-project');
  check('搜索无结果时显示提示并保留清除入口', await page.evaluate(() =>
    !document.getElementById('session-search-empty').hidden && !document.querySelector('.session-card')
      && document.getElementById('session-search').checkVisibility()));
  await page.keyboard.press('Escape');
  check('清除搜索恢复会话列表', await page.$$eval('.session-card', cards => cards.length === 1));
  await page.$eval('#session-search', input => input.blur());
  await page.screenshot({ path: '/tmp/duocli-workspace-ui-mobile-list.png' });
  const netMode = await page.evaluate(() => {
    const btn = document.getElementById('net-mode-btn');
    return {
      hidden: !btn || btn.style.display === 'none',
      text: btn?.textContent?.replace(/\s+/g, '') || '',
      className: btn?.className || '',
      aria: btn?.getAttribute('aria-label') || '',
      hasIcon: Boolean(btn?.querySelector('svg')),
    };
  });
  check('局域网模式下显示网络状态',
    !netMode.hidden && netMode.className.includes('lan') && netMode.hasIcon && netMode.aria === '局域网' && !netMode.text.includes('局域网'),
    JSON.stringify(netMode));
  const sessionOrders = await page.evaluate(() => {
    const saved = activeSessionsCache;
    activeSessionsCache = [
      { id: 'old', title: 'old', createdAt: 100, lastSubmittedAt: 400 },
      { id: 'new', title: 'new', createdAt: 300, lastSubmittedAt: 0 },
      { id: 'output', title: 'output', createdAt: 200, updatedAt: 999 },
      { id: 'pinned', title: 'pinned', createdAt: 50, lastSubmittedAt: 0 },
    ];
    pinnedSessionIds.add('pinned');
    renderSessionList();
    const order = () => [...document.querySelectorAll('.session-card')].map(card => card.dataset.id);
    const first = order();
    activeSessionsCache.find(session => session.id === 'output').lastSubmittedAt = 500;
    renderSessionList();
    const second = order();
    pinnedSessionIds.delete('pinned');
    activeSessionsCache = saved;
    renderSessionList();
    return { first, second };
  });
  check('会话按真实提交时间前移，普通输出不抢首位且置顶仍优先',
    JSON.stringify(sessionOrders.first) === JSON.stringify(['pinned', 'old', 'new', 'output'])
      && JSON.stringify(sessionOrders.second) === JSON.stringify(['pinned', 'output', 'old', 'new']),
    JSON.stringify(sessionOrders));
  await page.click('.session-card');
  await page.waitForFunction(() => term && term.cols > 0, { timeout: 8000 });
  await sleep(500);

  const cols = await page.evaluate(() => term.cols);
  console.log(`terminal cols = ${cols}`);
  const remoteBanner = await page.evaluate(() => {
    const el = document.getElementById('user-prompt-banner');
    return {
      hidden: el?.hidden ?? true,
      text: el?.querySelector('.user-prompt-text')?.textContent || '',
      parent: el?.parentElement?.id || '',
    };
  });
  check('打开会话后不再显示最近在说横幅',
    remoteBanner.hidden && !remoteBanner.text && !remoteBanner.parent,
    JSON.stringify(remoteBanner));
  const detailNetMode = await page.evaluate(() => {
    const btn = document.getElementById('net-mode-btn');
    const host = document.getElementById('detail-net-mode-host');
    return {
      parent: btn?.parentElement?.id || '',
      hidden: !btn || btn.style.display === 'none' || getComputedStyle(btn).display === 'none',
      visible: !!(btn && btn.offsetParent),
      aria: btn?.getAttribute('aria-label') || '',
      hasIcon: Boolean(btn?.querySelector('svg')),
      inHost: !!(host && btn && host.contains(btn)),
      planVisible: getComputedStyle(document.getElementById('detail-ac-label')).display !== 'none',
    };
  });
  check('竖屏对话内不显示网络切换',
    !detailNetMode.inHost && !detailNetMode.visible && detailNetMode.parent === 'main-net-mode-host',
    JSON.stringify(detailNetMode));
  check('计划设置胶囊已收进三点菜单', !detailNetMode.planVisible, JSON.stringify(detailNetMode));

  // Exercise native hit testing and focus, not programmatic textarea.value writes.
  await page.click('#msg-input');
  await page.keyboard.type('composer click draft');
  const composerClick = await page.$eval('#msg-input', input => {
    const rect = input.getBoundingClientRect();
    return {
      focused: document.activeElement === input,
      value: input.value,
      hit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.id,
    };
  });
  check('自定义输入框可点击聚焦并输入草稿',
    composerClick.focused && composerClick.value === 'composer click draft' && composerClick.hit === 'msg-input',
    JSON.stringify(composerClick));
  const historyOverlay = await page.evaluate(() => {
    const input = document.getElementById('msg-input');
    const layer = document.querySelector('.terminal-history-layer');
    const rect = input.getBoundingClientRect();
    return {
      hidden: layer?.hidden ?? null,
      display: layer ? getComputedStyle(layer).display : null,
      inert: layer?.hasAttribute('inert') ?? null,
      hit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.id,
    };
  });
  check('历史层默认不挡住输入框',
    historyOverlay.hidden && historyOverlay.display === 'none' && historyOverlay.hit === 'msg-input',
    JSON.stringify(historyOverlay));
  const historyShownHit = await page.evaluate(() => {
    const input = document.getElementById('msg-input');
    const layer = document.querySelector('.terminal-history-layer');
    if (layer) {
      layer.hidden = false;
      layer.removeAttribute('inert');
    }
    const rect = input.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.id;
    if (layer) {
      layer.hidden = true;
      layer.setAttribute('inert', '');
    }
    return hit;
  });
  check('历史层打开时仍能点输入框', historyShownHit === 'msg-input', historyShownHit);
  await page.$eval('#msg-input', input => { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); input.blur(); });

  mockSessions = [
    {
      id: 's1', title: 'e2e-session', status: 'running',
      cwd: '/tmp/e2e-proj', presetCommand: 'claude', createdAt: Date.now(),
      lastUserPrompt: '修好远程镜像交互',
    },
    {
      id: 's2', title: 'other-session', status: 'idle',
      cwd: '/tmp/e2e-other', presetCommand: 'claude', createdAt: Date.now(),
      lastUserPrompt: '另一个对话里的话',
    },
    {
      id: 's3', title: 'fresh-session', status: 'running',
      cwd: '/tmp/e2e-fresh', presetCommand: 'claude', createdAt: Date.now(),
      lastUserPrompt: '',
    },
  ];
  pushSessionsEvent();
  await page.evaluate(() => {
    // Simulate a recycled-id leftover that must not leak into a fresh session.
    globalThis.DuoUserPromptBanner.writeStoredPrompt('s3', '别的对话里的脏缓存');
  });
  await page.evaluate(() => openSession('s2'));
  await page.waitForFunction(() => currentSessionId === 's2' && term && term.cols > 0, { timeout: 8000 });
  await sleep(300);
  const switchedBanner = await page.evaluate(() => {
    const el = document.getElementById('user-prompt-banner');
    return { hidden: el?.hidden ?? true, text: el?.querySelector('.user-prompt-text')?.textContent || '' };
  });
  check('切换对话后不再占用横幅空间',
    switchedBanner.hidden && !switchedBanner.text,
    JSON.stringify(switchedBanner));

  await page.evaluate(() => openSession('s3'));
  await page.waitForFunction(() => currentSessionId === 's3' && term && term.cols > 0, { timeout: 8000 });
  await sleep(300);
  const freshBanner = await page.evaluate(() => {
    const el = document.getElementById('user-prompt-banner');
    return {
      hidden: el?.hidden ?? true,
      text: el?.querySelector('.user-prompt-text')?.textContent || '',
      stored: globalThis.DuoUserPromptBanner.readStoredPrompt('s3'),
    };
  });
  check('新对话不会挂上别的会话的最近在说',
    freshBanner.hidden && !freshBanner.text && !freshBanner.stored,
    JSON.stringify(freshBanner));

  mockSessions = [
    ...mockSessions,
    {
      id: 's-codex-new', title: 'Codex', status: 'running',
      cwd: '/tmp/e2e-codex', presetCommand: 'codex', cli: 'codex',
      chatCapable: true, resumeId: null, createdAt: Date.now(),
    },
    {
      id: 's-codex-chat', title: 'Codex聊天', status: 'running',
      cwd: '/tmp/e2e-codex2', presetCommand: 'codex', cli: 'codex',
      chatCapable: true, resumeId: 'resume-codex-1', createdAt: Date.now(),
    },
    {
      id: 's-codex-empty', title: 'Codex空记录', status: 'running',
      cwd: '/tmp/e2e-codex3', presetCommand: 'codex', cli: 'codex',
      chatCapable: true, resumeId: 'resume-codex-empty', createdAt: Date.now(),
    },
  ];
  mockChatById = {
    's-codex-new': { supported: true, ready: false, notFound: true, messages: [] },
    's-codex-empty': { supported: true, ready: false, notFound: true, messages: [] },
    's-codex-chat': {
      supported: true,
      ready: true,
      messages: [{ role: 'user', blocks: [{ type: 'text', text: 'ship it' }] }],
    },
  };
  await page.evaluate(() => openSession('s-codex-new'));
  await page.waitForFunction(() => currentSessionId === 's-codex-new' && term && term.cols > 0, { timeout: 8000 });
  const newCodexView = await page.evaluate(() => ({
    mode: sessionViewMode,
    chatHidden: document.getElementById('chat-container')?.hidden !== false,
    termHidden: document.getElementById('terminal-container')?.hidden === true,
    emptyText: document.getElementById('chat-transcript')?.textContent || '',
  }));
  check('新建 Codex 没有对话记录时打开终端而不是空对话',
    newCodexView.mode === 'terminal' && newCodexView.chatHidden && !newCodexView.termHidden
      && !newCodexView.emptyText.includes('还没有对话'),
    JSON.stringify(newCodexView));

  await page.waitForFunction(() => ws && ws.readyState === WebSocket.OPEN, { timeout: 8000 });
  wsClient.send(JSON.stringify({ type: 'replay', missingSession: true, data: '', sequence: 0 }));
  await page.waitForFunction(() => currentSessionId === null, { timeout: 8000 });
  const missingSessionState = await page.evaluate(() => ({
    inputReady: terminalInputReady,
    detailVisible: document.getElementById('detail-page').classList.contains('active'),
  }));
  check('缓存会话已结束时空回放不会开放输入',
    !missingSessionState.inputReady && !missingSessionState.detailVisible,
    JSON.stringify(missingSessionState));

  await page.evaluate(() => openSession('s-codex-new'));
  await page.waitForFunction(() => currentSessionId === 's-codex-new' && ws && ws.readyState === WebSocket.OPEN, { timeout: 8000 });
  wsClient.send(JSON.stringify({ type: 'history', missingSession: true, data: '', sequence: 0 }));
  await page.waitForFunction(() => currentSessionId === null, { timeout: 8000 });
  check('加载旧内容时会话已结束也返回列表并禁用输入',
    await page.evaluate(() => !terminalInputReady && !document.getElementById('detail-page').classList.contains('active')));

  await page.evaluate(() => openSession('s-codex-chat'));
  await page.waitForFunction(() => currentSessionId === 's-codex-chat' && sessionViewMode === 'terminal' && term && term.cols > 0, { timeout: 8000 });
  const existingCodexView = await page.evaluate(() => ({
    mode: sessionViewMode,
    chatHidden: document.getElementById('chat-container')?.hidden !== false,
    termHidden: document.getElementById('terminal-container')?.hidden === true,
    pref: sessionChatPref('s-codex-chat'),
  }));
  check('已有 Codex 对话记录时仍打开终端',
    existingCodexView.mode === 'terminal' && existingCodexView.chatHidden && !existingCodexView.termHidden
      && existingCodexView.pref !== 'chat',
    JSON.stringify(existingCodexView));
  await clickDetailMenuItem('#terminal-return-chat');
  await page.waitForFunction(() => sessionViewMode === 'chat' && document.getElementById('chat-transcript').textContent.includes('ship it'), { timeout: 8000 });
  check('菜单对话入口同步选中状态', await page.$eval('#terminal-return-chat', button => button.getAttribute('aria-pressed') === 'true'));
  await page.waitForFunction(() => !document.getElementById('copy-toast') || getComputedStyle(document.getElementById('copy-toast')).opacity === '0');
  await page.screenshot({ path: '/tmp/duocli-workspace-ui-mobile-chat.png' });
  const chatSync = await page.evaluate(async () => {
    stopNativeChatPolling();
    const originalApi = api;
    const id = currentSessionId;
    const previous = chatSnapshots.get(id);
    const scroller = document.getElementById('chat-transcript');
    const badge = document.getElementById('chat-new-messages');
    try {
      const messages = Array.from({ length: 25 }, (_, index) => ({ id: `sync-${index}`, role: 'assistant',
        blocks: [{ type: 'text', text: `第 ${index + 1} 条回复\n这里是对话内容，用来检查阅读位置。` }] }));
      chatSnapshots.set(id, { supported: true, ready: true, revision: 'before', messages });
      renderCurrentChat(id);
      scroller.scrollTop = 120;
      badge.hidden = true;
      const before = scroller.scrollTop;
      const updated = messages.map((message, index) => index === 24
        ? { ...message, blocks: [{ type: 'text', text: '同一条回复补充了新的内容。' }] } : message);
      api = async () => ({ supported: true, ready: true, revision: 'after', waitSupported: true, messages: updated });
      await refreshNativeChat(id, chatPollGeneration);
      const sameCountNotified = !badge.hidden && Math.abs(scroller.scrollTop - before) < 2;
      await refreshNativeChat(id, chatPollGeneration);
      const reminderPersists = !badge.hidden;
      badge.click();
      const jumped = badge.hidden && isChatPinnedToBottom();

      const calls = [];
      api = (url, options) => {
        calls.push({ url, signal: options.signal });
        if (calls.length === 1) return Promise.resolve({ unchanged: true, revision: 'after', waitSupported: true });
        return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => {
          reject(new DOMException('cancelled', 'AbortError'));
        }, { once: true }));
      };
      startNativeChatPolling(id);
      for (let i = 0; i < 50 && calls.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
      const continuous = calls.length === 2 && !calls[0].url.includes('wait=') && calls[1].url.includes('wait=10000');
      stopNativeChatPolling();
      await new Promise(resolve => setTimeout(resolve, 10));
      const aborted = calls[1]?.signal.aborted && chatPollFailures === 0;
      api = async () => ({ unchanged: true, revision: 'old-server' });
      const legacy = await refreshNativeChat(id, chatPollGeneration, true);
      return { sameCountNotified, reminderPersists, jumped, continuous, aborted, legacyDelay: legacy.nextPollDelay };
    } finally {
      stopNativeChatPolling();
      api = originalApi;
      chatSnapshots.set(id, previous);
      renderCurrentChat(id);
      scroller.scrollTop = scroller.scrollHeight;
      startNativeChatPolling(id);
    }
  });
  check('同条消息更新提示持续保留，阅读位置不跳动且可直达最新',
    chatSync.sameCountNotified && chatSync.reminderPersists && chatSync.jumped, JSON.stringify(chatSync));
  check('连续等待更新、取消不误报失败、旧服务端保持轮询间隔',
    chatSync.continuous && chatSync.aborted && chatSync.legacyDelay === 1000, JSON.stringify(chatSync));
  await clickDetailMenuItem('#session-terminal-tab');
  await page.waitForFunction(() => sessionViewMode === 'terminal' && terminalInputReady);
  check('菜单终端入口同步选中状态', await page.$eval('#session-terminal-tab', button => button.getAttribute('aria-pressed') === 'true'));
  await page.screenshot({ path: '/tmp/duocli-workspace-ui-mobile-terminal.png' });
  await clickDetailMenuItem('#terminal-return-chat');
  await page.waitForFunction(() => sessionViewMode === 'chat');
  await page.setViewport({ width: 320, height: 568, isMobile: true, hasTouch: true });
  check('小屏对话导航和发送按钮可见且不溢出', await page.evaluate(() => {
    const send = document.getElementById('send-btn').getBoundingClientRect();
    return document.body.scrollWidth <= innerWidth && send.right <= innerWidth && send.bottom <= innerHeight
      && document.getElementById('detail-more-btn').checkVisibility() && !document.getElementById('session-view-tabs');
  }));
  await page.screenshot({ path: '/tmp/duocli-workspace-ui-mobile-small.png' });
  await page.setViewport({ width: 390, height: 760, isMobile: true, hasTouch: true });

  await clickDetailMenuItem('#detail-menu-files-btn');
  await page.waitForSelector('#media-browse-page.active');
  await page.click('#media-browse-back-btn');
  check('项目文件入口返回后保留对话视图', await page.evaluate(() =>
    document.getElementById('detail-page').classList.contains('active') && sessionViewMode === 'chat'));

  const cachedOpen = await page.evaluate(async () => {
    const originalApi = api;
    let releaseSessions, releaseChat;
    api = (path, options) => {
      if (path === '/api/sessions') return new Promise(resolve => { releaseSessions = () => resolve(activeSessionsCache); });
      if (path.includes('/chat')) return new Promise(resolve => { releaseChat = () => resolve(chatSnapshots.get('s-codex-chat')); });
      return originalApi(path, options);
    };
    try {
      const opening = openSession('s-codex-chat');
      const result = await Promise.race([
        opening.then(() => ({ completed: true, visible: document.getElementById('chat-transcript').textContent.includes('ship it') })),
        new Promise(resolve => setTimeout(() => resolve({ completed: false, visible: false }), 1200)),
      ]);
      releaseSessions();
      releaseChat?.();
      await opening;
      return result;
    } finally { api = originalApi; }
  });
  check('缓存会话和对话在列表与聊天请求未返回时仍可显示',
    cachedOpen.completed && cachedOpen.visible, JSON.stringify(cachedOpen));

  const switchingState = await page.evaluate(async () => {
    const originalApi = api;
    let releaseSessions;
    sessionStorage.removeItem(sessionChatPrefKey('s-codex-chat'));
    chatSnapshots.delete('s-codex-chat'); // Cold chat cache still freezes the old view during the lookup.
    api = (path, options) => path === '/api/sessions'
      ? new Promise(resolve => { releaseSessions = () => resolve(activeSessionsCache); })
      : originalApi(path, options);
    try {
      const opening = openSession('s-codex-chat');
      const state = {
        mode: sessionViewMode,
        chatHidden: document.getElementById('chat-container')?.hidden,
        sendDisabled: document.getElementById('send-btn')?.disabled,
        loadingVisible: !document.getElementById('terminal-loading')?.classList.contains('hidden'),
      };
      releaseSessions();
      await opening;
      return state;
    } finally { api = originalApi; }
  });
  check('会话切换期间旧对话隐藏且发送入口冻结',
    switchingState.mode === 'terminal' && switchingState.chatHidden
      && switchingState.sendDisabled,
    JSON.stringify(switchingState));

  const chatFirstPaint = await page.evaluate(async () => {
    const id = currentSessionId;
    chatSnapshots.set(id, { supported: true, ready: true, messages: Array.from({ length: 120 }, (_, index) => ({
      id: `first-paint-${index}`, role: 'assistant', blocks: [{ type: 'text', text: `first paint ${index}` }],
    })) });
    await openNativeChatView(id);
    const scroller = document.getElementById('chat-transcript');
    return { top: scroller.scrollTop, bottom: scroller.scrollHeight - scroller.clientHeight };
  });
  check('打开已有长对话直接定位最新消息',
    chatFirstPaint.bottom > 0 && Math.abs(chatFirstPaint.top - chatFirstPaint.bottom) < 2,
    JSON.stringify(chatFirstPaint));

  const chatDom = await page.evaluate(() => {
    stopNativeChatPolling();
    const root = document.getElementById('chat-transcript');
    const snapshot = { supported: true, messages: [
      { id: 'tool', role: 'assistant', blocks: [{ type: 'tool-call', input: { command: 'pwd' } }] },
      { id: 'answer', role: 'assistant', blocks: [{ type: 'text', text: 'old' }] },
    ] };
    DuoNativeChatView.render(root, snapshot);
    const tool = root.firstElementChild;
    tool.querySelector('details').open = true;
    snapshot.messages[1].blocks[0].text = 'new';
    DuoNativeChatView.render(root, snapshot);
    const result = { sameNode: root.firstElementChild === tool, open: tool.querySelector('details').open, text: root.textContent };
    snapshot.messages.push({ id: 'answer', role: 'assistant', blocks: [{ type: 'text', text: 'second record' }] });
    DuoNativeChatView.render(root, snapshot);
    snapshot.messages[1].blocks[0].text = 'updated';
    DuoNativeChatView.render(root, snapshot);
    result.repeatedIdPreserved = root.children.length === 3 && root.textContent.includes('updated') && root.textContent.includes('second record');
    return result;
  });
  check('对话等长更新且保留未变消息、工具展开和同 ID 记录', chatDom.sameNode && chatDom.open && chatDom.text.includes('new') && chatDom.repeatedIdPreserved, JSON.stringify(chatDom));

  const longChat = await page.evaluate(() => {
    const root = document.getElementById('chat-transcript');
    const snapshot = { supported: true, messages: Array.from({ length: 350 }, (_, i) => ({
      id: `long-${i}`, role: 'assistant', blocks: [{ type: 'text', text: `message ${i}` }],
    })) };
    DuoNativeChatView.render(root, snapshot);
    const before = root.querySelectorAll('.native-chat-msg').length;
    root.querySelector('.native-chat-load-older').click();
    return { before, after: root.querySelectorAll('.native-chat-msg').length };
  });
  check('长对话限制初始 DOM 并可加载更早消息', longChat.before === 300 && longChat.after === 350, JSON.stringify(longChat));

  const pagedChat = await page.evaluate(async () => {
    const sessionId = currentSessionId;
    const root = document.getElementById('chat-transcript');
    const originalApi = api;
    try {
      chatSnapshots.set(sessionId, {
        supported: true, ready: true, paged: true, hasMore: true, startIndex: 2, totalMessages: 4,
        messages: [
          { id: 'page-2', role: 'assistant', blocks: [{ type: 'text', text: 'newer 2' }] },
          { id: 'page-3', role: 'assistant', blocks: [{ type: 'text', text: 'newer 3' }] },
        ],
      });
      renderCurrentChat(sessionId);
      api = async path => {
        if (!path.includes('before=2')) throw new Error(`unexpected path: ${path}`);
        return {
          supported: true, ready: true, paged: true, hasMore: false, startIndex: 0, totalMessages: 4,
          messages: [
            { id: 'page-0', role: 'assistant', blocks: [{ type: 'text', text: 'older 0' }] },
            { id: 'page-1', role: 'assistant', blocks: [{ type: 'text', text: 'older 1' }] },
          ],
        };
      };
      root.querySelector('.native-chat-load-older').click();
      for (let i = 0; i < 20 && root.querySelectorAll('.native-chat-msg').length !== 4; i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return { count: root.querySelectorAll('.native-chat-msg').length, text: root.textContent };
    } finally {
      api = originalApi;
    }
  });
  check('长对话从服务端加载更早分页并合并', pagedChat.count === 4 && pagedChat.text.indexOf('older 0') < pagedChat.text.indexOf('newer 2'), JSON.stringify(pagedChat));
  const pagedPollRace = await page.evaluate(async () => {
    const id = currentSessionId;
    const originalApi = api;
    let deliverOlder;
    chatSnapshots.set(id, {
      supported: true, ready: true, paged: true, hasMore: true, startIndex: 2,
      messages: [2, 3].map(index => ({ id: `race-${index}`, role: 'assistant',
        blocks: [{ type: 'text', text: `race ${index}` }] })),
    });
    api = () => new Promise(resolve => { deliverOlder = resolve; });
    try {
      const loading = loadOlderChatMessages(id);
      const latest = chatSnapshots.get(id);
      chatSnapshots.set(id, { ...latest, messages: [...latest.messages,
        { id: 'race-4', role: 'assistant', blocks: [{ type: 'text', text: 'race 4' }] }] });
      deliverOlder({ supported: true, ready: true, paged: true, hasMore: false, startIndex: 0,
        messages: [0, 1].map(index => ({ id: `race-${index}`, role: 'assistant',
          blocks: [{ type: 'text', text: `race ${index}` }] })) });
      await loading;
      return chatSnapshots.get(id).messages.map(message => message.id);
    } finally { api = originalApi; }
  });
  check('加载更早分页时轮询到的新消息仍保留',
    JSON.stringify(pagedPollRace) === JSON.stringify(['race-0', 'race-1', 'race-2', 'race-3', 'race-4']),
    JSON.stringify(pagedPollRace));
  const chatWindowGap = await page.evaluate(async () => {
    const id = currentSessionId;
    const originalApi = api;
    const before = chatSnapshots.get(id);
    chatSnapshots.set(id, { supported: true, paged: true, hasMore: true, startIndex: 0,
      messages: [0, 1].map(index => ({ id: `old-${index}`, role: 'assistant',
        blocks: [{ type: 'text', text: `old ${index}` }] })) });
    api = async () => ({ supported: true, paged: true, hasMore: true, startIndex: 5,
      messages: [5, 6].map(index => ({ id: `new-${index}`, role: 'assistant',
        blocks: [{ type: 'text', text: `new ${index}` }] })) });
    try {
      await refreshNativeChat(id, chatPollGeneration);
      const current = chatSnapshots.get(id);
      return { startIndex: current.startIndex, ids: current.messages.map(message => message.id) };
    } finally {
      api = originalApi;
      chatSnapshots.set(id, before);
    }
  });
  check('轮询跨过缓存窗口时不伪造连续历史',
    chatWindowGap.startIndex === 5 && JSON.stringify(chatWindowGap.ids) === JSON.stringify(['new-5', 'new-6']),
    JSON.stringify(chatWindowGap));
  const pollOlderRace = await page.evaluate(async () => {
    const id = currentSessionId;
    const originalApi = api;
    const before = chatSnapshots.get(id);
    let deliverPoll;
    chatSnapshots.set(id, { supported: true, paged: true, hasMore: true, startIndex: 2,
      messages: [2, 3].map(index => ({ id: `page-${index}`, role: 'assistant',
        blocks: [{ type: 'text', text: `page ${index}` }] })) });
    api = () => new Promise(resolve => { deliverPoll = resolve; });
    try {
      const polling = refreshNativeChat(id, chatPollGeneration);
      const current = chatSnapshots.get(id);
      chatSnapshots.set(id, { ...current, startIndex: 0, hasMore: false,
        messages: [0, 1, 2, 3].map(index => ({ id: `page-${index}`, role: 'assistant',
          blocks: [{ type: 'text', text: `page ${index}` }] })) });
      deliverPoll({ supported: true, paged: true, hasMore: true, startIndex: 2,
        messages: [2, 3, 4].map(index => ({ id: `page-${index}`, role: 'assistant',
          blocks: [{ type: 'text', text: `page ${index}` }] })) });
      await polling;
      const result = chatSnapshots.get(id);
      return { startIndex: result.startIndex, ids: result.messages.map(message => message.id) };
    } finally {
      api = originalApi;
      chatSnapshots.set(id, before);
    }
  });
  check('分页完成时迟到的轮询仍保留已加载历史',
    pollOlderRace.startIndex === 0 && JSON.stringify(pollOlderRace.ids) === JSON.stringify([
      'page-0', 'page-1', 'page-2', 'page-3', 'page-4',
    ]), JSON.stringify(pollOlderRace));
  await page.evaluate(() => renderCurrentChat(currentSessionId));

  mockChatInputDelay = 400;
  await page.evaluate(() => {
    const input = document.getElementById('msg-input');
    input.value = '第一行\n第二行\n第三行\n第四行';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const composerHeight = await page.$eval('#msg-input', el => el.getBoundingClientRect().height);
  check('多行输入框自动增高', composerHeight > 60, String(composerHeight));
  await page.click('#send-btn');
  const pendingChat = await page.evaluate(() => ({
    text: document.getElementById('chat-transcript').textContent,
    disabled: document.getElementById('send-btn').disabled,
    deliveryState: document.querySelector('.native-chat-delivery')?.className || '',
    syncState: document.getElementById('chat-status').dataset.state,
  }));
  check('点击发送后立即显示带状态的本地气泡', pendingChat.disabled && pendingChat.text.includes('第二行')
    && pendingChat.text.includes('发送中') && pendingChat.deliveryState.includes('state-sending')
    && pendingChat.syncState === 'loading', JSON.stringify(pendingChat));
  await page.waitForFunction(() => !document.getElementById('send-btn').disabled);
  mockChatById['s-codex-chat'].messages.push({ id: 'sent', role: 'user', blocks: [{ type: 'text', text: '第一行\n第二行\n第三行\n第四行' }] });
  await page.evaluate(() => refreshNativeChat(currentSessionId, chatPollGeneration));
  const reconciled = await page.$eval('#chat-transcript', el => ({ count: el.textContent.split('第二行').length - 1, pending: !!el.querySelector('.native-chat-delivery') }));
  check('服务端记录到达后本地消息不重复', reconciled.count === 1 && !reconciled.pending, JSON.stringify(reconciled));

  const refreshRace = await page.evaluate(async () => {
    const originalApi = api;
    const replies = [];
    try {
      api = () => new Promise(resolve => replies.push(resolve));
      const older = refreshNativeChat(currentSessionId, chatPollGeneration);
      const newer = refreshNativeChat(currentSessionId, chatPollGeneration);
      const snapshot = text => ({ supported: true, ready: true, messages: [{ id: 'race', role: 'assistant', blocks: [{ type: 'text', text }] }] });
      replies[1](snapshot('最新回复'));
      await newer;
      replies[0](snapshot('过期回复'));
      await older;
      const text = document.getElementById('chat-transcript').textContent;
      api = async () => { throw new Error('fixture timeout'); };
      await refreshNativeChat(currentSessionId, chatPollGeneration);
      return { text, preserved: document.getElementById('chat-transcript').textContent === text, status: document.getElementById('chat-status').textContent };
    } finally { api = originalApi; }
  });
  check('迟到响应不覆盖新消息，更新失败保留正文并显示重试状态', refreshRace.text.includes('最新回复') && !refreshRace.text.includes('过期回复') && refreshRace.preserved && refreshRace.status.includes('重试'), JSON.stringify(refreshRace));
  await page.evaluate(() => refreshNativeChat(currentSessionId, chatPollGeneration));

  mockChatInputFailure = true;
  await page.evaluate(() => { document.getElementById('msg-input').value = '失败后保留'; void sendMessage(); });
  await page.waitForFunction(() => !document.getElementById('send-btn').disabled);
  const failedChat = await page.evaluate(() => ({
    draft: document.getElementById('msg-input').value,
    text: document.getElementById('chat-transcript').textContent,
    deliveryState: document.querySelector('.native-chat-delivery:last-child')?.className || '',
    syncState: document.getElementById('chat-status').dataset.state,
  }));
  check('对话发送失败保留草稿和未确认气泡', failedChat.draft === '失败后保留'
    && failedChat.text.includes('发送状态未确认') && failedChat.deliveryState.includes('state-error')
    && failedChat.syncState === 'error', JSON.stringify(failedChat));
  mockChatInputDelay = 0;
  mockChatInputFailure = false;
  await page.screenshot({ path: '/tmp/duocli-chat-input-20260920.png' });

  const codeVisual = await page.evaluate(() => {
    const root = document.getElementById('chat-transcript');
    DuoNativeChatView.render(root, { supported: true, messages: [{
      id: 'visual-code', role: 'assistant', blocks: [
        { type: 'text', text: '正在检查这段代码：\n```ts\nconst answer: number = 42;\n// keep the state visible\nreturn answer;\n```' },
        { type: 'tool-call', name: '检查类型', state: 'running', input: { command: 'npm run build:ts' } },
      ],
    }] });
    setChatStatus('正在更新对话，等待新内容…', 'updating');
    return {
      language: root.querySelector('.native-chat-code-head span')?.textContent,
      keywords: root.querySelectorAll('.tok-keyword').length,
      toolState: root.querySelector('.native-chat-tool-state')?.textContent,
      syncState: document.getElementById('chat-status').dataset.state,
    };
  });
  check('代码染色、工具进行中和更新状态均有独立视觉标识', codeVisual.language === 'TypeScript'
    && codeVisual.keywords >= 2 && codeVisual.toolState === '进行中' && codeVisual.syncState === 'updating', JSON.stringify(codeVisual));
  await page.screenshot({ path: '/tmp/duocli-chat-code-status-20260920.png' });
  await page.evaluate(() => renderCurrentChat(currentSessionId));

  const toolGroup = await page.evaluate(() => {
    const root = document.getElementById('chat-transcript');
    DuoNativeChatView.render(root, { supported: true, messages: [
      { id: 'gu', role: 'user', blocks: [{ type: 'text', text: '跑一下构建' }] },
      { id: 'gc1', role: 'assistant', blocks: [{ type: 'tool-call', name: 'shell', input: { command: 'npm test' }, callId: 'gk1' }] },
      { id: 'gr1', role: 'tool', blocks: [{ type: 'tool-result', callId: 'gk1', output: 'ok' }] },
      { id: 'gc2', role: 'assistant', blocks: [{ type: 'tool-call', name: 'read', input: { path: 'a.ts' }, callId: 'gk2' }] },
      { id: 'ga', role: 'assistant', blocks: [{ type: 'text', text: '完成' }] },
    ] });
    const group = root.querySelector('.native-chat-tool-group');
    return {
      groups: root.querySelectorAll('.native-chat-tool-group').length,
      summary: group?.querySelector('summary')?.textContent || '',
      items: group?.querySelectorAll('.native-chat-tool').length || 0,
      articles: root.querySelectorAll('.native-chat-msg').length,
    };
  });
  check('连续工具过程合并为「执行任务」组并配对调用输出', toolGroup.groups === 1
    && toolGroup.summary.includes('执行任务') && toolGroup.summary.includes('2 个')
    && toolGroup.summary.includes('进行中')
    && toolGroup.items === 2 && toolGroup.articles === 3, JSON.stringify(toolGroup));
  await page.evaluate(() => renderCurrentChat(currentSessionId));

  await page.evaluate(() => {
    const input = document.getElementById('msg-input');
    globalThis.__modelPrefBefore = sessionStorage.getItem(sessionChatPrefKey(currentSessionId));
    input.value = '/model';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    void sendMessage();
  });
  await page.waitForFunction(() => sessionViewMode === 'terminal' && term, { timeout: 8000 });
  const modelInteraction = await page.evaluate(() => ({
    mode: sessionViewMode,
    toast: document.getElementById('copy-toast')?.textContent || '',
    pref: sessionStorage.getItem(sessionChatPrefKey(currentSessionId)),
    prefBefore: globalThis.__modelPrefBefore,
  }));
  check('/model 送达后打开同会话终端选择且不改默认模式', modelInteraction.mode === 'terminal'
    && modelInteraction.toast.includes('↑ ↓') && modelInteraction.pref === modelInteraction.prefBefore, JSON.stringify(modelInteraction));
  check('模型命令不会留下等待对话记录的聊天气泡', await page.evaluate(() =>
    !(chatLocalMessages.get(currentSessionId) || []).some(item => item.text === '/model')));
  await page.waitForFunction(() => isTerminalInputReady());
  receivedInputs.length = 0;
  await page.click('.key-btn[data-key="\\\\x1b[B"]');
  await page.click('.key-btn[data-key="\\\\r"]');
  await sleep(100);
  check('模型菜单方向键和确认各发一次', receivedInputs.join('') === '\x1b[B\r', JSON.stringify(receivedInputs));
  await page.screenshot({ path: '/tmp/duocli-chat-command-terminal-20260928.png' });
  await clickDetailMenuItem('#terminal-return-chat');
  await page.waitForFunction(() => sessionViewMode === 'chat');
  check('终端选择后可以直接返回同一对话', await page.evaluate(() => currentSessionId === 's-codex-chat'));
  await page.evaluate(async () => {
    document.getElementById('msg-input').value = '/permissions';
    await sendMessage();
  });
  await page.waitForFunction(() => sessionViewMode === 'terminal' && isTerminalInputReady());
  check('其他交互命令也打开终端且不留下假消息', await page.evaluate(() =>
    !(chatLocalMessages.get(currentSessionId) || []).some(item => item.text === '/permissions')));
  await clickDetailMenuItem('#terminal-return-chat');
  await page.waitForFunction(() => sessionViewMode === 'chat');
  // 白名单外的斜杠命令（自定义技能等）同样临时切终端，不留假气泡，偏好仍是对话。
  await page.evaluate(async () => {
    document.getElementById('msg-input').value = '/my-custom-skill';
    await sendMessage();
  });
  await page.waitForFunction(() => sessionViewMode === 'terminal' && isTerminalInputReady());
  check('未知斜杠命令也临时切终端且不留下假气泡', await page.evaluate(() =>
    sessionViewMode === 'terminal'
    && !(chatLocalMessages.get(currentSessionId) || []).some(item => item.text === '/my-custom-skill')
    && sessionStorage.getItem(sessionChatPrefKey(currentSessionId)) === 'chat'));
  await clickDetailMenuItem('#terminal-return-chat');
  await page.waitForFunction(() => sessionViewMode === 'chat');

  const lateAck = await page.evaluate(async () => {
    const original = requestSubmission;
    const input = document.getElementById('msg-input');
    let finish;
    try {
      requestSubmission = () => new Promise(resolve => { finish = resolve; });
      input.value = 'confirm after switching views';
      const sending = sendMessage();
      await openRawTerminalView(currentSessionId, terminalOpenRequest);
      await openNativeChatView(currentSessionId);
      finish();
      await sending;
      return { disabled: document.getElementById('send-btn').disabled, locked: composerSubmissions.has(currentSessionId) };
    } finally { requestSubmission = original; }
  });
  check('发送期间切换视图，确认后发送按钮恢复', !lateAck.disabled && !lateAck.locked, JSON.stringify(lateAck));

  await page.evaluate(() => openSession('s-codex-empty'));
  await page.waitForFunction(() => currentSessionId === 's-codex-empty' && term && term.cols > 0, { timeout: 8000 });
  const emptyResumeView = await page.evaluate(() => ({
    mode: sessionViewMode,
    chatHidden: document.getElementById('chat-container')?.hidden !== false,
    termHidden: document.getElementById('terminal-container')?.hidden === true,
  }));
  check('Codex 已有 resumeId 但还没有对话时仍打开终端',
    emptyResumeView.mode === 'terminal' && emptyResumeView.chatHidden && !emptyResumeView.termHidden,
    JSON.stringify(emptyResumeView));

  mockSessions = mockSessions.filter(s => s.id === 's1' || s.id === 's2' || s.id === 's3');
  mockChatById = {};
  await page.evaluate(() => openSession('s1'));
  await page.waitForFunction(() => currentSessionId === 's1' && term && term.cols > 0, { timeout: 8000 });
  await sleep(300);

  if (process.env.DUOCLI_INPUT_AUDIT === '1') {
    const audit = await runInputChatAudit(page);
    const byId = Object.fromEntries(audit.map(item => [item.id, item]));
    check('切换会话时旧连接不可发送', !byId['INPUT-01'].readyDuringSwitch && byId['INPUT-01'].writes.length === 0, JSON.stringify(byId['INPUT-01']));
    check('组合输入结束不会发送新会话草稿', byId['INPUT-02'].writes.length === 0, JSON.stringify(byId['INPUT-02']));
    check('旧会话确认不抢新会话输入焦点', byId['INPUT-03'].focusedBeforeAck && byId['INPUT-03'].focusedAfterAck, JSON.stringify(byId['INPUT-03']));
    check('未确认提交可恢复到输入框', byId['INPUT-04'].restoredInput === byId['INPUT-04'].pendingText, JSON.stringify(byId['INPUT-04']));
    check('迟到的终端创建不会覆盖对话模式', byId['CHAT-01'].connections.length === 0, JSON.stringify(byId['CHAT-01']));
  }

  const jumpStay = await page.evaluate(async () => {
    enterTerminalHistory();
    writeTerminalOutput(`\r\nlate-output ${'w'.repeat(20)}\r\n`, !isUserScrolling);
    await terminalWriteQueue;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      historyVisible: Boolean(terminalHistoryLayer?.isVisible()),
      isUserScrolling,
      viewportY: term.buffer.active.viewportY,
      baseY: term.buffer.active.baseY,
    };
  });
  check('回看历史时新输出不会把画面拽回最新',
    jumpStay.historyVisible === true
      && jumpStay.isUserScrolling === true
      && jumpStay.viewportY === jumpStay.baseY,
    JSON.stringify(jumpStay));

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
    // 模拟脏配置：若跟尾走错 API，会沿 scrollback 播很久。
    term.options.smoothScrollDuration = 1200;
    restoreTerminalSnapshot({ data: `\r\n${history}` });
    await terminalWriteQueue;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return {
      viewportY: term.buffer.active.viewportY,
      baseY: term.buffer.active.baseY,
      smoothScrollDuration: term.options.smoothScrollDuration,
      revealPending: document.getElementById('terminal-container')?.classList.contains('terminal-reveal-pending') || false,
      loadingHidden: document.getElementById('terminal-loading')?.classList.contains('hidden') || false,
    };
  });
  check('切换会话回放后立刻停在最新输出',
    snapshotScroll.viewportY === snapshotScroll.baseY
      && snapshotScroll.smoothScrollDuration === 0
      && snapshotScroll.revealPending === false
      && snapshotScroll.loadingHidden === true,
    JSON.stringify(snapshotScroll));

  const revealGate = await page.evaluate(async () => {
    const history = Array.from({ length: 400 }, (_, i) => `gate-${i} ${'w'.repeat(28)}\r\n`).join('');
    let sawPendingWhileWriting = false;
    let sendDisabledWhileWriting = false;
    const originalWrite = term.write.bind(term);
    term.write = (data, cb) => originalWrite(data, () => {
      sawPendingWhileWriting = document.getElementById('terminal-container')?.classList.contains('terminal-reveal-pending') || false;
      sendDisabledWhileWriting = document.getElementById('send-btn')?.disabled || false;
      if (typeof cb === 'function') cb();
    });
    restoreTerminalSnapshot({ data: `\r\n${history}` });
    await terminalWriteQueue;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    term.write = originalWrite;
    return {
      sawPendingWhileWriting,
      sendDisabledWhileWriting,
      sendReadyAfterReveal: !document.getElementById('send-btn')?.disabled,
      viewportY: term.buffer.active.viewportY,
      baseY: term.buffer.active.baseY,
      revealPending: document.getElementById('terminal-container')?.classList.contains('terminal-reveal-pending') || false,
    };
  });
  check('长回放写盘期间保持遮罩，完成后再露出最新行',
    revealGate.sawPendingWhileWriting === true
      && revealGate.sendDisabledWhileWriting === true
      && revealGate.sendReadyAfterReveal === true
      && revealGate.viewportY === revealGate.baseY
      && revealGate.revealPending === false,
    JSON.stringify(revealGate));

  const geometryRestore = await page.evaluate(async () => {
    const sourceCols = Math.max(term.cols + 48, 120);
    const sourceRows = Math.max(term.rows + 24, 48);
    const lines = Array.from({ length: sourceRows }, (_, i) => {
      const tag = i === sourceRows - 1 ? 'LATEST-LINE' : `old-${String(i).padStart(3, '0')}`;
      return `${tag} ${'x'.repeat(Math.max(8, sourceCols - tag.length - 2))}\r\n`;
    }).join('');
    isUserScrolling = false;
    restoreTerminalSnapshot({ data: `\r\n${lines}`, cols: sourceCols, rows: sourceRows });
    await terminalWriteQueue;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
    const buf = term.buffer.active;
    const visible = [];
    for (let y = buf.viewportY; y < buf.viewportY + term.rows; y++) {
      visible.push(buf.getLine(y)?.translateToString(true) || '');
    }
    return {
      viewportY: buf.viewportY,
      baseY: buf.baseY,
      cols: term.cols,
      rows: term.rows,
      sourceCols,
      sourceRows,
      seesLatest: visible.some(line => line.includes('LATEST-LINE')),
      seesOldest: visible.some(line => line.includes('old-000')),
      unreadHidden: document.getElementById('terminal-scroll-bottom-btn')?.hidden !== false,
    };
  });
  check('打开对话按桌面尺寸还原后再 fit，仍停在最新一行',
    geometryRestore.viewportY === geometryRestore.baseY
      && geometryRestore.seesLatest === true
      && geometryRestore.seesOldest === false
      && geometryRestore.unreadHidden === true,
    JSON.stringify(geometryRestore));

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
    await page.evaluate(() => document.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true })));
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
      copyButton: Boolean(document.getElementById('terminal-copy-selection-btn')),
      cells: getSelectionCells(), metrics: getTerminalCellMetrics(),
      viewport: term.buffer.active.viewportY, rows: term.rows,
      pendingHandleFrame: selectHandlesRaf,
    }));
    await page.touchscreen.touchEnd();
    await sleep(250);
    const clipAfterPress = await page.evaluate(() => navigator.clipboard.readText());
    // 复制入口由选区操作条承担（出现时机单独断言），长按本身只选词、不写剪贴板。
    check('长按只选中手指下的字', pressed.text === '工' && pressed.handles === 2,
      JSON.stringify(pressed));
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

    await page.evaluate(() => document.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true })));
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
    `copied=${JSON.stringify(tuiClip)} toast=”${afterCopy.toastShown}” cleared=${!afterCopy.selected}`);
  }

  // ===== 选区操作条：真机可点的复制入口，滚动出屏后仍贴边可达 =====
  await page.evaluate(async () => {
    writeTerminalOutput('selection-bar-target-line-0123456789\r\n');
    await terminalWriteQueue;
    jumpTerminalToLatest();
    // 刚写入的行在可视区底部（光标行上面一行），不是视口顶行。
    const buffer = term.buffer.active;
    term.select(0, buffer.baseY + term.rows - 2, 20);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const barShown = await page.evaluate(() => {
    const bar = document.getElementById('terminal-selection-bar');
    return {
      visible: Boolean(bar && !bar.hidden),
      copy: Boolean(bar?.querySelector('#terminal-copy-selection-btn')),
      screen: Boolean(bar?.querySelector('#terminal-copy-screen-btn')),
    };
  });
  check('选中文字后出现复制操作条', barShown.visible && barShown.copy && barShown.screen, JSON.stringify(barShown));
  const barScrolled = await page.evaluate(async () => {
    term.scrollLines(-30);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const bar = document.getElementById('terminal-selection-bar');
    const container = document.getElementById('terminal-container');
    return {
      visible: Boolean(bar && !bar.hidden),
      top: bar ? Number.parseFloat(bar.style.top) : NaN,
      containerHeight: container.clientHeight,
    };
  });
  check('向上滚动后复制操作条仍贴边可见', barScrolled.visible
    && Number.isFinite(barScrolled.top)
    && barScrolled.top > 0
    && barScrolled.top < barScrolled.containerHeight, JSON.stringify(barScrolled));
  await page.evaluate(() => document.querySelector('#terminal-copy-selection-btn').click());
  await sleep(400);
  const barCopy = await page.evaluate(async () => {
    const bar = document.getElementById('terminal-selection-bar');
    return {
      clip: await navigator.clipboard.readText(),
      cleared: !term.hasSelection(),
      hidden: !bar || bar.hidden,
    };
  });
  check('复制按钮把选区写入剪贴板并清除选区',
    barCopy.cleared && barCopy.hidden && barCopy.clip.includes('selection-bar-target'),
    JSON.stringify({ ...barCopy, clipLength: barCopy.clip.length }));
  await page.evaluate(async () => {
    writeTerminalOutput('selection-bar-screen-copy-check\r\n');
    await terminalWriteQueue;
    jumpTerminalToLatest();
    const buffer = term.buffer.active;
    term.select(0, buffer.baseY + term.rows - 2, 10);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    document.querySelector('#terminal-copy-screen-btn').click();
  });
  await sleep(400);
  const screenCopy = await page.evaluate(async () => ({
    clip: await navigator.clipboard.readText(),
    toast: document.getElementById('copy-toast')?.textContent || '',
    visibleRows: (() => {
      const buf = term.buffer.active;
      const rows = [];
      for (let y = buf.viewportY; y < buf.viewportY + term.rows; y++) {
        rows.push(buf.getLine(y)?.translateToString(true) ?? '');
      }
      return rows.filter(Boolean).length;
    })(),
  }));
  check('复制当前屏保留整屏行文本', screenCopy.clip.includes('screen-copy-check') && screenCopy.clip.includes('\n'),
    JSON.stringify({ lines: screenCopy.clip.split('\n').length, head: screenCopy.clip.slice(0, 40), toast: screenCopy.toast, visibleRows: screenCopy.visibleRows }));

  // ===== Test 4b: 已加载输出都在实时终端里滚动，到顶也不切历史层 =====
  const burst = await page.evaluate(async () => {
    term.clearSelection();
    jumpTerminalToLatest();
    const original = term.write.bind(term);
    let writes = 0;
    term.write = (...args) => { writes++; return original(...args); };
    const started = performance.now();
    for (let i = 0; i < 200; i++) writeTerminalOutput(`burst ${i}\r\n`);
    await terminalWriteQueue;
    term.write = original;
    return { writes, elapsedMs: Math.round(performance.now() - started),
      tail: Array.from({ length: term.buffer.active.length }, (_, i) =>
        term.buffer.active.getLine(i)?.translateToString(true)).join('\n') };
  });
  check('连续输出合并解析，完整保留头尾内容', burst.writes === 1
    && burst.tail.includes('burst 0\n') && burst.tail.includes('burst 199'),
    JSON.stringify({ writes: burst.writes, elapsedMs: burst.elapsedMs }));
  const selectedOutput = await page.evaluate(async () => {
    jumpTerminalToLatest();
    term.select(0, term.buffer.active.viewportY + 2, 7);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const before = term.buffer.active.viewportY;
    const selection = term.getSelection();
    writeTerminalOutput('new output while copying\r\n'.repeat(8));
    await terminalWriteQueue;
    const result = { before, after: term.buffer.active.viewportY, selection, afterSelection: term.getSelection() };
    term.clearSelection();
    jumpTerminalToLatest();
    return result;
  });
  check('在最新位置选中文字后，新输出不会抢走阅读位置',
    selectedOutput.before === selectedOutput.after && selectedOutput.selection.length > 0
      && selectedOutput.selection === selectedOutput.afterSelection, JSON.stringify(selectedOutput));
  pushOutput('\r\n' + Array.from({ length: 80 }, (_, i) => `scrollback-line-${i}`).join('\r\n') + '\r\n');
  await sleep(400);
  const pan = await page.evaluate(() => {
    term.clearSelection();
    jumpTerminalToLatest();
    const grid = document.getElementById('terminal-container').querySelector('.xterm-rows').getBoundingClientRect();
    return {
      x: grid.left + grid.width / 2,
      y: grid.top + grid.height * 0.4,
      liveScrollback: term.options.scrollback,
      viewportY: term.buffer.active.viewportY,
      baseY: term.buffer.active.baseY,
    };
  });
  check('实时区保留服务端同样的滚动缓存', pan.liveScrollback === LIVE_TERMINAL_SCROLLBACK, JSON.stringify(pan));
  const terminalTouch = await page.evaluate(() => ({
    container: getComputedStyle(document.getElementById('terminal-container')).touchAction,
    copyBarHidden: (() => {
      const bar = document.getElementById('terminal-selection-bar');
      return !bar || bar.hidden;
    })(),
  }));
  check('手机终端允许纵向滚动且无选区时不显示复制条', terminalTouch.container === 'pan-y' && terminalTouch.copyBarHidden,
    JSON.stringify(terminalTouch));
  // A quick phone flick can deliver just one coalesced touchmove before release.
  await page.touchscreen.touchStart(pan.x, pan.y);
  await page.touchscreen.touchMove(pan.x, pan.y + 120);
  await page.touchscreen.touchEnd();
  const flickViewport = await page.evaluate(() => term.buffer.active.viewportY);
  check('单次 touchmove 的快速滑动也能回看终端', flickViewport < pan.viewportY,
    JSON.stringify({ before: pan.viewportY, after: flickViewport }));
  await page.screenshot({ path: '/tmp/duocli-mobile-scroll-fixed.png' });
  await page.touchscreen.touchStart(pan.x, pan.y + 120);
  await page.touchscreen.touchMove(pan.x, pan.y);
  await page.touchscreen.touchEnd();
  const returnViewport = await page.evaluate(() => term.buffer.active.viewportY);
  check('反向快速滑动可回到最新输出', returnViewport === pan.viewportY,
    JSON.stringify({ expected: pan.viewportY, actual: returnViewport }));
  await page.evaluate(() => jumpTerminalToLatest());
  // 慢速拖动：每次移动间隔大于速度采样窗口，松手时没有可滑行的速度。
  await page.touchscreen.touchStart(pan.x, pan.y);
  for (let i = 1; i <= 6; i++) {
    await sleep(240);
    await page.touchscreen.touchMove(pan.x, pan.y + i * 30);
  }
  await page.touchscreen.touchEnd();
  await sleep(200);
  const panLocal = await page.evaluate(() => ({
    selected: term.hasSelection(),
    handles: [...document.querySelectorAll('.terminal-select-handle')].filter(el => !el.hidden).length,
    historyVisible: Boolean(terminalHistoryLayer?.isVisible()),
    viewportY: term.buffer.active.viewportY,
  }));
  check('未到顶时手指滚动实时区，不打开历史层',
    !panLocal.selected
      && panLocal.handles === 0
      && panLocal.historyVisible === false
      && panLocal.viewportY < pan.viewportY,
    JSON.stringify({ pan, panLocal }));

  // 惯性滑行：快速松手后继续滚，贴边（顶/底）即停，到底后恢复跟尾。
  const momentumBefore = panLocal.viewportY;
  if (momentumBefore > 0) {
    const upStarted = await page.evaluate(() => beginTerminalMomentum(-2));
    check('快速松手触发向上惯性滑行', upStarted === true, JSON.stringify({ upStarted }));
    await page.waitForFunction(() => !panMomentumRunner?.active(), { timeout: 3000 });
    const momentumUp = await page.evaluate(() => ({
      viewportY: term.buffer.active.viewportY,
      active: Boolean(panMomentumRunner?.active()),
      userScrolling: isUserScrolling,
    }));
    check('惯性把视口带离松手位置，停下后保持回看状态',
      momentumUp.viewportY < momentumBefore && !momentumUp.active && momentumUp.userScrolling,
      JSON.stringify({ momentumBefore, momentumUp }));
  }
  const downStarted = await page.evaluate(() => beginTerminalMomentum(3.5));
  check('反向惯性滑行启动', downStarted === true, JSON.stringify({ downStarted }));
  await page.waitForFunction(() => {
    const buffer = term.buffer.active;
    return buffer.viewportY === buffer.baseY && !panMomentumRunner?.active();
  }, { timeout: 5000 });
  const momentumDown = await page.evaluate(() => ({
    viewportY: term.buffer.active.viewportY,
    baseY: term.buffer.active.baseY,
    userScrolling: isUserScrolling,
    touchActive: terminalTouchActive,
    historyVisible: Boolean(terminalHistoryLayer?.isVisible()),
  }));
  check('惯性滑到最新输出后恢复跟尾', momentumDown.viewportY === momentumDown.baseY
    && !momentumDown.userScrolling && !momentumDown.touchActive && !momentumDown.historyVisible,
    JSON.stringify(momentumDown));

  await page.evaluate(async () => {
    await new Promise(resolve => term.write('\x1b[?1049h', resolve));
  });
  const altInputStart = receivedInputs.length;
  const altButtons = await page.evaluate(() => [...document.querySelectorAll('#terminal-alt-controls button')].map(button => button.textContent));
  check('全屏终端不显示翻页和复制按钮', altButtons.length === 0, JSON.stringify(altButtons));
  await page.touchscreen.touchStart(pan.x, pan.y);
  await page.touchscreen.touchMove(pan.x, pan.y + 120);
  await page.touchscreen.touchEnd();
  await sleep(100);
  const altFlickInput = receivedInputs.slice(altInputStart).join('');
  check('全屏 Codex 快速滑动发送上翻键', altFlickInput.includes('\x1b[5~'),
    JSON.stringify(altFlickInput));
  const altDownStart = receivedInputs.length;
  await page.touchscreen.touchStart(pan.x, pan.y + 120);
  await page.touchscreen.touchMove(pan.x, pan.y);
  await page.touchscreen.touchEnd();
  await sleep(100);
  const altDownInput = receivedInputs.slice(altDownStart).join('');
  check('全屏 Codex 反向快速滑动发送下翻键', altDownInput.includes('\x1b[6~'),
    JSON.stringify(altDownInput));
  await page.evaluate(async () => {
    await new Promise(resolve => term.write('\x1b[?1049l', resolve));
  });

  await page.evaluate(() => {
    if (terminalHistoryLayer?.isVisible()) terminalHistoryLayer.hide();
    term.scrollToLine(0);
    isUserScrolling = true;
    terminalFirstLatestPaint = true;
  });
  const historyRequestStart = receivedHistoryRequests.length;
  const topPan = await page.evaluate(() => {
    const grid = document.getElementById('terminal-container').querySelector('.xterm-rows').getBoundingClientRect();
    return { x: grid.left + grid.width / 2, y: grid.top + grid.height * 0.4 };
  });
  await page.touchscreen.touchStart(topPan.x, topPan.y);
  for (let i = 1; i <= 6; i++) {
    await page.touchscreen.touchMove(topPan.x, topPan.y + i * 30);
  }
  await page.touchscreen.touchEnd();
  await sleep(400);
  const panHistory = await page.evaluate(() => ({
    historyVisible: Boolean(terminalHistoryLayer?.isVisible()),
    viewportY: term.buffer.active.viewportY,
  }));
  check('滚到顶部后再上滑，仍留在已加载的终端里',
    panHistory.historyVisible === false && panHistory.viewportY === 0
      && receivedHistoryRequests.length === historyRequestStart,
    JSON.stringify({ panHistory, requests: receivedHistoryRequests.length, historyRequestStart }));

  const stayUp = await page.evaluate(async () => {
    terminalFirstLatestPaint = true;
    syncTerminalToViewport();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      historyVisible: Boolean(terminalHistoryLayer?.isVisible()),
      viewportY: term.buffer.active.viewportY,
    };
  });
  check('fit 不会把正在回看的终端拉走', stayUp.historyVisible === false && stayUp.viewportY === 0, JSON.stringify(stayUp));

  pushOutput('\r\n• Edited src/history.js (+1 -1)\r\n  + newest change\r\n');
  await sleep(350);
  const foldedOlder = await page.evaluate(() => {
    terminalFoldView.refresh();
    const initiallyFolded = terminalFoldView.isVisible();
    terminalFoldView.root.querySelector('.terminal-activity-toolbar button:first-of-type').click();
    const historyVisible = terminalHistoryLayer.isVisible();
    const atTop = term.buffer.active.viewportY === 0;
    document.querySelector('#terminal-scroll-bottom-btn')?.click?.();
    jumpTerminalToLatest();
    const restored = terminalFoldView.isVisible() && !terminalHistoryLayer.isVisible();
    terminalFoldView.root.querySelector('.terminal-activity-toolbar button:last-child')?.click();
    return { initiallyFolded, historyVisible, atTop, restored };
  });
  check('折叠记录的更早输出停在已加载内容顶部，回到最新后恢复折叠',
    foldedOlder.initiallyFolded && !foldedOlder.historyVisible && foldedOlder.atTop && foldedOlder.restored,
    JSON.stringify(foldedOlder));

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
  check('详情页更多入口展开完整菜单',
    !menuState.hidden && menuState.items === '终端,对话,项目文件,计划设置,手机设备,修改访问 Token,关闭对话' && menuState.expanded === 'true',
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
  const deviceOpen = await page.evaluate(() => {
    const sel = document.getElementById('device-select');
    return {
      active: document.getElementById('device-page').classList.contains('active'),
      options: [...(sel?.options || [])].map((option) => ({ value: option.value, text: option.textContent })),
      value: sel?.value || '',
    };
  });
  check('更多菜单可打开手机设备', deviceOpen.active, JSON.stringify(deviceOpen));
  check('设备下拉包含电脑入口',
    deviceOpen.options.some((option) => option.value === 'duocli-computer' && option.text.includes('电脑')),
    JSON.stringify(deviceOpen));
  const computerTap = await page.evaluate(() => {
    document.getElementById('device-select').value = 'duocli-computer';
    applySelectedDevice();
    const screen = document.getElementById('device-screen');
    screen.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'touch', clientX: 40, clientY: 80, buttons: 1 }));
    screen.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, pointerType: 'touch', clientX: 40, clientY: 80 }));
    return {
      controlId: androidControlDeviceId(),
      computerActive: document.body.classList.contains('computer-desktop-active'),
    };
  });
  check('选电脑后点击画面不会走 ADB',
    computerTap.controlId === '' && computerTap.computerActive,
    JSON.stringify(computerTap));
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
  if (await page.$eval('#shortcut-bar', bar => bar.hidden)) await page.click('#shortcut-mode-toggle');
  receivedInputs.length = 0;
  await page.click('#option-up-key');
  await sleep(200);
  check('Option + ↑ 只发送组合键序列',
    receivedInputs.length === 1 && receivedInputs[0] === '\x1b[1;3A',
    `received=${JSON.stringify(receivedInputs)}`);
  receivedInputs.length = 0;
  await page.click('#ctrl-slash-key');
  await sleep(200);
  check('Ctrl + / 只发送控制字符',
    receivedInputs.length === 1 && receivedInputs[0] === '\x1f',
    `received=${JSON.stringify(receivedInputs)}`);
  receivedInputs.length = 0;
  await page.click('#ctrl-o-key');
  await sleep(200);
  check('Ctrl + O 只发送控制字符',
    receivedInputs.length === 1 && receivedInputs[0] === '\x0f',
    `received=${JSON.stringify(receivedInputs)}`);
  const lastShortcutId = await page.evaluate(() => document.getElementById('shortcut-bar').lastElementChild?.id);
  check('Ctrl + O 位于快捷键栏最后', lastShortcutId === 'ctrl-o-key', `last=${lastShortcutId}`);

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
  const sentBanner = await page.evaluate(() => {
    const el = document.getElementById('user-prompt-banner');
    return { hidden: el?.hidden ?? true, text: el?.querySelector('.user-prompt-text')?.textContent || '' };
  });
  check('发送后不再新增最近在说横幅',
    sentBanner.hidden && !sentBanner.text,
    JSON.stringify(sentBanner));

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
  await page.click('#msg-input');
  await page.keyboard.type('desktop draft');
  const desktopComposer = await page.$eval('#msg-input', input => {
    const rect = input.getBoundingClientRect();
    return { focused: document.activeElement === input, value: input.value,
      hit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.id };
  });
  check('电脑网页输入框可点击输入', desktopComposer.focused && desktopComposer.value === 'desktop draft'
    && desktopComposer.hit === 'msg-input', JSON.stringify(desktopComposer));
  await page.$eval('#msg-input', input => { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); input.blur(); });
  const landscapeDrawer = await page.evaluate(() => ({
    workspace: document.body.classList.contains('landscape-workspace'),
    detail: document.getElementById('detail-page').classList.contains('active'),
    listPage: document.getElementById('main-page').classList.contains('active'),
    sessionsOpen: document.getElementById('main-page').classList.contains('landscape-drawer-open'),
    backButton: getComputedStyle(document.querySelector('#back-btn')).display,
    listCloseButton: getComputedStyle(document.querySelector('#main-drawer-close')).display,
    pickerButton: getComputedStyle(document.querySelector('#detail-session-picker-btn')).display,
    sessionsButton: getComputedStyle(document.querySelector('#detail-header .landscape-sessions-toggle')).display,
    deviceButton: getComputedStyle(document.querySelector('#detail-header .landscape-device-toggle')).display,
    devicePull: getComputedStyle(document.getElementById('landscape-device-pull')).display,
    netModeParent: document.getElementById('net-mode-btn')?.parentElement?.id || '',
    netModeHidden: !document.getElementById('net-mode-btn')
      || document.getElementById('net-mode-btn').style.display === 'none'
      || getComputedStyle(document.getElementById('net-mode-btn')).display === 'none',
    netModeAria: document.getElementById('net-mode-btn')?.getAttribute('aria-label') || '',
    netModeHasIcon: Boolean(document.getElementById('net-mode-btn')?.querySelector('svg')),
  }));
  check('电脑横屏默认左侧列表 + 中间 CLI，隐藏返回/收起箭头',
    landscapeDrawer.workspace
      && landscapeDrawer.detail
      && !landscapeDrawer.listPage
      && landscapeDrawer.sessionsOpen
      && landscapeDrawer.backButton === 'none'
      && landscapeDrawer.listCloseButton === 'none'
      && landscapeDrawer.pickerButton === 'none'
      && landscapeDrawer.sessionsButton !== 'none'
      && landscapeDrawer.deviceButton !== 'none'
      && landscapeDrawer.devicePull === 'none',
    JSON.stringify(landscapeDrawer));
  check('电脑横屏左侧列表打开时仍能在工作区左上角切换网络',
    landscapeDrawer.netModeParent === 'detail-net-mode-host'
      && !landscapeDrawer.netModeHidden
      && landscapeDrawer.netModeHasIcon
      && (landscapeDrawer.netModeAria === '局域网' || landscapeDrawer.netModeAria.includes('云端')),
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
  const openCloseFromMenu = async () => {
    await page.evaluate(() => {
      const menu = document.getElementById('detail-more-menu');
      if (menu?.hidden) document.getElementById('detail-more-btn')?.click();
    });
    await page.waitForFunction(() => !document.getElementById('detail-more-menu')?.hidden);
    await page.evaluate(() => document.getElementById('delete-btn')?.click());
  };
  await openCloseFromMenu();
  await answerCloseConfirm(false);
  await sleep(300);
  check('对话页关闭取消后仍停留在当前会话',
    receivedDeletes.length === 0
      && await page.evaluate(() => document.getElementById('detail-page')?.classList.contains('active')),
    `deletes=${JSON.stringify(receivedDeletes)}`);
  await openCloseFromMenu();
  await answerCloseConfirm(true);
  await sleep(400);
  check('对话页菜单关闭确认后结束会话',
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

  const quickPrepared = await page.evaluate(async () => {
    currentSessionId = 's1';
    localStorage.setItem(QCMD_STORAGE_KEY, JSON.stringify(['/迁移', '/help']));
    await syncQuickCommands();
    await updateQuickCommands({ action: 'add', command: '/review' });
    await updateQuickCommands({ action: 'add', command: '/unicloud-log-viewer' });
    await updateQuickCommands({ action: 'add', command: '这是一条很长的快捷命令用来测试截断' });
    const input = document.getElementById('msg-input');
    input.value = '前文后文';
    input.focus();
    input.setSelectionRange(2, 2);
    const review = [...document.querySelectorAll('#quick-commands [data-command]')].find(button => button.dataset.command === '/review');
    const long = [...document.querySelectorAll('#quick-commands [data-command]')].find(button => button.dataset.command === '/unicloud-log-viewer');
    const extra = [...document.querySelectorAll('#quick-commands [data-command]')].find(button => button.dataset.command === '这是一条很长的快捷命令用来测试截断');
    return {
      commands: (await api('/api/quick-commands')).commands,
      reviewLabel: review?.textContent,
      longLabel: long?.textContent,
      extraLabel: extra?.textContent,
    };
  });
  check('快捷命令胶囊只显示前 10 个字',
    quickPrepared.reviewLabel === '/review'
      && quickPrepared.longLabel === '/unicloud-…'
      && quickPrepared.extraLabel === '这是一条很长的快捷命…',
    JSON.stringify(quickPrepared));
  await page.evaluate(() => {
    const reviewBtn = [...document.querySelectorAll('#quick-commands [data-command]')].find(button => button.dataset.command === '/review');
    const pointer = { bubbles: true, button: 0, clientX: 8, clientY: 8, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    reviewBtn.dispatchEvent(new PointerEvent('pointerdown', pointer));
    reviewBtn.dispatchEvent(new PointerEvent('pointerup', pointer));
  });
  await page.waitForSelector('#mobile-confirm-dialog [data-confirm="yes"]', { timeout: 3000 });
  const confirmText = await page.$eval('#mobile-confirm-dialog .quick-command-confirm-text', el => el.textContent);
  check('快捷命令确认框显示全文', confirmText === '/review', confirmText);
  await page.click('#mobile-confirm-dialog [data-confirm="yes"]');
  const quickResult = await page.evaluate(async () => {
    const input = document.getElementById('msg-input');
    return { value: input.value, cursor: input.selectionStart, commands: (await api('/api/quick-commands')).commands };
  });
  check('快捷命令迁移到服务端并确认后插入光标位置，不发送',
    quickResult.value === '前文/review后文' && quickResult.cursor === 9
      && quickResult.commands.includes('/迁移') && quickResult.commands.includes('/review'), JSON.stringify(quickResult));
  quickCommandStore.update({ action: 'remove', command: '/review' });
  if (sseClient) sseClient.write(`event: quick-commands\ndata: ${JSON.stringify(quickCommandStore.read())}\n\n`);
  await page.waitForFunction(() => ![...document.querySelectorAll('#quick-commands [data-command]')].some(button => button.dataset.command === '/review'));
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

  const downloadClick = await page.evaluate(async () => {
    currentSessionId = 's1';
    const original = HTMLAnchorElement.prototype.click;
    let captured;
    HTMLAnchorElement.prototype.click = function () {
      captured = {
        href: this.href,
        download: this.download,
        attached: this.isConnected,
        protocol: new URL(this.href).protocol,
      };
    };
    try {
      await downloadSessionFile('data-store/Artifacts/家长糖宣传图-V7.zip');
    } finally {
      HTMLAnchorElement.prototype.click = original;
    }
    return captured;
  });
  check('ZIP 点击保存为原文件名而不是 html',
    downloadClick.protocol === 'blob:'
      && downloadClick.download === '家长糖宣传图-V7.zip'
      && !String(downloadClick.download).includes('.html')
      && downloadClick.attached, JSON.stringify(downloadClick));

  const videoPreview = await page.evaluate(() => {
    currentSessionId = 's1';
    openFilePreview('Artifacts/demo.mp4', { useStandalonePreview: true, returnPage: 'detail-page' });
    const video = document.querySelector('#file-preview-media video');
    const downloadBtn = document.getElementById('file-preview-download-btn');
    return {
      previewActive: document.getElementById('file-preview-page').classList.contains('active'),
      hasVideo: Boolean(video),
      downloadHidden: downloadBtn?.hidden,
    };
  });
  check('视频预览显示播放器和下载按钮',
    videoPreview.previewActive && videoPreview.hasVideo && videoPreview.downloadHidden === false,
    JSON.stringify(videoPreview));

  const previewDownload = await page.evaluate(async () => {
    currentSessionId = 's1';
    const original = HTMLAnchorElement.prototype.click;
    let captured;
    HTMLAnchorElement.prototype.click = function () {
      captured = {
        href: this.href,
        download: this.download,
        protocol: new URL(this.href).protocol,
      };
    };
    try {
      await downloadSessionFile('桂先老师-视频3秒信息图4秒版.mp4');
    } finally {
      HTMLAnchorElement.prototype.click = original;
    }
    return captured;
  });
  check('中文视频下载保存为 mp4 而不是 html',
    previewDownload.protocol === 'blob:'
      && previewDownload.download === '桂先老师-视频3秒信息图4秒版.mp4'
      && !String(previewDownload.download).endsWith('.html'), JSON.stringify(previewDownload));

  const stopped = await page.evaluate(() => {
    currentSessionId = 's1';
    openFilePreview('Artifacts/demo.mp4', { useStandalonePreview: true, returnPage: 'detail-page' });
    const video = document.querySelector('#file-preview-media video');
    let paused = false;
    if (video) video.pause = () => { paused = true; };
    document.getElementById('file-preview-back-btn').click();
    return {
      paused,
      remaining: document.querySelectorAll('#file-preview-media video, #mobile-file-preview-media video').length,
      previewActive: document.getElementById('file-preview-page').classList.contains('active'),
      downloadHidden: document.getElementById('file-preview-download-btn')?.hidden,
    };
  });
  check('返回预览后停止视频播放',
    stopped.paused && stopped.remaining === 0 && !stopped.previewActive && stopped.downloadHidden,
    JSON.stringify(stopped));

  await closeTestBrowser(browser);
  server.close();

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
