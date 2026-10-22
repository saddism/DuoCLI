// Exercise the shipped mobile page across tablet rotation and pointer modes.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { closeTestBrowser } from './browser-cleanup.mjs';
import { WebSocketServer } from 'ws';
import { resolveChromeExecutable } from './chrome-path.mjs';

const client = path.resolve('mobile/client');
const artifacts = path.resolve('tests/.artifacts/mobile-navigation');
fs.mkdirSync(artifacts, { recursive: true });
const sessions = ['one', 'two'].map(id => ({
  id, title: `iPad navigation ${id}`, status: 'running', cli: 'codex',
  cwd: '/tmp/navigation-fixture', presetCommand: 'codex', chatCapable: true,
  resumeId: `resume-${id}`, createdAt: 1000,
}));
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/events') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write(': connected\n\n');
    } else if (url.pathname === '/api/auth') res.end('{"ok":true}');
    else if (url.pathname === '/api/sessions') res.end(JSON.stringify(sessions));
    else if (url.pathname.endsWith('/chat')) res.end(JSON.stringify({
      supported: true, ready: true, revision: 'fixture', messages: [
        { role: 'user', blocks: [{ type: 'text', text: '检查竖屏返回对话列表。' }] },
      ],
    }));
    else if (url.pathname === '/api/quick-commands') res.end(JSON.stringify({ commands: ['/new', '/model', '继续', '检查当前工作区'], revision: 1 }));
    else if (url.pathname === '/api/presets' || url.pathname === '/api/devices') res.end('[]');
    else res.end('{}');
    return;
  }
  const file = path.resolve(client, url.pathname === '/' ? 'index.html' : `.${url.pathname}`);
  if (!file.startsWith(`${client}/`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end(); return;
  }
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
  res.setHeader('Content-Type', `${mime[path.extname(file)] || 'application/octet-stream'}; charset=utf-8`);
  res.end(fs.readFileSync(file));
});
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', socket => {
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'subscribe') socket.send(JSON.stringify({
      type: 'replay', capabilityVersion: 2, epoch: 1, scrollback: 0,
      data: '\x1b[36mDuoCLI · 终端工作区\x1b[0m\r\n\r\n› 精简对话区域上下空间\r\n\r\n• 顶部导航已收进三个点菜单\r\n• 底部快捷语和组合键可切换\r\n\r\n\x1b[32m✓\x1b[0m 操作入口保留，终端显示更多内容\r\n\r\n› ',
    }));
    else if (message.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true });
  for (const touch of [false, true]) {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      if (!/^https?:$/.test(location.protocol)) return;
      sessionStorage.setItem('duocli_mobile_chat_view:one', 'chat');
      sessionStorage.setItem('duocli_mobile_chat_view:two', 'chat');
    });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => { errors.push(error.message); console.error('BROWSER_ERROR', error.message); });
    const viewport = (width, height) => ({ width, height, isMobile: touch, hasTouch: touch });
    await page.setViewport(viewport(1133, 744));
    await page.goto(`${origin}/?token=navigation-fixture`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.classList.contains('landscape-workspace'));
    await page.waitForFunction(() => currentSessionId === 'one' && sessionViewMode === 'chat');
    assert.equal(await page.$('#session-view-tabs'), null);
    assert.equal(await page.$('#user-prompt-banner'), null);
    await page.click('#detail-more-btn');
    assert.equal(await page.$eval('#terminal-return-chat', button => button.getAttribute('aria-pressed')), 'true');
    await page.click('#session-terminal-tab');
    await page.waitForFunction(() => sessionViewMode === 'terminal' && term?.element && terminalInputReady);
    assert.equal(await page.$eval('#detail-more-menu', menu => menu.hidden), true);
    for (const mode of ['commands', 'keys', 'commands']) {
      if (await page.evaluate(() => shortcutMode) !== mode) await page.click('#shortcut-mode-toggle');
      const layout = await page.evaluate(() => {
        const strip = document.getElementById('composer-shortcuts').getBoundingClientRect();
        const terminal = document.getElementById('terminal-container').getBoundingClientRect();
        const detail = document.getElementById('detail-page').getBoundingClientRect();
        const toggle = document.getElementById('shortcut-mode-toggle').getBoundingClientRect();
        return {
          keysVisible: document.getElementById('shortcut-bar').checkVisibility(),
          commandsVisible: document.getElementById('quick-commands').checkVisibility(),
          topHeight: terminal.top - detail.top,
          bottomHeight: detail.bottom - terminal.bottom,
          stripHeight: strip.height,
          toggleReachable: document.elementFromPoint(toggle.x + toggle.width / 2, toggle.y + toggle.height / 2)?.id === 'shortcut-mode-toggle',
          overflow: document.body.scrollWidth > innerWidth,
        };
      });
      assert.equal(layout.keysVisible, mode === 'keys', JSON.stringify(layout));
      assert.equal(layout.commandsVisible, mode === 'commands', JSON.stringify(layout));
      assert.ok(layout.topHeight <= 52 && layout.bottomHeight <= 104 && layout.stripHeight <= 46, JSON.stringify(layout));
      assert.equal(layout.toggleReachable, true);
      assert.equal(layout.overflow, false);
      if (mode === 'keys') await page.screenshot({ path: path.join(artifacts, `compact-keys-${touch ? 'touch' : 'pointer'}.png`) });
    }
    await page.screenshot({ path: path.join(artifacts, `compact-terminal-${touch ? 'touch' : 'pointer'}.png`) });
    await page.click('#detail-more-btn');
    await page.screenshot({ path: path.join(artifacts, `compact-menu-${touch ? 'touch' : 'pointer'}.png`) });
    await page.click('#terminal-return-chat');
    await page.waitForFunction(() => sessionViewMode === 'chat');
    assert.equal(await page.$eval('#shortcut-mode-toggle', button => button.hidden), true);
    assert.equal(await page.$eval('#quick-commands', bar => bar.checkVisibility()), true);
    console.log(`PASS compact header, menu navigation, and one-row shortcut toggle (${touch ? 'touch' : 'fine pointer'})`);
    await page.click('#detail-header .landscape-sessions-toggle');
    await page.waitForFunction(() => !document.body.classList.contains('landscape-sessions-open'));
    await page.setViewport(viewport(744, 1133));
    await page.waitForFunction(() => matchMedia('(orientation: portrait)').matches);
    await new Promise(resolve => setTimeout(resolve, 250));
    const portrait = await page.evaluate(() => {
      const button = document.getElementById('back-btn');
      const rect = button.getBoundingClientRect();
      return { workspace: document.body.classList.contains('landscape-workspace'),
        sessionsOpen: document.body.classList.contains('landscape-sessions-open'),
        visible: button.checkVisibility(),
        clickable: rect.width > 0 && button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)),
        finePointer: matchMedia('(hover: hover) and (pointer: fine)').matches };
    });
    assert.equal(portrait.workspace, false, JSON.stringify(portrait));
    assert.equal(portrait.sessionsOpen, false, JSON.stringify(portrait));
    assert.equal(portrait.visible && portrait.clickable, true, JSON.stringify(portrait));
    await page.screenshot({ path: path.join(artifacts, `portrait-${touch ? 'touch' : 'pointer'}.png`) });
    await page.click('#back-btn');
    await page.waitForFunction(() => document.getElementById('main-page').classList.contains('active'));
    await page.waitForSelector('.session-card[data-id="two"]');
    await page.locator('#main-page .session-card[data-id="one"]').click();
    await page.waitForFunction(() => currentSessionId === 'one');
    await page.evaluate(() => openSession('two'));
    await page.waitForFunction(() => currentSessionId === 'two');
    await page.click('#back-btn');
    await page.waitForFunction(() => document.getElementById('main-page').classList.contains('active'), { timeout: 3000 });
    assert.equal(await page.evaluate(() => currentSessionId), null);
    await page.screenshot({ path: path.join(artifacts, `list-${touch ? 'touch' : 'pointer'}.png`) });
    await page.evaluate(() => sessionStorage.removeItem('duocli_mobile_chat_view:one'));
    await page.locator('#main-page .session-card[data-id="one"]').click();
    await page.waitForFunction(() => currentSessionId === 'one' && sessionViewMode === 'terminal' && term?.element);
    await page.click('#back-btn');
    await page.waitForFunction(() => document.getElementById('main-page').classList.contains('active'));
    await page.setViewport(viewport(1133, 744));
    await page.waitForFunction(() => document.body.classList.contains('landscape-workspace'));
    await page.waitForFunction(() => document.body.classList.contains('landscape-sessions-open'));
    await page.setViewport(viewport(768, 1024));
    await page.waitForFunction(() => !document.body.classList.contains('landscape-workspace'));
    assert.equal(await page.$eval('#back-btn', button => button.checkVisibility()), true);
    assert.equal(await page.evaluate(() => document.getElementById('main-page').classList.contains('landscape-drawer-open')), false);
    assert.deepEqual(errors, []);
    console.log(`PASS tablet portrait back navigation after rotation, sidebar collapse, and multiple sessions (${touch ? 'touch' : 'fine pointer'})`);
    await page.close();
  }
} finally {
  await closeTestBrowser(browser);
  for (const socket of wss.clients) socket.terminate();
  await new Promise(resolve => wss.close(resolve));
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
