import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';

const result = await build({
  entryPoints: [path.resolve('src/renderer/pane-workspace.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const workspace = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

test('Android pane identity changes when its selected device changes', () => {
  assert.notEqual(
    workspace.paneContentKey({ kind: 'android', deviceId: 'emulator-5554', label: 'Android' }),
    workspace.paneContentKey({ kind: 'android', deviceId: 'R58N123', label: 'Android' }),
  );
  assert.equal(workspace.paneContentKey({ kind: 'android', label: 'Android' }), 'android:');
});
