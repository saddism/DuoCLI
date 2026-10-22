(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DuoTerminalScrollHelpers = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // The live terminal keeps the same scrollback the server parser already
  // holds. Upward reading stays on this one surface. A second history layer is
  // only for a replay that was explicitly truncated, not for the last few screens.
  const SERVER_TERMINAL_SCROLLBACK = 5000;
  const LIVE_TERMINAL_SCROLLBACK = SERVER_TERMINAL_SCROLLBACK;
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

  // Codex 等全屏 TUI 没有 xterm 滚动缓存。滚轮若原样交给 xterm，会变成方向键，
  // 在 Codex 里变成翻提示历史，对话本身不动。这里把一段滑动换成翻页键。
  const ALT_SCREEN_PAGE_UP = '\u001b[5~';
  const ALT_SCREEN_PAGE_DOWN = '\u001b[6~';
  const ALT_SCREEN_MAX_PAGES = 4;

  function alternateScreenPageKeys(input) {
    const accumulated = Number(input?.accumulated) || 0;
    const deltaY = Number(input?.deltaY) || 0;
    if (input?.bufferType !== 'alternate') {
      return { data: '', remainder: accumulated };
    }
    const rowHeight = input.rowHeight > 0 ? input.rowHeight : 18;
    const rows = input.rows > 1 ? input.rows : 24;
    const pagePixels = Math.max(rowHeight * 4, rowHeight * rows * 0.34);
    // Reversing a gesture must respond immediately, not repay the old direction.
    let bank = (deltaY && accumulated * deltaY < 0 ? 0 : accumulated) + deltaY;
    let pages = 0;
    while (Math.abs(bank) >= pagePixels && Math.abs(pages) < ALT_SCREEN_MAX_PAGES) {
      const step = bank > 0 ? 1 : -1;
      pages += step;
      bank -= step * pagePixels;
    }
    if (input.flush && pages === 0 && Math.abs(bank) >= rowHeight * 2) {
      pages = bank > 0 ? 1 : -1;
      bank = 0;
    }
    const key = pages > 0 ? ALT_SCREEN_PAGE_DOWN : ALT_SCREEN_PAGE_UP;
    return { data: pages ? key.repeat(Math.abs(pages)) : '', remainder: bank };
  }

  function createAlternateScreenScroller(getScreen, send) {
    let accumulated = 0;
    let timer = null;
    function reset() {
      clearTimeout(timer);
      timer = null;
      accumulated = 0;
    }
    function scroll(deltaY, flush = false) {
      const screen = getScreen();
      if (screen?.bufferType !== 'alternate') { reset(); return false; }
      const result = alternateScreenPageKeys({ ...screen, deltaY, accumulated, flush });
      accumulated = result.remainder;
      if (result.data) send(result.data);
      return Boolean(result.data);
    }
    function wheel(deltaY) {
      clearTimeout(timer);
      const sent = scroll(deltaY);
      // A small trackpad gesture otherwise never reaches the page threshold.
      // Flush once when it ends; never carry its remainder into the next gesture.
      timer = setTimeout(() => { scroll(0, true); reset(); }, 90);
      return sent;
    }
    return { scroll, wheel, reset };
  }

  return {
    SERVER_TERMINAL_SCROLLBACK,
    LIVE_TERMINAL_SCROLLBACK,
    HISTORY_EDGE_LINES,
    ALT_SCREEN_PAGE_UP,
    ALT_SCREEN_PAGE_DOWN,
    isAtBottom,
    isAtHistoryEdge,
    shouldFollowOutput,
    isHistoryDirection,
    shouldRequestHistory,
    shouldFollowAfterLayout,
    alternateScreenPageKeys,
    createAlternateScreenScroller,
  };
});
