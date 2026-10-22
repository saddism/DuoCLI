(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DuoTerminalActivityFold = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const ACTIVITY = /^\s*[•●]\s*(Explored|Ran|Edited|Edit|Called|Calling|Viewed image|(?:Used|Using) computer(?=\s*·\s*\d+\s+actions?\b)|Failed(?=\s*\(exit\s+\d+\)))\b/i;
  const STICKY_ACTIVITY = /^(Called|Calling)$/i;
  const SHELL_COMMAND = /^\s*\$\s+\S/;
  const OUTPUT_HIDDEN = /^\s*(?:\.{3}|…)\s+\d+\s+output lines hidden\b/;
  const TEST_REPORTER = /^\s*(?:(?:ℹ|#)\s+(?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\s+\d|#\s+Subtest:|[✔✖✘⚠].*\(\d+(?:\.\d+)?m?s\)\s*$|duration_ms\b|(?:not )?ok\s+\d+\b)/;
  const TOOL_SUMMARY = /^\s{0,6}(Monitored background task|Grepped, globbed|Waited for shell)\b/i;
  const CURSOR_SUMMARY = /^\s{0,6}((?:Grepped|Globbed|Read|Searched|Listed)(?:,\s*(?:grepped|globbed|read|searched|listed))*)\s+\d+\s+(?:grep|glob|file|search|director)\w*\b/i;
  // Require an actual tool invocation; prose such as “Read this carefully” is not activity.
  const TOOL_INVOCATION = /^\s*(?:[⏺●✔✓✗✘]|[│┃]\s*[✔✓✗✘])\s*(Read|Write|Edit|MultiEdit|Bash|Shell|Grep|Glob|Search|WebFetch|WebSearch|Task|TodoWrite|ReadFile|WriteFile|EditFile|RunShellCommand|read_file|write_file|edit_file|run_shell_command|grep_search|glob|web_fetch)\s*(?:\(|:|\s+(?:[./~]|[A-Za-z0-9_-]+\.[A-Za-z0-9]))/i;
  const NEXT_ITEM = /^\s*[•●⏺]\s+\S/;
  const PROMPT = /^\s*(?:[›>❯❭→]\s|[─━]{8,})/;
  const TOOL_OUTPUT = /^\s*(?:Error:|Warning:|Traceback\b|[│┃└┌├╰╭⎿]|\.{3}\s|…\s)/;
  const PI_TOOL = /^\s*(read|write|edit|bash)\s+\S/i;
  const TOOL_DETAIL = /^\s*(?:\+\s*(?:Show details|\d+ lines)|\d+\s+[+\-])/;
  const HISTORY_FOOTER = /^\s*(?:New activity\s*·\s*)?(?:↓\s*)?Back to bottom\s*·\s*esc\s*$/i;

  function piToolInvocation(line, cli) {
    if (cli !== 'pi') return null;
    const match = PI_TOOL.exec(line.text);
    if (!match) return null;
    const start = line.text.search(/\S/);
    return (line.styles || []).some(run => run.start <= start && run.end >= start + match[1].length
      && (run.flags & 1) && run.bgMode) ? match : null;
  }

  function backgroundKey(line) {
    const run = (line.styles || []).find(style => style.bgMode);
    return run ? `${run.bgMode}:${run.bg}` : null;
  }

  function activityId(line, occurrence) {
    let hash = 2166136261;
    for (const char of line.text.trim()) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    // Buffer row numbers shift whenever xterm trims scrollback. The heading
    // and its occurrence keep an expanded group stable across that shift.
    return `${hash >>> 0}-${occurrence}`;
  }

  function physicalLine(source, reusableCell) {
    if (typeof source.getCell !== 'function') return { text: source.translateToString(false), styles: [] };
    let text = '';
    const styles = [];
    let run = null;
    for (let x = 0; x < source.length; x++) {
      const cell = source.getCell(x, reusableCell);
      if (!cell || (cell.getWidth() === 0 && !cell.getChars())) continue;
      const chars = cell.getChars() || ' ';
      const fg = cell.getFgColor(), bg = cell.getBgColor();
      const fgMode = cell.getFgColorMode(), bgMode = cell.getBgColorMode();
      const flags = (cell.isBold() ? 1 : 0) | (cell.isUnderline() ? 2 : 0)
        | (cell.isDim() ? 4 : 0) | (cell.isInverse() ? 8 : 0) | (cell.isItalic() ? 16 : 0);
      const start = text.length;
      text += chars;
      if (run && run.fg === fg && run.bg === bg && run.fgMode === fgMode
          && run.bgMode === bgMode && run.flags === flags) run.end = text.length;
      else { run = { start, end: text.length, fg, bg, fgMode, bgMode, flags }; styles.push(run); }
    }
    return { text, styles };
  }

  function readLines(buffer, options = {}) {
    if (!buffer || (buffer.type === 'alternate' && !options.allowAlternate)) return [];
    const lines = [];
    // xterm can fill one cell object in place; a full history otherwise creates
    // hundreds of thousands of short-lived objects on every streaming refresh.
    const reusableCell = buffer.getNullCell?.();
    for (let row = 0; row < Math.min(buffer.length, options.endRow ?? buffer.length); row++) {
      const source = buffer.getLine(row);
      if (!source) continue;
      const { text, styles } = physicalLine(source, reusableCell);
      if (source.isWrapped && lines.length) {
        const last = lines[lines.length - 1];
        const offset = last.text.length;
        last.text += text;
        last.styles.push(...styles.map(run => ({ ...run, start: run.start + offset, end: run.end + offset })));
      } else {
        lines.push({ row, text, styles });
      }
    }
    for (const line of lines) {
      line.text = line.text.trimEnd();
      line.styles = line.styles.filter(run => run.start < line.text.length)
        .map(run => ({ ...run, end: Math.min(run.end, line.text.length) }));
    }
    while (lines.length && !lines[lines.length - 1].text.trim()) lines.pop();
    return lines;
  }

  function groupLines(lines, cli) {
    const groups = [];
    let plain = [];
    let activity = null;
    const headingOccurrences = new Map();
    const flushPlain = () => {
      if (plain.length) groups.push({ type: 'plain', lines: plain });
      plain = [];
    };
    const flushActivity = () => {
      if (activity?.shell && activity.lines.length === 1) plain.push(activity.lines[0]);
      else if (activity) {
        // Generic headings recur on every page. Include their first detail so
        // opening one Explored record does not open a different one after paging.
        const key = activity.lines[0].text.trim() + (headingDetail(activity) ? ''
          : '\n' + (activity.lines.slice(1).find(line => line.text.trim())?.text.trim() || ''));
        const occurrence = (headingOccurrences.get(key) || 0) + 1;
        headingOccurrences.set(key, occurrence);
        activity.id = activityId({ text: key }, occurrence);
        groups.push(activity);
      }
      activity = null;
    };
    for (const line of lines) {
      const match = ACTIVITY.exec(line.text);
      const shell = SHELL_COMMAND.test(line.text);
      const pi = piToolInvocation(line, cli);
      const tool = pi || (cli === 'cursor' ? CURSOR_SUMMARY.exec(line.text) : null)
        || TOOL_INVOCATION.exec(line.text) || ((!activity || activity.shell || activity.tool) ? TOOL_SUMMARY.exec(line.text) : null);
      if (match || shell || tool) {
        flushActivity();
        flushPlain();
        const label = match?.[1] || tool?.[1] || 'Command';
        activity = { type: 'activity', label,
          shell, tool: Boolean(tool), sticky: STICKY_ACTIVITY.test(label), indent: line.text.match(/^\s*/)[0].length,
          toolBackground: pi ? backgroundKey(line) : null, lines: [line] };
      } else if (activity?.toolBackground && backgroundKey(line) === activity.toolBackground) {
        activity.lines.push(line);
      } else if (activity?.shell && OUTPUT_HIDDEN.test(line.text)) {
        activity.sticky = true;
        activity.lines.push(line);
      } else if (activity && (NEXT_ITEM.test(line.text) || PROMPT.test(line.text)
          || (activity.tool && line.text.trim() && line.text.match(/^\s*/)[0].length < activity.indent
            && !TOOL_OUTPUT.test(line.text))
          || (activity.lines.at(-1)?.text.trim() === '' && line.text.trim()
            && !TOOL_OUTPUT.test(line.text) && !TEST_REPORTER.test(line.text) && !TOOL_DETAIL.test(line.text)
            && !(/^Edit(?:ed)?$/i.test(activity.label) && /^\s*[+\-]\s/.test(line.text)))
          || ((activity.shell || activity.tool) && !activity.sticky && line.text.trim() && !/^\s{2,}/.test(line.text) && !TOOL_OUTPUT.test(line.text))
          || (activity.shell && activity.sticky && activity.lines.at(-1)?.text.trim() === ''
            && line.text.trim() && !/^\s{2,}/.test(line.text)
            && !OUTPUT_HIDDEN.test(line.text) && !TEST_REPORTER.test(line.text))
          || (!activity.sticky && !activity.shell && !activity.tool && activity.lines.at(-1)?.text.trim() === ''
            && line.text.trim() && !/^\s/.test(line.text)))) {
        flushActivity();
        plain.push(line);
      } else if (activity) {
        activity.lines.push(line);
      } else {
        plain.push(line);
      }
    }
    flushActivity();
    flushPlain();
    return groups;
  }

  function escapeHtml(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/"/g, '&quot;');
  }

  function headingDetail(group) {
    if (group.shell) return group.lines[0].text.replace(/^\s*\$\s*/, '').trim();
    const heading = String(group.lines[0]?.text || '').replace(/^\s*(?:[•●⏺✔✓✗✘]|[│┃]\s*[✔✓✗✘])\s*/, '');
    const label = String(group.label || '');
    const detail = heading.replace(new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b\\s*`, 'i'), '').trim();
    return detail;
  }

  function renderGroups(groups, renderLine = line => escapeHtml(line.text)) {
    return groups.map(group => {
      const body = group.lines.map(renderLine).join('\n');
      if (group.type === 'plain') return `<pre class="terminal-activity-plain">${body}</pre>`;
      const count = group.lines.length - 1;
      const status = group.lines.slice(0, 4).map(line => line.text.match(/\bexit\s+\d+\b/i)?.[0]).find(Boolean);
      const detail = headingDetail(group);
      return `<details class="terminal-activity-group" data-activity-id="${group.id}"><summary><span class="terminal-activity-chevron" aria-hidden="true"></span><span class="terminal-activity-label">${escapeHtml(group.label)}</span>${detail ? `<span class="terminal-activity-detail">${escapeHtml(detail)}</span>` : ''}${status ? `<span class="terminal-activity-status">${escapeHtml(status)}</span>` : ''}<span class="terminal-activity-count">${count} 行</span></summary><pre>${body}</pre></details>`;
    }).join('');
  }

  function createView(terminal, host, options = {}) {
    const history = globalThis.DuoTerminalHistoryLayer;
    const palette = history?.themePalette(terminal.options.theme);
    const content = globalThis.DuoTerminalContentHelpers;
    const files = globalThis.DuoFilePreviewHelpers;
    const renderPart = (line, start, end) => {
      if (start >= end) return '';
      const text = line.text.slice(start, end);
      if (!history?.renderLineHtml) return escapeHtml(text);
      const styles = (line.styles || []).filter(run => run.end > start && run.start < end)
        .map(run => ({ ...run, start: Math.max(0, run.start - start), end: Math.min(end - start, run.end - start) }));
      return history.renderLineHtml({ text, styles }, palette);
    };
    const renderLine = line => {
      const links = content?.findLinks?.(line.text)?.filter(match => match.kind === 'url'
        || (match.kind === 'file' && files?.isLinkableFileName?.(match.filePath))) || [];
      if (!links.length) return renderPart(line, 0, line.text.length);
      let html = '';
      let cursor = 0;
      for (const link of links) {
        if (link.index < cursor) continue;
        html += renderPart(line, cursor, link.index);
        const body = renderPart(line, link.index, link.index + link.length);
        html += link.kind === 'url'
          ? `<a class="terminal-activity-link" href="${escapeAttribute(link.url)}" target="_blank" rel="noopener noreferrer">${body}</a>`
          : `<button type="button" class="terminal-activity-link" data-terminal-file="${escapeAttribute(link.filePath)}">${body}</button>`;
        cursor = link.index + link.length;
      }
      return html + renderPart(line, cursor, line.text.length);
    };
    const root = document.createElement('div');
    root.className = 'terminal-activity-view';
    function syncMetrics() {
      root.style.fontFamily = terminal.options.fontFamily || '';
      root.style.fontSize = `${terminal.options.fontSize || 14}px`;
      root.style.lineHeight = String(terminal.options.lineHeight || 1.2);
    }
    syncMetrics();
    root.hidden = true;
    const toolbar = document.createElement('div');
    toolbar.className = 'terminal-activity-toolbar';
    const title = document.createElement('span');
    title.textContent = '折叠记录';
    const rawButton = document.createElement('button');
    rawButton.type = 'button';
    rawButton.textContent = '原样终端';
    const olderButton = document.createElement('button');
    olderButton.type = 'button';
    olderButton.textContent = '更早输出';
    toolbar.append(title, olderButton, rawButton);
    const scroller = document.createElement('div');
    scroller.className = 'terminal-activity-scroller';
    const historyHint = document.createElement('div');
    historyHint.className = 'terminal-activity-history-hint';
    const historyLabel = document.createElement('span');
    historyHint.appendChild(historyLabel);
    historyHint.hidden = true;
    if (options.showControls !== false) root.appendChild(toolbar);
    if (options.allowAlternate) root.appendChild(historyHint);
    root.appendChild(scroller);
    host.appendChild(root);

    const reopen = document.createElement('button');
    reopen.type = 'button';
    reopen.className = 'terminal-activity-reopen';
    reopen.textContent = '折叠记录';
    reopen.hidden = true;
    if (options.showControls !== false) host.appendChild(reopen);

    const latest = document.createElement('button');
    latest.type = 'button';
    latest.className = 'terminal-activity-latest';
    latest.textContent = '↓ 回到最新';
    latest.hidden = true;
    if (options.allowAlternate) historyHint.appendChild(latest);
    else toolbar.insertBefore(latest, rawButton);

    let raw = false;
    let rawForOlderOutput = false;
    let expandedByDefault = false;
    let hasActivities = false;
    let lastMarkup = '';
    let pendingSelectionRefresh = false;
    let pointerDown = false;
    let scrollingUntil = 0;
    let touchY = null;
    let deferredRefreshTimer = null;
    let disposed = false;
    let pagingUntil = 0;
    let pendingPage = null;
    let following = true;
    const atBottom = () => scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    function updateLatest() {
      const browsingHistory = isAlternateHistory();
      const paused = !following && !atBottom();
      latest.hidden = raw || root.hidden || !(browsingHistory || paused);
      historyHint.hidden = raw || root.hidden || !(browsingHistory || paused);
      historyLabel.textContent = browsingHistory ? '正在查看历史 · 上下滚动翻页' : '自动跟随已暂停';
    }
    const expandedRecords = new Map();
    function rememberExpanded() {
      for (const group of scroller.querySelectorAll('details')) {
        expandedRecords.set(group.dataset.activityId, group.open);
      }
      // Session-local UI state must not grow indefinitely during long runs.
      while (expandedRecords.size > 1000) expandedRecords.delete(expandedRecords.keys().next().value);
    }
    function captureAnchor(preferred) {
      const top = scroller.getBoundingClientRect().top;
      const node = preferred || Array.from(scroller.children).find(child => child.getBoundingClientRect().bottom > top);
      return { node, offset: node ? node.getBoundingClientRect().top - top : 0, scrollTop: scroller.scrollTop };
    }
    function restoreAnchor(anchor) {
      if (!anchor.node?.isConnected) {
        scroller.scrollTop = terminal.buffer.active.type === 'alternate' ? 0 : anchor.scrollTop;
        return;
      }
      const offset = anchor.node.tagName === 'DETAILS' && !anchor.node.open ? Math.max(0, anchor.offset) : anchor.offset;
      scroller.scrollTop += anchor.node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset;
    }
    const isAlternateHistory = () => {
      const buffer = terminal.buffer.active;
      if (buffer.type !== 'alternate') return false;
      for (let row = Math.max(0, buffer.length - 7); row < buffer.length; row++) {
        if (/Back to bottom|enter\/esc latest|Earlier messages available|New activity/i.test(buffer.getLine(row)?.translateToString(true) || '')) return true;
      }
      return false;
    };
    const hasSelection = () => {
      const selection = document.getSelection();
      return Boolean(selection && !selection.isCollapsed
        && (scroller.contains(selection.anchorNode) || scroller.contains(selection.focusNode)));
    };
    function refresh() {
      if (disposed) return;
      syncMetrics();
      const browsingHistory = isAlternateHistory();
      updateLatest();
      if (raw) {
        root.hidden = true;
        reopen.hidden = !lastMarkup || (terminal.buffer.active.type === 'alternate' && !options.allowAlternate);
        return;
      }
      if (options.isInteracting?.() || touchY != null || Date.now() < scrollingUntil) {
        if (deferredRefreshTimer == null) deferredRefreshTimer = setTimeout(() => {
          deferredRefreshTimer = null;
          refresh();
        }, 100);
        return;
      }
      clearTimeout(deferredRefreshTimer);
      deferredRefreshTimer = null;
      if (!root.hidden && hasSelection()) {
        pendingSelectionRefresh = true;
        return;
      }
      const buffer = terminal.buffer.active;
      let endRow;
      if (options.keepLiveInput) {
        // Leave the live editor, caret and CLI footer in xterm. A projected
        // transcript must never become a second copy of the interactive prompt.
        let row = buffer.baseY + buffer.cursorY;
        while (row > buffer.baseY && buffer.getLine(row)?.isWrapped) row--;
        let prompt = buffer.getLine(row)?.translateToString(true) || '';
        if (buffer.type === 'alternate') {
          // Redraws can leave the caret on an old user message as well as a
          // status line. Prefer the bottom editor even when that message also
          // begins with a prompt marker; otherwise later replies are cut off.
          for (let candidate = buffer.length - 1; candidate >= Math.max(0, buffer.length - 8); candidate--) {
            const text = buffer.getLine(candidate)?.translateToString(true) || '';
            if (/^\s*[›❯>]\s/.test(text) && !buffer.getLine(candidate)?.isWrapped) {
              row = candidate; prompt = text; break;
            }
          }
        }
        if (/^\s*[›❯>]\s/.test(prompt)) {
          endRow = row;
          const screen = terminal.element?.querySelector('.xterm-screen');
          const screenRect = screen?.getBoundingClientRect();
          const hostRect = host.getBoundingClientRect();
          const rowHeight = (screenRect?.height || 0) / terminal.rows;
          const inputTop = (screenRect?.top || hostRect.top) + (row - buffer.viewportY) * rowHeight;
          root.style.bottom = `${Math.max(0, hostRect.bottom - inputTop)}px`;
        } else if (buffer.type === 'alternate') {
          root.hidden = true;
          reopen.hidden = true;
          return;
        } else root.style.bottom = '';
      }
      const lines = readLines(buffer, { allowAlternate: options.allowAlternate, endRow })
        .filter(line => buffer.type !== 'alternate' || !HISTORY_FOOTER.test(line.text));
      const groups = groupLines(lines, options.getCli?.() || options.cli);
      const activitiesAvailable = groups.some(group => group.type === 'activity');
      hasActivities ||= activitiesAvailable;
      const available = activitiesAvailable || ((hasActivities || browsingHistory)
        && lines.length > 0 && options.keepLiveInput && buffer.type === 'alternate');
      root.hidden = raw || !available;
      reopen.hidden = !raw || !available;
      if (!available || raw) return;
      const markup = renderGroups(groups, renderLine);
      if (markup === lastMarkup) {
        if (pendingPage === 'latest' || (following && !browsingHistory)) {
          scroller.scrollTop = scroller.scrollHeight;
          pendingPage = null;
        }
        updateLatest();
        return;
      }
      if (hasSelection()) {
        pendingSelectionRefresh = true;
        return;
      }
      // Keep user intent across redraws and editor-height changes. Geometry
      // measured after new output arrives cannot tell whether we were following.
      const pinned = following && !browsingHistory && !pendingPage;
      const anchor = captureAnchor();
      const template = document.createElement('template');
      template.innerHTML = markup;
      const oldNodes = Array.from(scroller.children);
      rememberExpanded();
      const oldActivities = new Map(oldNodes.filter(node => node.matches('details[data-activity-id]'))
        .map(node => [node.dataset.activityId, node]));
      const desired = Array.from(template.content.children);
      const retained = new Set();
      desired.forEach((fresh, index) => {
        let node = fresh.matches('details[data-activity-id]')
          ? oldActivities.get(fresh.dataset.activityId) : oldNodes[index];
        if (retained.has(node) || (node && node.tagName !== fresh.tagName)) node = null;
        if (node) {
          if (node.tagName === 'DETAILS') {
            const summary = node.querySelector('summary');
            const body = node.querySelector('pre');
            if (summary.innerHTML !== fresh.querySelector('summary').innerHTML) summary.innerHTML = fresh.querySelector('summary').innerHTML;
            if (body.innerHTML !== fresh.querySelector('pre').innerHTML) body.innerHTML = fresh.querySelector('pre').innerHTML;
          } else if (node.innerHTML !== fresh.innerHTML) node.innerHTML = fresh.innerHTML;
        } else {
          node = fresh;
          if (node.tagName === 'DETAILS') node.open = expandedRecords.get(node.dataset.activityId) ?? expandedByDefault;
        }
        retained.add(node);
        if (scroller.children[index] !== node) scroller.insertBefore(node, scroller.children[index] || null);
      });
      for (const node of oldNodes) if (!retained.has(node)) node.remove();
      if (pinned || pendingPage === 'latest' || pendingPage === 'older') scroller.scrollTop = scroller.scrollHeight;
      else if (pendingPage === 'newer') scroller.scrollTop = 0;
      else restoreAnchor(anchor);
      pendingPage = null;
      lastMarkup = markup;
      updateLatest();
    }
    const onSelectionChange = () => {
      if (!pendingSelectionRefresh || hasSelection()) return;
      pendingSelectionRefresh = false;
      refresh();
    };
    // Font fitting and pane layout can move the editor without changing the
    // terminal's rows/columns or producing output. Observe geometry directly;
    // cursor-blink renders must not rescan the entire transcript.
    const layoutObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => refresh()) : null;
    layoutObserver?.observe(host);
    const screen = terminal.element?.querySelector('.xterm-screen');
    if (screen) layoutObserver?.observe(screen);
    document.addEventListener('selectionchange', onSelectionChange);
    root.addEventListener('click', event => {
      const summary = event.target?.closest?.('summary');
      if (summary && scroller.contains(summary) && !event.defaultPrevented) {
        const group = summary.parentElement;
        const anchor = captureAnchor(group);
        event.preventDefault();
        group.open = !group.open;
        following = false;
        scrollingUntil = 0;
        rememberExpanded();
        pagingUntil = Date.now() + 250;
        restoreAnchor(anchor);
        updateLatest();
        return;
      }
      const file = event.target?.closest?.('[data-terminal-file]');
      if (!file || !root.contains(file)) return;
      root.dispatchEvent(new CustomEvent('duocli-terminal-file', {
        bubbles: true, detail: { path: file.dataset.terminalFile },
      }));
    });
    function showOlder() {
      if (raw) return;
      following = false;
      // Desktop always projects folded records. Alternate-screen paging
      // updates that same projection instead of entering a hidden raw mode.
      if (options.showControls === false && terminal.buffer.active.type === 'alternate') {
        if (Date.now() < pagingUntil || !options.onOlder) return;
        pagingUntil = Date.now() + 180;
        pendingPage = 'older';
        options.onOlder?.();
        return;
      }
      raw = true;
      rawForOlderOutput = true;
      refresh();
      options.onOlder?.();
    }
    rawButton.addEventListener('click', () => { raw = true; rawForOlderOutput = false; refresh(); });
    olderButton.addEventListener('click', showOlder);
    function follow() {
      const browsingHistory = isAlternateHistory();
      if (hasSelection()) document.getSelection().removeAllRanges();
      following = true;
      pendingPage = 'latest';
      pagingUntil = Date.now() + 180;
      scrollingUntil = 0;
      touchY = null;
      scroller.scrollTop = scroller.scrollHeight;
      if (browsingHistory) options.onLatest?.();
      refresh();
    }
    latest.addEventListener('click', follow);
    function showNewer() {
      if (raw || !isAlternateHistory() || !options.onNewer) return false;
      if (Date.now() >= pagingUntil) {
        pagingUntil = Date.now() + 180;
        pendingPage = 'newer';
        options.onNewer();
      }
      return true;
    }
    scroller.addEventListener('wheel', event => {
      if (event.deltaY < 0) following = false;
      else if (event.deltaY > 0 && atBottom()) following = true;
      scrollingUntil = Date.now() + 150;
      if (event.deltaY > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
        if (showNewer() && event.cancelable) event.preventDefault();
        return;
      }
      if (event.deltaY >= 0 || scroller.scrollTop > 2) return;
      if (event.cancelable) event.preventDefault();
      showOlder();
    }, { passive: false });
    scroller.addEventListener('touchstart', event => {
      following = false;
      touchY = event.touches[0]?.clientY ?? null;
    }, { passive: true });
    scroller.addEventListener('touchmove', event => {
      const y = event.touches[0]?.clientY;
      if (touchY == null || y == null) return;
      if (touchY - y >= 24 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2 && showNewer()) {
        if (event.cancelable) event.preventDefault();
        touchY = null;
        return;
      }
      if (y - touchY < 24 || scroller.scrollTop > 2) return;
      if (event.cancelable) event.preventDefault();
      touchY = null;
      showOlder();
    }, { passive: false });
    const endTouch = () => {
      touchY = null;
      scrollingUntil = Date.now() + 100;
      following = atBottom() && !hasSelection();
    };
    scroller.addEventListener('touchend', endTouch, { passive: true });
    scroller.addEventListener('touchcancel', endTouch, { passive: true });
    scroller.addEventListener('scroll', () => {
      if (pointerDown || touchY != null || Date.now() < scrollingUntil) {
        scrollingUntil = Date.now() + 100;
        following = atBottom();
      }
      updateLatest();
    }, { passive: true });
    scroller.addEventListener('pointerdown', () => {
      following = false;
      pointerDown = true;
    }, { passive: true });
    const endPointer = () => {
      if (!pointerDown) return;
      pointerDown = false;
      following = atBottom() && !hasSelection() && !scroller.querySelector('details[open]');
    };
    document.addEventListener('pointerup', endPointer);
    document.addEventListener('pointercancel', endPointer);
    reopen.addEventListener('click', () => {
      raw = false; rawForOlderOutput = false; scrollingUntil = 0; touchY = null; refresh();
    });
    return { root, refresh, follow, syncMetrics, isVisible: () => !root.hidden,
      setExpanded: expanded => {
        const anchor = captureAnchor();
        expandedByDefault = Boolean(expanded);
        following = false;
        scrollingUntil = 0;
        expandedRecords.clear();
        for (const group of scroller.querySelectorAll('details')) group.open = expandedByDefault;
        rememberExpanded();
        pagingUntil = Date.now() + 250;
        restoreAnchor(anchor);
        updateLatest();
      },
      returnFromOlder: () => {
        if (!rawForOlderOutput) return;
        raw = false;
        rawForOlderOutput = false;
        scrollingUntil = 0;
        touchY = null;
        refresh();
      },
      dispose: () => {
        disposed = true;
        clearTimeout(deferredRefreshTimer);
        layoutObserver?.disconnect();
        latest.remove();
        root.remove();
        reopen.remove();
        expandedRecords.clear();
        document.removeEventListener('selectionchange', onSelectionChange);
        document.removeEventListener('pointerup', endPointer);
        document.removeEventListener('pointercancel', endPointer);
      } };
  }

  return { readLines, groupLines, renderGroups, createView };
});
