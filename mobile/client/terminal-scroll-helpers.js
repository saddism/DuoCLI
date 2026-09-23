(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DuoTerminalScrollHelpers = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Live xterm keeps ~3 typical desktop screens locally (≈40 rows each). Older
  // rows live in the archive overlay. First paint must include this window so a
  // slight flick does not jump into history.
  const TYPICAL_DESKTOP_ROWS = 40;
  const LIVE_HISTORY_SCREENS = 3;
  const LIVE_TERMINAL_SCROLLBACK = TYPICAL_DESKTOP_ROWS * LIVE_HISTORY_SCREENS;
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
    TYPICAL_DESKTOP_ROWS,
    LIVE_HISTORY_SCREENS,
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
