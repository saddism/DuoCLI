(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DuoTerminalScrollHelpers = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Live xterm only keeps a few screens above the viewport. Older rows live in
  // the history archive and are shown by the overlay. 80 ≈ 3 screens on a
  // 24-row terminal; cheap to pan, enough to scroll with a finger/scrollbar.
  const LIVE_TERMINAL_SCROLLBACK = 80;
  const HISTORY_EDGE_LINES = 3;

  function isAtBottom(viewportY, baseY) {
    // xterm exposes integer line positions. Even one line above baseY means the
    // user deliberately left the live edge and new output must not pull them down.
    return viewportY >= baseY;
  }

  function isAtHistoryEdge(input) {
    return Boolean(input?.noLocalHistory || (input?.viewportY ?? 0) <= HISTORY_EDGE_LINES);
  }

  function shouldFollowOutput(wasAtBottom, touchActive, startInteraction, currentInteraction) {
    return wasAtBottom && !touchActive && startInteraction === currentInteraction;
  }

  function isHistoryDirection(deltaY) {
    return deltaY < 0;
  }

  function shouldRequestHistory(input) {
    return Boolean(
      input?.explicitIntent
      && input?.hasMore
      && !input?.loading
      && !input?.touchActive
      && input?.bufferType !== 'alternate'
      && isAtHistoryEdge(input),
    );
  }

  function shouldFollowAfterLayout(input) {
    return !input?.userScrolling
      && !input?.touchActive
      && !input?.historyVisible
      && !input?.alreadyAtBottom
      && !input?.firstLatestPaint;
  }

  return {
    LIVE_TERMINAL_SCROLLBACK,
    HISTORY_EDGE_LINES,
    isAtBottom,
    isAtHistoryEdge,
    shouldFollowOutput,
    isHistoryDirection,
    shouldRequestHistory,
    shouldFollowAfterLayout,
  };
});
