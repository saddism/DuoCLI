import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { TerminalState } from '../dist/main/terminal-state.js';
import { PtyManager } from '../dist/main/pty-manager.js';
import { parseAndroidDevices } from '../dist/main/android-devices.js';

const require = createRequire(import.meta.url);
globalThis.self = globalThis;
const { Terminal } = require('../mobile/client/xterm.js');
const { Unicode11Addon } = require('../mobile/client/addon-unicode11.js');
const { intercept } = require('../mobile/client/spinner-interceptor.js');
const write = (term, data) => new Promise(resolve => term.write(data, resolve));
const buffer = term => {
  const b = term.buffer.active;
  return { lines: Array.from({ length: b.length }, (_, i) => b.getLine(i).translateToString(true)), cursor: [b.cursorX, b.cursorY], type: b.type };
};
function browserTerminal(cols = 43, rows = 33) {
  const term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  return term;
}

for (const name of ['qoder-cn', 'cursor', 'antigravity', 'codex']) {
  test(`${name}: real output matches browser and survives a mid-stream reconnect`, async t => {
    const fixture = JSON.parse(fs.readFileSync(new URL(`./fixtures/terminal/${name}.json`, import.meta.url)));
    const state = new TerminalState();
    const browser = browserTerminal();
    const restored = browserTerminal();
    t.after(() => { state.dispose(); browser.dispose(); restored.dispose(); });
    state.resize(43, 33);
    const midpoint = Math.floor(fixture.chunks.length / 2);
    for (let i = 0; i < fixture.chunks.length; i++) {
      const data = fixture.chunks[i].data;
      assert.equal(intercept(data), data);
      state.write(data, () => {});
      await write(browser, data);
      if (i === midpoint) {
        let snapshot;
        await state.snapshot(value => { snapshot = value; });
        assert.equal(snapshot.sequence, i + 1);
        await write(restored, snapshot.data);
      } else if (i > midpoint) await write(restored, data);
    }
    await state.snapshot(() => {});
    assert.deepEqual(buffer(browser), buffer(state.terminal));
    assert.deepEqual(buffer(restored), buffer(browser));
  });
}

test('snapshot preserves a split CSI, OSC and surrogate pair', async t => {
  for (const [first, second] of [['hello\x1b[3', '1mred'], ['hello\x1b]0;par', 'tial\x07next'], ['hello\ud83d', '\ude00next']]) {
    const state = new TerminalState();
    const restored = browserTerminal(80, 24);
    t.after(() => { state.dispose(); restored.dispose(); });
    state.write(first, () => {});
    let snapshot;
    await state.snapshot(value => { snapshot = value; });
    await write(restored, snapshot.data);
    state.write(second, () => {});
    await write(restored, second);
    await state.snapshot(() => {});
    assert.deepEqual(buffer(restored), buffer(state.terminal));
  }
});

test('large history and resize restore a parsed screen, never an arbitrary ANSI tail', async t => {
  const state = new TerminalState();
  const restored = browserTerminal();
  t.after(() => { state.dispose(); restored.dispose(); });
  state.write(('long history 中文\r\n').repeat(9000), () => {});
  state.resize(43, 33);
  state.write('\x1b[?2004h\r\nREADY', () => {});
  let snapshot;
  await state.snapshot(value => { snapshot = value; });
  assert.equal(snapshot.cols, 43);
  assert.equal(snapshot.rows, 33);
  await write(restored, snapshot.data);
  assert.deepEqual(buffer(restored), buffer(state.terminal));
  assert.equal(restored.modes.bracketedPasteMode, true);
});

test('duplicate submission IDs emit one paste and one Enter; separate submissions retain order', async t => {
  const manager = new PtyManager({ onData() {}, onTitleUpdate() {}, onExit() {} });
  const state = new TerminalState();
  t.after(() => state.dispose());
  state.write('\x1b[?2004h', () => {});
  manager.sessions.set('test', { terminalState: state, submissions: new Map(), submitQueue: Promise.resolve() });
  const writes = [];
  manager.write = (_id, data) => writes.push(data);
  await Promise.all([manager.submit('test', 'one', '你好\n第二行'), manager.submit('test', 'one', '你好\n第二行'), manager.submit('test', 'two', 'next')]);
  assert.deepEqual(writes, ['\x1b[200~你好\n第二行\x1b[201~', '\r', '\x1b[200~next\x1b[201~', '\r']);
  await assert.rejects(manager.submit('test', 'one', 'different'), /提交编号重复/);
});

test('device discovery distinguishes usable, unauthorized and offline devices', () => {
  const rows = parseAndroidDevices('List of devices attached\r\nready device product:test\nlocked unauthorized\nasleep offline\n');
  assert.deepEqual(rows.map(row => [row.id, row.state, row.available]), [['ready', 'device', true], ['locked', 'unauthorized', false], ['asleep', 'offline', false]]);
});
