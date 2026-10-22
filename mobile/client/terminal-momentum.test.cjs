const { test } = require('node:test');
const assert = require('node:assert/strict');
const momentum = require('./terminal-momentum.js');

function createClock() {
  let now = 0;
  return {
    advance(ms) { now += ms; },
    current() { return now; },
  };
}

function createFakeRaf() {
  const pending = new Map();
  let nextId = 1;
  return {
    requestAnimationFrame(callback) {
      const id = nextId++;
      pending.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) { pending.delete(id); },
    /** Run every pending frame with this timestamp; callbacks may queue more. */
    flush(ts) {
      let guard = 0;
      while (pending.size && guard++ < 1000) {
        const callbacks = [...pending.values()];
        pending.clear();
        for (const callback of callbacks) callback(ts);
      }
    },
    pendingCount: () => pending.size,
  };
}

test('tracker averages deltas over the trailing window', () => {
  const clock = createClock();
  const tracker = momentum.createPanVelocityTracker({ windowMs: 100 });
  assert.equal(tracker.velocity(clock.current()), 0, 'no samples yet');
  tracker.move(-30, clock.current());
  clock.advance(20);
  tracker.move(-30, clock.current());
  clock.advance(20);
  tracker.move(-30, clock.current());
  // -90px over 40ms, all samples inside the window.
  assert.ok(Math.abs(tracker.velocity(clock.current()) + 2.25) < 0.001,
    `got ${tracker.velocity(clock.current())}`);
  // Samples older than the window drop out: the 0ms one leaves first.
  clock.advance(90);
  tracker.move(-5, clock.current());
  // Remaining samples: -30 @ 40ms and -5 @ 130ms → -35px over 90ms.
  assert.ok(Math.abs(tracker.velocity(clock.current()) + 35 / 90) < 0.001,
    `got ${tracker.velocity(clock.current())}`);
  // Once everything is stale the tracker forgets the gesture entirely.
  clock.advance(200);
  assert.equal(tracker.velocity(clock.current()), 0);
  tracker.reset();
  assert.equal(tracker.velocity(clock.current()), 0);
});

test('tracker ignores a single sample and zero deltas', () => {
  const clock = createClock();
  const tracker = momentum.createPanVelocityTracker();
  tracker.move(0, clock.current());
  tracker.move(-50, clock.current());
  assert.equal(tracker.velocity(clock.current()), 0, 'one real sample is not a velocity');
});

test('runner rejects a slow release and never schedules frames', () => {
  const fake = createFakeRaf();
  const applied = [];
  const runner = momentum.createMomentumRunner({
    requestAnimationFrame: fake.requestAnimationFrame,
    cancelAnimationFrame: fake.cancelAnimationFrame,
    apply: delta => applied.push(delta),
  });
  assert.equal(runner.start(0.1), false, 'below min start velocity');
  assert.equal(fake.pendingCount(), 0);
  assert.deepEqual(applied, []);
  assert.equal(runner.active(), false);
});

test('runner coasts with exponential decay and stops on its own', () => {
  const fake = createFakeRaf();
  const applied = [];
  let ts = 0;
  const runner = momentum.createMomentumRunner({
    requestAnimationFrame: fake.requestAnimationFrame,
    cancelAnimationFrame: fake.cancelAnimationFrame,
    tauMs: 100,
    stopVelocity: 0.05,
    apply: delta => applied.push(delta),
    shouldContinue: () => true,
  });
  assert.equal(runner.start(1), true);
  assert.equal(fake.pendingCount(), 1);
  // 1px/ms * 325ms decay... tau 100ms: distance = sum v*dt ≈ v0 * tau = 100px.
  for (let i = 0; i < 60; i++) {
    ts += 16;
    fake.flush(ts);
    if (!runner.active()) break;
  }
  assert.equal(runner.active(), false, 'velocity decays below stop threshold');
  const total = applied.reduce((sum, delta) => sum + delta, 0);
  assert.ok(total > 60 && total < 130, `coast distance ${total}`);
  const signs = new Set(applied.map(delta => Math.sign(delta)));
  assert.deepEqual([...signs], [1], 'coast never reverses');
  assert.ok(applied[0] > applied[applied.length - 1], 'per-frame delta shrinks');
});

test('runner stops immediately when shouldContinue turns false and reports onEnd', () => {
  const fake = createFakeRaf();
  let allow = true;
  let ended = 0;
  const applied = [];
  const runner = momentum.createMomentumRunner({
    requestAnimationFrame: fake.requestAnimationFrame,
    cancelAnimationFrame: fake.cancelAnimationFrame,
    apply: delta => applied.push(delta),
    shouldContinue: () => allow,
    onEnd: () => { ended++; },
  });
  runner.start(-2);
  let ts = 100;
  fake.flush(ts);
  assert.equal(fake.pendingCount(), 1, 'still coasting');
  assert.ok(applied.length >= 1);
  allow = false;
  fake.flush(ts + 16);
  assert.equal(runner.active(), false);
  assert.equal(ended, 1, 'onEnd fires once');
  assert.equal(fake.pendingCount(), 0);
  // Restarting after a stop works and clamps to maxStartVelocity.
  allow = true;
  const seen = [];
  const clamped = momentum.createMomentumRunner({
    requestAnimationFrame: fake.requestAnimationFrame,
    cancelAnimationFrame: fake.cancelAnimationFrame,
    maxStartVelocity: 1,
    apply: delta => seen.push(delta),
    shouldContinue: () => false,
    onEnd: () => {},
  });
  assert.equal(clamped.start(9), true);
  ts += 16;
  fake.flush(ts);
  assert.ok(Math.abs(seen[0]) <= 1 * 16 + 0.001, `first frame ${seen[0]}`);
});

test('runner.stop cancels pending frames without firing onEnd', () => {
  const fake = createFakeRaf();
  let ended = 0;
  const runner = momentum.createMomentumRunner({
    requestAnimationFrame: fake.requestAnimationFrame,
    cancelAnimationFrame: fake.cancelAnimationFrame,
    apply: () => {},
    onEnd: () => { ended++; },
  });
  runner.start(1);
  runner.stop();
  assert.equal(fake.pendingCount(), 0);
  fake.flush(50);
  assert.equal(ended, 0);
});
