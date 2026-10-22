import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { resolveChromeExecutable } from './chrome-path.mjs';

const css = readFileSync('src/renderer/styles.css', 'utf8');
const html = readFileSync('src/renderer/index.html', 'utf8')
  .replace('<link rel="stylesheet" href="../../node_modules/@xterm/xterm/css/xterm.css">', '')
  .replace('<link rel="stylesheet" href="styles.css">', `<style>${css}</style>`)
  .replace('<script src="app.js"></script>', '');

const browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 720 });
  await page.setContent(html);
  const title = '修复很长的对话标题并检查侧边栏在窄宽度下是否还能显示更多关键文字';
  const layout = await page.evaluate((text) => {
    const list = document.getElementById('session-list');
    list.innerHTML = `<div class="session-item"><div class="session-item-top"><span class="session-status-dot idle"></span><div class="session-title-row"><span class="session-title"></span></div><div class="session-action-row"><button class="session-pin"></button><button class="session-edit-btn"></button><button class="session-close"></button></div></div><div class="session-item-bottom"><div class="session-meta-row"><span class="session-display-name"><span>Codex / Claude Code 全自动终端</span></span><span class="session-time">刚刚</span></div><div class="session-action-row session-settings-row"><button class="session-auto-continue-label">设置</button></div></div></div>`;
    const item = list.querySelector('.session-item');
    const titleEl = item.querySelector('.session-title');
    titleEl.textContent = text;
    const sidebar = document.getElementById('sidebar');
    sidebar.style.flexShrink = '0';
    sidebar.style.transition = 'none';
    return [180, 275].map(width => {
      sidebar.style.width = `${width}px`;
      const sidebarRect = sidebar.getBoundingClientRect();
      const titleRect = titleEl.getBoundingClientRect();
      const itemRect = item.getBoundingClientRect();
      const actionRect = item.querySelector('.session-action-row').getBoundingClientRect();
      const label = item.querySelector('.session-display-name');
      const top = item.querySelector('.session-item-top').getBoundingClientRect();
      const bottom = item.querySelector('.session-item-bottom').getBoundingClientRect();
      const icons = item.querySelector('.session-item-top .session-action-row').getBoundingClientRect();
      const labelRect = label.getBoundingClientRect();
      const settings = item.querySelector('.session-auto-continue-label').getBoundingClientRect();
      return { width, sidebarWidth: sidebarRect.width, itemWidth: itemRect.width, itemHeight: itemRect.height,
        titleWidth: titleRect.width, titleHeight: titleRect.height,
        titleEllipsis: titleEl.scrollWidth > titleEl.clientWidth + 1,
        labelWidth: labelRect.width,
        iconsOnTitle: Math.abs(icons.top - top.top) < 6,
        settingsOnMeta: Math.abs(settings.top - bottom.top) < 8,
        twoRows: bottom.top >= top.bottom - 2,
        titleRight: titleRect.right, itemRight: itemRect.right, actionRight: actionRect.right, iconsRight: icons.right };
    });
  }, title);
  for (const row of layout) {
    assert.ok(Math.abs(row.sidebarWidth - row.width) < 2, JSON.stringify(row));
    assert.ok(row.titleHeight < 24, JSON.stringify(row));
    assert.equal(row.titleEllipsis, true, JSON.stringify(row));
    assert.equal(row.iconsOnTitle, true, JSON.stringify(row));
    assert.equal(row.settingsOnMeta, true, JSON.stringify(row));
    assert.equal(row.twoRows, true, JSON.stringify(row));
    assert.ok(row.itemHeight < 78, JSON.stringify(row));
    assert.ok(row.labelWidth >= 48, JSON.stringify(row));
    assert.ok(row.titleRight <= row.iconsRight, JSON.stringify(row));
    assert.ok(row.iconsRight <= row.itemRight + 1, JSON.stringify(row));
    assert.ok(row.actionRight <= row.itemRight + 1, JSON.stringify(row));
  }
  if (process.env.DUOCLI_SIDEBAR_SCREENSHOT) {
    await page.screenshot({ path: process.env.DUOCLI_SIDEBAR_SCREENSHOT.replace(/\.png$/, '-list.png') });
    await page.$eval('#sidebar', el => { el.style.width = '180px'; });
    await page.screenshot({ path: process.env.DUOCLI_SIDEBAR_SCREENSHOT.replace(/\.png$/, '-narrow.png') });
  }

  for (const width of [900, 500]) {
    await page.setViewport({ width, height: 720 });
    const modal = await page.evaluate(() => {
      const overlay = document.getElementById('auto-continue-overlay');
      overlay.classList.add('active');
      const dialog = overlay.querySelector('.session-settings-dialog');
      const color = overlay.querySelector('.session-settings-color');
      const commands = overlay.querySelector('.session-settings-commands');
      const rect = dialog.getBoundingClientRect();
      const colorRect = color.getBoundingClientRect();
      const commandsRect = commands.getBoundingClientRect();
      return { left: rect.left, right: rect.right, viewport: innerWidth,
        colorRight: colorRect.right, commandsRight: commandsRect.right };
    });
    assert.ok(modal.left >= 0 && modal.right <= modal.viewport, JSON.stringify(modal));
    assert.ok(modal.colorRight <= modal.right && modal.commandsRight <= modal.right, JSON.stringify(modal));
  }
  if (process.env.DUOCLI_SIDEBAR_SCREENSHOT) {
    await page.setViewport({ width: 1100, height: 800 });
    await new Promise(resolve => setTimeout(resolve, 250));
    await page.screenshot({ path: process.env.DUOCLI_SIDEBAR_SCREENSHOT });
  }
  console.log('PASS desktop sidebar title width and session settings layout');
} finally {
  await browser.close();
}
