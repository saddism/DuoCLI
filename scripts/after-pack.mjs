import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function scrcpyServerCandidates() {
  const explicit = process.env.DUOCLI_SCRCPY_SERVER?.trim();
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return [
    explicit,
    path.resolve('vendor', 'scrcpy-server'),
    '/opt/homebrew/share/scrcpy/scrcpy-server',
    '/usr/local/share/scrcpy/scrcpy-server',
    '/usr/share/scrcpy/scrcpy-server',
    home && path.join(home, 'scoop', 'apps', 'scrcpy', 'current', 'scrcpy-server'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'scrcpy', 'scrcpy-server'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'scrcpy', 'scrcpy-server'),
  ].filter(Boolean);
}

function findScrcpyBinary() {
  const bin = process.platform === 'win32' ? 'scrcpy.exe' : 'scrcpy';
  for (const directory of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, bin);
    if (isFile(candidate)) return candidate;
  }
  return ['/opt/homebrew/bin/scrcpy', '/usr/local/bin/scrcpy', '/usr/bin/scrcpy']
    .find(isFile) || null;
}

function detectVersion() {
  const binary = findScrcpyBinary();
  if (!binary) return '';
  try {
    const output = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 3000 });
    return output.match(/scrcpy\s+([0-9]+(?:\.[0-9]+){1,2})/i)?.[1] || '';
  } catch {
    return '';
  }
}

function androidMediaHelperCandidates() {
  const binary = process.platform === 'win32' ? 'android-media.exe' : 'android-media';
  return [
    process.env.DUOCLI_ANDROID_MEDIA_HELPER,
    path.resolve('native', 'android-media', binary),
    path.resolve('vendor', binary),
  ].filter(Boolean);
}

export default async function afterPack(context) {
  const serverPath = scrcpyServerCandidates().find(isFile);
  if (!serverPath) {
    throw new Error(
      'DuoCLI 打包需要 scrcpy-server。请安装 scrcpy，或设置 DUOCLI_SCRCPY_SERVER 指向匹配版本的服务器文件。',
    );
  }

  const resourcesDir = context.packager.getResourcesDir(context.appOutDir);
  const targetDir = path.join(resourcesDir, 'scrcpy');
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(serverPath, path.join(targetDir, 'scrcpy-server'));

  // The jar is platform-independent, but the command line version is part of
  // the Android server handshake. Persist it next to the copied jar so a
  // packaged app never guesses from an unrelated host binary.
  const version = process.env.DUOCLI_SCRCPY_VERSION?.trim() || detectVersion() || '4.1';
  fs.writeFileSync(path.join(targetDir, 'scrcpy-version.txt'), `${version}\n`, 'utf8');
  console.log(`[after-pack] bundled scrcpy-server ${version} from ${serverPath}`);

  const helper = androidMediaHelperCandidates().find(isFile);
  if (helper) {
    const helperDir = path.join(resourcesDir, 'android-media');
    fs.mkdirSync(helperDir, { recursive: true });
    const target = path.join(helperDir, path.basename(helper));
    fs.copyFileSync(helper, target);
    if (process.platform !== 'win32') fs.chmodSync(target, 0o755);
    console.log(`[after-pack] bundled Pion Android media helper from ${helper}`);
  } else {
    console.log('[after-pack] Pion Android media helper not present; WebRTC capability remains disabled');
  }
}
