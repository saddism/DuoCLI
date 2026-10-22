import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function activate(pid) {
  if (!pid || process.platform !== 'darwin') return;
  execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e',
    `ObjC.import('AppKit'); const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}); if (app) app.activateWithOptions(3);`,
  ], () => {});
}

function run(command, args, cwd, onStart = () => {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    onStart(child.pid);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} exited: ${signal || code}`));
    });
  });
}

async function ensureRemotePortFree() {
  const running = await new Promise((resolve, reject) => {
    const client = net.connect({ host: '127.0.0.1', port: 9800 });
    client.once('connect', () => { client.destroy(); resolve(true); });
    client.once('error', (error) => {
      if (error.code === 'ECONNREFUSED') resolve(false);
      else reject(error);
    });
  });
  if (running) throw new Error('另一个入口已占用 9800；请先正常退出该 DuoCLI，再打开固定图标。');
}

// Hold the startup socket until Electron exits. Desktop and remote requests
// share one build/client and can bring its window forward without restarting it.
export async function launchSource({ socketPath, build, launch, focus = () => {} }) {
  const server = net.createServer((client) => {
    client.end('running');
    focus();
  });
  const listen = () => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => { server.removeListener('error', reject); resolve(); });
  });
  try {
    await listen();
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    let previous;
    try { previous = fs.lstatSync(socketPath); } catch (failure) {
      if (failure.code !== 'ENOENT') throw failure;
    }
    if (previous && (!previous.isSocket() || previous.uid !== process.getuid())) {
      throw new Error('Unsafe launcher socket');
    }
    const running = await new Promise((resolve, reject) => {
      const client = net.connect(socketPath);
      client.once('connect', () => { client.end(); resolve(true); });
      client.once('error', (failure) => {
        if (['ECONNREFUSED', 'ENOENT'].includes(failure.code)) resolve(false);
        else reject(failure);
      });
    });
    if (running) return 'already-running';
    // Only reclaim our user-owned, abandoned socket, never an arbitrary file.
    try {
      const info = fs.lstatSync(socketPath);
      if (!info.isSocket() || info.uid !== process.getuid()) throw new Error('Unsafe launcher socket');
      // Another opener may already have replaced the abandoned socket.
      if (!previous || info.ino !== previous.ino || info.dev !== previous.dev) {
        return launchSource({ socketPath, build, launch, focus });
      }
      fs.unlinkSync(socketPath);
    } catch (failure) {
      if (failure.code !== 'ENOENT') throw failure;
    }
    try { await listen(); } catch (failure) {
      if (failure.code === 'EADDRINUSE') return 'already-running';
      throw failure;
    }
  }
  fs.chmodSync(socketPath, 0o600);
  try {
    await build();
    await launch();
    return 'exited';
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const key = createHash('sha256').update(fs.realpathSync(projectDir)).digest('hex').slice(0, 12);
  const socketPath = path.join(os.tmpdir(), `duocli-source-${process.getuid()}-${key}.sock`);
  const npm = path.join(path.dirname(process.execPath), 'npm');
  let electronPid;
  try {
    const result = await launchSource({
      socketPath,
      build: async () => {
        await ensureRemotePortFree();
        console.log(`[source-launcher] ${new Date().toISOString()} building ${projectDir}`);
        await run(npm, ['run', 'build:ts'], projectDir);
        await run(npm, ['run', 'copy:html'], projectDir);
      },
      launch: () => run(path.join(projectDir, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
        [projectDir], projectDir, (pid) => { electronPid = pid; }),
      focus: () => activate(electronPid),
    });
    console.log(`[source-launcher] ${result}`);
  } catch (error) {
    console.error(`[source-launcher] ${error.message}`);
    execFile('/usr/bin/osascript', ['-e',
      'display notification "启动未完成，请查看 /tmp/duocli-start.log；修正后再打开即可重试。" with title "DuoCLI"',
    ], () => {});
    process.exitCode = 1;
  }
}
