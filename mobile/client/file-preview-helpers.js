(function (root, factory) {
  const terminalContentHelpers = root.DuoTerminalContentHelpers
    || (typeof module === 'object' && module.exports ? require('./terminal-content-helpers.js') : null);
  const exported = factory(terminalContentHelpers);
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  root.DuoFilePreviewHelpers = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (terminalContentHelpers) {
  const PREVIEW_EXTENSIONS = new Set([
    'md', 'markdown', 'txt', 'log', 'json', 'jsonl', 'yaml', 'yml', 'toml',
    'xml', 'csv', 'tsv', 'ini', 'conf', 'config', 'properties',
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

  const CODE_EXTENSIONS = new Set([
    'js', 'jsx', 'ts', 'tsx', 'vue', 'css', 'scss', 'less', 'html', 'htm',
    'py', 'pyw', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cc', 'cpp', 'h',
    'hpp', 'sh', 'bash', 'zsh', 'fish', 'sql', 'nvue', 'wxml', 'wxss',
    'rb', 'php', 'cs', 'm', 'mm', 'scala', 'clj', 'ex', 'exs', 'erl', 'hs',
    'lua', 'r', 'dart', 'svelte', 'astro',
  ]);

  const DOCUMENT_EXTENSIONS = new Set([
    'md', 'markdown', 'txt', 'log', 'pdf', 'rtf', 'doc', 'docx', 'odt',
    'pages', 'epub', 'mobi', 'csv', 'tsv', 'xls', 'xlsx', 'ppt', 'pptx',
    'numbers', 'key', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'xml', 'ini',
    'conf', 'config', 'properties',
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
      .filter(item => item.kind === 'file' && !item.filePath.includes('node_modules') && isPreviewableFileName(item.filePath))
      .map(item => ({ filePath: item.filePath, index: item.index, length: item.length }));
  }

  return {
    PREVIEW_EXTENSIONS,
    MEDIA_EXT_KIND,
    DOCUMENT_EXTENSIONS,
    CODE_EXTENSIONS,
    isPreviewableFileName,
    findFilePathMatches,
    getMediaKind,
    getFileExtension,
    shouldSkipDirName,
    matchesFileBrowseFilter,
  };
});
