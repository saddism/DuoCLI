import { execFile, spawn, SpawnOptions, ChildProcess } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

export function parseAndroidDevices(output: string) {
  return output.split(/\r?\n/).map(line => line.trim())
    .filter(line => line && !line.startsWith('List of devices') && !line.startsWith('*'))
    .map(line => {
      const [id, state, ...info] = line.split(/\s+/);
      return { id, state: state || 'unknown', info: info.join(' '), available: state === 'device' };
    });
}

export async function resolveAdb(): Promise<string> {
  const bin = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const home = os.homedir();
  const candidates = [
    ...[process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT].filter(Boolean).map(p => path.join(p!, 'platform-tools', bin)),
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(p => path.join(p, bin)),
    path.join(home, 'Library/Android/sdk/platform-tools', bin),
    path.join(home, 'Android/Sdk/platform-tools', bin),
    path.join(home, 'AppData/Local/Android/Sdk/platform-tools', bin),
    '/opt/homebrew/bin/adb', '/usr/local/bin/adb',
  ];
  for (const candidate of candidates) {
    try { await fs.access(candidate, fs.constants.X_OK); return candidate; } catch { /* try next */ }
  }
  throw new Error('未找到 adb，请安装 Android SDK Platform Tools 或设置 ANDROID_HOME 后重试');
}

/**
 * 启动一个长生命周期的 adb 进程。
 * 普通命令继续使用 runAdb；镜像会话需要保留 stdin/stdout/socket 生命周期，
 * 所以不能通过 execFile 等待完整 stdout 后再返回。
 */
export async function spawnAdb(args: string[], options: SpawnOptions = {}): Promise<ChildProcess> {
  const adb = await resolveAdb();
  return spawn(adb, args, options);
}

export async function runAdb(args: string[], options: { timeout?: number; maxBuffer?: number; binary?: boolean } = {}): Promise<Buffer> {
  const adb = await resolveAdb();
  return new Promise((resolve, reject) => {
    execFile(adb, args, { encoding: 'buffer', timeout: options.timeout ?? 8000, maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(error.killed ? '设备响应超时，请检查 USB 连接和手机授权后重试' : (stderr.toString().trim() || error.message)));
      } else resolve(stdout);
    });
  });
}
