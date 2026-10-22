import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWakeGateway } from '../../scripts/remote-wake-gateway.mjs';

// Explicit opt-in: launches a separate packaged app with isolated configuration.
const appPath = process.env.DUOCLI_WAKE_TEST_APP;
if (process.platform !== 'darwin' || !appPath) throw new Error('Set DUOCLI_WAKE_TEST_APP to the packaged macOS app path');
const root = path.resolve('tests/.artifacts');
fs.mkdirSync(root, { recursive: true });
const profile = fs.mkdtempSync(path.join(root, 'remote-wake-profile-'));
const mobileConfig = path.join(profile, 'mobile');
const userData = path.join(profile, 'electron');
const disabledTunnelConfig = path.join(profile, 'disabled-tunnel.yml');
fs.writeFileSync(disabledTunnelConfig, 'tunnel: YOUR_TUNNEL_NAME\ncredentials-file: /ABSOLUTE/PATH/TO/YOUR_TUNNEL_ID.json\ningress:\n  - hostname: duocli.example.com\n    service: http_status:404\n');
const runFile = promisify(execFile);
const portServer = net.createServer();
await new Promise((resolve) => portServer.listen(0, '127.0.0.1', resolve));
const targetPort = portServer.address().port;
await new Promise((resolve) => portServer.close(resolve));
let launches = 0;
let testPid;
const gateway = createWakeGateway({ targetPort, launch: async () => {
  launches++;
  await runFile('/usr/bin/open', [
    '-n', '-g', '--env', `DUOCLI_REMOTE_PORT=${targetPort}`,
    '--env', `DUOCLI_REMOTE_CONFIG_DIR=${mobileConfig}`,
    '--env', `DUOCLI_CLOUDFLARED_CONFIG=${disabledTunnelConfig}`,
    '--stdout', path.join(profile, 'app.log'), '--stderr', path.join(profile, 'app-error.log'),
    appPath, '--args', `--user-data-dir=${userData}`,
  ], { timeout: 10_000 });
} });
await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
try {
  assert.equal(launches, 0);
  const startedAt = Date.now();
  const base = `http://127.0.0.1:${gateway.address().port}`;
  const response = await fetch(base, { signal: AbortSignal.timeout(30_000) });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /DuoCLI/i);
  assert.equal(launches, 1);
  const elapsedMs = Date.now() - startedAt;
  const pids = execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${targetPort}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n');
  assert.equal(pids.length, 1);
  testPid = Number(pids[0]);
  const command = execFileSync('/bin/ps', ['-p', String(testPid), '-o', 'command='], { encoding: 'utf8' }).trim();
  assert.ok(command.startsWith(path.join(appPath, 'Contents', 'MacOS', 'DuoCLI')));
  assert.ok(command.includes(`--user-data-dir=${userData}`), 'only the isolated instance may be stopped');
  const token = JSON.parse(fs.readFileSync(path.join(mobileConfig, 'config.json'), 'utf8')).token;
  const sessions = await fetch(`${base}/api/sessions`, { headers: { authorization: `Bearer ${token}` } }).then((res) => res.json());
  assert.ok(Array.isArray(sessions));
  assert.equal(sessions.length, 0, 'the isolated app must not restore existing terminal sessions');
  assert.equal((await fetch(`${base}/api/sessions`)).status, 401);
  console.log(JSON.stringify({ passed: true, elapsedMs, launches, isolatedPid: testPid, targetPort, profile }, null, 2));
} finally {
  await gateway.stop();
  // Stop only the proven isolated instance; preserve the user's running DuoCLI.
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n');
  for (const row of rows) {
    const match = row.trim().match(/^(\d+)\s+(.+)$/);
    if (match && match[2].startsWith(path.join(appPath, 'Contents', 'MacOS', 'DuoCLI')) && match[2].includes(`--user-data-dir=${userData}`)) {
      process.kill(Number(match[1]), 'SIGTERM');
    }
  }
}
