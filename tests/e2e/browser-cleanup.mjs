import { execFileSync } from 'node:child_process';

// Chrome can leave its shutdown request pending. Bound fixture teardown so a
// completed regression cannot strand the rest of the suite or its browser.
export async function closeTestBrowser(browser) {
  if (!browser) return;
  let timer;
  const closing = browser.close();
  try {
    const closed = await Promise.race([
      closing.then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), 2000); }),
    ]);
    if (closed) return;
    const child = browser.process();
    const profile = child?.spawnargs.find(arg => arg.startsWith('--user-data-dir=')
      && arg.includes('puppeteer_dev_chrome_profile-'));
    if (!child?.pid || !profile) throw new Error('Cannot identify the owned fixture browser for teardown');
    if (process.platform === 'win32') child.kill('SIGKILL');
    else {
      const processes = execFileSync('ps', ['-axo', 'pgid=,command='], { encoding: 'utf8' });
      const ownedGroup = processes.split('\n').some(line => {
        const match = /^\s*(\d+)\s+(.*)$/.exec(line);
        return match && Number(match[1]) === child.pid && match[2].includes(profile);
      });
      if (ownedGroup) process.kill(-child.pid, 'SIGKILL');
    }
    await browser.disconnect();
    await closing.catch(() => {});
    console.log('INFO completed fixture browser required bounded shutdown');
  } finally {
    clearTimeout(timer);
  }
}
