(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DuoUserPromptBanner = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const PREVIEW_CHARS = 200;
  const STORE_KEY = 'duocli_last_user_prompts';

  function codePoints(text) {
    return Array.from(String(text || ''));
  }

  function normalizePrompt(text) {
    return String(text || '').replace(/\r\n?/g, '\n').trim();
  }

  function looksLikeUserPrompt(text) {
    const value = normalizePrompt(text);
    if (!value) return false;
    if (/^(y|n|yes|no|ok|好|是|否)$/i.test(value)) return false;
    // CLI slash commands are controls, not something the user is saying.
    // A path such as /Users/name stays eligible because its first token
    // continues with another slash rather than ending as a command.
    if (/^\/[A-Za-z][A-Za-z0-9_-]*(?:$|[\s=:?&])/.test(value)) return false;
    return codePoints(value).length >= 2;
  }

  function previewText(text, limit) {
    const full = normalizePrompt(text);
    const chars = codePoints(full);
    const max = Number.isInteger(limit) && limit > 0 ? limit : PREVIEW_CHARS;
    if (chars.length <= max) return { preview: full, truncated: false, full };
    return { preview: chars.slice(0, max).join(''), truncated: true, full };
  }

  function searchNeedle(text) {
    const first = normalizePrompt(text).split('\n')[0].replace(/\s+/g, ' ').trim();
    return codePoints(first).slice(0, 40).join('');
  }

  const BOX_EDGE = /[╭╮╰╯│┃┌┐└┘─━═╔╗╚╝║▌▍▎▏▕▔▁]/g;
  const LEADING_CHROME = /^[\s╭╮╰╯│┃┌┐└┘─━═╔╗╚╝║▌▍▎▏▕▔▁❯>•●◆▪▸]+/;
  const TRAILING_CHROME = /[╭╮╰╯│┃┌┐└┘─━═╔╗╚╝║▌▍▎▏▕▔▁]+$/;

  function physicalLineText(buffer, y) {
    return String(buffer.getLine(y)?.translateToString?.(true) || '');
  }

  function stripPromptChrome(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(LEADING_CHROME, '')
      .replace(TRAILING_CHROME, '')
      .trim();
  }

  function isPromptBottomLine(text) {
    return /^[╰└╚].*[╯┘╝─━═]/.test(String(text || '').trim());
  }

  function isPromptChromeLine(text) {
    const raw = String(text || '').trim();
    if (!raw) return false;
    if (/^[╭┌╔].*[╮┐╗─━═]/.test(raw)) return true;
    if (isPromptBottomLine(raw)) return true;
    if (/^[─━═]{4,}/.test(raw)) return true;
    const stripped = stripPromptChrome(raw);
    if (!stripped) return true;
    if (/^(user|you|用户|human)\b/i.test(stripped) && codePoints(stripped).length <= 12) return true;
    const withoutBox = raw.replace(BOX_EDGE, '').replace(/\s+/g, '');
    return withoutBox.length === 0;
  }

  function matchesPromptText(haystack, snippet, short) {
    if (!haystack) return false;
    if (haystack.includes(snippet) || snippet.includes(haystack)) return true;
    return Boolean(short) && haystack.includes(short);
  }

  function wrapGroupStart(buffer, y) {
    let from = y;
    while (from > 0 && buffer.getLine(from)?.isWrapped) from--;
    return from;
  }

  function joinedPromptText(buffer, from, to) {
    let text = '';
    for (let row = from; row <= to; row++) text += stripPromptChrome(physicalLineText(buffer, row));
    return text.replace(/\s+/g, ' ').trim();
  }

  function findPromptLine(buffer, text) {
    if (!buffer || typeof buffer.getLine !== 'function') return -1;
    const needle = stripPromptChrome(searchNeedle(text));
    if (!needle) return -1;
    const snippet = codePoints(needle).slice(0, Math.min(24, codePoints(needle).length)).join('');
    const short = codePoints(snippet).slice(0, Math.min(12, codePoints(snippet).length)).join('');
    const start = Math.max(0, buffer.length - 4000);
    for (let y = buffer.length - 1; y >= start; y--) {
      if (y + 1 < buffer.length && buffer.getLine(y + 1)?.isWrapped) continue;
      const from = wrapGroupStart(buffer, y);
      const joined = joinedPromptText(buffer, from, y);
      const line = stripPromptChrome(physicalLineText(buffer, y));
      if (matchesPromptText(joined, snippet, short) || matchesPromptText(line, snippet, short)) return from;
    }
    return -1;
  }

  function promptBlockStartLine(buffer, text) {
    const found = findPromptLine(buffer, text);
    if (found < 0) return -1;
    const needle = stripPromptChrome(searchNeedle(text));
    let y = wrapGroupStart(buffer, found);
    while (y > 0) {
      const prev = physicalLineText(buffer, y - 1);
      if (!prev.trim() || isPromptBottomLine(prev)) break;
      const prevText = stripPromptChrome(prev);
      if (isPromptChromeLine(prev) || (codePoints(prevText).length >= 2 && needle.includes(prevText))) {
        y--;
        continue;
      }
      break;
    }
    return y;
  }

  function findPromptItemIndex(items, text) {
    if (!Array.isArray(items)) return -1;
    const raw = normalizePrompt(text);
    const needle = stripPromptChrome(searchNeedle(raw));
    if (!raw && !needle) return -1;
    const snippet = codePoints(needle).slice(0, Math.min(24, codePoints(needle).length)).join('');
    const short = codePoints(snippet).slice(0, Math.min(12, codePoints(snippet).length)).join('');
    let found = -1;
    for (let i = items.length - 1; i >= 0; i--) {
      const line = String(items[i]?.text || '');
      if ((raw && line.includes(raw)) || (needle && line.includes(needle))) {
        found = i;
        break;
      }
      const stripped = stripPromptChrome(line);
      let joined = '';
      for (let j = Math.max(0, i - 2); j <= Math.min(items.length - 1, i + 2); j++) {
        joined += stripPromptChrome(items[j]?.text);
      }
      joined = joined.replace(/\s+/g, ' ').trim();
      if (matchesPromptText(stripped, snippet, short) || matchesPromptText(joined, snippet, short)) {
        found = i;
        break;
      }
    }
    if (found < 0) return -1;
    let y = found;
    while (y > 0) {
      const prev = String(items[y - 1]?.text || '');
      if (!prev.trim() || isPromptBottomLine(prev)) break;
      const prevText = stripPromptChrome(prev);
      if (isPromptChromeLine(prev) || (codePoints(prevText).length >= 2 && needle.includes(prevText))) {
        y--;
        continue;
      }
      break;
    }
    return y;
  }

  function resolvePromptJumpLine(buffer, text, marker) {
    const fresh = promptBlockStartLine(buffer, text);
    if (fresh >= 0) return fresh;
    if (marker && !marker.isDisposed && Number.isInteger(marker.line) && marker.line >= 0) {
      return marker.line;
    }
    return -1;
  }

  function scrollLineToTop(terminal, line) {
    if (!terminal?.scrollToLine || !Number.isInteger(line) || line < 0) return -1;
    const buffer = terminal.buffer.active;
    const target = Math.min(Math.max(0, line), Math.max(0, buffer.baseY));
    try {
      if (terminal.options && terminal.options.smoothScrollDuration !== 0) {
        terminal.options.smoothScrollDuration = 0;
      }
    } catch { /* ignore read-only options */ }
    terminal.scrollToLine(target);
    const viewport = terminal._core?._viewport;
    if (typeof viewport?.syncScrollArea === 'function') viewport.syncScrollArea(true);
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        if (terminal.buffer?.active?.viewportY !== target) terminal.scrollToLine(target);
        if (typeof viewport?.syncScrollArea === 'function') viewport.syncScrollArea(true);
      });
    }
    return target;
  }

  function skipEscapeSequence(data, i) {
    if (i + 1 >= data.length) return i;
    const next = data.charCodeAt(i + 1);
    if (next === 0x5b) {
      let j = i + 2;
      while (j < data.length) {
        const c = data.charCodeAt(j);
        if (c >= 0x40 && c <= 0x7e) return j;
        if (c >= 0x20 && c <= 0x3f) { j++; continue; }
        return j;
      }
      return data.length - 1;
    }
    if (next === 0x5d) {
      let j = i + 2;
      while (j < data.length) {
        if (data.charCodeAt(j) === 0x07) return j;
        if (data.charCodeAt(j) === 0x1b && j + 1 < data.length && data.charCodeAt(j + 1) === 0x5c) return j + 1;
        j++;
      }
      return data.length - 1;
    }
    if (next === 0x4f) return Math.min(i + 2, data.length - 1);
    return i + 1;
  }

  function consumeTypedInput(currentLine, data) {
    let line = String(currentLine || '');
    const segments = [];
    const chunk = String(data || '');
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      const code = chunk.charCodeAt(i);
      if (ch === '\r' || ch === '\n') {
        const trimmed = line.trim();
        if (trimmed) segments.push(trimmed);
        line = '';
      } else if (code === 0x7f || code === 0x08) {
        const chars = codePoints(line);
        chars.pop();
        line = chars.join('');
      } else if (code === 0x1b) {
        i = skipEscapeSequence(chunk, i);
      } else if (code >= 0x20) {
        line += ch;
      }
    }
    return { line, segments };
  }

  function readStoredPrompt(sessionId, storage) {
    const store = storage || (typeof localStorage === 'undefined' ? null : localStorage);
    if (!store || !sessionId) return '';
    try {
      const all = JSON.parse(store.getItem(STORE_KEY) || '{}') || {};
      const value = normalizePrompt(all[sessionId] || '');
      return looksLikeUserPrompt(value) ? value : '';
    } catch {
      return '';
    }
  }

  function lastUserPromptFrom(segments) {
    const list = Array.isArray(segments) ? segments : [];
    for (let i = list.length - 1; i >= 0; i--) {
      const value = normalizePrompt(list[i]);
      if (looksLikeUserPrompt(value)) return codePoints(value).slice(0, 4000).join('');
    }
    return '';
  }

  function writeStoredPrompt(sessionId, text, storage) {
    const store = storage || (typeof localStorage === 'undefined' ? null : localStorage);
    if (!store || !sessionId) return;
    try {
      const all = JSON.parse(store.getItem(STORE_KEY) || '{}') || {};
      const value = normalizePrompt(text);
      if (!value) delete all[sessionId];
      else if (looksLikeUserPrompt(value)) all[sessionId] = codePoints(value).slice(0, 4000).join('');
      store.setItem(STORE_KEY, JSON.stringify(all));
    } catch { /* ignore quota */ }
  }

  function markerAtLine(terminal, line) {
    if (!terminal?.registerMarker || !Number.isInteger(line) || line < 0) return null;
    const buf = terminal.buffer.active;
    const cursor = buf.baseY + buf.cursorY;
    const marker = terminal.registerMarker(line - cursor);
    return marker && !marker.isDisposed ? marker : null;
  }

  function createBanner() {
    const root = document.createElement('div');
    root.className = 'user-prompt-banner';
    root.hidden = true;
    root.innerHTML = [
      '<div class="user-prompt-banner-copy">',
      '<span class="user-prompt-kicker">最近在说</span>',
      '<p class="user-prompt-text"></p>',
      '<button type="button" class="user-prompt-more" hidden>更多</button>',
      '</div>',
      '<button type="button" class="user-prompt-jump">滚动到这里</button>',
    ].join('');
    return {
      element: root,
      textEl: root.querySelector('.user-prompt-text'),
      moreBtn: root.querySelector('.user-prompt-more'),
      jumpBtn: root.querySelector('.user-prompt-jump'),
    };
  }

  function bindExistingBanner(root) {
    if (!root) return null;
    return {
      element: root,
      textEl: root.querySelector('.user-prompt-text'),
      moreBtn: root.querySelector('.user-prompt-more'),
      jumpBtn: root.querySelector('.user-prompt-jump'),
    };
  }

  function renderBanner(banner, state) {
    if (!banner?.element || !banner.textEl || !banner.moreBtn) return;
    const normalized = normalizePrompt(state?.text);
    if (!looksLikeUserPrompt(normalized)) {
      banner.element.hidden = true;
      banner.element.classList.remove('is-expanded');
      banner.textEl.textContent = '';
      banner.moreBtn.hidden = true;
      return;
    }
    const { preview, truncated, full } = previewText(normalized);
    const expanded = Boolean(state?.expanded && truncated);
    banner.element.hidden = false;
    banner.element.classList.toggle('is-expanded', expanded);
    banner.textEl.textContent = expanded ? full : (truncated ? `${preview}…` : preview);
    banner.moreBtn.hidden = !truncated;
    banner.moreBtn.textContent = expanded ? '收起' : '更多';
  }

  return {
    PREVIEW_CHARS,
    looksLikeUserPrompt,
    previewText,
    normalizePrompt,
    findPromptLine,
    promptBlockStartLine,
    findPromptItemIndex,
    resolvePromptJumpLine,
    scrollLineToTop,
    lastUserPromptFrom,
    consumeTypedInput,
    readStoredPrompt,
    writeStoredPrompt,
    markerAtLine,
    createBanner,
    bindExistingBanner,
    renderBanner,
  };
});
