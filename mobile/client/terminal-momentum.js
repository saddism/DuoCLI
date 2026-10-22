(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DuoTerminalMomentum = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // xterm 的手机滚动走逐行 scrollLines，浏览器原生惯性被 preventDefault 拦掉了，
  // 松手即停很生硬。这里补两层纯逻辑：速度采样 + 指数衰减滑行，
  // 由调用方决定每帧位移落到哪个滚动面（实时区 / 历史层）。
  const DEFAULT_WINDOW_MS = 100;
  const DEFAULT_TAU_MS = 325;
  const DEFAULT_STOP_VELOCITY = 0.03;
  const DEFAULT_MIN_START_VELOCITY = 0.15;
  const DEFAULT_MAX_START_VELOCITY = 3.5;
  const DEFAULT_MAX_FRAME_MS = 64;

  function createPanVelocityTracker(options = {}) {
    const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    let samples = [];
    function prune(now) {
      // 窗口外的旧样本一律丢弃，只留最新一个；稀疏事件下自然失忆，
      // 避免一次中断的旧手势污染下一次松手速度。
      while (samples.length > 1 && now - samples[0].t > windowMs) samples.shift();
    }
    function move(delta, now) {
      const d = Number(delta) || 0;
      if (!d) return;
      const t = Number.isFinite(now) ? now : Date.now();
      prune(t);
      samples.push({ delta: d, t });
    }
    function velocity(now) {
      const t = Number.isFinite(now) ? now : Date.now();
      prune(t);
      if (samples.length < 2) return 0;
      const dt = samples[samples.length - 1].t - samples[0].t;
      if (dt <= 0) return 0;
      let sum = 0;
      for (const sample of samples) sum += sample.delta;
      return sum / dt;
    }
    function reset() { samples = []; }
    return { move, velocity, reset };
  }

  function createMomentumRunner(options = {}) {
    const tauMs = options.tauMs ?? DEFAULT_TAU_MS;
    const stopVelocity = options.stopVelocity ?? DEFAULT_STOP_VELOCITY;
    const minStartVelocity = options.minStartVelocity ?? DEFAULT_MIN_START_VELOCITY;
    const maxStartVelocity = options.maxStartVelocity ?? DEFAULT_MAX_START_VELOCITY;
    const maxFrameMs = options.maxFrameMs ?? DEFAULT_MAX_FRAME_MS;
    const raf = options.requestAnimationFrame ?? requestAnimationFrame.bind(globalThis);
    const cancelRaf = options.cancelAnimationFrame ?? cancelAnimationFrame.bind(globalThis);
    const apply = options.apply;
    const shouldContinue = options.shouldContinue;
    const onEnd = options.onEnd;
    let velocity = 0;
    let lastTs = null;
    let frame = null;
    let running = false;
    function step(ts) {
      frame = null;
      if (!running) return;
      const dt = lastTs == null ? 16 : Math.min(maxFrameMs, Math.max(1, ts - lastTs));
      lastTs = ts;
      apply(velocity * dt);
      velocity *= Math.exp(-dt / tauMs);
      if (Math.abs(velocity) < stopVelocity || (shouldContinue && !shouldContinue(velocity))) {
        const done = onEnd;
        stop();
        if (done) done();
        return;
      }
      frame = raf(step);
    }
    function start(initialVelocity) {
      stop();
      const v = Math.max(-maxStartVelocity, Math.min(maxStartVelocity, Number(initialVelocity) || 0));
      if (Math.abs(v) < minStartVelocity) return false;
      velocity = v;
      lastTs = null;
      running = true;
      frame = raf(step);
      return true;
    }
    function stop() {
      if (frame !== null) cancelRaf(frame);
      frame = null;
      running = false;
      velocity = 0;
      lastTs = null;
    }
    function active() { return running; }
    return { start, stop, active };
  }

  return {
    DEFAULT_TAU_MS,
    DEFAULT_STOP_VELOCITY,
    DEFAULT_MIN_START_VELOCITY,
    DEFAULT_MAX_START_VELOCITY,
    DEFAULT_WINDOW_MS,
    createPanVelocityTracker,
    createMomentumRunner,
  };
});
