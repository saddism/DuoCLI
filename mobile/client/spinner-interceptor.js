(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DuoSpinnerInterceptor = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Keep every original byte. WebSocket packets are not terminal frames;
  // filtering here would desync xterm across packet boundaries.
  function intercept(data) {
    return typeof data === 'string' && data.length ? data : null;
  }
  return { intercept };
});
