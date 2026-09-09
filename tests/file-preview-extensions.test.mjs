// 手机端与服务端各自维护一份“可预览 / 媒体”扩展名表。
// 两边漂移的话，手机端会对服务端其实拒绝的类型显示预览入口，点开只能看到报错。
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mobileHelpers = require('../mobile/client/file-preview-helpers.js');
const { PREVIEW_EXTENSIONS, MEDIA_EXT_MAP } = await import('../dist/main/remote-server.js');

test('可预览的文本扩展名两端一致', () => {
  // 服务端用 path.extname 比较，带点；手机端不带
  const server = [...PREVIEW_EXTENSIONS].sort();
  const mobile = [...mobileHelpers.PREVIEW_EXTENSIONS].map(ext => `.${ext}`).sort();
  assert.deepEqual(mobile, server);
});

test('媒体扩展名及分流类型两端一致', () => {
  const server = Object.fromEntries(
    Object.entries(MEDIA_EXT_MAP).map(([ext, meta]) => [ext.slice(1), meta.kind]),
  );
  assert.deepEqual({ ...mobileHelpers.MEDIA_EXT_KIND }, server);
});
