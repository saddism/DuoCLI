// 远程配置同步：桌面端写入必须落到运行中的服务，手机端才读得到同一份数据
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DUOCLI_REMOTE_PORT = '0';
process.env.DUOCLI_REMOTE_HOST = '127.0.0.1';
process.env.DUOCLI_REMOTE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'duocli-config-sync-'));

const { startRemoteServer, addRemoteRecentCwd, recordRemotePresetUsage } = await import('../dist/main/remote-server.js');
const { PtyManager } = await import('../dist/main/pty-manager.js');

const manager = new PtyManager({ onData() {}, onTitleUpdate() {}, onExit() {}, onResize() {} });
let server;
const info = await new Promise(resolve => { server = startRemoteServer(manager, undefined, undefined, resolve); });
const origin = `http://127.0.0.1:${info.port}`;
const headers = { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' };
const getJson = async (p) => (await fetch(`${origin}${p}`, { headers })).json();
const readConfigOnDisk = () => JSON.parse(
  fs.readFileSync(path.join(process.env.DUOCLI_REMOTE_CONFIG_DIR, 'config.json'), 'utf-8')
);

after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

test('桌面端同步的最近目录立刻出现在手机端接口上', async () => {
  addRemoteRecentCwd('/tmp/duocli-sync-a');
  const res = await getJson('/api/recent-cwds');
  assert.ok(res.items.includes('/tmp/duocli-sync-a'), JSON.stringify(res.items));
});

test('服务端其它写入不会覆盖桌面端刚同步的目录', async () => {
  const put = await fetch(`${origin}/api/custom-presets`, {
    method: 'PUT',
    headers,
    body: JSON.stringify([{ id: 'custom-1', name: 'ds-cc', command: 'ds-cc', autoFlag: '' }]),
  });
  assert.equal(put.ok, true);
  addRemoteRecentCwd('/tmp/duocli-sync-b');

  const res = await getJson('/api/recent-cwds');
  assert.deepEqual(res.items.slice(0, 2), ['/tmp/duocli-sync-b', '/tmp/duocli-sync-a']);
  assert.ok(readConfigOnDisk().recentCwds.includes('/tmp/duocli-sync-b'));
});

test('预设使用次数被统计，恢复会话的 resume 命令不计入', async () => {
  recordRemotePresetUsage('opencode');
  recordRemotePresetUsage('opencode');
  recordRemotePresetUsage('ds-cc');
  recordRemotePresetUsage('');
  recordRemotePresetUsage('claude --resume 1234abcd');

  const res = await getJson('/api/preset-usage');
  const usage = Object.fromEntries(res.items.map(i => [i.command, i.count]));
  assert.equal(usage['opencode'], 2);
  assert.equal(usage['ds-cc'], 1, '自定义预设的命令也要计入');
  assert.equal(usage[''], 1, '纯终端同样计入');
  assert.equal(res.items.some(i => i.command.includes('--resume')), false);
  assert.equal(readConfigOnDisk().presetUsage.opencode, 2);
});
