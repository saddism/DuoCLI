import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';

const entry = path.resolve('src/renderer/pane-layout.ts');
const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const source = result.outputFiles[0].text;
const layout = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('closing split panes collapses their parent groups back to the surviving pane', () => {
  let workspace = layout.createEmptyLayout();
  const firstId = workspace.root.id;
  workspace = layout.setPaneContent(workspace, firstId, { kind: 'terminal', sessionId: 'one' });

  workspace = layout.splitPane(workspace, firstId, 'horizontal', { kind: 'terminal', sessionId: 'two' }, 'split-a', 'pane-two');
  workspace = layout.splitPane(workspace, 'pane-two', 'vertical', { kind: 'terminal', sessionId: 'three' }, 'split-b', 'pane-three');

  workspace = layout.closePane(workspace, 'pane-three').layout;
  workspace = layout.closePane(workspace, 'pane-two').layout;

  assert.equal(workspace.root.type, 'pane');
  assert.equal(workspace.root.id, firstId);
  assert.deepEqual(workspace.root.content, { kind: 'terminal', sessionId: 'one' });
  assert.equal(workspace.focusedPaneId, firstId);
});

test('closing the final pane leaves one full-size empty pane', () => {
  const initial = layout.createEmptyLayout();
  const closed = layout.closePane(initial, initial.root.id).layout;

  assert.equal(closed.root.type, 'pane');
  assert.equal(closed.root.id, initial.root.id);
  assert.deepEqual(closed.root.content, { kind: 'empty' });
});

test('tiled layout puts four panes into two rows of two', () => {
  let workspace = layout.createEmptyLayout();
  const firstId = workspace.root.id;
  workspace = layout.setPaneContent(workspace, firstId, { kind: 'terminal', sessionId: 'one' });
  workspace = layout.splitPane(workspace, firstId, 'vertical', { kind: 'terminal', sessionId: 'two' }, 'split-1', 'pane-two');
  workspace = layout.splitPane(workspace, 'pane-two', 'vertical', { kind: 'terminal', sessionId: 'three' }, 'split-2', 'pane-three');
  workspace = layout.arrangeTiled(workspace);
  workspace = layout.splitPane(workspace, 'pane-three', 'horizontal', { kind: 'terminal', sessionId: 'four' }, 'split-3', 'pane-four');

  const tiled = layout.arrangeTiled(workspace);
  assert.equal(tiled.root.type, 'split');
  assert.equal(tiled.root.direction, 'vertical');
  assert.equal(tiled.root.first.type, 'split');
  assert.equal(tiled.root.second.type, 'split');
  assert.equal(tiled.root.first.direction, 'horizontal');
  assert.equal(tiled.root.second.direction, 'horizontal');
  assert.deepEqual(layout.listPanes(tiled.root).map((pane) => pane.content.kind === 'terminal' ? pane.content.sessionId : ''),
    ['one', 'two', 'three', 'four']);
});

test('tiled layout keeps two panes side-by-side and preserves focus', () => {
  let workspace = layout.createEmptyLayout();
  const firstId = workspace.root.id;
  workspace = layout.setPaneContent(workspace, firstId, { kind: 'terminal', sessionId: 'one' });
  workspace = layout.splitPane(workspace, firstId, 'vertical', { kind: 'terminal', sessionId: 'two' }, 'split-1', 'pane-two');

  const tiled = layout.arrangeTiled(workspace);
  assert.equal(tiled.root.type, 'split');
  assert.equal(tiled.root.direction, 'horizontal');
  assert.equal(tiled.focusedPaneId, 'pane-two');
  assert.deepEqual(layout.listPanes(tiled.root).map((pane) => pane.content.kind === 'terminal' ? pane.content.sessionId : ''), ['one', 'two']);
});

test('tiled layout gives three panes a full-width lower row', () => {
  let workspace = layout.createEmptyLayout();
  const firstId = workspace.root.id;
  workspace = layout.setPaneContent(workspace, firstId, { kind: 'terminal', sessionId: 'one' });
  workspace = layout.splitPane(workspace, firstId, 'vertical', { kind: 'terminal', sessionId: 'two' }, 'split-1', 'pane-two');
  workspace = layout.splitPane(workspace, 'pane-two', 'vertical', { kind: 'terminal', sessionId: 'three' }, 'split-2', 'pane-three');

  const tiled = layout.arrangeTiled(workspace);
  assert.equal(tiled.root.type, 'split');
  assert.equal(tiled.root.direction, 'vertical');
  assert.equal(tiled.root.first.type, 'split');
  assert.equal(tiled.root.first.direction, 'horizontal');
  assert.equal(tiled.root.second.type, 'pane');
});

test('replacing a focused pane keeps normal sessions independent of the four-pane limit', () => {
  let workspace = layout.createEmptyLayout();
  const firstId = workspace.root.id;
  workspace = layout.setPaneContent(workspace, firstId, { kind: 'terminal', sessionId: 'one' });
  workspace = layout.splitPane(workspace, firstId, 'vertical', { kind: 'terminal', sessionId: 'two' }, 'split-1', 'pane-two');
  workspace = layout.splitPane(workspace, 'pane-two', 'vertical', { kind: 'terminal', sessionId: 'three' }, 'split-2', 'pane-three');
  workspace = layout.arrangeTiled(workspace);
  workspace = layout.splitPane(workspace, 'pane-three', 'horizontal', { kind: 'terminal', sessionId: 'four' }, 'split-3', 'pane-four');
  workspace = layout.arrangeTiled(workspace);

  const switched = layout.setPaneContent(workspace, workspace.focusedPaneId, {
    kind: 'terminal',
    sessionId: 'five',
  });

  assert.equal(layout.countPanes(switched.root), 4);
  assert.deepEqual(layout.listPanes(switched.root).map((pane) => pane.content.kind === 'terminal' ? pane.content.sessionId : ''),
    ['one', 'two', 'three', 'five']);
  assert.ok(layout.validateLayout(switched));
});

test('swapPaneContents exchanges terminals in a vertical split', () => {
  let workspace = layout.createEmptyLayout();
  const firstId = workspace.root.id;
  workspace = layout.setPaneContent(workspace, firstId, { kind: 'terminal', sessionId: 'top' });
  workspace = layout.splitPane(workspace, firstId, 'vertical', { kind: 'terminal', sessionId: 'bottom' }, 'split-v', 'pane-bottom');

  const swapped = layout.swapPaneContents(workspace, firstId, 'pane-bottom');
  assert.equal(swapped.root.type, 'split');
  assert.equal(swapped.root.direction, 'vertical');
  assert.deepEqual(
    layout.listPanes(swapped.root).map((pane) => (pane.content.kind === 'terminal' ? pane.content.sessionId : '')),
    ['bottom', 'top'],
  );
});
