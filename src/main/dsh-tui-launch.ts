import { spawn } from 'child_process';
import * as path from 'path';
import { DshProtocolError, ensureDshTuiHost } from './dsh-host';

function extraArgs(): string[] {
  const args = process.argv.slice(2);
  return args[0] === '--' ? args.slice(1) : args;
}

async function main(): Promise<void> {
  process.stdout.write('DuoCLI: 正在准备 DSH host（dsh web）…\n');
  const host = await ensureDshTuiHost();
  if (!host) {
    process.stderr.write('dsh-tui: 没有可用的 dsh web。请先安装 dsh，或手动运行 `dsh web --port 3080 --no-open`。\n');
    process.exit(1);
  }

  const preload = path.join(__dirname, 'dsh-tui-auth-preload.js');
  const env = {
    ...process.env,
    DSH_URL: host.url,
    DSH_TOKEN: host.token || '',
    DSH_COOKIE: host.cookie || '',
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preload}`].filter(Boolean).join(' '),
  };
  process.stdout.write(`DuoCLI: 已连接 ${host.url}\n`);
  const child = spawn('dsh-tui', extraArgs(), { stdio: 'inherit', env });
  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });
}

void main().catch((error) => {
  const prefix = error instanceof DshProtocolError ? '' : 'dsh-tui: ';
  process.stderr.write(`${prefix}${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
