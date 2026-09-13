const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const helpers = require('./android-pointer-helpers.js');

const source = fs.readFileSync(require.resolve('./app.js'), 'utf8');
const geometry = source.slice(source.indexOf('function mirrorSurfaceSize('), source.indexOf('function fitAndroidSurface('));
const gestures = source.slice(source.indexOf('function legacyAndroidGesture('), source.indexOf('function setAndroidStreamStatus('));

function harness({ controller = true, fallback = false, controlReady = !fallback } = {}) {
  let now = 0;
  let timerId = 0;
  const timers = new Map();
  const sent = [];
  const requests = [];
  const hints = [];
  class Target {
    listeners = new Map();
    dataset = {};
    style = {};
    capture = new Set();
    width = 100;
    height = 200;
    addEventListener(name, handler) {
      const list = this.listeners.get(name) || [];
      list.push(handler);
      this.listeners.set(name, list);
    }
    emit(name, fields = {}) {
      const event = { pointerId: 1, pointerType: 'touch', button: 0, clientX: 20, clientY: 30,
        preventDefault() { this.defaultPrevented = true; }, ...fields };
      for (const handler of this.listeners.get(name) || []) handler(event);
      return event;
    }
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 200 }; }
    setPointerCapture(id) { this.capture.add(id); }
    hasPointerCapture(id) { return this.capture.has(id); }
    releasePointerCapture(id) { this.capture.delete(id); this.emit('lostpointercapture', { pointerId: id }); }
  }
  class Canvas extends Target {}
  const surface = fallback ? new Target() : new Canvas();
  const win = new Target();
  const doc = new Target();
  let ack = { ok: true };
  const mirror = {
    isController: controller, hasFrame: true, geometryVersion: 1, controlEpoch: 1,
    connectionGeneration: 1, ready: controlReady, claims: 0, width: 100, height: 200,
    isReady() { return this.ready; },
    claimControl() { this.claims++; },
    sendInput(input) {
      if (this.failAction === input.action) return null;
      sent.push({ ...input, time: now, epoch: this.controlEpoch });
      return sent.length;
    },
    sendEmergencyInput(input) { sent.push({ ...input, time: now, emergency: true }); return sent.length; },
    waitForAck() { return Promise.resolve(ack); },
  };
  const context = vm.createContext({
    DuoAndroidPointerHelpers: helpers, HTMLCanvasElement: Canvas,
    androidMirror: mirror, androidMirrorDevice: 'phone', androidMediaSessions: new Map(),
    remoteTapEnabled: true, API: '', token: '', window: win, document: doc,
    performance: { now: () => now },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch(url, options) { requests.push({ url, body: JSON.parse(options.body) }); return Promise.resolve({ ok: true }); },
    setDeviceHint: message => hints.push(message), $: () => null,
  });
  vm.runInContext(geometry + gestures, context);
  context.bindAndroidPointerSurface(surface, true);
  const advance = ms => {
    const end = now + ms;
    while (true) {
      const next = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
    }
    now = end;
  };
  return { surface, mirror, win, doc, sent, requests, hints, advance, context,
    rejectAck: () => { ack = { ok: false, error: 'rejected' }; } };
}

const actions = h => h.sent.map(input => input.action);

test('long press sends DOWN while held and preserves its duration', () => {
  const h = harness();
  h.surface.emit('pointerdown');
  assert.deepEqual(actions(h), ['down']);
  h.advance(750);
  assert.deepEqual(actions(h), ['down']);
  h.surface.emit('pointerup');
  assert.deepEqual(actions(h), ['down', 'up']);
  assert.equal(h.sent[1].time - h.sent[0].time, 750);
});

test('first drag starts as soon as ownership arrives while still held', () => {
  const h = harness({ controller: false });
  h.surface.emit('pointerdown');
  h.advance(100);
  h.mirror.isController = true;
  h.advance(16);
  assert.deepEqual(actions(h), ['down']);
  h.advance(600);
  h.surface.emit('pointermove', { clientX: 60, clientY: 90 });
  h.advance(130);
  assert.deepEqual(actions(h), ['down', 'move']);
  h.surface.emit('pointerup', { clientX: 60, clientY: 90 });
  h.advance(130);
  assert.deepEqual(actions(h), ['down', 'move', 'up']);
  assert.equal(h.mirror.claims, 1);
});

test('gesture completed before control grant replays path and hold timing', () => {
  const h = harness({ controller: false });
  h.surface.emit('pointerdown');
  h.advance(550);
  h.surface.emit('pointermove', { clientX: 50 });
  h.advance(100);
  h.surface.emit('pointerup', { clientX: 80 });
  h.advance(50);
  h.mirror.isController = true;
  h.advance(16);
  assert.deepEqual(actions(h), ['down']);
  h.advance(700);
  assert.deepEqual(actions(h), ['down', 'move', 'move', 'up']);
  assert.ok(h.sent[1].time - h.sent[0].time >= 550);
  assert.ok(h.sent[3].time - h.sent[0].time >= 650);
  assert.equal(h.requests.length, 0);
});

test('fast drag flushes pending MOVE and final position before UP', () => {
  const h = harness();
  h.surface.emit('pointerdown');
  h.advance(2);
  h.surface.emit('pointermove', { clientX: 50 });
  h.advance(2);
  h.surface.emit('pointerup', { clientX: 90 });
  assert.deepEqual(actions(h), ['down', 'move', 'up']);
  assert.equal(h.sent[1].x, 89);
  assert.equal(h.sent[2].x, 89);
});

test('captured drags clamp to the edge and new presses outside are ignored', () => {
  const h = harness();
  h.surface.emit('pointerdown', { clientX: -10 });
  assert.equal(h.sent.length, 0);
  h.surface.emit('pointerdown');
  h.advance(20);
  h.surface.emit('pointermove', { clientX: 400, clientY: -50 });
  h.advance(20);
  h.surface.emit('pointerup', { clientX: 400, clientY: -50 });
  assert.deepEqual(actions(h), ['down', 'move', 'up']);
  assert.equal(h.sent[1].x, 99);
  assert.equal(h.sent[1].y, 0);
});

for (const reason of ['blur', 'pointercancel', 'lostpointercapture', 'hidden']) {
  test(`${reason} releases contact exactly once and cancels delayed input`, () => {
    const h = harness();
    h.surface.emit('pointerdown');
    if (reason === 'blur') h.win.emit('blur');
    else if (reason === 'hidden') { h.doc.visibilityState = 'hidden'; h.doc.emit('visibilitychange'); }
    else h.surface.emit(reason);
    h.advance(100);
    h.surface.emit('pointerup');
    assert.deepEqual(actions(h), ['down', 'cancel']);
    const waiting = harness({ controller: false });
    waiting.surface.emit('pointerdown');
    waiting.win.emit('blur');
    waiting.mirror.isController = true;
    waiting.advance(100);
    assert.deepEqual(actions(waiting), []);
  });
}

for (const change of ['controlEpoch', 'connectionGeneration', 'geometryVersion']) {
  test(`${change} invalidates a gesture without replaying it via ADB`, () => {
    const h = harness();
    h.surface.emit('pointerdown');
    h.mirror[change]++;
    h.advance(20);
    h.surface.emit('pointerup');
    assert.deepEqual(actions(h), change === 'geometryVersion' ? ['down', 'cancel'] : ['down']);
    assert.equal(h.requests.length, 0);
  });
}

test('failed UP triggers emergency release', () => {
  const h = harness();
  h.surface.emit('pointerdown');
  h.mirror.failAction = 'up';
  h.surface.emit('pointerup');
  assert.deepEqual(actions(h), ['down', 'cancel']);
});

test('rejected DOWN ack cancels held input and surfaces the failure', async () => {
  const h = harness();
  h.rejectAck();
  h.surface.emit('pointerdown');
  await Promise.resolve();
  assert.deepEqual(actions(h), ['down', 'cancel']);
  assert.ok(h.hints.includes('rejected'));
});

test('rejected UP ack still releases contact after the browser gesture ended', async () => {
  const h = harness();
  h.surface.emit('pointerdown');
  await Promise.resolve();
  h.rejectAck();
  h.surface.emit('pointerup');
  await Promise.resolve();
  assert.deepEqual(actions(h), ['down', 'up', 'cancel']);
});

test('an old rejected ack cannot release a newer contact using the same pointer ID', async () => {
  const h = harness();
  const acks = [];
  h.mirror.waitForAck = () => new Promise(resolve => acks.push(resolve));
  h.surface.emit('pointerdown');
  h.surface.emit('pointerup');
  h.surface.emit('pointerdown');
  acks[1]({ ok: false, error: 'old UP failed' });
  await Promise.resolve();
  assert.deepEqual(actions(h), ['down', 'up', 'down']);
  h.surface.emit('pointerup');
  assert.deepEqual(actions(h), ['down', 'up', 'down', 'up']);
});

test('claim timeout never injects an unauthorized fallback gesture', () => {
  const h = harness({ controller: false });
  h.surface.emit('pointerdown');
  h.surface.emit('pointerup');
  h.advance(3100);
  assert.equal(h.sent.length, 0);
  assert.equal(h.requests.length, 0);
  assert.ok(h.hints.some(hint => hint.includes('未取得')));
});

test('first tap survives the server takeover window and network delay', () => {
  const h = harness({ controller: false });
  h.surface.emit('pointerdown');
  h.advance(60);
  h.surface.emit('pointerup');
  h.advance(1740);
  h.mirror.isController = true;
  h.advance(100);
  assert.deepEqual(actions(h), ['down', 'up']);
  assert.equal(h.requests.length, 0);
});

test('fallback long press uses a stationary swipe with measured duration', () => {
  const h = harness({ fallback: true });
  h.surface.emit('pointerdown');
  h.advance(800);
  h.surface.emit('pointerup');
  assert.equal(h.requests[0].url, '/api/android/swipe');
  assert.equal(h.requests[0].body.duration, 800);
  assert.equal(h.requests[0].body.x1, h.requests[0].body.x2);
  assert.equal(h.sent.length, 0);
});

test('JPEG/image fallback streams live touch in encoded coordinates when control is available', () => {
  const h = harness({ fallback: true, controlReady: true });
  h.mirror.hasFrame = false;
  h.mirror.width = 200;
  h.mirror.height = 400;
  Object.assign(h.surface.dataset, { fallbackDeviceWidth: '1000', fallbackDeviceHeight: '2000' });
  h.surface.emit('pointerdown', { clientX: 50, clientY: 100 });
  assert.deepEqual(actions(h), ['down']);
  assert.equal(h.sent[0].x, 100);
  assert.equal(h.sent[0].y, 200);
  h.advance(600);
  h.surface.emit('pointermove', { clientX: 75, clientY: 150 });
  h.advance(20);
  h.surface.emit('pointerup', { clientX: 75, clientY: 150 });
  assert.deepEqual(actions(h), ['down', 'move', 'up']);
  assert.equal(h.sent[1].x, 149);
  assert.equal(h.sent[1].y, 299);
  assert.equal(h.requests.length, 0);
});

test('fallback picture from a different orientation cannot inject into the live geometry', () => {
  const h = harness({ fallback: true, controlReady: true });
  h.mirror.width = 200;
  h.mirror.height = 100;
  h.surface.emit('pointerdown');
  h.surface.emit('pointerup');
  assert.equal(h.sent.length, 0);
  assert.equal(h.requests.length, 0);
});

test('fallback tap and drag use their original transport and physical geometry', () => {
  const h = harness({ fallback: true });
  Object.assign(h.surface.dataset, { fallbackDeviceWidth: '1000', fallbackDeviceHeight: '2000' });
  h.surface.emit('pointerdown', { clientX: 50, clientY: 100 });
  h.advance(60);
  h.surface.emit('pointerup', { clientX: 50, clientY: 100 });
  assert.equal(h.requests[0].url, '/api/android/tap');
  assert.equal(h.requests[0].body.x, 500);
  h.surface.emit('pointerdown');
  h.advance(450);
  h.surface.emit('pointerup', { clientX: 80 });
  assert.equal(h.requests[1].body.duration, 450);
  assert.equal(h.sent.length, 0);
});

test('browser context menu and native image drag are suppressed on control surfaces', () => {
  const h = harness();
  assert.ok(h.surface.emit('contextmenu').defaultPrevented);
  assert.ok(h.surface.emit('dragstart').defaultPrevented);
});
