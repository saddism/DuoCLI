// Use the shipped mobile page and the existing isolated HTTP/WS fixture.
// Keep timing as diagnostic evidence; assert bounded work rather than a
// machine-dependent frame-time threshold.
import fs from 'node:fs';
import assert from 'node:assert/strict';

const fixture = new URL('./mobile.e2e.mjs', import.meta.url);
const source = fs.readFileSync(fixture, 'utf8');
const boundary = source.indexOf('async function main()');
assert.ok(boundary > 0);
let prefix = source.slice(0, boundary)
  .replace('const PORT = 8931;', 'const PORT = 0;')
  .replace('const ORIGIN = `http://localhost:${PORT}`;', 'let ORIGIN;')
  .replaceAll('import.meta.url', JSON.stringify(fixture.href));
prefix = prefix.replace(/\bfrom\s+(['"])([^'"]+)\1/g, (_match, _quote, specifier) =>
  `from ${JSON.stringify(specifier.startsWith('.') ? new URL(specifier, fixture).href : import.meta.resolve(specifier))}`);

const probe = `
import assert from 'node:assert/strict';
async function performanceMain() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  ORIGIN = 'http://127.0.0.1:' + server.address().port;
  const browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewport({ width: 390, height: 760, isMobile: true, hasTouch: true });
    await page.goto(ORIGIN + '/index.html?token=e2e', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.session-card');
    await page.click('.session-card');
    await page.waitForFunction(() => term && terminalInputReady);
    const client = await page.createCDPSession();
    await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const result = await page.evaluate(async () => {
      closeWebSocket();
      term.reset();
      const data = Array.from({ length: 5000 }, (_, i) => i % 17 === 0
        ? '● Ran npm test\\r\\n' : 'row ' + i + ' check /tmp/file-' + i + '.ts\\r\\n').join('');
      await new Promise(resolve => term.write(data, resolve));
      term.scrollToBottom();
      await new Promise(resolve => setTimeout(resolve, 500));
      const buffer = term.buffer.active;
      const originalLogical = terminalContentHelpers.readLogicalLine;
      const originalGetLine = buffer.getLine.bind(buffer);
      let logicalReads = 0, bufferReads = 0;
      terminalContentHelpers.readLogicalLine = (...args) => { logicalReads++; return originalLogical(...args); };
      buffer.getLine = (...args) => { bufferReads++; return originalGetLine(...args); };
      try {
        terminalTouchActive = false;
        const start = performance.now();
        refreshMobileLinkHighlights();
        const linkMs = performance.now() - start;
        const idleReads = logicalReads;
        const decorations = mobileLinkDecorations.length;
        const markersBeforeRepeat = term.markers.length;
        refreshMobileLinkHighlights();
        const markersAfterRepeat = term.markers.length;
        logicalReads = 0; bufferReads = 0;
        terminalTouchActive = true;
        refreshMobileLinkHighlights();
        const linkReadsDuringTouch = logicalReads;
        bufferReads = 0;
        const foldStart = performance.now();
        terminalFoldView.refresh();
        const foldMsDuringTouch = performance.now() - foldStart;
        const foldReadsDuringTouch = bufferReads;
        terminalTouchActive = false;
        const scroller = terminalFoldView.root.querySelector('.terminal-activity-scroller');
        const touch = new Touch({ identifier: 1, target: scroller, clientX: 120, clientY: 200 });
        scroller.dispatchEvent(new TouchEvent('touchstart', { touches: [touch], bubbles: true }));
        bufferReads = 0;
        terminalFoldView.refresh();
        const foldReadsDuringNativeTouch = bufferReads;
        await new Promise(resolve => term.write('\\r\\nAFTER_TOUCH_FINAL', resolve));
        scroller.dispatchEvent(new TouchEvent('touchcancel', { touches: [], bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 350));
        const updatedAfterTouch = scroller.textContent.includes('AFTER_TOUCH_FINAL');
        term.scrollToLine(100);
        await new Promise(resolve => setTimeout(resolve, 250));
        const highlightsFollowViewport = mobileLinkDecorations.some(decoration =>
          decoration.marker.line >= buffer.viewportY && decoration.marker.line < buffer.viewportY + term.rows);
        return { rows: term.rows, bufferRows: buffer.length, linkMs, idleReads, decorations,
          linkReadsDuringTouch, foldReadsDuringTouch, foldMsDuringTouch,
          markersBeforeRepeat, markersAfterRepeat, foldReadsDuringNativeTouch,
          updatedAfterTouch, highlightsFollowViewport };
      } finally {
        terminalTouchActive = false;
        terminalContentHelpers.readLogicalLine = originalLogical;
        buffer.getLine = originalGetLine;
      }
    });
    console.log('MOBILE_SCROLL_PERFORMANCE', JSON.stringify({ cpuThrottle: 4, ...result }));
    assert.ok(result.idleReads <= result.rows * 3 + 2, 'link highlighting must scan only the viewport and nearby rows');
    assert.ok(result.decorations > 0, 'visible file links must remain highlighted');
    assert.equal(result.linkReadsDuringTouch, 0, 'link scans must yield to touch scrolling');
    assert.equal(result.foldReadsDuringTouch, 0, 'full-history folding must yield to touch scrolling');
    assert.equal(result.foldReadsDuringNativeTouch, 0, 'folded native scrolling must yield to its own touch gesture');
    assert.equal(result.markersAfterRepeat, result.markersBeforeRepeat, 'refreshing highlights must release obsolete markers');
    assert.equal(result.updatedAfterTouch, true, 'deferred folding must update again after touch ends');
    assert.equal(result.highlightsFollowViewport, true, 'scrolling older rows must highlight the newly visible links');
    assert.deepEqual(errors, []);
    console.log('PASS visible links are bounded and heavy terminal scans yield to touch scrolling');
  } finally {
    await closeTestBrowser(browser);
    for (const socket of wss.clients) socket.terminate();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
await performanceMain();
`;
try {
  await import('data:text/javascript;base64,' + Buffer.from(prefix + probe).toString('base64'));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
