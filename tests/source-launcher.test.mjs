import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { launchSource } from '../scripts/source-launcher.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duocli-launch-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'launch.sock');
}
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test('concurrent desktop and remote opens share one build and focus the running client', async (t) => {
  const socketPath = fixture(t);
  const building = deferred();
  const finishBuild = deferred();
  const finishApp = deferred();
  const started = deferred();
  let focuses = 0;
  const focused = deferred();
  let builds = 0;
  let launches = 0;
  const first = launchSource({ socketPath,
    build: async () => { builds++; building.resolve(); await finishBuild.promise; },
    launch: async () => { launches++; started.resolve(); await finishApp.promise; },
    focus: () => { focuses++; focused.resolve(); },
  });
  await building.promise;
  assert.equal(await launchSource({ socketPath, build: () => assert.fail('duplicate build'), launch: () => assert.fail('duplicate client') }), 'already-running');
  finishBuild.resolve();
  await started.promise;
  assert.equal(await launchSource({ socketPath, build: () => assert.fail('duplicate build'), launch: () => assert.fail('duplicate client') }), 'already-running');
  await focused.promise;
  assert.equal(builds, 1);
  assert.equal(launches, 1);
  assert.ok(focuses > 0);
  finishApp.resolve();
  await first;
});

test('a failed build never launches old output and the next open can retry', async (t) => {
  const socketPath = fixture(t);
  await assert.rejects(launchSource({ socketPath,
    build: () => { throw new Error('compile failed'); },
    launch: () => assert.fail('stale output must not launch'),
  }), /compile failed/);
  const order = [];
  await launchSource({ socketPath, build: async () => { order.push('build'); }, launch: async () => { order.push('launch'); } });
  assert.deepEqual(order, ['build', 'launch']);
});

test('reopening after quit builds the newly changed local source', async (t) => {
  const socketPath = fixture(t);
  let source = 'first';
  let built;
  const launches = [];
  const options = { socketPath, build: async () => { built = source; }, launch: async () => { launches.push(built); } };
  await launchSource(options);
  source = 'changed';
  await launchSource(options);
  assert.deepEqual(launches, ['first', 'changed']);
});

test('concurrent opens recover an abandoned startup socket with one build', async (t) => {
  const socketPath = fixture(t);
  const abandoned = spawn(process.execPath, ['-e',
    'require("node:net").createServer().listen(process.argv[1], () => process.stdout.write("ready"))', socketPath,
  ], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { if (abandoned.exitCode == null && abandoned.signalCode == null) abandoned.kill(); });
  await once(abandoned.stdout, 'data');
  const exited = once(abandoned, 'exit');
  abandoned.kill();
  await exited;
  assert.ok(fs.existsSync(socketPath), 'simulate the socket left by an interrupted launcher');
  const built = deferred();
  const finish = deferred();
  let builds = 0;
  const options = { socketPath,
    build: async () => { builds++; built.resolve(); },
    launch: () => finish.promise,
  };
  const opens = [launchSource(options), launchSource(options)];
  await built.promise;
  // Wait for the second opener to join while the first client is still running.
  assert.equal(await Promise.race(opens), 'already-running');
  assert.equal(builds, 1);
  finish.resolve();
  await Promise.all(opens);
});

test('an unrelated file at the socket path is preserved', async (t) => {
  const socketPath = fixture(t);
  fs.writeFileSync(socketPath, 'preserve me');
  await assert.rejects(launchSource({ socketPath,
    build: () => assert.fail('must not build'), launch: () => assert.fail('must not launch'),
  }), /Unsafe launcher socket/);
  assert.equal(fs.readFileSync(socketPath, 'utf8'), 'preserve me');
});
