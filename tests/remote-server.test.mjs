import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeUploadFilename, isDuoCliProcessCommand } from '../dist/main/remote-server.js';

test('decodes one upload filename layer without allowing paths', () => {
  assert.equal(decodeUploadFilename(encodeURIComponent('报告 1.md')), '报告 1.md');
  assert.equal(decodeUploadFilename('nested%2Fsecret.txt'), null);
  assert.equal(decodeUploadFilename('%E0%A4%A'), null);
  assert.equal(decodeUploadFilename('..'), null);
  assert.equal(decodeUploadFilename('100%25-ready.txt'), '100%-ready.txt');
});

test('only recognizes clearly owned DuoCLI listeners', () => {
  const root = '/Users/example/DuoCLI';
  assert.equal(isDuoCliProcessCommand(`${root}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .`, root), true);
  assert.equal(isDuoCliProcessCommand('/Applications/DuoCLI.app/Contents/MacOS/DuoCLI --no-sandbox', root), true);
  assert.equal(isDuoCliProcessCommand('/usr/local/bin/node unrelated-server.js', root), false);
  assert.equal(isDuoCliProcessCommand(`${root}-fork/node_modules/electron/dist/electron .`, root), false);
});
