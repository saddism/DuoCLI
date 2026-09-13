(function (root, factory) {
  const terminalContentHelpers = root.DuoTerminalContentHelpers
    || (typeof module === 'object' && module.exports ? require('./terminal-content-helpers.js') : null);
  const exported = factory(terminalContentHelpers);
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  root.DuoFilePreviewHelpers = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (terminalContentHelpers) {
  // Text / code previews. Media uses MEDIA_EXT_KIND below; keep this list
  // aligned with terminal-content-helpers SOURCE_FILE_EXTENSIONS so wrap
  // clicks on non-.md paths open instead of "暂不支持预览".
  const PREVIEW_EXTENSIONS = new Set([
    'md', 'mdx', 'markdown', 'txt', 'log', 'rtf',
    'ipynb', 'tex', 'bib', 'rst', 'adoc', 'diff', 'patch', 'srt', 'vtt', 'graphql', 'gql', 'proto',
    'json', 'jsonc', 'jsonl', 'yaml', 'yml', 'toml', 'xml', 'csv', 'tsv',
    'ini', 'conf', 'cfg', 'config', 'properties', 'env', 'lock', 'map',
    'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts',
    'vue', 'svelte', 'astro', 'nvue', 'wxml', 'wxss',
    'css', 'scss', 'sass', 'less', 'html', 'htm', 'xhtml',
    'py', 'pyw', 'pyi', 'go', 'rs', 'java', 'kt', 'kts', 'swift',
    'c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'hh', 'hxx', 'cs',
    'rb', 'php', 'pl', 'pm', 'r', 'lua', 'dart', 'scala', 'clj',
    'ex', 'exs', 'erl', 'hs', 'mm', 'm', 'sql', 'gradle',
    'sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1', 'psm1',
  ]);

  // 媒体扩展名 → kind（与后端 MEDIA_EXT_MAP 对应，用于前端分流渲染）
  const MEDIA_EXT_KIND = {
    jpg: 'image', jpeg: 'image', png: 'image', gif: 'image',
    webp: 'image', bmp: 'image', svg: 'image', avif: 'image',
    heic: 'image', heif: 'image', ico: 'image',
    mp4: 'video', m4v: 'video', mov: 'video', webm: 'video', mkv: 'video',
    mp3: 'audio', m4a: 'audio', aac: 'audio', wav: 'audio',
    ogg: 'audio', flac: 'audio',
    pdf: 'pdf',
  };

  const CODE_EXTENSIONS = new Set([
    'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts',
    'vue', 'svelte', 'astro', 'nvue', 'wxml', 'wxss',
    'css', 'scss', 'sass', 'less', 'html', 'htm', 'xhtml',
    'py', 'pyw', 'pyi', 'go', 'rs', 'java', 'kt', 'kts', 'swift',
    'c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'hh', 'hxx', 'cs',
    'rb', 'php', 'pl', 'pm', 'r', 'lua', 'dart', 'scala', 'clj',
    'ex', 'exs', 'erl', 'hs', 'mm', 'm', 'sql', 'gradle',
    'sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1', 'psm1',
  ]);

  const DOCUMENT_EXTENSIONS = new Set([
    'md', 'mdx', 'markdown', 'txt', 'log', 'pdf', 'rtf', 'doc', 'docx', 'odt',
    'pages', 'epub', 'mobi', 'csv', 'tsv', 'xls', 'xlsx', 'ppt', 'pptx',
    'numbers', 'key', 'json', 'jsonc', 'jsonl', 'yaml', 'yml', 'toml', 'xml',
    'ini', 'conf', 'cfg', 'config', 'properties', 'env', 'lock', 'map',
  ]);

  const SKIP_DIR_NAMES = new Set([
    'node_modules', '.git', '.hg', '.svn', '__pycache__', '.next', '.nuxt',
  ]);

  function getFileExtension(filePath) {
    const name = String(filePath || '').split(/[\\/]/).pop() || '';
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return '';
    return name.slice(dot + 1).toLowerCase();
  }

  function getMediaKind(filePath) {
    const name = String(filePath || '').split(/[\\/]/).pop() || '';
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return null;
    return MEDIA_EXT_KIND[name.slice(dot + 1).toLowerCase()] || null;
  }

  function isPreviewableFileName(filePath) {
    const name = String(filePath || '').split(/[\\/]/).pop() || '';
    if (name.toLowerCase() === '.env' || name.toLowerCase().startsWith('.env.')) return false;
    const ext = getFileExtension(filePath);
    if (!ext) return false;
    return PREVIEW_EXTENSIONS.has(ext) || MEDIA_EXT_KIND[ext] != null;
  }

  function isDownloadableFileName(filePath) {
    return terminalContentHelpers.DOWNLOAD_EXTENSIONS.has(getFileExtension(filePath));
  }

  function isLinkableFileName(filePath) {
    return isPreviewableFileName(filePath) || isDownloadableFileName(filePath);
  }

  function shouldSkipDirName(name) {
    return SKIP_DIR_NAMES.has(String(name || ''));
  }

  function matchesFileBrowseFilter(item, filter) {
    if (!item || item.isDir) return !shouldSkipDirName(item?.name);
    if (filter === 'all') return true;
    const ext = getFileExtension(item.path || item.name);
    if (filter === 'media') return MEDIA_EXT_KIND[ext] != null;
    if (filter === 'document') {
      return DOCUMENT_EXTENSIONS.has(ext) && !CODE_EXTENSIONS.has(ext);
    }
    return true;
  }

  function findFilePathMatches(text) {
    if (!terminalContentHelpers) return [];
    return terminalContentHelpers.findLinks(String(text || ''))
      .filter(item => item.kind === 'file' && !item.filePath.includes('node_modules') && isLinkableFileName(item.filePath))
      .map(item => ({ filePath: item.filePath, index: item.index, length: item.length }));
  }

  return {
    PREVIEW_EXTENSIONS,
    MEDIA_EXT_KIND,
    DOCUMENT_EXTENSIONS,
    CODE_EXTENSIONS,
    isPreviewableFileName,
    isDownloadableFileName,
    isLinkableFileName,
    findFilePathMatches,
    getMediaKind,
    getFileExtension,
    shouldSkipDirName,
    matchesFileBrowseFilter,
  };
});
