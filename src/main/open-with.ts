import { execFile, spawn } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export type OpenWithApp = { name: string; path: string };

const MAC_LIST_APPS_JXA = [
  "ObjC.import('AppKit');",
  'function run(argv) {',
  "  const filePath = argv && argv[0];",
  "  if (!filePath) return '[]';",
  '  const url = $.NSURL.fileURLWithPath(filePath);',
  '  const apps = $.NSWorkspace.sharedWorkspace.URLsForApplicationsToOpenURL(url);',
  '  const out = [];',
  '  const seen = {};',
  '  for (let i = 0; i < apps.count; i++) {',
  '    const appURL = apps.objectAtIndex(i);',
  '    const appPath = ObjC.unwrap(appURL.path);',
  '    if (!appPath || seen[appPath]) continue;',
  '    seen[appPath] = true;',
  "    let name = String(appPath).split('/').pop().replace(/\\.app$/i, '');",
  '    try {',
  '      const info = $.NSBundle.bundleWithURL(appURL).infoDictionary;',
  "      const display = ObjC.unwrap(info.objectForKey('CFBundleDisplayName'))",
  "        || ObjC.unwrap(info.objectForKey('CFBundleName'));",
  '      if (display) name = String(display);',
  '    } catch (e) {}',
  '    out.push({ name: name, path: String(appPath) });',
  '  }',
  '  return JSON.stringify(out);',
  '}',
].join('\n');

const MAC_CHOOSE_APP_SCRIPT = [
  'try',
  '  return id of (choose application with prompt "选择用来打开的应用程序")',
  'on error',
  '  return ""',
  'end try',
].join('\n');

export function parseOpenWithAppsJson(raw: string): OpenWithApp[] {
  try {
    const parsed = JSON.parse(String(raw || '[]'));
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const apps: OpenWithApp[] = [];
    for (const item of parsed) {
      const name = String(item?.name || '').trim();
      const appPath = String(item?.path || '').trim();
      if (!name || !appPath || seen.has(appPath)) continue;
      seen.add(appPath);
      apps.push({ name, path: appPath });
    }
    return apps;
  } catch {
    return [];
  }
}

export function filterOpenWithApps(apps: OpenWithApp[], limit = 10): OpenWithApp[] {
  return apps
    .filter((app) => !/DuoCLI\.app$/i.test(app.path.replace(/\/+$/, '')))
    .slice(0, limit);
}

export function openWithAppCommand(
  platform: NodeJS.Platform,
  filePath: string,
  appPath: string,
): { cmd: string; args: string[] } {
  if (platform === 'darwin') {
    if (appPath.includes('.') && !appPath.includes('/') && !appPath.endsWith('.app')) {
      return { cmd: 'open', args: ['-b', appPath, filePath] };
    }
    return { cmd: 'open', args: ['-a', appPath, filePath] };
  }
  return { cmd: appPath, args: [filePath] };
}

export function systemOpenWithDialogCommand(
  platform: NodeJS.Platform,
  filePath: string,
): { cmd: string; args: string[] } | 'choose-app' | null {
  if (platform === 'win32') return { cmd: 'rundll32.exe', args: ['shell32.dll,OpenAs_RunDLL', filePath] };
  if (platform === 'darwin') return 'choose-app';
  return null;
}

export async function listAppsForFile(filePath: string): Promise<OpenWithApp[]> {
  const target = String(filePath || '').trim();
  if (!target || process.platform !== 'darwin') return [];
  try {
    const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', MAC_LIST_APPS_JXA, '--', target], {
      timeout: 2500,
      maxBuffer: 1024 * 1024,
    });
    return filterOpenWithApps(parseOpenWithAppsJson(stdout));
  } catch {
    return [];
  }
}

export async function chooseMacApplication(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('osascript', ['-e', MAC_CHOOSE_APP_SCRIPT], {
      timeout: 120000,
      maxBuffer: 64 * 1024,
    });
    return String(stdout || '').trim();
  } catch {
    return '';
  }
}

function spawnDetached(cmd: string, args: string[]): void {
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

export async function openFileWithApp(filePath: string, appPath: string): Promise<void> {
  const target = String(filePath || '').trim();
  const app = String(appPath || '').trim();
  if (!target || !app) return;
  const { cmd, args } = openWithAppCommand(process.platform, target, app);
  spawnDetached(cmd, args);
}

export async function openFileWithSystemDialog(filePath: string): Promise<void> {
  const target = String(filePath || '').trim();
  if (!target) return;
  const spec = systemOpenWithDialogCommand(process.platform, target);
  if (spec === 'choose-app') {
    const bundleId = await chooseMacApplication();
    if (!bundleId) return;
    spawnDetached('open', ['-b', bundleId, target]);
    return;
  }
  if (spec) spawnDetached(spec.cmd, spec.args);
}
