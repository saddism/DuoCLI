// Exercise the shipped desktop app; only Electron IPC and PTY output are fixtures.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { closeTestBrowser } from './browser-cleanup.mjs';
import { build } from 'esbuild';
import { resolveChromeExecutable } from './chrome-path.mjs';

const artifacts = path.resolve('tests/.artifacts/workspace-ui');
fs.mkdirSync(artifacts, { recursive: true });
const bundle = await build({ entryPoints: ['src/renderer/app.ts'], bundle: true, write: false, platform: 'browser', external: ['electron'] });
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/app.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(bundle.outputFiles[0].text);
    return;
  }
  const files = {
    '/': 'src/renderer/index.html',
    '/styles.css': 'src/renderer/styles.css',
    '/node_modules/@xterm/xterm/css/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  };
  if (files[url.pathname]) {
    res.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(fs.readFileSync(files[url.pathname]));
  } else {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ items: [], presets: [], commands: ['/model', '/review', '/help'], revision: 0 }));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true });
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on('pageerror', error => errors.push(error.message));
  await page.evaluateOnNewDocument((serverOrigin) => {
    const sessions = [
      { id: 'workspace-1', title: '优化手机端对话与模型选择', displayName: 'Codex', cwd: '/workspace/DuoCLI', themeId: 'vscode-dark', createdAt: 3000 },
      { id: 'workspace-2', title: '检查终端恢复与跨设备同步', displayName: 'Claude Code', cwd: '/workspace/DuoCLI', themeId: 'vscode-dark', createdAt: 2000 },
      { id: 'workspace-3', title: '整理产品文档和下一个版本的交付清单', displayName: 'Codex', cwd: '/workspace/Notes', themeId: 'vscode-dark', createdAt: 1000 },
    ];
    const callbacks = {};
    const health = { status: 'lan-only', localOk: true, publicOk: false, tunnelRunning: false, message: '局域网可用' };
    const bridge = {
      autoContinueManaged: true,
      getAutoContinueConfigs: async () => ({}),
      getSessions: async () => sessions,
      closedSessionsList: async () => [{ id: 'closed-with-context', title: '可导出的已关闭会话', cwd: '/workspace/DuoCLI',
        presetCommand: 'codex', resumeId: 'fixture-history', resumeCommand: 'codex resume fixture-history', displayName: 'Codex', closedAt: 1000,
        contextHistory: [{ role: 'user', content: 'fixture context' }] }],
      getAvailableBuiltinPresets: async () => [
        { value: 'codex', label: 'Codex (全自动)' },
        { value: 'flutter', label: 'Flutter终端' },
        { value: '', label: '空终端' },
      ],
      listTerminalTasks: async () => ({ revision: 0, tasks: [] }),
      getQuickCommands: async () => ({ commands: ['/model', '/review', '/help'], revision: 1 }),
      getRemoteServerInfo: async () => ({ lanUrl: serverOrigin, port: Number(new URL(serverOrigin).port), token: 'fixture-only', health }),
      getRemoteHealth: async () => health,
      fileTreeListDir: async cwd => [
        { name: 'src', path: cwd + '/src', isDir: true },
        { name: 'mobile', path: cwd + '/mobile', isDir: true },
        { name: 'tests', path: cwd + '/tests', isDir: true },
        { name: 'README.md', path: cwd + '/README.md', isDir: false },
        { name: 'package.json', path: cwd + '/package.json', isDir: false },
      ],
      snapshotPty: async () => ({ sequence: 0, epoch: 1, cols: 100, rows: 32,
        data: '\x1b[36mDuoCLI · 工作区交互预览\x1b[0m\r\n\r\n› 优化桌面和手机端的对话界面\r\n\r\n  已整理会话导航、模型菜单与输入区域。\r\n  可在左侧切换项目，在右侧查看文件。\r\n\r\n• Explored\r\n  Read src/app.ts\r\n• Ran npm test\r\n  PASS checks\r\n\r\n\x1b[32m✓\x1b[0m 消息重试与会话切换检查通过\r\n\r\n› ' }),
      aiGetCurrentConfig: async () => ({}),
      terminalAutoResponseGetConfig: async () => ({ enabled: false, rules: [], delayMs: 0, cooldownMs: 1000 }),
    };
    window.duocli = new Proxy(bridge, { get(target, key) {
      if (key in target) return target[key];
      if (String(key).startsWith('on')) return callback => { callbacks[key] = callback; return () => {}; };
      return async () => undefined;
    } });
  }, origin);
  await page.goto(origin, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.session-item[data-session-id="workspace-1"]');
  const assertWelcomeCentered = async () => {
    await page.waitForFunction(() => !document.querySelector('.empty-state-card').getAnimations().some(a => a.playState === 'running'));
    const offsets = await page.evaluate(() => {
      const content = document.getElementById('terminal-content').getBoundingClientRect();
      const card = document.querySelector('.empty-state-card').getBoundingClientRect();
      return {
        x: card.x + card.width / 2 - (content.x + content.width / 2),
        y: card.y + card.height / 2 - (content.y + content.height / 2),
      };
    });
    assert.ok(Math.abs(offsets.x) < 1 && Math.abs(offsets.y) < 1, `Welcome center offsets: ${JSON.stringify(offsets)}`);
  };
  await assertWelcomeCentered();
  await page.click('#file-tree-toggle');
  await page.setViewport({ width: 1692, height: 1382 });
  await page.waitForFunction(() => !document.getElementById('file-tree-panel').getAnimations().some(a => a.playState === 'running'));
  await assertWelcomeCentered();
  await page.screenshot({ path: path.join(artifacts, 'desktop-welcome-centered.png') });
  await page.click('#file-tree-toggle');
  await page.setViewport({ width: 1440, height: 900 });
  await assertWelcomeCentered();
  await page.waitForFunction(() => !document.getElementById('file-tree-panel').getAnimations().some(a => a.playState === 'running'));
  console.log('PASS welcome card stays centered with the file inspector expanded or collapsed and after resizing');
  await page.click('.session-item[data-session-id="workspace-1"]');
  await page.waitForSelector('.pane-leaf .xterm-screen');
  await page.waitForFunction(() => !document.querySelector('.terminal-reveal-pending'));
  assert.deepEqual(errors, []);
  const rect = async selector => page.$eval(selector, el => {
    const r = el.getBoundingClientRect(); return { x: r.x, right: r.right, y: r.y, width: r.width, height: r.height };
  });
  const sidebar = await rect('#sidebar');
  const main = await rect('#terminal-area');
  const files = await rect('#file-tree-panel');
  assert.ok(sidebar.right <= main.x && main.right <= files.x, JSON.stringify({ sidebar, main, files }));
  console.log('PASS desktop navigation is left, working surface central, file inspector right');
  await page.waitForFunction(() => document.querySelectorAll('.file-tree-row').length >= 6);
  assert.equal(await page.$$eval('.file-tree-row', rows => rows.length), 6);
  console.log('PASS overlapping directory renders do not duplicate rows');
  await page.screenshot({ path: path.join(artifacts, 'desktop-workspace.png') });

  assert.equal(await page.$('#pane-layout-summary'), null);
  assert.equal(await page.$('.pane-agent-tag'), null);
  assert.equal(await page.$('.terminal-activity-toolbar'), null);
  assert.equal(await page.$('.terminal-activity-reopen'), null);
  assert.equal(await page.$$eval('.terminal-activity-group', nodes => nodes.length > 0 && nodes.every(node => !node.open)), true);
  await page.click('.pane-leaf-focused .pane-action[title="更多操作"]');
  await page.screenshot({ path: path.join(artifacts, 'desktop-record-menu.png') });
  await page.click('.pane-menu [aria-label="展开全部记录"]');
  assert.equal(await page.$$eval('.terminal-activity-group', nodes => nodes.every(node => node.open)), true);
  await page.click('.pane-leaf-focused .pane-action[title="更多操作"]');
  await page.click('.pane-menu [aria-label="折叠全部记录"]');
  assert.equal(await page.$$eval('.terminal-activity-group', nodes => nodes.every(node => !node.open)), true);
  await page.click('.terminal-activity-group summary');
  assert.equal(await page.$eval('.terminal-activity-group', node => node.open), true);
  await page.click('.terminal-activity-group summary');
  console.log('PASS terminal records fold by default, expand individually or from the header menu, without mode toggles');

  const splitThroughMenu = async label => {
    await page.click('.pane-leaf-focused .pane-action[title="拆分窗口"]');
    await page.click(`.pane-menu [aria-label="${label}"]`);
  };
  for (const direction of ['向上拆分', '向下拆分', '向左拆分', '向右拆分']) {
    const original = await rect('.pane-leaf');
    await page.click('.pane-leaf-focused .pane-action[title="拆分窗口"]');
    if (direction === '向上拆分') await page.screenshot({ path: path.join(artifacts, 'desktop-split-menu.png') });
    await page.click(`.pane-menu [aria-label="${direction}"]`);
    const empty = await rect('.pane-leaf-focused');
    const terminal = await rect('.pane-leaf:not(.pane-leaf-focused)');
    assert.equal(await page.$$eval('.pane-leaf', nodes => nodes.length), 2);
    if (direction === '向上拆分') assert.ok(empty.y + empty.height <= terminal.y + 1);
    if (direction === '向下拆分') assert.ok(terminal.y + terminal.height <= empty.y + 1);
    if (direction === '向左拆分') assert.ok(empty.right <= terminal.x + 1);
    if (direction === '向右拆分') assert.ok(terminal.right <= empty.x + 1);
    await page.click('.pane-leaf-focused .pane-action[title="关闭 Pane"]');
    const restored = await rect('.pane-leaf');
    assert.ok(Math.abs(restored.width - original.width) < 1);
    assert.ok(Math.abs(restored.height - original.height) < 1);
  }
  await page.click('.pane-leaf-focused .pane-action[title="拆分窗口"]');
  await page.keyboard.press('Escape');
  assert.equal(await page.$('.pane-menu'), null);
  console.log('PASS one split button offers four directions, creates the pane in the selected position, and Escape closes the menu');

  const assertActiveSession = async id => {
    assert.deepEqual(await page.$$eval('.session-item.active', nodes => nodes.map(node => node.dataset.sessionId)), id ? [id] : []);
    assert.deepEqual(await page.$$eval('.session-item[aria-current="true"]', nodes => nodes.map(node => node.dataset.sessionId)), id ? [id] : []);
  };
  const firstPaneId = await page.$eval('.pane-leaf-focused', node => node.dataset.paneId);
  await splitThroughMenu('向右拆分');
  await page.click('.session-item[data-session-id="workspace-2"]');
  // Focus the first visible terminal directly, without selecting its sidebar row.
  await page.click(`.pane-leaf[data-pane-id="${firstPaneId}"] .pane-header`);
  assert.deepEqual(await page.$$eval('.session-item.active', nodes => nodes.map(node => node.dataset.sessionId)), ['workspace-1']);
  await assertActiveSession('workspace-1');
  await page.click('.session-item[data-session-id="workspace-2"]');
  await assertActiveSession('workspace-2');
  await page.click(`.pane-leaf[data-pane-id="${firstPaneId}"] .pane-body`);
  await assertActiveSession('workspace-1');
  await page.click('.session-item[data-session-id="workspace-2"]');
  await assertActiveSession('workspace-2');
  await page.screenshot({ path: path.join(artifacts, 'desktop-active-session.png') });
  const highlight = await page.$eval('.session-item.active', node => {
    const style = getComputedStyle(node);
    return { background: style.backgroundColor, marker: style.boxShadow };
  });
  assert.notEqual(highlight.marker, 'none');
  await page.hover('.session-item.active');
  assert.equal(await page.$eval('.session-item.active', node => getComputedStyle(node).boxShadow), highlight.marker);
  await splitThroughMenu('向右拆分');
  await assertActiveSession(null);
  await page.click('.pane-leaf-focused .pane-action[title="关闭 Pane"]');
  await assertActiveSession('workspace-1');
  console.log('PASS sidebar selection follows terminal focus, empty panes, and pane closure');

  await page.type('#session-search', 'Notes');
  assert.equal(await page.$$eval('.session-item', nodes => nodes.length), 1);
  assert.equal(await page.$eval('.session-item', node => node.dataset.sessionId), 'workspace-3');
  await page.keyboard.press('Escape');
  assert.equal(await page.$$eval('.session-item', nodes => nodes.length), 3);
  await page.type('#session-search', 'no-such-project');
  assert.equal(await page.$eval('#session-search-empty', node => node.hidden), false);
  await page.keyboard.press('Escape');
  console.log('PASS desktop project search, empty result, and Escape restore');

  for (const [handle, panel, delta] of [['#sidebar-resizer', '#sidebar', 45], ['#file-tree-resizer', '#file-tree-panel', -45]]) {
    const before = await rect(panel);
    const grip = await rect(handle);
    await page.mouse.move(grip.x + grip.width / 2, 300);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2 + delta, 300, { steps: 6 });
    await page.mouse.up();
    await page.waitForFunction(({ selector, width }) => document.querySelector(selector).getBoundingClientRect().width >= width + 40, {}, { selector: panel, width: before.width });
  }
  console.log('PASS both resize handles grow in the direction of the working surface');
  await page.click('#sidebar-toggle');
  await page.waitForFunction(() => document.getElementById('sidebar').offsetWidth === 0);
  assert.equal(await page.$eval('#sidebar-resizer', node => node.getBoundingClientRect().width), 0);
  await page.click('#sidebar-toggle');
  await page.click('#file-tree-toggle');
  await page.waitForFunction(() => document.getElementById('file-tree-panel').offsetWidth === 0);
  assert.equal(await page.$eval('#file-tree-resizer', node => node.getBoundingClientRect().width), 0);
  await page.click('#file-tree-toggle');
  console.log('PASS collapsed side panels leave no draggable gutter and reopen');

  await page.click('#remote-connection-panel > summary');
  assert.equal(await page.$eval('#remote-server-info', node => node.checkVisibility()), true);
  await page.click('#remote-connection-panel > summary');
  await page.click('#toolbar-new-btn');
  await page.waitForSelector('#new-session-overlay.active');
  await new Promise(resolve => setTimeout(resolve, 300));
  await page.screenshot({ path: path.join(artifacts, 'desktop-new-session.png') });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 520, height: 420 }]) {
    await page.setViewport(viewport);
    await page.click('#preset-display');
    await page.waitForFunction(() => !document.getElementById('preset-dropdown').getAnimations().some(a => a.playState === 'running'));
    const menu = await page.evaluate(() => {
      const dropdown = document.getElementById('preset-dropdown');
      const body = document.querySelector('#new-session-dialog .new-session-body');
      const last = dropdown.lastElementChild;
      last.scrollIntoView({ block: 'nearest' });
      const option = last.getBoundingClientRect();
      const hit = document.elementFromPoint(option.x + option.width / 2, option.y + option.height / 2);
      const arrow = getComputedStyle(document.getElementById('preset-display'), '::after');
      return {
        lastReachable: !!hit?.closest('.custom-select-option'),
        horizontalOverflow: body.scrollWidth > body.clientWidth + 1,
        arrowVisible: arrow.content === '""' && parseFloat(arrow.width) > 0 && parseFloat(arrow.borderRightWidth) > 0,
      };
    });
    assert.deepEqual(menu, { lastReachable: true, horizontalOverflow: false, arrowVisible: true }, JSON.stringify(viewport));
    await page.screenshot({ path: path.join(artifacts, `desktop-cli-dropdown-${viewport.width}.png`) });
    await page.click('#preset-dropdown .custom-select-option:last-child');
    assert.equal(await page.$eval('#preset-select-wrap', node => node.classList.contains('open')), false);
    assert.equal(await page.$eval('#preset-display', node => node.textContent), '空终端');
  }
  console.log('PASS CLI dropdown has an arrow and its last option is visible and selectable in normal and short windows');
  await page.setViewport({ width: 1440, height: 900 });
  await page.click('#task-plan-enabled');
  await page.type('#task-plan-instruction', 'review整个代码库尤其是最近一周的修改，然后部署测试服务器');
  await page.$eval('#task-plan-delay', node => { node.value = '60'; });
  await page.$eval('#task-plan-dependency', node => {
    node.add(new Option('等待已有终端完成：' + '包含长名称和目录路径的前置任务'.repeat(10), 'fixture-overflow'));
    node.value = 'fixture-overflow';
  });
  for (const viewport of [{width:1440,height:900}, {width:900,height:700}, {width:520,height:620}, {width:360,height:600}]) {
    await page.setViewport(viewport);
    await page.waitForFunction(() => !document.getElementById('new-session-dialog').getAnimations().some(a => a.playState === 'running'));
    const layout = await page.evaluate(() => {
      const dialog = document.getElementById('new-session-dialog');
      const body = dialog.querySelector('.new-session-body');
      const bounds = dialog.getBoundingClientRect();
      const fields = [...document.querySelectorAll('#task-plan-fields input:not([type="hidden"]), #task-plan-fields select, #task-plan-fields textarea')]
        .map(node => node.getBoundingClientRect());
      const action = document.getElementById('new-session-create').getBoundingClientRect();
      return { overflow: body.scrollWidth > body.clientWidth + 1,
        fieldsFit: fields.every(r => r.left >= bounds.left && r.right <= bounds.right),
        dialogFits: bounds.top >= 0 && bounds.bottom <= innerHeight,
        actionReachable: action.bottom <= innerHeight && !!document.elementFromPoint(action.x + action.width / 2, action.y + action.height / 2)?.closest('#new-session-create') };
    });
    assert.deepEqual(layout, {overflow:false,fieldsFit:true,dialogFits:true,actionReachable:true}, JSON.stringify(viewport));
    if (viewport.width === 1440 || viewport.width === 360) {
      await page.screenshot({ path: path.join(artifacts, `desktop-task-plan-${viewport.width}.png`) });
    }
  }
  await page.click('#task-plan-delay-clear');
  assert.equal(await page.$eval('#task-plan-delay', node => node.value), '');
  assert.equal(await page.$eval('#task-plan-quiet', node => node.value), '10');
  assert.ok(await page.$eval('#task-plan-name-preview', node => node.title.length > 0));
  console.log('PASS queued task settings fit long dependencies and compact windows with reachable actions');
  await page.click('#new-session-cancel');
  console.log('PASS connection details and new session dialog remain accessible');

  await page.click('.closed-sessions-header > button:first-of-type');
  await page.waitForSelector('.session-item-closed button[title="导出 1 条对话"]');
  assert.equal(await page.$eval('.session-item-closed button[title="导出 1 条对话"]', button => button.disabled), false);
  assert.deepEqual(errors, []);
  console.log('PASS closed sessions with context render their export and restore actions');

  await page.setViewport({ width: 900, height: 700 });
  // A fresh compact window has no deliberately pinned-open inspector.
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForFunction(() => document.body.classList.contains('layout-compact'));
  await page.waitForFunction(() => document.getElementById('terminal-area').getBoundingClientRect().width > 500);
  await page.click('.session-item[data-session-id="workspace-1"]');
  await assertActiveSession('workspace-1');
  await page.waitForFunction(() => !document.querySelector('.session-item.active').getAnimations().some(animation => animation.playState === 'running'));
  assert.equal(await page.$eval('.session-item.active', node => getComputedStyle(node).backgroundColor), highlight.background);
  assert.equal(await page.$eval('.session-item.active', node => getComputedStyle(node).boxShadow), highlight.marker);
  assert.equal(await page.$eval('body', el => el.scrollWidth > innerWidth), false);
  assert.equal(await page.$$eval('.pane-action', buttons => buttons.every(button => {
    const rect = button.getBoundingClientRect();
    return rect.width === 0 || button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  })), true);
  await new Promise(resolve => setTimeout(resolve, 300));
  await page.screenshot({ path: path.join(artifacts, 'desktop-compact.png') });
  assert.deepEqual(errors, []);
  console.log('PASS compact workspace preserves the terminal and has no horizontal overflow');
} finally {
  await closeTestBrowser(browser);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
