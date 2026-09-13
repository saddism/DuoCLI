import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import express from 'express';
import { DOWNLOAD_EXTENSIONS, sendFileDownload } from '../dist/main/file-download.js';
const require = createRequire(import.meta.url);
const content = require('../mobile/client/terminal-content-helpers.js');
const preview = require('../mobile/client/file-preview-helpers.js');

test('all downloadable extensions are recognized on both clients and match the server', () => {
  assert.deepEqual([...DOWNLOAD_EXTENSIONS].sort(), [...content.DOWNLOAD_EXTENSIONS].map(ext => `.${ext}`).sort());
  for (const ext of content.DOWNLOAD_EXTENSIONS) {
    const file = `data-store/Artifacts/宣传素材.${ext.toUpperCase()}`;
    assert.deepEqual(content.findLinks(`下载 (${file})`).map(item => item.filePath), [file]);
    assert.deepEqual(preview.findFilePathMatches(`下载 (${file})`).map(item => item.filePath), [file]);
    assert.equal(preview.isDownloadableFileName(file), true);
    assert.equal(content.findLinks(`archive.${ext}`)[0]?.filePath, `archive.${ext}`);
    assert.equal(preview.isPreviewableFileName(file), false);
  }
  assert.equal(preview.isLinkableFileName('.env.local'), false);
  assert.deepEqual(content.findLinks('example.com 档案/聊天 v1.2.3'), []);
});

test('downloads stream exact bytes with attachment headers and enforce workspace boundaries', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duocli-download-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const name = '家长糖宣传图-V7.zip';
  const bytes = Buffer.from([0x50, 0x4b, 0, 255, 13, 10]);
  fs.writeFileSync(path.join(workspace, name), bytes);
  fs.writeFileSync(path.join(root, 'outside.zip'), bytes);
  fs.writeFileSync(path.join(workspace, '.env'), 'secret');
  fs.symlinkSync(path.join(root, 'outside.zip'), path.join(workspace, 'escape.zip'));
  fs.mkdirSync(path.join(workspace, 'directory.zip'));
  const app = express();
  app.get('/download', (req, res) => sendFileDownload(workspace, String(req.query.path || ''), res));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const get = file => fetch(`http://127.0.0.1:${server.address().port}/download?path=${encodeURIComponent(file)}`);
  for (const file of [name, `@/${name}`, path.join(workspace, name)]) {
    const response = await get(file);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /^attachment;/);
    assert.ok(response.headers.get('content-disposition').includes(encodeURIComponent(name)));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  }
  for (const file of ['../outside.zip', 'escape.zip', '.env', 'directory.zip', path.join(root, 'outside.zip')]) {
    assert.equal((await get(file)).status, 400, file);
  }
  assert.equal((await get('missing.zip')).status, 404);
});
