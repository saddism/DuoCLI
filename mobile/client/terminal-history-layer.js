(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DuoTerminalHistoryLayer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEFAULT_ROW_HEIGHT = 18;
  const OVERSCAN = 8;
  const MAX_SELECTION_LINES = 200;
  const MAX_SEEK_PAGES = 64;

  const PALETTE = [
    '#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
    '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
  ];
  const THEME_KEYS = [
    'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
  ];

  function xterm256(index, palette) {
    const value = Math.max(0, Math.min(255, index | 0));
    const colors = palette && palette.length >= 16 ? palette : PALETTE;
    if (value < 16) return colors[value];
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

  function normalizeColorMode(mode) {
    const value = Number(mode);
    if (!Number.isFinite(value) || value <= 0) return 0;
    if (value <= 3) return value;
    return ((value >>> 0) & 0x3000000) >>> 24;
  }

  function colorOf(mode, value, palette) {
    const normalized = normalizeColorMode(mode);
    if ((normalized === 1 || normalized === 2) && Number.isInteger(value)) return xterm256(value, palette);
    if (normalized === 3 && Number.isInteger(value)) {
      const rgb = value >>> 0;
      return `rgb(${(rgb >> 16) & 255},${(rgb >> 8) & 255},${rgb & 255})`;
    }
    return '';
  }

  function themePalette(theme) {
    if (!theme) return PALETTE.slice();
    return THEME_KEYS.map((key, index) => theme[key] || PALETTE[index]);
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function renderLineHtml(item, palette) {
    const text = String(item?.text || '');
    const styles = Array.isArray(item?.styles) ? item.styles : [];
    if (!styles.length) return escapeHtml(text) || '&nbsp;';
    let html = '';
    let cursor = 0;
    for (const run of styles) {
      const start = Math.max(0, Math.min(text.length, run.start | 0));
      const end = Math.max(start, Math.min(text.length, run.end | 0));
      if (start > cursor) html += escapeHtml(text.slice(cursor, start));
      let fg = colorOf(run.fgMode, run.fg, palette);
      let bg = colorOf(run.bgMode, run.bg, palette);
      const flags = run.flags | 0;
      if (flags & 8) {
        const nextFg = bg || 'var(--terminal-history-background, #000)';
        const nextBg = fg || 'var(--terminal-history-foreground, #ccc)';
        fg = nextFg;
        bg = nextBg;
      }
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
    const edgeLines = Number.isInteger(input?.edgeLines) ? input.edgeLines : 3;
    const atHistoryEdge = Boolean(input?.noLocalHistory || (input?.viewportY ?? 0) <= edgeLines);
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

  // Keep a real view of the live edge below older pages, rather than swapping
  // the entire screen for an unrelated history document on the first wheel.
  function captureLiveEdge(terminal, host) {
    if (!terminal?.element || !host || terminal.buffer.active.type !== 'normal') return null;
    const element = terminal.element;
    const rect = element.getBoundingClientRect();
    const bounds = host.getBoundingClientRect();
    if (!rect.width || !rect.height || !bounds.height) return null;
    const screen = element.querySelector('.xterm-screen');
    const screenRect = screen?.getBoundingClientRect();
    const rowsRect = element.querySelector('.xterm-rows')?.getBoundingClientRect() || screenRect;
    const preview = element.cloneNode(true);
    // A visual continuation, not a second interactive terminal or accessibility tree.
    preview.removeAttribute('id');
    preview.setAttribute('aria-hidden', 'true');
    preview.removeAttribute('inert');
    preview.classList.add('terminal-history-preview');
    preview.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
    preview.querySelectorAll('textarea, .xterm-accessibility, .xterm-helpers').forEach(node => node.remove());
    const originals = element.querySelectorAll('canvas');
    preview.querySelectorAll('canvas').forEach((canvas, index) => {
      if (originals[index]) canvas.getContext('2d')?.drawImage(originals[index], 0, 0);
    });
    const originalViewports = element.querySelectorAll('.xterm-viewport');
    preview.querySelectorAll('.xterm-viewport').forEach((node, index) => {
      node.scrollTop = originalViewports[index]?.scrollTop || 0;
    });
    Object.assign(preview.style, { position: 'absolute', left: (rect.left - bounds.left) + 'px',
      top: (rect.top - bounds.top) + 'px', width: rect.width + 'px', height: rect.height + 'px',
      margin: '0', pointerEvents: 'auto', userSelect: 'text', visibility: 'visible', opacity: '1' });
    const buffer = terminal.buffer.normal;
    const local = [];
    // Rows from the current viewport down to the live edge. The archive also
    // has these lines; they stay in the native buffer and must not be painted again.
    for (let row = buffer.viewportY; row < buffer.baseY; row++) {
      const line = buffer.getLine(row);
      const text = line?.translateToString(true) || '';
      if (line?.isWrapped && local.length) local[local.length - 1].text += text;
      else local.push({ text, partial: row === buffer.viewportY && Boolean(line?.isWrapped) });
    }
    const screenLines = [];
    const screenEnd = Math.min(buffer.length, buffer.viewportY + terminal.rows);
    for (let row = buffer.viewportY; row < screenEnd; row++) {
      const line = buffer.getLine(row);
      const text = line?.translateToString(true) || '';
      if (line?.isWrapped && screenLines.length) screenLines[screenLines.length - 1].text += text;
      else screenLines.push({ text, partial: row === buffer.viewportY && Boolean(line?.isWrapped) });
    }
    let marker;
    try { marker = terminal.registerMarker(buffer.viewportY - buffer.baseY - buffer.cursorY); } catch {}
    return { preview, terminal, local, screen: screenLines, viewportY: buffer.viewportY, marker,
      height: bounds.height, rowHeight: screenRect?.height / terminal.rows || DEFAULT_ROW_HEIGHT,
      gridWidth: rowsRect?.width || rect.width,
      paddingLeft: Math.max(0, (rowsRect?.left || rect.left) - bounds.left),
      paddingRight: Math.max(0, bounds.right - (rowsRect?.right || rect.right)),
      background: terminal.options.theme?.background || getComputedStyle(element.querySelector('.xterm-viewport') || element).backgroundColor,
      foreground: terminal.options.theme?.foreground || getComputedStyle(element).color,
      fontFamily: terminal.options.fontFamily, fontSize: terminal.options.fontSize };
  }

  function lineText(value) {
    return String(value?.text ?? value ?? '').replace(/\s+$/g, '');
  }

  function sameEdgeLine(archiveText, localLine, allowPartial) {
    const left = lineText({ text: archiveText });
    const right = lineText(localLine);
    if (left === right) return true;
    return Boolean(allowPartial && right && left.endsWith(right));
  }

  function groupsOf(items) {
    const groups = [];
    items.forEach((item, index) => {
      let group = groups[groups.length - 1];
      if (!group || group.id !== item.lineId) {
        group = { id: item.lineId, start: index, text: '' };
        groups.push(group);
      }
      group.text += item.text;
    });
    return groups;
  }

  function beforeLiveEdge(items, local) {
    if (!local.length) return null;
    // Archive pages are logical lines and can contain fragments. Match the
    // retained native scrollback once, then omit its duplicate archive suffix.
    const groups = groupsOf(items);
    for (let start = groups.length - local.length; start >= 0; start--) {
      if (!local.every((line, offset) => {
        const text = groups[start + offset]?.text;
        return offset === 0 && line.partial ? text?.endsWith(line.text) : text === line.text;
      })) continue;
      const group = groups[start];
      const result = items.slice(0, group.start);
      // Preserve the older portion of a logical line cut by the native ring.
      const prefix = local[0].partial ? group.text.slice(0, -local[0].text.length) : '';
      if (prefix) {
        const item = items[group.start];
        result.push({ ...item, text: prefix, wraps: (item.wraps || []).filter(offset => offset < prefix.length),
          styles: (item.styles || []).filter(run => run.start < prefix.length).map(run => ({ ...run, end: Math.min(run.end, prefix.length) })) });
      }
      return result;
    }
    // The native scrollback is often longer than the pages fetched so far, and
    // the newest archive rows can be the visible screen past that scrollback.
    // Align the end of the native lines with the newest archive rows that match,
    // then drop that suffix so it is not drawn again above the live preview.
    const maxExtra = Math.min(groups.length, 80);
    for (let extra = 0; extra <= maxExtra; extra++) {
      const end = groups.length - extra;
      if (end <= 0) break;
      let matched = 0;
      while (matched < end && matched < local.length) {
        const localLine = local[local.length - 1 - matched];
        const archiveText = groups[end - 1 - matched].text;
        const allowPartial = local.length - 1 - matched === 0 && Boolean(localLine.partial);
        if (!sameEdgeLine(archiveText, localLine, allowPartial)) break;
        matched++;
      }
      const blank = matched > 0 && Array.from({ length: matched }, (_, offset) => (
        lineText(local[local.length - 1 - offset]) === ''
      )).every(Boolean);
      const tail = lineText({ text: groups[end - 1].text });
      const confident = matched >= 4 || (matched >= 2 && !blank) || (matched === 1 && !blank && tail.length >= 8);
      if (!confident) continue;
      const start = end - matched;
      if (start <= 0) return [];
      return items.slice(0, groups[start].start);
    }
    return null;
  }

  function wheelPixels(event, rowHeight, pageHeight) {
    return (Number(event.deltaY) || 0) * (event.deltaMode === 1 ? rowHeight : event.deltaMode === 2 ? pageHeight : 1);
  }

  function createHistoryLayer(options = {}) {
    let rowHeight = options.rowHeight || DEFAULT_ROW_HEIGHT;
    let ansiPalette = PALETTE.slice();
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

    const liveEdge = document.createElement('div');
    liveEdge.className = 'terminal-history-live-edge';
    scroller.appendChild(liveEdge);
    let edge = null;
    let seamPages = [];
    let seamResolved = false;
    let seamRequests = 0;
    let pendingPixels = 0;
    let archiveHeight = 0;
    let liveIntentUntil = 0;
    let seekTextValue = '';
    let seekResolve = null;
    let seekPages = 0;

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
      liveRevision: undefined,
      pinnedKeys: new Set(),
      requestId: 0,
      clipboardBound: false,
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
      archiveHeight = top;
      // While the seam is still loading, slide the live preview with the gesture
      // instead of freezing the current screen until the archive arrives.
      const pendingShift = edge && !seamResolved ? Math.max(0, -pendingPixels) : 0;
      const edgeHeight = edge ? (scroller.clientHeight || edge.height || 0) : 0;
      liveEdge.style.top = `${top + pendingShift}px`;
      liveEdge.style.height = `${edgeHeight}px`;
      spacer.style.height = `${top + pendingShift + edgeHeight}px`;
    }

    let renderRaf = 0;

    function renderWindow() {
      if (!state.visible) return;
      const width = scroller.clientWidth;
      if (width && renderedWidth !== width) {
        renderedWidth = width;
        if (edge) root.style.setProperty('--terminal-history-padding-right', Math.max(0, width - edge.paddingLeft - edge.gridWidth) + 'px');
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
          node.innerHTML = renderLineHtml(entry.item, ansiPalette);
          record = { node };
          rowNodes.set(key, record);
        }
        record.node.style.top = `${entry.top}px`;
        if (record.node === before) before = before.nextSibling;
        else windowEl.insertBefore(record.node, before);
      }
      // Server column counts are not CSS widths (especially on phones and
      // with CJK text). Measure only mounted rows and correct the spacer.
      const liveOffset = edge && scroller.scrollTop >= archiveHeight ? scroller.scrollTop - archiveHeight : null;
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
        if (liveOffset !== null) scroller.scrollTop = archiveHeight + liveOffset;
        else if (anchor) scroller.scrollTop = restoreAnchorTop(state.layout, anchor);
        previousScrollTop = scroller.scrollTop;
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

    function refreshLivePreview() {
      const previous = edge;
      if (!previous || !state.visible) return;
      requestAnimationFrame(() => {
        if (edge !== previous || !state.visible) return;
        const refreshed = captureLiveEdge(options.getTerminal?.(), root.parentElement);
        if (!refreshed) return;
        const top = scroller.scrollTop;
        previous.marker?.dispose();
        edge = { ...refreshed, local: previous.local, screen: previous.screen };
        liveEdge.replaceChildren(edge.preview);
        layoutItems();
        scroller.scrollTop = top;
        previousScrollTop = scroller.scrollTop;
        renderWindow();
      });
    }

    function resumeLive(remaining = 0) {
      if (!state.visible) return;
      const current = edge;
      const viewportY = current?.marker && !current.marker.isDisposed ? current.marker.line : current?.viewportY;
      hide();
      if (current && typeof options.onResumeLive === 'function') {
        options.onResumeLive({ viewportY: Math.max(0, viewportY || 0), deltaY: Math.max(0, remaining), rowHeight });
      } else onBackToLive();
    }

    function viewingLiveEdge() {
      if (!edge || !state.visible) return false;
      const height = scroller.clientHeight || edge.height || 0;
      if (!height) return false;
      const top = seamResolved ? archiveHeight : Math.max(0, -pendingPixels);
      const viewTop = scroller.scrollTop;
      const viewBottom = viewTop + height;
      return viewBottom > top + 8 && viewTop < top + height - 8;
    }

    function noteLiveOutput() {
      if (!state.visible) return;
      const selection = root.ownerDocument?.getSelection?.();
      const selectingPreview = Boolean(selection && !selection.isCollapsed && liveEdge.contains(selection.anchorNode));
      if (viewingLiveEdge() && !selectingPreview) {
        refreshLivePreview();
        return;
      }
      state.liveUnread = true;
      updateLiveBtn();
    }

    function scrollByPixels(deltaY) {
      const delta = Number(deltaY) || 0;
      if (delta === 0) return scroller.scrollTop;
      if (edge && !seamResolved) {
        const limit = (scroller.clientHeight || edge.height || 480) * 8;
        pendingPixels = Math.max(-limit, pendingPixels + delta);
        if (delta < 0) maybeLoadMore();
        if (pendingPixels >= -0.5) {
          const extra = Math.max(0, pendingPixels);
          pendingPixels = 0;
          layoutItems();
          resumeLive(extra);
          return 0;
        }
        layoutItems();
        scroller.scrollTop = 0;
        previousScrollTop = 0;
        updateLiveBtn();
        return scroller.scrollTop;
      }
      if (delta > 0 && scroller.scrollTop + delta >= Math.max(0, scroller.scrollHeight - scroller.clientHeight) - 0.5) {
        const remaining = scroller.scrollTop + delta - Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        resumeLive(remaining);
        return 0;
      }
      scroller.scrollTop = Math.max(0, scroller.scrollTop + delta);
      // A direct pan can reach an already-clamped boundary without emitting
      // a native scroll event. The upward gesture still requests older rows.
      if (delta < 0) maybeLoadMore();
      updateLiveBtn();
      scheduleRenderWindow();
      return scroller.scrollTop;
    }

    function updateLiveBtn() {
      liveBtn.textContent = state.liveUnread ? '有新输出 · 回到最新' : '回到最新';
      const distance = Math.max(0, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop);
      liveBtn.hidden = !state.visible || (edge && !state.liveUnread && distance < (scroller.clientHeight || edge.height) * 0.8);
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
      if (seekTextValue && seekPages >= MAX_SEEK_PAGES) {
        finishSeek(-1);
        return;
      }
      state.loading = true;
      state.requestId += 1;
      if (seekTextValue) seekPages += 1;
      setHint();
      onRequest({
        requestId: `h${state.requestId}`,
        beforeCursor: state.nextCursor,
        force: Boolean(seekTextValue),
      });
    }

    function show(meta = {}) {
      // Repeated wheel/touch events must not rewind the pagination cursor.
      if (state.visible) return;
      const boundaryChanged = state.stale
        || (state.liveCursor !== undefined && meta.nextCursor !== undefined
          && state.liveCursor !== meta.nextCursor)
        || (state.liveRevision !== undefined && meta.revision !== undefined
          && state.liveRevision !== meta.revision);
      const terminal = options.getTerminal?.();
      const reuse = state.items.length > 0 && !boundaryChanged;
      if (boundaryChanged || (terminal && !reuse)) reset();
      if (terminal) {
        edge = captureLiveEdge(terminal, root.parentElement);
        if (edge) {
          rowHeight = edge.rowHeight;
          ansiPalette = themePalette(terminal.options?.theme);
          root.classList.add('is-continuous');
          root.style.setProperty('--terminal-history-background', edge.background);
          root.style.setProperty('--terminal-history-foreground', edge.foreground);
          root.style.setProperty('--terminal-history-font-family', edge.fontFamily);
          root.style.setProperty('--terminal-history-font-size', edge.fontSize + 'px');
          root.style.setProperty('--terminal-history-padding-left', edge.paddingLeft + 'px');
          root.style.setProperty('--terminal-history-padding-right', edge.paddingRight + 'px');
          liveEdge.appendChild(edge.preview);
          pendingPixels = Math.min(0, Number(meta.deltaY) || 0);
          seamPages = []; seamResolved = reuse; seamRequests = 0;
        }
      }
      if (!state.items.length && !state.loading) {
        state.hasMore = meta.hasMore !== false;
        // A live snapshot's cursor can lag behind output produced afterward.
        // Start a fresh page at the server's current edge.
        state.nextCursor = terminal ? null : meta.nextCursor ?? null;
        state.liveCursor = meta.nextCursor;
      }
      state.liveRevision = meta.revision;
      state.visible = true;
      root.hidden = false;
      root.removeAttribute('inert');
      root.setAttribute('aria-hidden', 'false');
      refresh();
      if (reuse && edge) {
        scroller.scrollTop = Math.max(0, archiveHeight + pendingPixels);
        previousScrollTop = scroller.scrollTop;
        renderWindow();
        updateLiveBtn();
      }
      if (!state.items.length) requestMore();
      try { terminal?.clearSelection?.(); } catch { /* unmounted renderer */ }
      bindHistoryClipboard();
    }

    function hide() {
      unbindHistoryClipboard();
      state.visible = false;
      edge?.marker?.dispose();
      edge = null;
      liveEdge.textContent = '';
      liveEdge.style.height = '0px';
      root.classList.remove('is-continuous');
      root.hidden = true;
      root.setAttribute('inert', '');
      root.setAttribute('aria-hidden', 'true');
      state.liveUnread = false;
      finishSeek(-1);
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
      state.liveRevision = undefined;
      state.requestId += 1; // invalidate any response from before the reset
      state.pinnedKeys.clear();
      seamPages = []; seamResolved = false; pendingPixels = 0; archiveHeight = 0;
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
        continueSeekAfterPage();
        return { applied: false, stale: true };
      }
      let incoming = Array.isArray(page?.items) ? page.items : [];
      const opening = edge && !seamResolved;
      if (opening) {
        seamPages = mergeItems(seamPages, incoming);
        let before = edge.local?.length ? beforeLiveEdge(seamPages, edge.local) : null;
        if (!edge.local?.length && edge.screen?.length) before = beforeLiveEdge(seamPages, edge.screen);
        if ((before === null || !before.length) && page.hasMore && ++seamRequests < 4) {
          // Skip at most a few pages already present in the native buffer.
          // Keep the current screen visible throughout this bounded catch-up.
          state.nextCursor = page.nextCursor;
          state.hasMore = true;
          const completedRequest = state.requestId;
          // Let the transport finish/cancel its current request before asking
          // for the next overlap page (mobile keeps its own in-flight flag).
          queueMicrotask(() => {
            if (state.visible && state.requestId === completedRequest && !state.loading) requestMore();
          });
          continueSeekAfterPage();
          return { applied: true, count: 0, catchingUp: true };
        }
        // A changed/evicted boundary cannot be identified by text. Preserve
        // the returned archive, but still drop a suffix that repeats the
        // pixels already shown in the live preview.
        if (before === null && edge.screen?.length) before = beforeLiveEdge(seamPages, edge.screen);
        incoming = before !== null ? before : seamPages;
        seamResolved = true;
        seamPages = [];
      }
      state.items = mergeItems(state.items, incoming);
      if (typeof page?.hasMore === 'boolean') state.hasMore = page.hasMore;
      if (page?.nextCursor !== undefined) state.nextCursor = page.nextCursor;
      // Set the new scroll extent and restore the reader's anchor BEFORE
      // rendering the virtual window. Otherwise a page briefly paints blank.
      layoutItems();
      const end = state.layout[state.layout.length - 1];
      scroller.scrollTop = opening ? Math.max(0, archiveHeight + pendingPixels)
        : anchor ? restoreAnchorTop(state.layout, anchor)
        : Math.max(0, (end ? end.top + end.height : 0) - scroller.clientHeight);
      previousScrollTop = scroller.scrollTop;
      pendingPixels = 0;
      renderWindow();
      setHint();
      updateLiveBtn();
      continueSeekAfterPage();
      return { applied: true, stale: false, count: incoming.length };
    }

    function findText(text) {
      const needle = String(text || '').trim();
      if (!needle) return -1;
      if (typeof options.findIndex === 'function') {
        const index = options.findIndex(state.items, needle);
        return Number.isInteger(index) ? index : -1;
      }
      return state.items.findIndex(item => String(item.text || '').includes(needle));
    }

    function scrollToItem(index) {
      const row = state.layout[index];
      if (!row) return false;
      scroller.scrollTop = row.top;
      previousScrollTop = scroller.scrollTop;
      scheduleRenderWindow();
      updateLiveBtn();
      return true;
    }

    function finishSeek(index) {
      const resolve = seekResolve;
      seekTextValue = '';
      seekResolve = null;
      seekPages = 0;
      if (typeof resolve === 'function') resolve(index);
    }

    function tryFinishSeekFound() {
      if (!seekTextValue) return false;
      const index = findText(seekTextValue);
      if (index < 0) return false;
      scrollToItem(index);
      finishSeek(index);
      return true;
    }

    function continueSeekAfterPage() {
      if (!seekTextValue) return;
      if (tryFinishSeekFound()) return;
      if (!state.visible || state.stale || !state.hasMore || seekPages >= MAX_SEEK_PAGES) {
        finishSeek(-1);
        return;
      }
      queueMicrotask(() => {
        if (state.visible && seekTextValue && !state.loading) requestMore();
      });
    }

    function seekText(text) {
      const needle = String(text || '').trim();
      finishSeek(-1);
      if (!needle) return Promise.resolve(-1);
      seekTextValue = needle;
      seekPages = 0;
      return new Promise((resolve) => {
        seekResolve = resolve;
        if (tryFinishSeekFound()) return;
        if (!state.visible || state.stale || !state.hasMore || seekPages >= MAX_SEEK_PAGES) {
          finishSeek(-1);
          return;
        }
        if (!state.loading) requestMore();
      });
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
      const movingNewer = scroller.scrollTop > previousScrollTop;
      previousScrollTop = scroller.scrollTop;
      if (movingNewer && Date.now() < liveIntentUntil && isScrollerAtBottom()) { resumeLive(); return; }
      updateLiveBtn();
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
      const delta = historyTouchY == null || y == null ? 0 : historyTouchY - y;
      historyTouchY = y ?? null;
      if (delta) options.onPanMove?.(delta);
      if (delta > 0) liveIntentUntil = Date.now() + 800;
      if (edge && delta) { if (event.cancelable) event.preventDefault(); scrollByPixels(delta); }
      else if (delta < 0) noteOlderIntent();
      event.stopPropagation();
    }, { capture: true, passive: false });
    scroller.addEventListener('touchend', (event) => {
      historyTouchY = null;
      // 上报松手速度给共用惯性引擎：快速甩动继续滑行，慢松手原地停住。
      options.onPanEnd?.();
      event.stopPropagation();
    }, { capture: true, passive: true });
    scroller.addEventListener('touchcancel', () => {
      historyTouchY = null;
      options.onPanCancel?.();
    }, { capture: true, passive: true });
    scroller.addEventListener('wheel', (event) => {
      const delta = wheelPixels(event, rowHeight, scroller.clientHeight);
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      if (delta < 0) historyIntentUntil = Date.now() + 600;
      if (delta > 0) liveIntentUntil = Date.now() + 800;
      scrollByPixels(delta);
    }, { capture: true, passive: false });
    scroller.addEventListener('pointerdown', event => {
      if (event.target === scroller) liveIntentUntil = Date.now() + 10000;
    }, { passive: true });
    // Reading/copy happens in the overlay. Typing still goes to the live CLI,
    // but pointerdown must not steal focus or native selection never starts.
    scroller.tabIndex = -1;
    function liveTerminal() {
      return options.getTerminal?.() || null;
    }
    function keepLiveTerminalFocused() {
      if (typeof options.onKeepLiveFocus === 'function') {
        options.onKeepLiveFocus();
        return;
      }
      try { liveTerminal()?.focus?.(); } catch { /* unmounted renderer */ }
    }
    function isOverlayChrome(target) {
      return Boolean(target instanceof Element && target.closest('.terminal-history-live-btn'));
    }
    function isComposerTarget(target) {
      return Boolean(target instanceof Element && target.closest(
        'input:not(.xterm-helper-textarea), textarea:not(.xterm-helper-textarea), [contenteditable="true"], .terminal-composer',
      ));
    }
    function isEditShortcut(event) {
      const key = String(event.key || '').toLowerCase();
      return (event.metaKey || event.ctrlKey) && !event.altKey && (key === 'c' || key === 'a' || key === 'x');
    }
    function historySelectionText() {
      const selection = root.ownerDocument?.getSelection?.();
      if (!selection || selection.isCollapsed) return '';
      if (!root.contains(selection.anchorNode) && !root.contains(selection.focusNode)) return '';
      return String(selection).replace(/\u00a0/g, ' ');
    }
    function copyHistorySelection(event) {
      const text = historySelectionText();
      if (!text) return false;
      if (event?.preventDefault) {
        event.preventDefault();
        event.stopPropagation();
        event.clipboardData?.setData?.('text/plain', text);
      }
      if (!event?.clipboardData && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(text);
      }
      return true;
    }
    function onDocumentKeyDown(event) {
      if (!state.visible || isOverlayChrome(event.target) || isComposerTarget(event.target)) return;
      if (isEditShortcut(event)) {
        const key = String(event.key || '').toLowerCase();
        if (key === 'c' || key === 'x') copyHistorySelection(event);
        return;
      }
      if (event.key === 'Meta' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Shift') return;
      keepLiveTerminalFocused();
    }
    function onDocumentCopy(event) {
      if (!state.visible || isComposerTarget(event.target)) return;
      copyHistorySelection(event);
    }
    function bindHistoryClipboard() {
      const doc = root.ownerDocument;
      if (!doc || state.clipboardBound) return;
      state.clipboardBound = true;
      doc.addEventListener('keydown', onDocumentKeyDown, true);
      doc.addEventListener('copy', onDocumentCopy, true);
    }
    function unbindHistoryClipboard() {
      const doc = root.ownerDocument;
      if (!doc || !state.clipboardBound) return;
      state.clipboardBound = false;
      doc.removeEventListener('keydown', onDocumentKeyDown, true);
      doc.removeEventListener('copy', onDocumentCopy, true);
    }
    root.addEventListener('keydown', (event) => {
      if (!state.visible || isOverlayChrome(event.target) || isComposerTarget(event.target)) return;
      if (isEditShortcut(event)) return;
      if (event.key === 'Meta' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Shift') return;
      keepLiveTerminalFocused();
    }, true);

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
      seekText,
      isSeeking() {
        return Boolean(seekTextValue);
      },
      abandonSeek() {
        finishSeek(-1);
      },
      scrollByPixels,
      refreshLivePreview,
      viewingLiveEdge,
      noteLiveOutput,
      isAtBottom() {
        return isScrollerAtBottom();
      },
      isVisible() {
        return state.visible;
      },
      getSelectionText() {
        return historySelectionText();
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
    colorOf,
    normalizeColorMode,
    themePalette,
    shouldEnterHistory,
    isHistoryDirection,
    itemKey,
    beforeLiveEdge,
    wheelPixels,
  };
});
