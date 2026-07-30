(function (root, factory) {
  const exported = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  root.DuoFilePreviewHelpers = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const PREVIEW_EXTENSIONS = new Set([
    'md', 'markdown', 'txt', 'log', 'json', 'jsonl', 'yaml', 'yml', 'toml',
    'xml', 'csv', 'tsv', 'ini', 'conf', 'config', 'env', 'properties',
    'js', 'jsx', 'ts', 'tsx', 'vue', 'css', 'scss', 'less', 'html', 'htm',
    'py', 'pyw', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cc', 'cpp', 'h',
    'hpp', 'sh', 'bash', 'zsh', 'fish', 'sql', 'nvue', 'wxml', 'wxss',
  ]);

  // 媒体扩展名 → kind（与后端 MEDIA_EXT_MAP 对应，用于前端分流渲染）
  const MEDIA_EXT_KIND = {
    jpg: 'image', jpeg: 'image', png: 'image', gif: 'image',
    webp: 'image', bmp: 'image', svg: 'image', avif: 'image',
    heic: 'image', heif: 'image',
    mp4: 'video', m4v: 'video', mov: 'video', webm: 'video',
    mp3: 'audio', m4a: 'audio', aac: 'audio', wav: 'audio',
    ogg: 'audio', flac: 'audio',
    pdf: 'pdf',
  };

  function getMediaKind(filePath) {
    const name = String(filePath || '').split(/[\\/]/).pop() || '';
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return null;
    return MEDIA_EXT_KIND[name.slice(dot + 1).toLowerCase()] || null;
  }

  const PATH_RE = /(?:@\/?|\.\/|\/)?(?:[\w.\-\u4e00-\u9fff]+\/)+[\w.\-\u4e00-\u9fff]*(?:\.[\w]+)?/g;
  const SINGLE_FILE_RE = /(?<![\/\w.\-])[\w.\-\u4e00-\u9fff]+\.[a-z0-9][a-z0-9_-]{0,15}(?![\w.\-])/gi;
  const URL_RE = /https?:\/\/[^\s<>"']+/g;

  function trimPunctuation(value) {
    return value.replace(/[.,;:!?)\]}>]+$/, '');
  }

  function isPreviewableFileName(filePath) {
    const name = String(filePath || '').split(/[\\/]/).pop() || '';
    if (name.toLowerCase() === '.env') return true;
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return false;
    const ext = name.slice(dot + 1).toLowerCase();
    return PREVIEW_EXTENSIONS.has(ext) || MEDIA_EXT_KIND[ext] != null;
  }

  function findFilePathMatches(text) {
    const matched = [];
    let match;
    URL_RE.lastIndex = 0;
    while ((match = URL_RE.exec(text)) !== null) {
      const url = trimPunctuation(match[0]);
      if (url.length >= 8) matched.push({ filePath: url, index: match.index, length: url.length, isUrl: true });
    }

    PATH_RE.lastIndex = 0;
    while ((match = PATH_RE.exec(text)) !== null) {
      const filePath = trimPunctuation(match[0]);
      if (filePath.length < 4 || !isPreviewableFileName(filePath)) continue;
      if (filePath.includes('node_modules')) continue;
      if (matched.some((item) => match.index >= item.index && match.index < item.index + item.length)) continue;
      matched.push({ filePath, index: match.index, length: filePath.length });
    }

    SINGLE_FILE_RE.lastIndex = 0;
    while ((match = SINGLE_FILE_RE.exec(text)) !== null) {
      const filePath = match[0];
      if (!isPreviewableFileName(filePath)) continue;
      if (matched.some((item) => match.index >= item.index && match.index < item.index + item.length)) continue;
      matched.push({ filePath, index: match.index, length: filePath.length });
    }
    return matched.filter((item) => !item.isUrl).sort((a, b) => a.index - b.index);
  }

  return { PREVIEW_EXTENSIONS, MEDIA_EXT_KIND, isPreviewableFileName, findFilePathMatches, getMediaKind };
});
