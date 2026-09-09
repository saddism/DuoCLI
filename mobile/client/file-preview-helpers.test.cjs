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
