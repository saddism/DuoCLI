const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const stylePath = path.join(__dirname, '..', 'mobile', 'client', 'style.css');
const styleCss = fs.readFileSync(stylePath, 'utf8');

test('empty file-preview media does not steal flex space from text', () => {
  assert.match(
    styleCss,
    /\.mobile-file-preview-media:empty[\s\S]*?display:\s*none/,
    'empty media slot must collapse so markdown/text can fill the preview panel',
  );
  assert.match(
    styleCss,
    /\.mobile-file-preview-content:empty[\s\S]*?display:\s*none/,
    'empty text slot must collapse so images/video can fill the preview panel',
  );
});

test('cc-chat page stays hidden until .active is applied', () => {
  assert.equal(
    /#cc-chat-page\.page\s*\{\s*display:\s*flex;/m.test(styleCss),
    false,
    'cc-chat page must not force display:flex outside the .active state',
  );

  assert.equal(
    /#cc-chat-page\.active\s*\{\s*display:\s*flex;/m.test(styleCss),
    true,
    'cc-chat page should only be visible in the active state',
  );
});

test('empty splash is centered and has a new-session button', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'client', 'index.html'), 'utf8');
  assert.match(html, /id="empty-new-session-btn"/);
  assert.match(html, /id="new-session-btn"/);
  assert.equal(
    /\.empty-state\s*\{[^}]*display:\s*flex;/.test(styleCss),
    false,
    'empty splash must stay hidden until JS shows it, otherwise it shares height with the session list',
  );
  assert.match(styleCss, /\.session-list:empty[\s\S]*?display:\s*none/);
  assert.match(styleCss, /\.empty-state\s*\{[^}]*justify-content:\s*center/);
  assert.match(styleCss, /\.empty-state\s*\{[^}]*align-items:\s*center/);
});

test('device picker includes a computer remote-desktop entry', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'client', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'client', 'app.js'), 'utf8');
  assert.match(html, /id="mac-desktop-container"/);
  assert.match(html, /id="mac-desktop-fullscreen-preview"/);
  assert.match(html, /id="device-desktop-window-btn"/);
  assert.match(app, /const COMPUTER_DEVICE_ID = 'duocli-computer'/);
  assert.match(app, /opt\.textContent = '电脑'/);
  assert.match(app, /function showComputerDesktop/);
  assert.match(app, /function startMacDesktopPreview/);
  assert.match(app, /function openMacDesktopFullscreen/);
  assert.match(app, /function openMacDesktopWindow/);
  assert.match(app, /\/api\/mac-desktop\/screenshot/);
  assert.match(app, /function androidControlDeviceId/);
  assert.match(app, /if \(!id \|\| isComputerDevice\(id\)\) return;/);
  assert.equal(app.includes('checkIsMacDesktop()'), false);
  assert.match(styleCss, /body\.computer-desktop-fullscreen/);
});

test('mac desktop dedicated viewer page exists', () => {
  const clientDir = path.join(__dirname, '..', 'mobile', 'client');
  const html = fs.readFileSync(path.join(clientDir, 'mac-desktop-view.html'), 'utf8');
  const js = fs.readFileSync(path.join(clientDir, 'mac-desktop-view.js'), 'utf8');
  const sw = fs.readFileSync(path.join(clientDir, 'sw.js'), 'utf8');
  assert.match(html, /id="desktop"/);
  assert.match(html, /mac-desktop-view\.js/);
  assert.match(js, /\/api\/mac-desktop\/screenshot/);
  assert.match(js, /\/api\/mac-desktop\/tap/);
  assert.match(sw, /mac-desktop-view\.html/);
  assert.match(sw, /mac-desktop-view\.js/);
});

test('network mode chip lives in a shared host and is not hidden by the landscape drawer', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'client', 'index.html'), 'utf8');
  assert.match(html, /id="main-net-mode-host"/);
  assert.match(html, /id="detail-net-mode-host"/);
  assert.match(html, /id="net-mode-btn"/);
  assert.equal(
    /#main-page\.landscape-drawer-open #net-mode-btn/.test(styleCss),
    false,
    'landscape session drawer must not hide the network switch',
  );
});

test('landscape workspace hides back arrows because the session list is already visible', () => {
  assert.match(styleCss, /body\.landscape-workspace #back-btn/);
  assert.match(styleCss, /body\.landscape-sessions-open #back-btn/);
  assert.match(styleCss, /body\.landscape-workspace #main-drawer-close/);
  assert.match(
    styleCss,
    /body:not\(\.landscape-workspace\) #main-page\.landscape-drawer-open \.landscape-panel-close/,
  );
});

test('service worker precaches every mobile client script', () => {
  const clientDir = path.join(__dirname, '..', 'mobile', 'client');
  const html = fs.readFileSync(path.join(clientDir, 'index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(clientDir, 'sw.js'), 'utf8');
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((match) => `/${match[1]}`);
  assert.ok(scripts.includes('/android-pointer-helpers.js'));
  for (const script of scripts) {
    assert.ok(sw.includes(`'${script}'`), `sw.js must precache ${script}`);
  }
});

test('service worker skips push banners while a visible page is open', () => {
  const sw = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'client', 'sw.js'), 'utf8');
  assert.match(sw, /visibilityState === 'visible'/);
  assert.match(sw, /clients\.matchAll/);
});
