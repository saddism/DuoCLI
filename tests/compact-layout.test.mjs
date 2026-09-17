import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';

const entry = path.resolve('src/renderer/compact-layout.ts');
const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const source = result.outputFiles[0].text;
const layout = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('uses hysteresis so mid-size windows do not flicker', () => {
  assert.equal(layout.compactLayoutPhase(1200, false), 'compact');
  assert.equal(layout.compactLayoutPhase(1400, true), 'roomy');
  assert.equal(layout.compactLayoutPhase(1320, true), 'compact');
  assert.equal(layout.compactLayoutPhase(1320, false), 'hold');
});

test('auto-collapses the file tree only when the user has not pinned it open', () => {
  assert.equal(layout.shouldFileTreeCollapse({
    phase: 'compact',
    userCollapsed: false,
    userPinnedOpen: false,
    collapsed: false,
  }), true);
  assert.equal(layout.shouldFileTreeCollapse({
    phase: 'compact',
    userCollapsed: false,
    userPinnedOpen: true,
    collapsed: false,
  }), false);
  assert.equal(layout.shouldFileTreeCollapse({
    phase: 'roomy',
    userCollapsed: false,
    userPinnedOpen: false,
    collapsed: true,
  }), false);
  assert.equal(layout.shouldFileTreeCollapse({
    phase: 'roomy',
    userCollapsed: true,
    userPinnedOpen: false,
    collapsed: true,
  }), true);
});

test('narrows the session list in compact mode and restores the preferred width when roomy', () => {
  assert.equal(layout.nextSidebarWidth({
    phase: 'compact',
    userCollapsed: false,
    userPinnedWidth: false,
    currentWidth: 275,
    preferredWidth: 275,
  }), layout.SIDEBAR_COMPACT_WIDTH);
  assert.equal(layout.nextSidebarWidth({
    phase: 'compact',
    userCollapsed: false,
    userPinnedWidth: true,
    currentWidth: 260,
    preferredWidth: 275,
  }), 260);
  assert.equal(layout.nextSidebarWidth({
    phase: 'roomy',
    userCollapsed: false,
    userPinnedWidth: false,
    currentWidth: 210,
    preferredWidth: 275,
  }), 275);
  assert.equal(layout.nextSidebarWidth({
    phase: 'compact',
    userCollapsed: true,
    userPinnedWidth: false,
    currentWidth: 275,
    preferredWidth: 275,
  }), null);
});
