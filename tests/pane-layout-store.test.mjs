import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';

const entry = path.resolve('src/renderer/pane-layout-store.ts');
const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const store = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => { memory.set(key, String(value)); },
  removeItem: (key) => { memory.delete(key); },
  clear: () => { memory.clear(); },
  key: () => null,
  get length() { return memory.size; },
};

function pane(sessionId) {
  return {
    version: 1,
    root: { type: 'pane', id: `pane-${sessionId}`, content: { kind: 'terminal', sessionId } },
    focusedPaneId: `pane-${sessionId}`,
  };
}

test('loadGlobalWorkspaceLayout migrates the densest per-project layout once', () => {
  memory.clear();
  store.saveWorkspaceLayout('/Users/me/project-a', pane('a'));
  const two = {
    version: 1,
    root: {
      type: 'split',
      id: 'split-1',
      direction: 'horizontal',
      ratio: 0.5,
      first: { type: 'pane', id: 'pane-b1', content: { kind: 'terminal', sessionId: 'b1' } },
      second: { type: 'pane', id: 'pane-b2', content: { kind: 'terminal', sessionId: 'b2' } },
    },
    focusedPaneId: 'pane-b1',
  };
  store.saveWorkspaceLayout('/Users/me/project-b', two);

  const global = store.loadGlobalWorkspaceLayout();
  assert.equal(global.root.type, 'split');
  assert.equal(global.root.first.content.sessionId, 'b1');
  assert.equal(global.root.second.content.sessionId, 'b2');

  // Second load uses the migrated global key and ignores later per-project noise.
  store.saveWorkspaceLayout('/Users/me/project-c', pane('c'));
  const again = store.loadGlobalWorkspaceLayout();
  assert.equal(again.root.type, 'split');
  assert.equal(again.root.first.content.sessionId, 'b1');
});

test('saving under the global key keeps one shared board', () => {
  memory.clear();
  store.saveWorkspaceLayout(store.GLOBAL_WORKSPACE_KEY, pane('shared'));
  const loaded = store.loadGlobalWorkspaceLayout();
  assert.equal(loaded.root.content.sessionId, 'shared');
});
