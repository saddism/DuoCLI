const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isPreviewableFileName,
  findFilePathMatches,
} = require('./file-preview-helpers.js');

test('preview helper accepts common text files case-insensitively', () => {
  assert.equal(isPreviewableFileName('README.MD'), true);
  assert.equal(isPreviewableFileName('logs/build.LOG'), true);
  assert.equal(isPreviewableFileName('video.mp4'), false);
});

test('preview helper finds relative and absolute paths without trailing punctuation', () => {
  const matches = findFilePathMatches('看 docs/README.MD 和 /tmp/config.JSON。');
  assert.deepEqual(matches.map((item) => item.filePath), ['docs/README.MD', '/tmp/config.JSON']);
});

test('preview helper does not turn URLs into file previews', () => {
  assert.deepEqual(findFilePathMatches('参考 https://example.com/README.md'), []);
});
