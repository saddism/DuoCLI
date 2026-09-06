(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DuoTerminalScrollHelpers = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function isAtBottom(viewportY, baseY) {
    // xterm exposes integer line positions. Even one line above baseY means the
    // user deliberately left the live edge and new output must not pull them down.
    return viewportY >= baseY;
  }

  function shouldFollowOutput(wasAtBottom, touchActive, startInteraction, currentInteraction) {
    return wasAtBottom && !touchActive && startInteraction === currentInteraction;
  }

  return { isAtBottom, shouldFollowOutput };
});
