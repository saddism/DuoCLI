import http from 'http';
import https from 'https';
import { CloudflaredManager } from './cloudflared-manager';

export type RemoteSyncStatus = 'healthy' | 'lan-only' | 'degraded' | 'retrying' | 'error';

export interface RemoteSyncHealth {
  status: RemoteSyncStatus;
  localOk: boolean;
  tunnelRunning: boolean;
  publicOk: boolean;
  publicUrl?: string;
  message: string;
  lastCheckedAt: number;
}

export function probeLocalRemoteServer(port: number, host = '127.0.0.1', timeoutMs = 3000): Promise<boolean> {
  if (!Number.isInteger(port) || port <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const req = http.get(`http://${host}:${port}/ping.png`, { timeout: timeoutMs }, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

export function probePublicRemoteServer(publicBaseUrl: string, timeoutMs = 8000): Promise<boolean> {
  const base = String(publicBaseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return Promise.resolve(false);

  let url: URL;
  try {
    url = new URL(`${base}/ping.png`);
  } catch {
    return Promise.resolve(false);
  }

  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldProbePublicUrl(
  localOk: boolean,
  tunnel: ReturnType<CloudflaredManager['getStatus']>,
): boolean {
  return Boolean(localOk && tunnel.installed && tunnel.url && tunnel.running);
}

export class RemoteSyncMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private retryInFlight = false;
  private lastRecoveryAt = 0;
  private readonly checkIntervalMs = 20_000;
  private readonly recoveryCooldownMs = 60_000;

  constructor(
    private readonly cloudflared: CloudflaredManager,
    private readonly getPort: () => number,
    private readonly restartLocalServer: () => void,
    private readonly onHealth: (health: RemoteSyncHealth) => void,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.refreshAndMaybeRecover(false);
    this.timer = setInterval(() => {
      void this.refreshAndMaybeRecover(true);
    }, this.checkIntervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async getHealth(): Promise<RemoteSyncHealth> {
    const port = this.getPort();
    const localOk = await probeLocalRemoteServer(port);
    const tunnel = this.cloudflared.getStatus();
    const probePublic = shouldProbePublicUrl(localOk, tunnel);
    const publicOk = probePublic && tunnel.url
      ? await probePublicRemoteServer(tunnel.url)
      : false;
    return this.buildHealth(localOk, tunnel, this.retryInFlight, publicOk, probePublic);
  }

  async retrySync(force = true): Promise<RemoteSyncHealth> {
    await this.runRecovery(force);
    const health = await this.getHealth();
    this.onHealth(health);
    return health;
  }

  private async refreshAndMaybeRecover(autoRecover: boolean): Promise<void> {
    const health = await this.getHealth();
    this.onHealth(health);

    const shouldRecover = health.status === 'error' || health.status === 'degraded';
    if (!autoRecover || !shouldRecover) return;
    if (Date.now() - this.lastRecoveryAt < this.recoveryCooldownMs) return;
    this.lastRecoveryAt = Date.now();
    await this.runRecovery(false);
    this.onHealth(await this.getHealth());
  }

  private async runRecovery(_force: boolean): Promise<void> {
    if (this.retryInFlight) return;
    this.retryInFlight = true;
    this.onHealth({
      status: 'retrying',
      localOk: false,
      tunnelRunning: false,
      publicOk: false,
      message: '正在恢复远程同步…',
      lastCheckedAt: Date.now(),
    });

    try {
      const port = this.getPort();
      let localOk = await probeLocalRemoteServer(port);
      if (!localOk) {
        console.log('[RemoteSync] Local remote server not responding, restarting…');
        this.restartLocalServer();
        for (let attempt = 0; attempt < 6 && !localOk; attempt++) {
          await sleep(attempt === 0 ? 800 : 1000);
          localOk = await probeLocalRemoteServer(port);
        }
      }

      if (localOk) {
        // 恢复流程里强制重启隧道，避免“进程在跑但公网 502”的僵尸 tunnel
        this.cloudflared.reconcileTunnel(true);
        for (let attempt = 0; attempt < 5; attempt++) {
          await sleep(attempt === 0 ? 2000 : 2500);
          const health = await this.getHealth();
          if (health.status === 'healthy') break;
        }
      } else {
        console.warn('[RemoteSync] Local remote server still unavailable after restart');
      }
    } finally {
      this.retryInFlight = false;
    }
  }

  private buildHealth(
    localOk: boolean,
    tunnel: ReturnType<CloudflaredManager['getStatus']>,
    retrying: boolean,
    publicOk: boolean,
    probePublic: boolean,
  ): RemoteSyncHealth {
    const lastCheckedAt = Date.now();
    const publicUrl = tunnel.url || undefined;

    if (retrying) {
      return {
        status: 'retrying',
        localOk,
        tunnelRunning: tunnel.running,
        publicOk,
        publicUrl,
        message: '正在恢复远程同步…',
        lastCheckedAt,
      };
    }

    if (!localOk) {
      return {
        status: 'error',
        localOk: false,
        tunnelRunning: tunnel.running,
        publicOk: false,
        publicUrl,
        message: '本地远程服务未响应，手机端无法连接',
        lastCheckedAt,
      };
    }

    if (!tunnel.installed) {
      return {
        status: 'lan-only',
        localOk: true,
        tunnelRunning: false,
        publicOk: false,
        message: 'cloudflared 未安装，仅局域网可用',
        lastCheckedAt,
      };
    }

    if (tunnel.message && !tunnel.running) {
      return {
        status: 'lan-only',
        localOk: true,
        tunnelRunning: false,
        publicOk: false,
        publicUrl,
        message: tunnel.message,
        lastCheckedAt,
      };
    }

    if (!tunnel.running) {
      return {
        status: 'degraded',
        localOk: true,
        tunnelRunning: false,
        publicOk: false,
        publicUrl,
        message: 'Cloudflare 隧道未运行，公网地址不可用',
        lastCheckedAt,
      };
    }

    if (probePublic && !publicOk) {
      return {
        status: 'degraded',
        localOk: true,
        tunnelRunning: true,
        publicOk: false,
        publicUrl,
        message: publicUrl ? `公网 ${publicUrl} 无法访问` : '公网地址无法访问',
        lastCheckedAt,
      };
    }

    return {
      status: 'healthy',
      localOk: true,
      tunnelRunning: true,
      publicOk: probePublic,
      publicUrl,
      message: probePublic ? '公网与局域网均正常' : '局域网正常',
      lastCheckedAt,
    };
  }
}
