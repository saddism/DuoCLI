import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const files = [
  ...readdirSync('mobile/client').filter(name => name.endsWith('.test.cjs')).map(name => `mobile/client/${name}`),
  ...readdirSync('tests').filter(name => name.endsWith('.test.mjs')).map(name => `tests/${name}`),
  'tests/mobile-page-visibility.test.js',
];
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
