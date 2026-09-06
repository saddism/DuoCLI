import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// puppeteer-core does not download a browser. Keep the test runner portable,
// while allowing CI and developers to provide an exact browser binary.
export function resolveChromeExecutable() {
  const configured = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  const candidates = configured ? [configured] : platformCandidates();
  const executable = candidates.find(candidate => fs.existsSync(candidate));
  if (executable) return executable;

  throw new Error([
    'No Chrome/Chromium executable was found for the desktop E2E tests.',
    'Set CHROME_PATH (or PUPPETEER_EXECUTABLE_PATH) to a browser binary.',
    `Checked: ${candidates.join(', ')}`,
  ].join(' '));
}

function platformCandidates() {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }

  if (process.platform === 'win32') {
    const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return [
      path.join(programFiles, 'Google/Chrome/Application/chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
      path.join(localAppData, 'Google/Chrome/Application/chrome.exe'),
      path.join(programFiles, 'Chromium/Application/chrome.exe'),
    ];
  }

  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
}
