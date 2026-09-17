(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DuoTerminalHistoryLayer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEFAULT_ROW_HEIGHT = 18;
  const OVERSCAN = 8;
  const MAX_SELECTION_LINES = 200;

  const PALETTE = [
    '#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
    '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
  ];

  function xterm256(index) {
    const value = Math.max(0, Math.min(255, index | 0));
    if (value < 16) return PALETTE[value];
    if (value < 232) {
      const n = value - 16;
      const r = Math.floor(n / 36);
      const g = Math.floor((n % 36) / 6);
      const b = n % 6;
      const step = [0, 95, 135, 175, 215, 255];
      return `rgb(${step[r]},${step[g]},${step[b]})`;
    }
    const gray = 8 + (value - 232) * 10;
    return `rgb(${gray},${gray},${gray})`;
  }

  function colorOf(mode, value, fallback) {
    if (mode === 1 && Number.isInteger(value)) return xterm256(value);
    if (mode === 2 && Number.isInteger(value)) {
      const rgb = value >>> 0;
      return `rgb(${(rgb >> 16) & 255},${(rgb >> 8) & 255},${rgb & 255})`;
    }
    return fallback;
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function renderLineHtml(item) {
    const text = String(item?.text || '');
    const styles = Array.isArray(item?.styles) ? item.styles : [];
    if (!styles.length) return escapeHtml(text) || '&nbsp;';
    let html = '';
    let cursor = 0;
    for (const run of styles) {
      const start = Math.max(0, Math.min(text.length, run.start | 0));
      const end = Math.max(start, Math.min(text.length, run.end | 0));
      if (start > cursor) html += escapeHtml(text.slice(cursor, start));
      const fg = colorOf(run.fgMode, run.fg);
      const bg = colorOf(run.bgMode, run.bg);
      const flags = run.flags | 0;
      const css = [
        fg ? `color:${fg}` : '',
        bg ? `background:${bg}` : '',
        flags & 1 ? 'font-weight:700' : '',
        flags & 2 ? 'text-decoration:underline' : '',
        flags & 4 ? 'opacity:0.7' : '',
        flags & 16 ? 'font-style:italic' : '',
      ].filter(Boolean).join(';');
      const body = escapeHtml(text.slice(start, end)) || '&nbsp;';
      html += css ? `<span style="${css}">${body}</span>` : body;
      cursor = end;
    }
    if (cursor < text.length) html += escapeHtml(text.slice(cursor));
    return html || '&nbsp;';
  }

  function estimateRows(item, cols) {
    if (Array.isArray(item?.wraps) && item.wraps.length) return item.wraps.length + 1;
    const width = Math.max(8, cols || 80);
    return Math.max(1, Math.ceil(String(item?.text || ' ').length / width) || 1);
  }

  function itemKey(item) {
    return `${item.epoch}:${item.lineId}:${item.part || 0}`;
  }

  function captureAnchor(items, layout, scrollTop, rowHeight) {
    if (!items.length || !layout.length) return null;
    let index = 0;
    while (index + 1 < layout.length && layout[index + 1].top <= scrollTop) index++;
    const row = layout[index];
    const pixelOffset = Math.max(0, scrollTop - row.top);
    const charOffset = Math.floor(pixelOffset / Math.max(1, rowHeight)) * 1;
    return {
      lineId: row.item.lineId,
      part: row.item.part || 0,
      charOffset,
      pixelOffset,
    };
  }

  function restoreAnchorTop(layout, anchor) {
    if (!anchor || !layout.length) return 0;
    const row = layout.find(entry => (
      entry.item.lineId === anchor.lineId && (entry.item.part || 0) === (anchor.part || 0)
    )) || layout.find(entry => entry.item.lineId === anchor.lineId);
    if (!row) return 0;
    return Math.max(0, row.top + (anchor.pixelOffset || 0));
  }

  function mergeItems(existing, incoming) {
    const seen = new Set(existing.map(itemKey));
    const next = incoming.filter(item => {
      const key = itemKey(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return next.concat(existing);
  }

  function shouldEnterHistory(input) {
    const atHistoryEdge = Boolean(input?.noLocalHistory || (input?.viewportY ?? 0) <= 3);
    return Boolean(
      input?.explicitIntent
      && input?.hasMore
      && !input?.loading
      && !input?.touchActive
      && input?.bufferType !== 'alternate'
      && atHistoryEdge,
    );
  }

  function isHistoryDirection(deltaY) {
    return deltaY < 0;
  }

  function createHistoryLayer(options = {}) {
    const rowHeight = options.rowHeight || DEFAULT_ROW_HEIGHT;
    const onRequest = typeof options.onRequest === 'function' ? options.onRequest : () => {};
    const onBackToLive = typeof options.onBackToLive === 'function' ? options.onBackToLive : () => {};
    const onSelectionLimit = typeof options.onSelectionLimit === 'function' ? options.onSelectionLimit : () => {};

    const root = document.createElement('div');
    root.className = 'terminal-history-layer';
    root.hidden = true;
    root.setAttribute('inert', '');
    root.setAttribute('aria-hidden', 'true');

    const hint = document.createElement('div');
    hint.className = 'terminal-history-hint';

    const scroller = document.createElement('div');
    scroller.className = 'terminal-history-scroller';

    const spacer = document.createElement('div');
    spacer.className = 'terminal-history-spacer';

    const windowEl = document.createElement('div');
    windowEl.className = 'terminal-history-window';

    const liveBtn = document.createElement('button');
    liveBtn.type = 'button';
    liveBtn.className = 'terminal-history-live-btn';
    liveBtn.textContent = '有新输出 · 回到最新';
    liveBtn.hidden = true;

    scroller.appendChild(spacer);
    scroller.appendChild(windowEl);
    root.appendChild(hint);
    root.appendChild(scroller);
    root.appendChild(liveBtn);

    const state = {
      items: [],
      layout: [],
      cols: options.cols || 80,
      loading: false,
      hasMore: false,
      truncated: false,
      stale: false,
      visible: false,
      liveUnread: false,
      nextCursor: null,
      pinnedKeys: new Set(),
      requestId: 0,
    };

    function setHint() {
      if (state.loading) {
        hint.textContent = '正在加载更早输出…';
        hint.hidden = false;
        return;
      }
      if (state.stale) {
        hint.textContent = '历史游标已过期，请重新打开回看';
        hint.hidden = false;
        return;
      }
      if (state.truncated && !state.hasMore) {
        hint.textContent = '更早内容已不在本次终端缓存中';
        hint.hidden = false;
        return;
      }
      hint.textContent = '';
      hint.hidden = true;
    }

    const rowHeights = new Map();
    const rowNodes = new Map();
    let renderedWidth = 0;

    function layoutItems() {
      if (!state.items.length) {
        rowHeights.clear();
        rowNodes.clear();
        windowEl.textContent = '';
      }
      let top = 0;
      state.layout = state.items.map(item => {
        const height = rowHeights.get(itemKey(item)) || estimateRows(item, state.cols) * rowHeight;
        const entry = { item, top, height };
        top += height;
        return entry;
      });
      spacer.style.height = `${top}px`;
    }

    let renderRaf = 0;

    function renderWindow() {
      if (!state.visible) return;
      const width = scroller.clientWidth;
      if (width && renderedWidth !== width) {
        renderedWidth = width;
        rowHeights.clear();
        layoutItems();
      }
      const scrollTop = scroller.scrollTop;
      const viewH = scroller.clientHeight || rowHeight * 24;
      const start = scrollTop - OVERSCAN * rowHeight;
      const end = scrollTop + viewH + OVERSCAN * rowHeight;
      // Binary search the virtual window; scrolling must not scan every page.
      let low = 0;
      let high = state.layout.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        const row = state.layout[mid];
        if (row.top + row.height < start) low = mid + 1;
        else high = mid;
      }
      const visible = [];
      for (let i = low; i < state.layout.length && state.layout[i].top <= end; i++) {
        visible.push(state.layout[i]);
      }
      const selection = root.ownerDocument?.getSelection?.();
      if (!selection || selection.isCollapsed) state.pinnedKeys.clear();
      else {
        for (const [key, record] of rowNodes) {
          if (selection.containsNode(record.node, true) && state.pinnedKeys.size < MAX_SELECTION_LINES) {
            state.pinnedKeys.add(key);
          }
        }
      }
      const wanted = new Set(visible.map(entry => itemKey(entry.item)));
      if (state.pinnedKeys.size) {
        for (const entry of state.layout) {
          const key = itemKey(entry.item);
          if (state.pinnedKeys.has(key) && !wanted.has(key)) { visible.push(entry); wanted.add(key); }
        }
        visible.sort((a, b) => a.top - b.top);
      }
      for (const [key, record] of rowNodes) {
        if (!wanted.has(key)) { record.node.remove(); rowNodes.delete(key); }
      }
      windowEl.style.transform = 'translateY(0)';
      let before = windowEl.firstChild;
      for (const entry of visible) {
        const key = itemKey(entry.item);
        let record = rowNodes.get(key);
        if (!record) {
          const node = document.createElement('div');
          node.className = 'terminal-history-row';
          node.dataset.lineId = String(entry.item.lineId);
          node.dataset.part = String(entry.item.part || 0);
          node.style.cssText = `position:absolute;left:0;right:0;box-sizing:border-box;min-height:${rowHeight}px;line-height:${rowHeight}px`;
          node.innerHTML = renderLineHtml(entry.item);
          record = { node };
          rowNodes.set(key, record);
        }
        record.node.style.top = `${entry.top}px`;
        if (record.node === before) before = before.nextSibling;
        else windowEl.insertBefore(record.node, before);
      }
      // Server column counts are not CSS widths (especially on phones and
      // with CJK text). Measure only mounted rows and correct the spacer.
      const anchor = captureAnchor(state.items, state.layout, scroller.scrollTop, rowHeight);
      let changed = false;
      for (const entry of visible) {
        const key = itemKey(entry.item);
        const height = Math.max(rowHeight, rowNodes.get(key).node.getBoundingClientRect().height || entry.height);
        if (Math.abs(height - entry.height) > 0.5) changed = true;
        rowHeights.set(key, height);
      }
      if (changed) {
        layoutItems();
        for (const entry of state.layout) {
          const record = rowNodes.get(itemKey(entry.item));
          if (record) record.node.style.top = `${entry.top}px`;
        }
        if (anchor) scroller.scrollTop = restoreAnchorTop(state.layout, anchor);
        scheduleRenderWindow();
      }
    }

    function scheduleRenderWindow() {
      if (typeof requestAnimationFrame !== 'function') {
        renderWindow();
        return;
      }
      if (renderRaf) return;
      renderRaf = requestAnimationFrame(() => {
        renderRaf = 0;
        if (state.visible) renderWindow();
      });
    }

    function isScrollerAtBottom() {
      return scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8;
    }

    function scrollByPixels(deltaY) {
      const delta = Number(deltaY) || 0;
      if (delta === 0) return scroller.scrollTop;
      scroller.scrollTop = Math.max(0, scroller.scrollTop + delta);
      // A direct pan can reach an already-clamped boundary without emitting
      // a native scroll event. The upward gesture still requests older rows.
      if (delta < 0) maybeLoadMore();
      scheduleRenderWindow();
      return scroller.scrollTop;
    }

    function updateLiveBtn() {
      liveBtn.textContent = state.liveUnread ? '有新输出 · 回到最新' : '回到最新';
      liveBtn.hidden = !state.visible;
    }

    function refresh() {
      layoutItems();
      renderWindow();
      setHint();
      updateLiveBtn();
    }

    function maybeLoadMore() {
      if (!state.visible || state.loading || !state.hasMore) return;
      if (scroller.scrollTop > rowHeight * 3) return;
      requestMore();
    }

    function requestMore() {
      if (state.loading || !state.hasMore) return;
      state.loading = true;
      state.requestId += 1;
      setHint();
      onRequest({
        requestId: `h${state.requestId}`,
        beforeCursor: state.nextCursor,
      });
    }

    function show(meta = {}) {
      // Repeated wheel/touch events must not rewind the pagination cursor.
      if (state.visible) return;
      if (state.stale || (state.liveCursor !== undefined && meta.nextCursor !== undefined
          && state.liveCursor !== meta.nextCursor)) reset();
      if (!state.items.length && !state.loading) {
        state.hasMore = meta.hasMore !== false;
        state.nextCursor = meta.nextCursor ?? null;
        state.liveCursor = meta.nextCursor;
      }
      state.visible = true;
      root.hidden = false;
      root.removeAttribute('inert');
      root.setAttribute('aria-hidden', 'false');
      refresh();
      if (!state.items.length) requestMore();
    }

    function hide() {
      state.visible = false;
      root.hidden = true;
      root.setAttribute('inert', '');
      root.setAttribute('aria-hidden', 'true');
      state.liveUnread = false;
      updateLiveBtn();
    }

    function reset() {
      state.items = [];
      state.layout = [];
      state.loading = false;
      state.hasMore = false;
      state.truncated = false;
      state.stale = false;
      state.liveUnread = false;
      state.nextCursor = null;
      state.liveCursor = undefined;
      state.requestId += 1; // invalidate any response from before the reset
      state.pinnedKeys.clear();
      hide();
      refresh();
    }

    function prepend(page) {
      if (page?.requestId && page.requestId !== `h${state.requestId}`) {
        return { applied: false, ignored: true };
      }
      const anchor = captureAnchor(state.items, state.layout, scroller.scrollTop, rowHeight);
      state.loading = false;
      state.stale = Boolean(page?.stale);
      state.truncated = Boolean(page?.truncated);
      if (page?.stale) {
        state.hasMore = false;
        setHint();
        return { applied: false, stale: true };
      }
      const incoming = Array.isArray(page?.items) ? page.items : [];
      state.items = mergeItems(state.items, incoming);
      if (typeof page?.hasMore === 'boolean') state.hasMore = page.hasMore;
      if (page?.nextCursor !== undefined) state.nextCursor = page.nextCursor;
      // Set the new scroll extent and restore the reader's anchor BEFORE
      // rendering the virtual window. Otherwise a page briefly paints blank.
      layoutItems();
      const end = state.layout[state.layout.length - 1];
      scroller.scrollTop = anchor ? restoreAnchorTop(state.layout, anchor)
        : Math.max(0, (end ? end.top + end.height : 0) - scroller.clientHeight);
      renderWindow();
      setHint();
      updateLiveBtn();
      return { applied: true, stale: false, count: incoming.length };
    }

    function findText(text) {
      const needle = String(text || '').trim();
      if (!needle) return -1;
      return state.items.findIndex(item => item.text.includes(needle));
    }

    function scrollToItem(index) {
      const row = state.layout[index];
      if (!row) return false;
      scroller.scrollTop = row.top;
      return true;
    }

    let previousScrollTop = 0;
    let historyTouchY = null;
    let historyIntentUntil = 0;
    function noteOlderIntent() {
      historyIntentUntil = Date.now() + 600;
      maybeLoadMore();
    }
    scroller.addEventListener('scroll', () => {
      const movingOlder = scroller.scrollTop < previousScrollTop;
      previousScrollTop = scroller.scrollTop;
      scheduleRenderWindow();
      // Prepending and restoring an anchor is not another page request.
      if (movingOlder && Date.now() < historyIntentUntil) maybeLoadMore();
    }, { passive: true });
    scroller.addEventListener('selectstart', () => state.pinnedKeys.clear());
    scroller.addEventListener('touchstart', (event) => {
      historyTouchY = event.touches[0]?.clientY ?? null;
      event.stopPropagation();
    }, { capture: true, passive: true });
    scroller.addEventListener('touchmove', (event) => {
      const y = event.touches[0]?.clientY;
      if (historyTouchY != null && y > historyTouchY) noteOlderIntent();
      historyTouchY = y ?? null;
      event.stopPropagation();
    }, { capture: true, passive: true });
    scroller.addEventListener('touchend', (event) => {
      historyTouchY = null;
      event.stopPropagation();
    }, { capture: true, passive: true });
    scroller.addEventListener('wheel', (event) => {
      if (event.deltaY < 0) noteOlderIntent();
      event.stopPropagation();
    }, { capture: true, passive: true });
    scroller.tabIndex = 0;
    scroller.addEventListener('keydown', (event) => {
      if (event.key === 'PageUp' || event.key === 'ArrowUp' || event.key === 'Home') noteOlderIntent();
    });

    liveBtn.addEventListener('click', () => {
      state.liveUnread = false;
      onBackToLive();
    });

    return {
      root,
      state,
      show,
      hide,
      reset,
      prepend,
      requestMore,
      setCols(cols) {
        if (state.cols === cols && renderedWidth === scroller.clientWidth) return;
        state.cols = cols;
        rowHeights.clear();
        if (state.visible) {
          const anchor = captureAnchor(state.items, state.layout, scroller.scrollTop, rowHeight);
          layoutItems();
          if (anchor) scroller.scrollTop = restoreAnchorTop(state.layout, anchor);
          renderWindow();
        }
      },
      setLiveUnread(value) {
        state.liveUnread = Boolean(value);
        updateLiveBtn();
      },
      setLoading(value) {
        state.loading = Boolean(value);
        setHint();
      },
      setError(message) {
        state.loading = false;
        hint.textContent = String(message || '加载失败，继续向上滚动重试');
        hint.hidden = false;
      },
      captureAnchor() {
        return captureAnchor(state.items, state.layout, scroller.scrollTop, rowHeight);
      },
      restoreAnchor(anchor) {
        refresh();
        scroller.scrollTop = restoreAnchorTop(state.layout, anchor);
      },
      findText,
      scrollToItem,
      scrollByPixels,
      isAtBottom() {
        return isScrollerAtBottom();
      },
      isVisible() {
        return state.visible;
      },
      getItems() {
        return state.items.slice();
      },
    };
  }

  return {
    createHistoryLayer,
    captureAnchor,
    restoreAnchorTop,
    mergeItems,
    estimateRows,
    renderLineHtml,
    shouldEnterHistory,
    isHistoryDirection,
    itemKey,
  };
});
