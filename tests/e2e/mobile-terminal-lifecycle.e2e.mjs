// Reuse the existing mock HTTP/WS fixture, without running unrelated device UI
// scenarios. The temporary module stays beside the fixture for relative imports.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const source = fs.readFileSync(new URL('./mobile.e2e.mjs', import.meta.url), 'utf8');
const boundary = source.indexOf('async function main() {');
assert.ok(boundary > 0, 'mobile fixture setup boundary is available');
const prefix = source.slice(0, boundary).replace('const PORT = 8931;', 'const PORT = 0;').replace('const ORIGIN = ', 'let ORIGIN = ');
const generated = fileURLToPath(new URL(`./.mobile-lifecycle-${process.pid}.generated.mjs`, import.meta.url));
const probe = `
async function lifecycleMain() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  ORIGIN = 'http://127.0.0.1:' + server.address().port;
  const browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true });
  const errors = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 760, isMobile: true, hasTouch: true });
    page.on('pageerror', error => { errors.push(error.stack || error.message); console.error('BROWSER_ERROR', error.stack || error.message); });
    await page.goto(ORIGIN + '/index.html?token=e2e', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.session-card', { timeout: 8000 });
    await page.click('.session-card');
    await page.waitForFunction(() => term && term.cols > 0, { timeout: 8000 });
    await sleep(300);
    const result = await page.evaluate(async () => {
      const pending = [];
      for (let i = 0; i < 6; i++) {
        pending.push(createTerminal());
        if (i % 2 === 0) closeTerminal();
      }
      pending.push(createTerminal());
      let scrollRegistrations = 0;
      const container = document.getElementById('terminal-container');
      const originalAddListener = container.addEventListener.bind(container);
      container.addEventListener = (type, listener, ...args) => {
        if (type === 'touchstart' && listener?.name === 'onTouchStart') scrollRegistrations++;
        return originalAddListener(type, listener, ...args);
      };
      await Promise.race([
        Promise.all(pending),
        new Promise((_, reject) => setTimeout(() => reject(new Error('superseded terminal initialization did not settle')), 2000)),
      ]);
      await new Promise(resolve => setTimeout(resolve, 100));
      return { live: Boolean(term), cols: term?.cols, screens: document.querySelectorAll('#terminal-container .xterm').length, scrollRegistrations };
    });
    // The separate remote-desktop bundle currently boots noVNC's full app UI
    // without its settings DOM. Report it, but do not confuse it with xterm.
    const terminalErrors = errors.filter(stack => !stack.includes('/mac-desktop-novnc-bundle.js:'));
    if (!result.live || result.cols <= 0 || result.screens !== 1 || result.scrollRegistrations !== 1 || terminalErrors.length) {
      throw new Error(JSON.stringify({ result, terminalErrors, externalErrors: errors.length - terminalErrors.length }));
    }
    console.log('PASS rapid mobile create/close/recreate settles old initializers and registers scrolling only once');
    console.log('PASS no terminal initialization exceptions; external noVNC errors=' + (errors.length - terminalErrors.length));
  } finally {
    await browser.close();
    for (const client of wss.clients) client.terminate();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
lifecycleMain().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
`;
fs.writeFileSync(generated, prefix + probe, { flag: 'wx' });
try {
  const result = spawnSync(process.execPath, [generated], { encoding: 'utf8', timeout: 30000 });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'mobile terminal lifecycle regression');
} finally {
  fs.unlinkSync(generated);
}
