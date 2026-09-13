const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isPreviewableFileName,
  findFilePathMatches,
  getMediaKind,
} = require('./file-preview-helpers.js');

test('preview helper accepts common text files case-insensitively', () => {
  assert.equal(isPreviewableFileName('README.MD'), true);
  assert.equal(isPreviewableFileName('logs/build.LOG'), true);
  // mp4 现在作为媒体文件可预览
  assert.equal(isPreviewableFileName('video.mp4'), true);
  // 无扩展名或非可预览扩展名仍为 false
  assert.equal(isPreviewableFileName('Makefile'), false);
  assert.equal(isPreviewableFileName('archive.zip'), false);
  assert.equal(isPreviewableFileName('.env'), false);
  assert.equal(isPreviewableFileName('.env.local'), false);
});

test('media kind detection', () => {
  assert.equal(getMediaKind('a/b.mp4'), 'video');
  assert.equal(getMediaKind('photo.JPG'), 'image');
  assert.equal(getMediaKind('clip.mov'), 'video');
  assert.equal(getMediaKind('song.mp3'), 'audio');
  assert.equal(getMediaKind('doc.pdf'), 'pdf');
  assert.equal(getMediaKind('README.md'), null); // 文本，非媒体
  assert.equal(getMediaKind('archive.zip'), null);
});

test('preview helper finds relative and absolute paths without trailing punctuation', () => {
  const matches = findFilePathMatches('看 docs/README.MD、"src/My File.ts":8 和 C:\\work\\main.py:4:2。');
  assert.deepEqual(matches.map((item) => item.filePath), ['docs/README.MD', 'src/My File.ts', 'C:\\work\\main.py']);
});

test('file browse filter matches media and documents without code', () => {
  const { matchesFileBrowseFilter } = require('./file-preview-helpers.js');
  assert.equal(matchesFileBrowseFilter({ name: 'node_modules', isDir: true, path: '/p/node_modules' }, 'all'), false);
  assert.equal(matchesFileBrowseFilter({ name: 'clip.mp4', isDir: false, path: '/p/clip.mp4' }, 'media'), true);
  assert.equal(matchesFileBrowseFilter({ name: 'README.md', isDir: false, path: '/p/README.md' }, 'document'), true);
  assert.equal(matchesFileBrowseFilter({ name: 'app.ts', isDir: false, path: '/p/app.ts' }, 'document'), false);
  assert.equal(matchesFileBrowseFilter({ name: 'app.ts', isDir: false, path: '/p/app.ts' }, 'all'), true);
});

test('notebooks, markup, patches and subtitles are previewable links', () => {
  for (const ext of ['ipynb', 'tex', 'bib', 'rst', 'adoc', 'diff', 'patch', 'srt', 'vtt', 'graphql', 'gql', 'proto']) {
    const file = `artifacts/示例.${ext}`;
    assert.equal(isPreviewableFileName(file), true);
    assert.deepEqual(findFilePathMatches(`打开 (${file})`).map(item => item.filePath), [file]);
  }
});

test('parenthesized mp4 and md citations stay previewable links', () => {
  const mp4 = 'Artifacts/20260913-原生验证/enhanced-review.mp4';
  const md = 'docs/制作总稿原生验证-20260913.md';
  const matches = findFilePathMatches(`增强检查片（23.9 秒） (${mp4}) · 验证记录 (${md})`);
  assert.deepEqual(matches.map((item) => item.filePath), [mp4, md]);
});

test('parenthesized HTML artifact path is a previewable link', () => {
  const html = 'Artifacts/20260913-全片总稿验证/project/views/r000134-b8055f7f9fea-4e4df0ce/index.html';
  assert.equal(isPreviewableFileName(html), true);
  assert.deepEqual(
    findFilePathMatches(`全片制作总稿 HTML (${html})。它包含全文`).map((item) => item.filePath),
    [html],
  );
});
