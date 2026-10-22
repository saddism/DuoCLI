import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// One-time local setup. The installed app keeps calling the checkout's launcher.
// Dry-run by default; --apply changes only the listed entry points.
if (process.platform !== 'darwin') throw new Error('This installer requires macOS');
const apply = process.argv.includes('--apply');
const root = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const home = os.homedir();
const uid = process.getuid();
const appPath = path.join(home, 'Applications', 'DuoCLI.app');
const desktopApp = path.join(home, 'Desktop', 'DuoCLI.app');
const desktopCommand = path.join(home, 'Desktop', 'DuoCLI一键启动.command');
const launcher = path.join(root, 'scripts', 'start-latest.sh');
const terminalCommand = path.join(home, '.local', 'lib', 'duocli', 'start-latest.command');
const wakePlist = path.join(home, 'Library', 'LaunchAgents', 'com.duocli.remote-wake.plist');
const wakeScript = path.join(home, '.local', 'lib', 'duocli', 'remote-wake-gateway.mjs');
const legacyApp = path.join(root, 'release', 'mac-arm64', 'DuoCLI.app');
const stateDir = path.join(home, '.config', 'duocli-tunnel');
const register = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const owned = (file) => {
  const info = fs.lstatSync(file);
  if (info.uid !== uid || info.isSymbolicLink()) throw new Error(`Expected a user-owned non-symlink: ${file}`);
};
const runJxa = (script) => execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { encoding: 'utf8' }).trim();
let desktopInfo;
try { desktopInfo = fs.lstatSync(desktopApp); } catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
owned(root);
owned(launcher);
for (const file of [appPath, desktopCommand, terminalCommand, wakePlist, wakeScript]) {
  if (fs.existsSync(file)) owned(file);
}
if (desktopInfo) {
  const target = desktopInfo.isSymbolicLink() ? fs.readlinkSync(desktopApp) : runJxa(`
    ObjC.import('Foundation');
    const file = $.NSURL.fileURLWithPath(${JSON.stringify(desktopApp)});
    const target = $.NSURL.URLByResolvingAliasFileAtURLOptionsError(file,
      $.NSURLBookmarkResolutionWithoutUI | $.NSURLBookmarkResolutionWithoutMounting, $());
    if (!target) throw new Error('Unable to resolve desktop alias');
    ObjC.unwrap(target.path);
  `);
  if (desktopInfo.uid !== uid || target !== appPath) {
    throw new Error(`An unrelated desktop app already exists: ${desktopApp}`);
  }
}
for (const directory of [path.dirname(appPath), path.dirname(desktopApp), stateDir]) {
  if (fs.existsSync(directory)) owned(directory);
}
const plist = fs.existsSync(wakePlist)
  ? JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', wakePlist], { encoding: 'utf8' }))
  : null;
if (plist && (plist.Label !== 'com.duocli.remote-wake' || plist.ProgramArguments?.[1] !== wakeScript)) {
  throw new Error('Unexpected remote wake job identity');
}
console.log(JSON.stringify({ root, appPath, desktopApp, desktopCommand, terminalCommand,
  remoteWake: plist ? wakePlist : 'not installed', build: 'current local checkout; no Git operations', apply }, null, 2));
if (!apply) process.exit(0);

const backupDir = path.join(stateDir, `source-launcher-backup-${Date.now()}`);
fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
const manifest = [];
for (const file of [appPath, desktopCommand, terminalCommand, wakePlist, wakeScript]) {
  if (!fs.existsSync(file)) continue;
  const backup = path.join(backupDir, String(manifest.length));
  fs.cpSync(file, backup, { recursive: true, dereference: false });
  manifest.push({ original: file, backup });
}
fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
console.log(`Recoverable backups: ${backupDir}`);

const shellQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
// Let the existing Terminal workflow read the checkout in Documents. A short-
// lived background applet cannot reliably present Documents permission prompts.
fs.mkdirSync(path.dirname(terminalCommand), { recursive: true });
const commandContent = `#!/bin/bash\n# Fixed local-source entry; never pulls code or terminates sessions.\nexec /bin/bash ${shellQuote(launcher)}\n`;
fs.writeFileSync(terminalCommand, commandContent, { mode: 0o755 });
fs.chmodSync(terminalCommand, 0o755);
const appleScript = `on run
  do shell script ${JSON.stringify(`/usr/bin/open -g -a /System/Applications/Utilities/Terminal.app ${shellQuote(terminalCommand)}`)}
end run
on reopen
  run
end reopen
`;
const stagedApp = path.join(backupDir, 'new-DuoCLI.app');
execFileSync('/usr/bin/osacompile', ['-o', stagedApp, '-e', appleScript]);
const infoPath = path.join(stagedApp, 'Contents', 'Info.plist');
const info = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', infoPath], { encoding: 'utf8' }));
// osacompile supplies an asset-catalog icon name which overrides IconFile.
// Use the project's .icns instead of the applet's generic catalog entry.
delete info.CFBundleIconName;
Object.assign(info, {
  CFBundleIdentifier: 'com.duocli.app',
  CFBundleName: 'DuoCLI',
  CFBundleDisplayName: 'DuoCLI',
  CFBundleShortVersionString: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
  CFBundleVersion: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
  CFBundleIconFile: 'duocli.icns',
  LSUIElement: true,
  DuoCLISourceRoot: root,
});
fs.writeFileSync(infoPath, JSON.stringify(info));
execFileSync('/usr/bin/plutil', ['-convert', 'xml1', infoPath]);
fs.copyFileSync(path.join(root, 'build', 'icon.icns'), path.join(stagedApp, 'Contents', 'Resources', 'duocli.icns'));
execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', stagedApp]);
fs.mkdirSync(path.dirname(appPath), { recursive: true });
if (fs.existsSync(appPath)) fs.renameSync(appPath, path.join(backupDir, 'previous-DuoCLI.app'));
fs.renameSync(stagedApp, appPath);
if (desktopInfo) {
  const backup = path.join(backupDir, 'previous-desktop-entry');
  fs.renameSync(desktopApp, backup);
  manifest.push({ original: desktopApp, backup });
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
}
// A Finder alias with its own icon avoids stale/empty symlink icon caching.
// Set custom artwork on the alias only, keeping the signed app bundle intact.
runJxa(`
  ObjC.import('AppKit');
  const target = $.NSURL.fileURLWithPath(${JSON.stringify(appPath)});
  const desktop = $.NSURL.fileURLWithPath(${JSON.stringify(desktopApp)});
  const data = target.bookmarkDataWithOptionsIncludingResourceValuesForKeysRelativeToURLError(
    $.NSURLBookmarkCreationSuitableForBookmarkFile | $.NSURLBookmarkCreationWithoutImplicitSecurityScope, $(), $(), $());
  if (!data || !$.NSURL.writeBookmarkDataToURLOptionsError(data, desktop, 0, $())) throw new Error('Unable to create desktop alias');
  const icon = $.NSImage.alloc.initWithContentsOfFile(${JSON.stringify(path.join(appPath, 'Contents', 'Resources', 'duocli.icns'))});
  if (!icon.isValid || !$.NSWorkspace.sharedWorkspace.setIconForFileOptions(icon, ${JSON.stringify(desktopApp)}, 0)) {
    throw new Error('Unable to set desktop icon');
  }
`);
fs.writeFileSync(desktopCommand, commandContent, { mode: 0o755 });
fs.chmodSync(desktopCommand, 0o755);
if (fs.existsSync(legacyApp)) {
  try { execFileSync(register, ['-u', legacyApp], { stdio: 'pipe' }); } catch { /* already unregistered */ }
}
execFileSync(register, ['-f', appPath]);

if (plist) {
  fs.copyFileSync(path.join(root, 'scripts', 'remote-wake-gateway.mjs'), wakeScript);
  plist.EnvironmentVariables = { ...plist.EnvironmentVariables,
    DUOCLI_WAKE_APP: appPath, DUOCLI_WAKE_STARTUP_TIMEOUT_MS: '90000' };
  fs.writeFileSync(wakePlist, JSON.stringify(plist), { mode: 0o600 });
  execFileSync('/usr/bin/plutil', ['-convert', 'xml1', wakePlist]);
  try { execFileSync('/bin/launchctl', ['bootout', `gui/${uid}/com.duocli.remote-wake`], { stdio: 'ignore' }); } catch { /* not loaded */ }
  // launchd may still be removing the old job immediately after bootout.
  for (let attempt = 0; ; attempt++) {
    try {
      execFileSync('/bin/launchctl', ['bootstrap', `gui/${uid}`, wakePlist], { stdio: 'pipe' });
      break;
    } catch (error) {
      if (attempt >= 9) throw error;
      await delay(300);
    }
  }
}
console.log('Installed fixed local-source entry. Desktop and remote wake use the same launcher.');
