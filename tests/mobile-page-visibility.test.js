const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const stylePath = path.join(__dirname, '..', 'mobile', 'client', 'style.css');
const styleCss = fs.readFileSync(stylePath, 'utf8');

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
