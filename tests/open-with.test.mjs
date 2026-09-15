import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterOpenWithApps,
  openWithAppCommand,
  parseOpenWithAppsJson,
  systemOpenWithDialogCommand,
} from '../dist/main/open-with.js';

test('parseOpenWithAppsJson keeps unique Launch Services apps', () => {
  const apps = parseOpenWithAppsJson(JSON.stringify([
    { name: 'QuickTime Player', path: '/System/Applications/QuickTime Player.app' },
    { name: 'QuickTime Player', path: '/System/Applications/QuickTime Player.app' },
    { name: '', path: '/Applications/Empty.app' },
    { name: 'IINA', path: '/Applications/IINA.app' },
  ]));
  assert.deepEqual(apps.map(item => item.name), ['QuickTime Player', 'IINA']);
});

test('filterOpenWithApps drops DuoCLI and caps the menu', () => {
  const apps = filterOpenWithApps([
    { name: 'DuoCLI', path: '/Applications/DuoCLI.app' },
    { name: 'Cursor', path: '/Applications/Cursor.app' },
    ...Array.from({ length: 12 }, (_, i) => ({ name: `App ${i}`, path: `/Applications/App${i}.app` })),
  ], 3);
  assert.deepEqual(apps.map(item => item.name), ['Cursor', 'App 0', 'App 1']);
});

test('openWithAppCommand uses Launch Services flags on macOS', () => {
  assert.deepEqual(
    openWithAppCommand('darwin', '/tmp/clip.mp4', '/Applications/IINA.app'),
    { cmd: 'open', args: ['-a', '/Applications/IINA.app', '/tmp/clip.mp4'] },
  );
  assert.deepEqual(
    openWithAppCommand('darwin', '/tmp/clip.mp4', 'com.apple.QuickTimePlayerX'),
    { cmd: 'open', args: ['-b', 'com.apple.QuickTimePlayerX', '/tmp/clip.mp4'] },
  );
  assert.deepEqual(
    openWithAppCommand('win32', 'C:\\a.mp4', 'C:\\IINA.exe'),
    { cmd: 'C:\\IINA.exe', args: ['C:\\a.mp4'] },
  );
});

test('systemOpenWithDialogCommand uses each OS picker', () => {
  assert.deepEqual(
    systemOpenWithDialogCommand('win32', 'C:\\a.mp4'),
    { cmd: 'rundll32.exe', args: ['shell32.dll,OpenAs_RunDLL', 'C:\\a.mp4'] },
  );
  assert.equal(systemOpenWithDialogCommand('darwin', '/tmp/a.mp4'), 'choose-app');
  assert.equal(systemOpenWithDialogCommand('linux', '/tmp/a.mp4'), null);
});
