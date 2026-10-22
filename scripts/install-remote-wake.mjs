import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Dry-run by default. Private tunnel configurations never appear in stdout.
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const appPath = args.includes('--app') ? path.resolve(value('--app')) : '';
const hostname = args.includes('--hostname') ? value('--hostname') : '';
const configs = args.flatMap((arg, i) => arg === '--config' ? [path.resolve(args[i + 1])] : []);
if (process.platform !== 'darwin' || !appPath || !hostname || !configs.length) {
  throw new Error('Usage (macOS): node scripts/install-remote-wake.mjs --app /path/DuoCLI.app --hostname example.com --config /path/config.yml [--config ...] [--apply]');
}
const home = os.homedir();
const uid = process.getuid();
const label = 'com.duocli.remote-wake';
const legacyLabel = 'com.kaifeng.duocli-app';
const installDir = path.join(home, '.local', 'lib', 'duocli');
const installedScript = path.join(installDir, 'remote-wake-gateway.mjs');
const plistPath = path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
const stateDir = path.join(home, '.config', 'duocli-tunnel');
const gatewaySource = fileURLToPath(new URL('./remote-wake-gateway.mjs', import.meta.url));
const regularOwnedFile = (file) => {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== uid) throw new Error(`Expected a user-owned regular file: ${file}`);
};
regularOwnedFile(path.join(appPath, 'Contents', 'Info.plist'));
fs.accessSync(path.join(appPath, 'Contents', 'MacOS', 'DuoCLI'), fs.constants.X_OK);
const changes = configs.map((configPath) => {
  regularOwnedFile(configPath);
  const lines = fs.readFileSync(configPath, 'utf8').split('\n');
  let matchingRoute = false;
  let matched = 0;
  for (let i = 0; i < lines.length; i++) {
    const route = lines[i].match(/^\s*-\s*hostname:\s*([^\s#]+)\s*$/);
    if (route) matchingRoute = route[1] === hostname;
    else if (/^\s*-/.test(lines[i])) matchingRoute = false;
    if (matchingRoute && /^\s*service:/.test(lines[i])) {
      if (!/^\s*service:\s*http:\/\/127\.0\.0\.1:980[01]\s*$/.test(lines[i])) {
        throw new Error(`Unexpected origin for the requested hostname in ${configPath}`);
      }
      lines[i] = lines[i].replace(/:980[01]/, ':9801');
      matched++;
    }
  }
  if (matched !== 1) throw new Error(`Expected exactly one matching hostname in ${configPath}`);
  return { configPath, content: lines.join('\n') };
});
const escapeXml = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const nodeBinary = args.includes('--node') ? path.resolve(value('--node')) : process.execPath;
fs.accessSync(nodeBinary, fs.constants.X_OK);
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${escapeXml(nodeBinary)}</string><string>${escapeXml(installedScript)}</string></array>
<key>EnvironmentVariables</key><dict><key>DUOCLI_WAKE_APP</key><string>${escapeXml(appPath)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>5</integer>
<key>StandardOutPath</key><string>${escapeXml(path.join(stateDir, 'remote-wake.log'))}</string>
<key>StandardErrorPath</key><string>${escapeXml(path.join(stateDir, 'remote-wake.log'))}</string>
</dict></plist>
`;
console.log(JSON.stringify({ appPath, plistPath, gateway: '127.0.0.1:9801 -> 127.0.0.1:9800', configs, legacyDaemonToDisable: legacyLabel, apply: args.includes('--apply') }, null, 2));
if (args.includes('--apply')) {
  let legacyLoaded = false;
  try {
    execFileSync('/bin/launchctl', ['print', `gui/${uid}/${legacyLabel}`], { stdio: 'ignore' });
    legacyLoaded = true;
  } catch { /* not loaded */ }
  if (legacyLoaded) throw new Error('The old app keepalive is loaded; stop it separately before installation to preserve its running terminal sessions.');
  const backupDir = path.join(stateDir, `remote-wake-backup-${Date.now()}`);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const backedUp = [];
  for (const file of [...configs, plistPath, installedScript]) {
    if (!fs.existsSync(file)) continue;
    regularOwnedFile(file);
    const backup = path.join(backupDir, String(backedUp.length));
    fs.copyFileSync(file, backup);
    fs.chmodSync(backup, 0o600);
    backedUp.push({ original: file, backup });
  }
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(backedUp, null, 2), { mode: 0o600 });
  console.log(`Recoverable backups: ${backupDir}`);
  fs.mkdirSync(installDir, { recursive: true });
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.copyFileSync(gatewaySource, installedScript);
  fs.writeFileSync(plistPath, plist, { mode: 0o600 });
  execFileSync('/usr/bin/plutil', ['-lint', plistPath], { stdio: 'inherit' });
  try { execFileSync('/bin/launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' }); } catch { /* not loaded */ }
  execFileSync('/bin/launchctl', ['enable', `gui/${uid}/${label}`]);
  execFileSync('/bin/launchctl', ['bootstrap', `gui/${uid}`, plistPath]);
  // Old keepalive launches a second source instance even when the packaged app starts.
  // On-demand launching replaces it; disable persists across app bootstrap attempts.
  execFileSync('/bin/launchctl', ['disable', `gui/${uid}/${legacyLabel}`]);
  try { execFileSync('/bin/launchctl', ['bootout', `gui/${uid}/${legacyLabel}`], { stdio: 'ignore' }); } catch { /* not loaded */ }
  for (const change of changes) {
    fs.writeFileSync(change.configPath, change.content, { mode: 0o600 });
  }
  console.log('Installed. Restart only the tunnel processes using the updated configurations to activate the new origin.');
}
