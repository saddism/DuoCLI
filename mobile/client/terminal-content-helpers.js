(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DuoTerminalContentHelpers = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function readPhysicalLine(line, lineIndex, startCell = 0, endCell = line?.length || 0) {
    let text = '';
    const positions = [];
    if (!line) return { text, positions, usedColumns: 0 };
    for (let cellIndex = startCell; cellIndex < Math.min(endCell, line.length); cellIndex++) {
      const cell = line.getCell(cellIndex);
      const chars = cell?.getChars() || '';
      const width = cell?.getWidth() ?? 1;
      if (chars) {
        text += chars;
        for (let index = 0; index < chars.length; index++) positions.push({ line: lineIndex, cell: cellIndex });
      } else if (width !== 0) {
        text += ' ';
        positions.push({ line: lineIndex, cell: cellIndex });
      }
    }
    while (text.endsWith(' ')) {
      text = text.slice(0, -1);
      positions.pop();
    }
    const usedColumns = positions.length ? positions[positions.length - 1].cell + 1 : 0;
    return { text, positions, usedColumns };
  }

  function segmentAt(buffer, lineIndex) {
    let start = lineIndex;
    while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
    let end = start;
    while (end + 1 < buffer.length && buffer.getLine(end + 1)?.isWrapped) end++;
    const parts = [];
    for (let row = start; row <= end; row++) parts.push(readPhysicalLine(buffer.getLine(row), row));
    return {
      start,
      end,
      text: parts.map(part => part.text).join(''),
      usedColumns: Math.max(0, ...parts.map(part => part.usedColumns)),
      parts,
    };
  }

  function indentOf(text) { return text.match(/^ */)?.[0].length || 0; }
  function isUiRule(text) {
    const value = text.trim();
    return value.length >= 4 && /^(.)\1{3,}$/.test(value);
  }
  function isListItem(text) {
    return /^(?:[-*•▪▸]|\d+[.)]|[A-Za-z][.)])\s+/.test(text.trimStart());
  }
  function compatibleSegment(candidate, referenceIndent) {
    return candidate.text.trim().length > 0 && !isUiRule(candidate.text)
      && !isListItem(candidate.text) && Math.abs(indentOf(candidate.text) - referenceIndent) <= 1;
  }

  function trailingToken(text) {
    return String(text || '').match(/(\S+)\s*$/)?.[1] || '';
  }

  function leadingToken(text) {
    return String(text || '').trimStart().match(/^(\S+)/)?.[1] || '';
  }

  function stripEdgeQuotes(token) {
    return String(token || '').replace(/^["'`]+/, '').replace(/["'`]+$/, '');
  }

  // Mid-path hard wraps (common for long .md/.ts paths on a narrow phone
  // terminal) must glue back together even when the TUI paragraph heuristic
  // would leave them as separate short rows.
  function clipGluedProse(value) {
    const text = String(value || '');
    const cut = text.search(/[)）。；！？、]/);
    return cut >= 0 ? text.slice(0, cut) : text;
  }

  function isIncompletePathToken(token) {
    const plain = clipGluedProse(normalizedFilePath(trimToken(stripEdgeQuotes(token)).value));
    if (!plain) return false;
    const { filePath } = splitLocation(plain);
    const last = filePath.split(/[\\/]/).pop() || '';
    if (hasSourceExtension(last) || isSpecialFilename(last)) return false;
    if (/[\\/]/.test(plain)) return true;
    // Bare names that already started an extension ("Component.t") are also
    // incomplete when the rest of a known suffix is on the next visual row.
    return /\.[A-Za-z0-9_+-]*$/.test(last) && /[\\/._-]/.test(plain);
  }

  function completesKnownExtension(leftPlain, rightPlain) {
    const match = leftPlain.match(/\.([A-Za-z0-9_+-]*)$/);
    if (!match) return false;
    if (!/^[A-Za-z0-9_+-]+$/.test(rightPlain)) return false;
    return SOURCE_FILE_EXTENSIONS.has((match[1] + rightPlain).toLowerCase());
  }

  function isPathContinuationToken(token) {
    const plain = clipGluedProse(trimToken(stripEdgeQuotes(token)).value);
    if (!plain) return false;
    if (/^[\\/_.-]/.test(plain)) return true;
    const { filePath } = splitLocation(plain);
    const last = filePath.split(/[\\/]/).pop() || filePath;
    if (hasSourceExtension(last) || isSpecialFilename(last)) return true;
    if (/^[A-Za-z0-9._~+-]+/.test(plain)) return true;
    // Phone-width wrap in a Chinese directory: "验" + "证/project/views/abc"
    return /[\\/]/.test(plain) && /[A-Za-z0-9._~+-]/.test(plain);
  }

  function shouldJoinPathWrap(previousText, nextText) {
    const left = trailingToken(previousText);
    const right = leadingToken(nextText);
    if (!left || !right) return false;
    const leftPlain = trimToken(stripEdgeQuotes(left)).value;
    const rightPlain = trimToken(stripEdgeQuotes(right)).value;
    if (!leftPlain || !rightPlain) return false;
    if (completesKnownExtension(leftPlain, rightPlain)) return true;
    if (isIncompletePathToken(leftPlain) && isPathContinuationToken(rightPlain)) return true;
    if (/[\\/_@.:-]$/.test(leftPlain) && /^[A-Za-z0-9._~+/\u3400-\u9fff-]/.test(rightPlain)) return true;
    // Hard wrap split a parenthesized path: "... (do" / "cs/file.md)"
    if (unmatchedOpenParens(previousText) > 0) {
      if (isIncompletePathToken(leftPlain) && /^[\u3400-\u9fff]/.test(rightPlain)) return true;
      const wrapped = clipGluedProse(trimToken(leftPlain + rightPlain).value);
      if (looksLikeFilePath(splitLocation(normalizedFilePath(wrapped)).filePath)) return true;
    }

    // Only glue when the left token already looks path-shaped, so ordinary
    // words before a filename (e.g. "see helpers.ts") stay separate.
    if (!/[\\/]/.test(leftPlain) && !/[\\/_@.:-]$/.test(leftPlain) && !/\.[A-Za-z0-9_+-]*$/.test(leftPlain)) {
      return false;
    }
    const combined = trimToken(leftPlain + rightPlain).value;
    const combinedPath = splitLocation(normalizedFilePath(combined)).filePath;
    const leftPath = splitLocation(normalizedFilePath(leftPlain)).filePath;
    if (!looksLikeFilePath(combinedPath)) return false;
    if (isIncompletePathToken(leftPlain)) return true;
    const combinedLast = combinedPath.split(/[\\/]/).pop() || '';
    const leftLast = leftPath.split(/[\\/]/).pop() || '';
    return hasSourceExtension(combinedLast) && !hasSourceExtension(leftLast);
  }

  // Some full-screen TUIs manually render visual wraps as hard terminal rows.
  // Treat a bounded, same-indent block as one paragraph only when at least one
  // non-final row reaches the TUI's right margin. This avoids merging ordinary
  // short output lines and lists.
  function hardWrapGroup(buffer, lineIndex) {
    const current = segmentAt(buffer, lineIndex);
    const indent = indentOf(current.text);
    const segments = [current];
    let cursor = current.start - 1;
    while (cursor >= 0 && segments.length < 20) {
      const candidate = segmentAt(buffer, cursor);
      const pathJoin = shouldJoinPathWrap(candidate.text, segments[0].text);
      if (!pathJoin && !compatibleSegment(candidate, indent)) break;
      if (!pathJoin && (candidate.parts.length !== 1 || segments[0].parts.length !== 1)) break;
      segments.unshift(candidate);
      cursor = candidate.start - 1;
    }
    cursor = current.end + 1;
    while (cursor < buffer.length && segments.length < 20) {
      const candidate = segmentAt(buffer, cursor);
      const pathJoin = shouldJoinPathWrap(segments[segments.length - 1].text, candidate.text);
      if (!pathJoin && !compatibleSegment(candidate, indent)) break;
      if (!pathJoin && (candidate.parts.length !== 1 || segments[segments.length - 1].parts.length !== 1)) break;
      segments.push(candidate);
      cursor = candidate.end + 1;
    }
    if (segments.length < 2) return [current];

    const pathPairs = [];
    for (let index = 1; index < segments.length; index++) {
      pathPairs[index] = shouldJoinPathWrap(segments[index - 1].text, segments[index].text);
    }
    if (pathPairs.some(Boolean)) {
      // Keep the contiguous path-join run that contains the tapped/current line.
      let from = 0;
      let to = segments.length - 1;
      for (let index = 1; index < segments.length; index++) {
        if (pathPairs[index]) continue;
        if (current.start >= segments[index].start) from = index;
        else { to = index - 1; break; }
      }
      const run = segments.slice(from, to + 1);
      if (run.length >= 2 && run.some((segment, index) => index > 0 && pathPairs[from + index])) {
        return run;
      }
    }

    if (segments.some(segment => segment.parts.length !== 1)) return [current];
    const threshold = Math.max(8, buffer.getLine(current.start)?.length - Math.max(4, Math.ceil((buffer.getLine(current.start)?.length || 80) * 0.18)));
    const reachesMargin = segments.slice(0, -1).some(segment => segment.usedColumns >= threshold);
    const endsBeforeMargin = segments[segments.length - 1].usedColumns < threshold;
    return reachesMargin && endsBeforeMargin ? segments : [current];
  }

  function unmatchedOpenParens(text) {
    let count = 0;
    for (const ch of String(text || '')) {
      if (ch === '(' || ch === '（' || ch === '[' || ch === '【') count++;
      else if (ch === ')' || ch === '）' || ch === ']' || ch === '】') count = Math.max(0, count - 1);
    }
    return count;
  }

  function joiner(previous, next) {
    if (shouldJoinPathWrap(previous, next)) return '';
    const left = previous.match(/(\S+)\s*$/)?.[1] || '';
    const right = next.match(/^\s*(\S+)/)?.[1] || '';
    if (!left || !right) return '';
    if (/^[·•・]/.test(right) || /[·•・]$/.test(left)) return ' ';
    if (/^[(（]/.test(right) && unmatchedOpenParens(previous) === 0) return ' ';
    if (/[^\x00-\x7f]$/.test(left) || /^[^\x00-\x7f]/.test(right)) return '';
    if (/[\\/_@.:-]$/.test(left) || /^[\\/_.:,-]/.test(right)) return '';
    if (/[\\/_@.:-]/.test(left) || /[\\/_@.:-]/.test(right)) return '';
    return /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right) ? ' ' : '';
  }

  function readLogicalLine(buffer, lineIndex) {
    const segments = hardWrapGroup(buffer, lineIndex);
    let text = '';
    const positions = [];
    const hardJoinedRows = [];
    segments.forEach((segment, segmentIndex) => {
      let segmentText = '';
      let segmentPositions = [];
      segment.parts.forEach(part => {
        segmentText += part.text;
        segmentPositions.push(...part.positions);
      });
      if (segmentIndex > 0) {
        const indent = indentOf(segmentText);
        const added = joiner(text, segmentText.slice(indent));
        text += added;
        for (let index = 0; index < added.length; index++) positions.push(null);
        segmentText = segmentText.slice(indent);
        segmentPositions = segmentPositions.slice(indent);
        hardJoinedRows.push(segment.start);
      }
      text += segmentText;
      positions.push(...segmentPositions);
    });
    return {
      text,
      positions,
      startLine: segments[0].start,
      endLine: segments[segments.length - 1].end,
      hardJoinedRows,
    };
  }

  function getSelectionText(buffer, selection) {
    if (!selection) return '';
    let endRow = selection.end.y;
    let endCell = selection.end.x;
    if (endRow > selection.start.y && endCell === 0) {
      endRow--;
      endCell = buffer.getLine(endRow)?.length || 0;
    }
    let result = '';
    for (let row = selection.start.y; row <= endRow; row++) {
      const line = buffer.getLine(row);
      if (!line) continue;
      const start = row === selection.start.y ? selection.start.x : 0;
      const end = row === endRow ? endCell : line.length;
      let part = readPhysicalLine(line, row, start, end).text;
      if (row === selection.start.y) {
        result = part;
        continue;
      }
      if (line.isWrapped) {
        result += part;
        continue;
      }
      const group = readLogicalLine(buffer, row);
      if (group.hardJoinedRows.includes(row)) {
        part = part.slice(indentOf(part));
        result += joiner(result, part) + part;
      } else {
        result += '\n' + part;
      }
    }
    return result;
  }

  function trimToken(raw) {
    let start = 0;
    while (start < raw.length && /[([{<"'`“‘（【]/.test(raw[start])) start++;
    let end = raw.length;
    while (end > start && /[.,;:!?)\]}>，。；！？、"'`”’）】·•・]/.test(raw[end - 1])) end--;
    return { value: raw.slice(start, end), offset: start };
  }
  function splitLocation(value) {
    const match = value.match(/(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?)$/i);
    return match ? { filePath: value.slice(0, -match[0].length), suffix: match[0] } : { filePath: value, suffix: '' };
  }

  const DOWNLOAD_EXTENSIONS = new Set([
    'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'tbz2', 'xz', 'txz',
    'zst', 'cab', 'iso', 'dmg', 'doc', 'docx', 'docm', 'dot', 'dotx', 'xls',
    'xlsx', 'xlsm', 'xlsb', 'xlt', 'xltx', 'ppt', 'pptx', 'pptm', 'pps', 'ppsx',
    'pot', 'potx', 'odt', 'ods', 'odp', 'pages', 'numbers', 'key', 'epub', 'mobi',
    'azw', 'azw3', 'psd', 'psb', 'ai', 'eps', 'sketch', 'fig', 'xd', 'indd',
    'blend', 'obj', 'stl', 'glb', 'gltf', 'fbx', 'ttf', 'otf', 'woff', 'woff2',
    'apk', 'aab', 'ipa', 'exe', 'msi', 'deb', 'rpm', 'pkg', 'appimage', 'wasm',
    'db', 'sqlite', 'sqlite3', 'parquet', 'arrow', 'feather', 'npy', 'npz', 'pkl', 'pickle',
    'tiff', 'tif', 'raw', 'cr2', 'nef', 'avi', 'wmv', 'flv', 'mpeg', 'mpg',
    'm4b', 'opus', 'aiff', 'aif',
  ]);

  const SOURCE_FILE_EXTENSIONS = new Set([
    ...DOWNLOAD_EXTENSIONS,
    // web / js
    'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte', 'astro', 'css', 'scss', 'sass', 'less',
    'html', 'htm', 'xhtml', 'nvue', 'wxml', 'wxss',
    // docs / data / config
    'md', 'mdx', 'markdown', 'txt', 'log', 'json', 'jsonc', 'jsonl', 'yaml', 'yml', 'toml', 'xml', 'csv', 'tsv',
    'ini', 'conf', 'cfg', 'config', 'properties', 'env', 'lock', 'map',
    'ipynb', 'tex', 'bib', 'rst', 'adoc', 'diff', 'patch', 'srt', 'vtt', 'graphql', 'gql', 'proto',
    // scripts / shells
    'sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1', 'psm1',
    // systems languages
    'py', 'pyw', 'pyi', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'hh', 'hxx',
    'cs', 'rb', 'php', 'pl', 'pm', 'r', 'lua', 'dart', 'scala', 'clj', 'ex', 'exs', 'erl', 'hs', 'mm', 'm',
    'sql', 'gradle', 'wasm',
    // mobile / design / docs
    'pdf', 'rtf', 'svg',
    // media (clickable when wrapped; preview routed by media helpers)
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'heic', 'heif', 'ico',
    'mp4', 'm4v', 'mov', 'webm', 'mkv',
    'mp3', 'm4a', 'aac', 'wav', 'ogg', 'flac',
    // build / meta filenames treated as extensions above when dotted
    'dockerfile', 'makefile', 'gitignore', 'npmrc', 'editorconfig', 'eslintrc', 'prettierrc',
  ]);

  const SLASH_STOP_WORDS = new Set([
    'and', 'or', 'yes', 'no', 'on', 'off', 'in', 'out', 'up', 'down', 'to', 'from',
    'as', 'at', 'by', 'of', 'if', 'is', 'it', 'an', 'the', 'per', 'via', 'for', 'not',
    'new', 'old', 'pre', 'post', 'true', 'false', 'input', 'output', 'inner', 'outer',
    'read', 'write', 'open', 'close', 'add', 'del', 'get', 'set', 'use', 'dev', 'prod',
    'test', 'live', 'lan', 'wan', 'io',
  ]);

  function hasSourceExtension(value) {
    const match = value.match(/\.([A-Za-z0-9][A-Za-z0-9_+-]{0,20})$/);
    if (!match) return false;
    return SOURCE_FILE_EXTENSIONS.has(match[1].toLowerCase());
  }

  function isSpecialFilename(value) {
    return /^(Makefile|Dockerfile|README|LICENSE)$/i.test(value);
  }

  function looksLikeHostname(value) {
    return /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(value);
  }

  function looksLikeVersion(value) {
    return /^v?\d+(?:\.\d+){1,3}(?:[-+][\w.-]+)?$/i.test(value);
  }

  function looksLikeSlashPath(plain) {
    const { filePath } = splitLocation(plain);
    if (/^\d[\d./-]*$/.test(filePath.replace(/[\\/]/g, '/'))) return false;

    const segments = filePath.split(/[\\/]/).filter(Boolean);
    if (segments.length === 0) return false;

    const last = segments[segments.length - 1];
    const hasExtension = hasSourceExtension(last) || isSpecialFilename(last);
    const hasExplicitPrefix = /^(?:file:\/\/|[A-Za-z]:[\\/]|\\\\|\/|~[\\/]|\.{1,2}[\\/]|@[\\/])/.test(plain);

    // A slash in prose (for example, “档案/聊天”) is common Chinese
    // punctuation, not a path. Bare slash paths without a file extension
    // must use conventional ASCII path segments; explicit prefixes still
    // allow intentionally named non-ASCII directories.
    if (!hasExplicitPrefix && !hasExtension
      && !segments.every(segment => /^[A-Za-z0-9._~@+\-]+$/.test(segment))) return false;

    if (/^@[^/\\]+/.test(filePath) && segments.length <= 2 && !hasExtension) return false;

    if (segments.length === 2 && !hasExtension) {
      const [left, right] = segments;
      const wordLike = (part) => /^[a-z]{2,8}$/i.test(part) && !/[_\d.-]/.test(part);
      const leftStop = SLASH_STOP_WORDS.has(left.toLowerCase());
      const rightStop = SLASH_STOP_WORDS.has(right.toLowerCase());
      if (wordLike(left) && wordLike(right) && (leftStop || rightStop)) return false;
    }

    return true;
  }

  function looksLikeBareFilename(plain) {
    const { filePath } = splitLocation(plain);
    if (!filePath || filePath.includes('@')) return false;
    if (looksLikeVersion(filePath)) return false;
    if (!hasSourceExtension(filePath)) return false;
    if (looksLikeHostname(filePath) && !DOWNLOAD_EXTENSIONS.has(filePath.split('.').pop().toLowerCase())) return false;
    return true;
  }

  function looksLikeFilePath(value) {
    const plain = clipGluedProse(value.replace(/^file:\/\//i, '').replace(/\\ /g, ' '));
    if (/^(?:[A-Za-z]:[\\/]|\\\\|\/|~[\\/]|\.{1,2}[\\/]|@[\\/])/.test(plain)) return true;
    if (/[\\/]/.test(plain)) return looksLikeSlashPath(plain);
    return looksLikeBareFilename(plain);
  }
  function normalizedFilePath(value) {
    return value.replace(/^file:\/\//i, '').replace(/\\ /g, ' ');
  }
  function overlaps(matches, start, length) {
    return matches.some(match => start < match.index + match.length && start + length > match.index);
  }

  function pushFileMatch(matches, raw, index) {
    if (!raw) return;
    const cleaned = clipGluedProse(raw);
    if (!cleaned) return;
    const location = splitLocation(cleaned);
    if (!looksLikeFilePath(location.filePath) || overlaps(matches, index, cleaned.length)) return;
    matches.push({
      kind: 'file',
      filePath: normalizedFilePath(location.filePath),
      display: cleaned,
      index,
      length: cleaned.length,
    });
  }

  function findLinks(text) {
    const matches = [];
    const quoted = /(["'`])([^"'`\r\n]+)\1/gu;
    let match;
    while ((match = quoted.exec(text)) !== null) {
      pushFileMatch(matches, match[2], match.index + 1);
    }
    // CLI citations: 增强检查片（23.9 秒） (Artifacts/foo.mp4) · 验证记录 (docs/bar.md)
    const wrapped = /[（(]([^）)\r\n]+)[）)]/gu;
    while ((match = wrapped.exec(text)) !== null) {
      const inner = match[1];
      const trimmed = inner.replace(/^\s+|\s+$/g, '');
      if (!trimmed) continue;
      pushFileMatch(matches, trimmed, match.index + 1 + inner.indexOf(trimmed));
    }
    const tokens = /(?:\\ |[^\s<>"'`·•・])+/gu;
    while ((match = tokens.exec(text)) !== null) {
      const trimmed = trimToken(match[0]);
      if (!trimmed.value) continue;
      const index = match.index + trimmed.offset;
      if (/^https?:\/\//i.test(trimmed.value)) {
        if (!overlaps(matches, index, trimmed.value.length)) matches.push({ kind: 'url', url: trimmed.value, display: trimmed.value, index, length: trimmed.value.length });
        continue;
      }
      pushFileMatch(matches, trimmed.value, index);
    }
    return matches.sort((a, b) => a.index - b.index);
  }

  function positionsRange(logicalLine, start, end) {
    let from = start;
    let to = end;
    while (from <= to && !logicalLine.positions[from]) from++;
    while (to >= from && !logicalLine.positions[to]) to--;
    if (from > to) return null;
    return { start: logicalLine.positions[from], end: logicalLine.positions[to] };
  }

  function matchRange(logicalLine, match) {
    return positionsRange(logicalLine, match.index, match.index + match.length - 1);
  }

  function cellInLinkRange(range, cell, cols = 0) {
    if (!range || !cell) return false;
    const row = cell.row;
    const col = cell.col;
    if (row < range.start.line || row > range.end.line) return false;
    if (range.start.line === range.end.line) {
      return col >= range.start.cell && col <= range.end.cell;
    }
    if (row === range.start.line) return col >= range.start.cell;
    if (row === range.end.line) return col <= range.end.cell;
    // Middle visual rows of a wrapped path are fully clickable.
    if (cols > 0) return col >= 0 && col < cols;
    return true;
  }

  function cellDistanceToLinkRange(range, cell) {
    if (!range || !cell) return Infinity;
    const row = cell.row;
    const col = cell.col;
    if (row < range.start.line) {
      return (range.start.line - row) * 1000 + Math.max(0, range.start.cell - col);
    }
    if (row > range.end.line) {
      return (row - range.end.line) * 1000 + Math.max(0, col - range.end.cell);
    }
    if (range.start.line === range.end.line) {
      if (col < range.start.cell) return range.start.cell - col;
      if (col > range.end.cell) return col - range.end.cell;
      return 0;
    }
    if (row === range.start.line && col < range.start.cell) return range.start.cell - col;
    if (row === range.end.line && col > range.end.cell) return col - range.end.cell;
    return 0;
  }

  /** Prefer an exact wrapped-range hit; otherwise the nearest link within a few cells. */
  function findLinkAtCell(logicalLine, cell, options = {}) {
    if (!logicalLine || !cell) return null;
    const matches = Array.isArray(options.matches) ? options.matches : findLinks(logicalLine.text);
    const maxDist = Number.isFinite(options.maxDistance) ? options.maxDistance : 2;
    const cols = options.cols || 0;
    const predicate = typeof options.predicate === 'function' ? options.predicate : () => true;
    let best = null;
    let bestDist = Infinity;
    for (const match of matches) {
      if (!predicate(match)) continue;
      const range = matchRange(logicalLine, match);
      if (!range) continue;
      if (cellInLinkRange(range, cell, cols)) return match;
      const dist = cellDistanceToLinkRange(range, cell);
      if (dist < bestDist) {
        bestDist = dist;
        best = match;
      }
    }
    return bestDist <= maxDist ? best : null;
  }

  function isHighSurrogate(value) {
    const code = value.charCodeAt(0);
    return code >= 0xd800 && code <= 0xdbff;
  }

  function charEnd(text, index) {
    return index + (isHighSurrogate(text[index]) ? 2 : 1);
  }

  // 中文没有空格分词，一次选中一个字，剩下的交给用户拖手柄扩选。
  function isCjkChar(value) {
    const code = value.codePointAt(0);
    return (code >= 0x3040 && code <= 0x30ff)
      || (code >= 0x3400 && code <= 0x4dbf)
      || (code >= 0x4e00 && code <= 0x9fff)
      || (code >= 0xac00 && code <= 0xd7af)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xff00 && code <= 0xffef);
  }

  // positions 里同一个宽字符会出现两次（指向同一 cell），命中后半格时退到字符起点。
  function indexAtCell(logicalLine, cell) {
    let best = -1;
    for (let index = 0; index < logicalLine.positions.length; index++) {
      const position = logicalLine.positions[index];
      if (!position) continue;
      if (position.line > cell.row || (position.line === cell.row && position.cell > cell.col)) break;
      best = index;
    }
    return best;
  }

  function wordRangeAt(logicalLine, cell) {
    if (!logicalLine || !cell) return null;
    const text = logicalLine.text;
    const index = indexAtCell(logicalLine, cell);
    if (index < 0 || index >= text.length) return null;
    let start = index;
    let end = charEnd(text, index);
    if (/\s/.test(text[index])) {
      while (start > 0 && /\s/.test(text[start - 1])) start--;
      while (end < text.length && /\s/.test(text[end])) end = charEnd(text, end);
    } else if (!isCjkChar(text[index])) {
      while (start > 0 && !/\s/.test(text[start - 1])) start--;
      while (end < text.length && !/\s/.test(text[end])) end = charEnd(text, end);
      const rawStart = start;
      const rawEnd = end;
      while (start < end && /[([{<"'`“‘（【]/.test(text[start])) start++;
      while (end > start && /[.,;:!?)\]}>，。；！？、"'`”’）】]/.test(text[end - 1])) end--;
      if (start >= end) { start = rawStart; end = rawEnd; }
    }
    return positionsRange(logicalLine, start, end - 1);
  }

  return { DOWNLOAD_EXTENSIONS, readLogicalLine, getSelectionText, findLinks, matchRange, wordRangeAt, findLinkAtCell, cellInLinkRange };
});
