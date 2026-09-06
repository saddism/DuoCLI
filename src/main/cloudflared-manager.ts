import { ChildProcess, execFileSync, execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface CloudflaredStatus {
  installed: boolean;
  running: boolean;
  url: string;
  configPath: string;
  message?: string;
}

const TEMPLATE_MARKERS = [
  'YOUR_TUNNEL_NAME',
  'YOUR_TUNNEL_ID',
  '/ABSOLUTE/PATH/TO/',
  'duocli.example.com',
];

export class CloudflaredManager {
  private child: ChildProcess | null = null;
  private readonly configPath: string;
  private readonly logPath: string;

  constructor(projectRoot: string) {
    this.configPath = this.resolveConfigPath(projectRoot);
    this.logPath = path.join(path.dirname(this.configPath), 'cloudflared.log');
  }

  getStatus(): CloudflaredStatus {
    const installed = Boolean(this.resolveBinary());
    const running = this.isRunning();
    const config = this.readConfig();
    const publicUrl = config.hostname ? `https://${config.hostname}` : '';
    const configReady = this.isConfigReady(config.raw);
    const message = this.getStatusMessage(installed, configReady, config);
    return {
      installed,
      running,
      url: publicUrl,
      configPath: this.configPath,
      message,
    };
  }

  /** 与 start 相同，语义上表示“确保隧道在跑”。 */
  ensureRunning(): CloudflaredStatus {
    return this.start();
  }

  /**
   * 清理不属于当前配置的 DuoCLI 隧道，并在需要时重新启动。
   * force=true 时会先停掉所有 DuoCLI 相关 cloudflared 再启动。
   */
  reconcileTunnel(force = false): CloudflaredStatus {
    if (force) {
      this.killAllDuocliTunnels();
      return this.start();
    }
    const status = this.getStatus();
    if (status.running) return status;
    this.killAllDuocliTunnels();
    return this.start();
  }

  start(): CloudflaredStatus {
    // 启动前清理：杀掉旧实例残留的 cloudflared 进程
    // 注意：9800 端口由 remote-server 启动前自行清理，此处不应再碰，否则会杀掉当前 Electron 进程
    this.killAllDuocliTunnels();

    const bin = this.resolveBinary();
    if (!bin) return this.getStatus();
    const config = this.readConfig();
    const publicUrl = config.hostname ? `https://${config.hostname}` : '';
    if (!config.exists) {
      return {
        installed: true,
        running: false,
        url: publicUrl,
        configPath: this.configPath,
        message: `找不到 cloudflared 配置: ${this.configPath}`,
      };
    }
    if (!this.isConfigReady(config.raw)) {
      return {
        installed: true,
        running: false,
        url: publicUrl,
        configPath: this.configPath,
        message: `Cloudflare 配置未完成，请填写本机私有配置: ${this.configPath}`,
      };
    }
    if (this.isRunning()) return this.getStatus();

    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
    const out = fs.openSync(this.logPath, 'a');
    const child = spawn(bin, ['tunnel', '--protocol', 'http2', '--config', this.configPath, 'run'], {
      detached: true,
      stdio: ['ignore', out, out],
    });
    this.child = child;
    child.unref();
    child.on('exit', () => {
      this.child = null;
    });
    return this.getStatus();
  }

  stopOwnedProcess(): void {
    if (!this.child || this.child.killed) return;
    // 杀掉整个进程组（cloudflared 可能 spawn 子进程）
    if (this.child.pid) {
      try { process.kill(-this.child.pid, 'SIGKILL'); } catch { /* ignore */ }
      try { process.kill(this.child.pid, 'SIGKILL'); } catch { /* ignore */ }
    }
    try { this.child.kill('SIGKILL'); } catch { /* ignore */ }
    this.child = null;
    // 确保残留的 cloudflared 进程也被清理
    this.killAllDuocliTunnels();
  }

  /** Exported for tests: any cloudflared tunnel launched for DuoCLI. */
  static isDuocliTunnelCommand(command: string): boolean {
    const normalized = String(command || '');
    if (!/(?:^|\/)cloudflared(?:\s|$)/.test(normalized)) return false;
    return /(?:--config(?:=|\s+)\S*(?:cloudflared-config|duocli-tunnel\/config\.yml))/i.test(normalized)
      || (/\btunnel\b/.test(normalized) && /\brun\b/.test(normalized) && /duocli/i.test(normalized));
  }

  /** 杀掉所有 DuoCLI 相关 cloudflared（含 ~/.config/duocli-tunnel 等旧配置路径）。 */
  killAllDuocliTunnels(): void {
    for (const pid of this.listDuocliTunnelProcesses()) {
      try {
        process.kill(pid, 'SIGKILL');
        console.log(`[Cloudflared] Killed stale cloudflared PID ${pid}`);
      } catch {
        // 进程可能已不存在
      }
    }
  }

  /** 杀掉占用指定端口的进程 */
  private killPortOccupants(port: number): void {
    try {
      const out = execSync(`lsof -i :${port} -t -sTCP:LISTEN 2>/dev/null || true`, {
        encoding: 'utf-8',
        timeout: 5000,
      });
      const pids = out.trim().split('\n').filter(Boolean).map(Number).filter(n => !isNaN(n));
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
          console.log(`[Cloudflared] Killed port ${port} occupant PID ${pid}`);
        } catch {
          // 进程可能已不存在
        }
      }
    } catch {
      // lsof 失败，忽略
    }
  }

  private resolveConfigPath(projectRoot: string): string {
    const candidates = [
      process.env.DUOCLI_CLOUDFLARED_CONFIG || '',
      path.join(projectRoot, 'frp', 'cloudflared-config.local.yml'),
      path.join(projectRoot, 'frp', 'cloudflared-config.private.yml'),
      path.join(os.homedir(), '.config', 'duocli-tunnel', 'config.yml'),
      process.resourcesPath ? path.join(process.resourcesPath, 'frp', 'cloudflared-config.local.yml') : '',
      process.resourcesPath ? path.join(process.resourcesPath, 'frp', 'cloudflared-config.private.yml') : '',
      process.resourcesPath ? path.join(process.resourcesPath, 'frp', 'cloudflared-config.yml') : '',
      path.join(projectRoot, 'frp', 'cloudflared-config.yml'),
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }

    return path.join(projectRoot, 'frp', 'cloudflared-config.local.yml');
  }

  private resolveBinary(): string | null {
    const candidates = [
      process.env.DUOCLI_CLOUDFLARED_BIN || '',
      '/opt/homebrew/bin/cloudflared',
      '/usr/local/bin/cloudflared',
      'cloudflared',
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (candidate.includes('/')) {
        if (fs.existsSync(candidate)) return candidate;
        continue;
      }
      try {
        execFileSync('/usr/bin/which', [candidate], { stdio: 'ignore' });
        return candidate;
      } catch { /* try next */ }
    }
    return null;
  }

  private isRunning(): boolean {
    if (this.child && !this.child.killed) return true;
    return this.listDuocliTunnelProcesses().length > 0;
  }

  private listDuocliTunnelProcesses(): number[] {
    try {
      const output = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf-8' });
      return output.split('\n').flatMap((line) => {
        const match = line.trim().match(/^(\d+)\s+(.+)$/);
        if (!match) return [];
        const [, pidText, command] = match;
        if (!CloudflaredManager.isDuocliTunnelCommand(command)) return [];
        const pid = Number(pidText);
        return Number.isSafeInteger(pid) && pid !== process.pid ? [pid] : [];
      });
    } catch {
      return [];
    }
  }

  private readConfig(): { exists: boolean; raw: string; hostname: string | null } {
    if (!fs.existsSync(this.configPath)) {
      return { exists: false, raw: '', hostname: null };
    }
    const raw = fs.readFileSync(this.configPath, 'utf-8');
    const hostnameMatch = raw.match(/^\s*-\s*hostname:\s*([^\s#]+)\s*$/m);
    return {
      exists: true,
      raw,
      hostname: hostnameMatch ? hostnameMatch[1].trim() : null,
    };
  }

  private isConfigReady(raw: string): boolean {
    if (!raw.trim()) return false;
    return !TEMPLATE_MARKERS.some(marker => raw.includes(marker));
  }

  private getStatusMessage(
    installed: boolean,
    configReady: boolean,
    config: { exists: boolean; hostname: string | null },
  ): string | undefined {
    if (!installed) return 'cloudflared 未安装，请先运行: brew install cloudflared';
    if (!config.exists) return `找不到 cloudflared 配置: ${this.configPath}`;
    if (!configReady) return `Cloudflare 配置未完成，请填写本机私有配置: ${this.configPath}`;
    if (!config.hostname) return `Cloudflare 配置缺少 hostname: ${this.configPath}`;
    return undefined;
  }
}
