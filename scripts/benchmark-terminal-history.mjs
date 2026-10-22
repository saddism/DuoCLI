// Run after npm run build:main. This is a backend microbenchmark, not UI FPS.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
const require = createRequire(import.meta.url);
const { TerminalState } = require('../dist/main/terminal-state.js');
const seed = Array.from({ length: 4800 }, (_, i) => `history-${i} ${'.'.repeat(65)}\r\n`).join('');
async function measure(fullScan) {
  const state = new TerminalState();
  const write = data => new Promise(resolve => state.write(data, resolve));
  try {
    if (fullScan) {
      // Reproduce the pre-fix archive-extraction strategy, without reverting files.
      assert.equal(typeof state.syncHistory, 'function');
      state.syncHistory = () => state.history.syncFromBuffer(state.terminal.buffer.normal);
    }
    await write(seed);
    const started = performance.now();
    for (let i = 0; i < 60; i++) await write(`live-${i}\r\n`);
    return { elapsedMs: Math.round(performance.now() - started), historyCount: state.history.count,
      historyHash: createHash('sha256').update(JSON.stringify(state.history.getLines())).digest('hex') };
  } finally { state.dispose(); }
}
const beforeStrategy = await measure(true);
const incrementalStrategy = await measure(false);
assert.equal(incrementalStrategy.historyCount, beforeStrategy.historyCount);
assert.equal(incrementalStrategy.historyHash, beforeStrategy.historyHash);
console.log(JSON.stringify({ scenario: '4800 history rows + 60 sequential small writes',
  beforeStrategy, incrementalStrategy,
  speedup: Number((beforeStrategy.elapsedMs / Math.max(1, incrementalStrategy.elapsedMs)).toFixed(2)),
  note: 'Same-build strategy comparison; timings vary with system load. Not a browser frame-rate measurement.' }, null, 2));
