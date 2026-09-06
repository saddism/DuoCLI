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
      if (!compatibleSegment(candidate, indent)) break;
      segments.unshift(candidate);
      cursor = candidate.start - 1;
    }
    cursor = current.end + 1;
    while (cursor < buffer.length && segments.length < 20) {
      const candidate = segmentAt(buffer, cursor);
      if (!compatibleSegment(candidate, indent)) break;
      segments.push(candidate);
      cursor = candidate.end + 1;
    }
    if (segments.length < 2 || segments.some(segment => segment.parts.length !== 1)) return [current];
    const threshold = Math.max(8, buffer.getLine(current.start)?.length - Math.max(4, Math.ceil((buffer.getLine(current.start)?.length || 80) * 0.18)));
    const reachesMargin = segments.slice(0, -1).some(segment => segment.usedColumns >= threshold);
    const endsBeforeMargin = segments[segments.length - 1].usedColumns < threshold;
    return reachesMargin && endsBeforeMargin ? segments : [current];
  }

  function joiner(previous, next) {
    const left = previous.match(/(\S+)\s*$/)?.[1] || '';
    const right = next.match(/^\s*(\S+)/)?.[1] || '';
    if (!left || !right) return '';
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
    while (start < raw.length && /[([{<]/.test(raw[start])) start++;
    let end = raw.length;
    while (end > start && /[.,;!?，。；！？、)\]}>]/.test(raw[end - 1])) end--;
    return { value: raw.slice(start, end), offset: start };
  }
  function splitLocation(value) {
    const match = value.match(/(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?)$/i);
    return match ? { filePath: value.slice(0, -match[0].length), suffix: match[0] } : { filePath: value, suffix: '' };
  }

  const SOURCE_FILE_EXTENSIONS = new Set([
    'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'vue', 'svelte',
    'css', 'scss', 'less', 'html', 'htm', 'json', 'yaml', 'yml', 'toml', 'md', 'mdx',
    'txt', 'sh', 'bash', 'zsh', 'bat', 'ps1', 'sql', 'swift', 'kt', 'kts', 'java',
    'cpp', 'cc', 'cxx', 'c', 'h', 'hpp', 'hh', 'hxx', 'cs', 'rb', 'php', 'pl', 'pm',
    'r', 'gradle', 'properties', 'env', 'ini', 'conf', 'cfg', 'lock', 'map', 'wasm',
    'dockerfile', 'makefile', 'gitignore', 'npmrc', 'editorconfig',
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
    if (looksLikeHostname(filePath)) return false;
    return true;
  }

  function looksLikeFilePath(value) {
    const plain = value.replace(/^file:\/\//i, '').replace(/\\ /g, ' ');
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

  function findLinks(text) {
    const matches = [];
    const quoted = /(["'`])([^"'`\r\n]+)\1/gu;
    let match;
    while ((match = quoted.exec(text)) !== null) {
      const location = splitLocation(match[2]);
      if (!looksLikeFilePath(location.filePath)) continue;
      matches.push({ kind: 'file', filePath: normalizedFilePath(location.filePath), display: match[2], index: match.index + 1, length: match[2].length });
    }
    const tokens = /(?:\\ |[^\s<>"'`])+/gu;
    while ((match = tokens.exec(text)) !== null) {
      const trimmed = trimToken(match[0]);
      if (!trimmed.value) continue;
      const index = match.index + trimmed.offset;
      if (/^https?:\/\//i.test(trimmed.value)) {
        if (!overlaps(matches, index, trimmed.value.length)) matches.push({ kind: 'url', url: trimmed.value, display: trimmed.value, index, length: trimmed.value.length });
        continue;
      }
      const location = splitLocation(trimmed.value);
      if (!looksLikeFilePath(location.filePath) || overlaps(matches, index, trimmed.value.length)) continue;
      matches.push({ kind: 'file', filePath: normalizedFilePath(location.filePath), display: trimmed.value, index, length: trimmed.value.length });
    }
    return matches.sort((a, b) => a.index - b.index);
  }

  function matchRange(logicalLine, match) {
    let start = match.index;
    let end = match.index + match.length - 1;
    while (start <= end && !logicalLine.positions[start]) start++;
    while (end >= start && !logicalLine.positions[end]) end--;
    if (start > end) return null;
    return { start: logicalLine.positions[start], end: logicalLine.positions[end] };
  }

  return { readLogicalLine, getSelectionText, findLinks, matchRange };
});
