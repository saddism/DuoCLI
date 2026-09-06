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

  function getMediaKind(filePath) {
    const name = String(filePath || '').split(/[\\/]/).pop() || '';
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return null;
    return MEDIA_EXT_KIND[name.slice(dot + 1).toLowerCase()] || null;
  }

  function isPreviewableFileName(filePath) {
    const name = String(filePath || '').split(/[\\/]/).pop() || '';
    if (name.toLowerCase() === '.env' || name.toLowerCase().startsWith('.env.')) return false;
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return false;
    const ext = name.slice(dot + 1).toLowerCase();
    return PREVIEW_EXTENSIONS.has(ext) || MEDIA_EXT_KIND[ext] != null;
  }

  function findFilePathMatches(text) {
    if (!terminalContentHelpers) return [];
    return terminalContentHelpers.findLinks(String(text || ''))
      .filter(item => item.kind === 'file' && !item.filePath.includes('node_modules') && isPreviewableFileName(item.filePath))
      .map(item => ({ filePath: item.filePath, index: item.index, length: item.length }));
  }

  return { PREVIEW_EXTENSIONS, MEDIA_EXT_KIND, isPreviewableFileName, findFilePathMatches, getMediaKind };
});
