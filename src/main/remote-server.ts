import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import { execFileSync, execSync } from 'child_process';

function resolveAdb(): string {
  try { return execSync('which adb', { encoding: 'utf8' }).trim(); } catch { return 'adb'; }
}
const ADB = resolveAdb();
import { WebSocketServer, WebSocket } from 'ws';
import webpush from 'web-push';
import sharp from 'sharp';
import { PtyManager, getDisplayName } from './pty-manager';
import { ChatSessionManager } from './chat-session-manager';

// 缓存 ptyManager 和回调供远程创建使用（在 startRemoteServer 中设置）
let cachedPtyManager: PtyManager | null = null;
let cachedOnRemoteCreate: ((sessionInfo: any) => void) | null = null;

// 根据 preset 命令获取实际使用的模型提供商（与 index.ts 保持一致）
function getCliProvider(presetCommand: string): string | null {
  const home = os.homedir();

  if (presetCommand.startsWith('claude')) {
    const settingsPath = path.join(home, '.claude', 'settings.json');
    try {
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        const env = settings.env || {};
        const baseUrl = env.ANTHROPIC_BASE_URL || '';

        if (baseUrl.includes('minimaxi')) return 'MiniMax';
        if (baseUrl.includes('deepseek')) return 'DeepSeek';
        if (baseUrl.includes('zhipu') || baseUrl.includes('bigmodel')) return 'GLM';
        if (baseUrl.includes('cloudflare')) return 'Cloudflare';
        if (baseUrl.includes('anthropic') || !baseUrl) return 'Anthropic';

        if (baseUrl) {
          try {
            const url = new URL(baseUrl);
            return url.hostname.replace(/^api\./, '').split('.')[0].toUpperCase();
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }

    const rcFiles = [path.join(home, '.zshrc'), path.join(home, '.bashrc')];
    for (const rcFile of rcFiles) {
      if (!fs.existsSync(rcFile)) continue;
      const content = fs.readFileSync(rcFile, 'utf-8');
      const vars = parseShellExports(content);
      const baseUrl = vars.get('ANTHROPIC_BASE_URL') || '';
      if (baseUrl.includes('minimaxi')) return 'MiniMax';
      if (baseUrl.includes('deepseek')) return 'DeepSeek';
      if (baseUrl.includes('zhipu') || baseUrl.includes('bigmodel')) return 'GLM';
    }

    return 'Anthropic';
  }

  if (presetCommand.startsWith('codex')) {
    return 'OpenAI';
  }

  if (presetCommand.startsWith('kimi')) {
    return 'Moonshot';
  }

  if (presetCommand.startsWith('gemini')) {
    return 'Google';
  }

  if (presetCommand.startsWith('opencode')) {
    return 'OpenCode';
  }

  if (presetCommand.startsWith('devin')) {
    return 'Devin';
  }

  if (presetCommand.startsWith('kiro-cli')) {
    return 'Kiro';
  }

  if (presetCommand.startsWith('agent') || presetCommand.includes('cursor')) {
    return 'Cursor';
  }

  return null;
}

function parseShellExports(content: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^export\s+([A-Z_][A-Z0-9_]*)=["']?([^"'\n]+?)["']?\s*$/);
    if (match) {
      vars.set(match[1], match[2]);
    }
  }
  return vars;
}

function resolveSessionDisplayName(presetCommand: string, customPresets: CustomPreset[]): string {
  const displayName = getDisplayName(presetCommand);
  const customPreset = customPresets.find(p =>
    presetCommand === p.command || (p.autoFlag && presetCommand === p.command + ' ' + p.autoFlag)
  );
  return customPreset
    ? (presetCommand === customPreset.command + ' ' + customPreset.autoFlag
        ? customPreset.name + '全自动' : customPreset.name)
    : displayName;
}

const PORT = parseInt(process.env.DUOCLI_REMOTE_PORT || '9800');

/** 杀掉占用指定端口的残留进程（旧 DuoCLI 实例崩溃残留） */
function killPortOccupants(port: number): void {
  try {
    const out = execSync(`lsof -i :${port} -t -sTCP:LISTEN 2>/dev/null || true`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
    const pids = out.trim().split('\n').filter(Boolean).map(Number).filter(n => !isNaN(n));
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
        console.log(`[RemoteServer] Killed port ${port} occupant PID ${pid}`);
      } catch {
        // 进程可能已不存在
      }
    }
  } catch {
    // lsof 失败，忽略
  }
}

// 获取本机局域网 IP
function getLocalIP(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// ========== 配置持久化 ==========

const CONFIG_DIR = path.join(process.env.HOME || os.homedir(), '.duocli-mobile');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

interface CustomPreset {
  id: string;
  name: string;
  command: string;
  autoFlag: string;
}

interface RemoteConfig {
  token: string;
  vapidPublic: string;
  vapidPrivate: string;
  pushSubscriptions: webpush.PushSubscription[];
  recentCwds: string[];
  customPresets: CustomPreset[];
}

function generateAccessToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

function loadOrCreateConfig(): RemoteConfig {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) as Partial<RemoteConfig>;
      const fallbackKeys = webpush.generateVAPIDKeys();
      return {
        token: typeof raw.token === 'string' && raw.token.trim() ? raw.token.trim() : generateAccessToken(),
        vapidPublic: raw.vapidPublic || fallbackKeys.publicKey,
        vapidPrivate: raw.vapidPrivate || fallbackKeys.privateKey,
        pushSubscriptions: Array.isArray(raw.pushSubscriptions) ? raw.pushSubscriptions : [],
        recentCwds: Array.isArray(raw.recentCwds) ? raw.recentCwds.filter(Boolean).slice(0, 20) : [],
        customPresets: Array.isArray(raw.customPresets) ? raw.customPresets : [],
      };
    } catch {}
  }
  const vapidKeys = webpush.generateVAPIDKeys();
  const config: RemoteConfig = {
    token: generateAccessToken(),
    vapidPublic: vapidKeys.publicKey,
    vapidPrivate: vapidKeys.privateKey,
    pushSubscriptions: [],
    recentCwds: [],
    customPresets: [],
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  return config;
}

const MAX_RECENT_CWDS = 20;
const MAX_PREVIEW_BYTES = 1024 * 1024;
const PREVIEW_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.log', '.json', '.jsonl', '.yaml', '.yml', '.toml',
  '.xml', '.csv', '.tsv', '.ini', '.conf', '.config', '.env', '.properties',
  '.js', '.jsx', '.ts', '.tsx', '.vue', '.css', '.scss', '.less', '.html', '.htm',
  '.py', '.pyw', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.cc', '.cpp', '.h',
  '.hpp', '.sh', '.bash', '.zsh', '.fish', '.sql', '.nvue', '.wxml', '.wxss',
]);

function normalizeCwd(cwd: string): string {
  return (cwd || '').trim().replace(/\/+$/, '');
}

function isPreviewableFile(filePath: string): boolean {
  const name = path.basename(filePath).toLowerCase();
  return name === '.env' || PREVIEW_EXTENSIONS.has(path.extname(name));
}

function resolvePreviewPath(cwd: string, requestedPath: string): { cwdReal: string; filePath: string } | null {
  try {
    const cwdReal = fs.realpathSync(cwd);
    const raw = String(requestedPath || '').trim().replace(/^['"`]|['"`]$/g, '');
    if (!raw) return null;
    const expanded = raw.startsWith('@/') || raw.startsWith('@')
      ? path.join(cwdReal, raw.replace(/^@\/?/, ''))
      : path.isAbsolute(raw) ? raw : path.resolve(cwdReal, raw);
    const filePath = fs.realpathSync(expanded);
    if (!filePath.startsWith(cwdReal + path.sep)) return null;
    return { cwdReal, filePath };
  } catch {
    return null;
  }
}

function addRecentCwdInConfig(config: RemoteConfig, cwd: string): void {
  const normalized = normalizeCwd(cwd);
  if (!normalized) return;
  const next = [normalized, ...config.recentCwds.filter(x => x !== normalized)];
  config.recentCwds = next.slice(0, MAX_RECENT_CWDS);
}

/**
 * 启动远程访问服务器，复用桌面端的 ptyManager
 * @param ptyManager 桌面端的终端管理器实例
 * @param onRemoteCreate 手机端创建会话后的回调，通知桌面端 renderer 刷新
 * @param onRemoteDestroy 手机端销毁会话后的回调
 * @param onServerStarted 服务器启动后的回调，用于返回连接信息（IP、端口、Token）
 */
export function startRemoteServer(
  ptyManager: PtyManager,
  onRemoteCreate?: (sessionInfo: any) => void,
  onRemoteDestroy?: (id: string) => void,
  onServerStarted?: (info: { lanUrl: string; token: string; port: number }) => void,
): void {
  // 缓存供 Bridge 事件使用
  cachedPtyManager = ptyManager;
  cachedOnRemoteCreate = onRemoteCreate || null;

  const config = loadOrCreateConfig();
  const LOCAL_IP = getLocalIP();

  console.log('[RemoteServer] Starting server, IP:', LOCAL_IP, 'PORT:', PORT);

  webpush.setVapidDetails('mailto:duocli@localhost', config.vapidPublic, config.vapidPrivate);

  const app = express();
  const server = http.createServer(app);

  app.use(express.json());

  // 静态文件：serve mobile/client 目录
  const clientDir = path.join(__dirname, '../../mobile/client');
  app.use(express.static(clientDir));

  // 认证中间件
  function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
    if (req.path === '/auth' || req.path === '/server-info' || req.path === '/vapid-public-key') return next();
    const t = req.headers['authorization']?.replace('Bearer ', '') || req.query.token as string;
    if (t !== config.token) { res.status(401).json({ error: '未授权' }); return; }
    next();
  }

  app.use('/api', authMiddleware);

  // ========== WebSocket ==========

  // 启用 permessage-deflate：终端 ANSI 文本压缩比通常 5-10x，
  // 对弱网首屏 replay 与刷屏 output 都是关键收益。threshold 以下不压缩，避免小消息反而变大。
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    perMessageDeflate: {
      threshold: 1024,
      zlibDeflateOptions: { level: 6, memLevel: 7 },
      clientNoContextTakeover: true,
      serverNoContextTakeover: true,
      concurrencyLimit: 10,
    },
  });
  const wsClients = new Map<string, Set<WebSocket>>();
  type AliveWebSocket = WebSocket & { isAlive?: boolean };

  // WS 层心跳：清理半开连接，避免弱网下“假在线”导致客户端一直卡重连
  const wsHeartbeatTimer = setInterval(() => {
    wss.clients.forEach((client) => {
      const wsClient = client as AliveWebSocket;
      if (wsClient.isAlive === false) {
        wsClient.terminate();
        return;
      }
      wsClient.isAlive = false;
      try {
        wsClient.ping();
      } catch { /* ignore */ }
    });
  }, 20000);
  server.on('close', () => {
    clearInterval(wsHeartbeatTimer);
  });

  wss.on('connection', (ws, req) => {
    const aliveWs = ws as AliveWebSocket;
    aliveWs.isAlive = true;
    ws.on('pong', () => {
      aliveWs.isAlive = true;
    });

    const url = new URL(req.url || '', 'http://localhost');
    if (url.searchParams.get('token') !== config.token) {
      ws.close(4001, '未授权');
      return;
    }

    let subscribedSession: string | null = null;

    ws.on('message', (msg) => {
      try {
        const data = JSON.parse(msg.toString());

        if (data.type === 'subscribe' && data.sessionId) {
          if (subscribedSession) wsClients.get(subscribedSession)?.delete(ws);
          subscribedSession = data.sessionId;
          if (!wsClients.has(data.sessionId)) wsClients.set(data.sessionId, new Set());
          wsClients.get(data.sessionId)!.add(ws);

          // 回放历史 buffer（始终发送 replay，即使 rawBuffer 为空，让客户端知道订阅已生效）
          const session = ptyManager.getSession(data.sessionId);
          ws.send(JSON.stringify({ type: 'replay', data: session?.rawBuffer || '' }));
        }

        if (data.type === 'input' && subscribedSession) {
          ptyManager.write(subscribedSession, data.data);
        }

        // base64 编码的 input，解码后写入 pty（避免控制字符在 JSON 传输中丢失）
        if (data.type === 'input_b64' && subscribedSession && typeof data.data === 'string') {
          const decoded = Buffer.from(data.data, 'base64').toString('utf-8');
          ptyManager.write(subscribedSession, decoded);
        }

        // 手机端 resize — 同步调整 pty 尺寸，让输出按手机列数排版
        if (data.type === 'resize' && subscribedSession && data.cols && data.rows) {
          ptyManager.resize(subscribedSession, data.cols, data.rows);
        }

        // 心跳 ping，忽略即可
        if (data.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        }
      } catch {}
    });

    ws.on('close', () => {
      if (subscribedSession) wsClients.get(subscribedSession)?.delete(ws);
    });
  });

  // pty rawData → 推送给 WebSocket 客户端（由 index.ts 中 onRawData 回调触发）
  // 微批合并：8ms 内的多次 onData 拼成一帧再 send，减少 ws 帧数与 JSON 包头开销。
  // 8ms 在人眼几乎察觉不到，却能把 npm install / 编译刷屏从几百帧压到几十帧。
  const pendingChunks = new Map<string, string>();
  const pendingTimers = new Map<string, NodeJS.Timeout>();
  const FLUSH_DELAY_MS = 8;
  const FLUSH_MAX_BYTES = 32768; // 累积超过 32KB 立即冲刷，避免长期积压
  // 弱网背压：单连接 socket 缓冲区超过 1MB 视为积压，直接 terminate
  // 客户端重连时通过 replay 拿到 rawBuffer 最新 128KB，正好跳过所有堆积的旧帧。
  const WS_BACKPRESSURE_BYTES = 1024 * 1024;

  const flushChunks = (id: string) => {
    const data = pendingChunks.get(id);
    pendingChunks.delete(id);
    const t = pendingTimers.get(id);
    if (t) { clearTimeout(t); pendingTimers.delete(id); }
    if (!data) return;
    const clients = wsClients.get(id);
    if (!clients || clients.size === 0) return;
    const msg = JSON.stringify({ type: 'output', data });
    for (const ws of clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (ws.bufferedAmount > WS_BACKPRESSURE_BYTES) {
        // 弱网积压：放弃这条连接，触发客户端重连+replay
        ws.terminate();
        clients.delete(ws);
        continue;
      }
      ws.send(msg);
    }
  };

  (startRemoteServer as any)._pushRawData = (id: string, data: string) => {
    const clients = wsClients.get(id);
    if (!clients || clients.size === 0) return;
    const prev = pendingChunks.get(id) || '';
    const merged = prev + data;
    pendingChunks.set(id, merged);
    if (merged.length >= FLUSH_MAX_BYTES) {
      flushChunks(id);
      return;
    }
    if (!pendingTimers.has(id)) {
      pendingTimers.set(id, setTimeout(() => flushChunks(id), FLUSH_DELAY_MS));
    }
  };

  // ========== API 路由 ==========

  app.get('/api/server-info', (_req, res) => {
    res.json({ ip: LOCAL_IP, port: PORT, hostname: os.hostname() });
  });

  // 返回当前所有可用的局域网 IPv4 地址（多网卡 / 多网段）
  // 手机端在 CF Tunnel 模式下用此接口探测是否能直连 LAN
  // 注意：此接口需要 token 鉴权（走 /api 前缀），避免泄露内网拓扑
  app.get('/api/lan-info', (_req, res) => {
    const interfaces = os.networkInterfaces();
    const lanIps: string[] = [];
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] || []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          lanIps.push(iface.address);
        }
      }
    }
    res.json({ lanIps, port: PORT, hostname: os.hostname() });
  });

  // 1x1 透明 PNG，给手机端 <img> 探针用（HTTPS 页面下 fetch HTTP 会被
  // Mixed Content 拦截，但 <img> 跨协议加载不被拦，可用 onload 判通断）
  // 注意：不挂在 /api 下，避免 token 限制——这是公开探针端点
  const PING_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64'
  );
  app.get('/ping.png', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('png').send(PING_PNG);
  });

  app.post('/api/auth', (req, res) => {
    if (req.body.token === config.token) {
      res.json({ ok: true, ip: LOCAL_IP, port: PORT });
    } else {
      res.status(401).json({ error: 'Token 错误' });
    }
  });

  app.get('/api/vapid-public-key', (_req, res) => {
    res.json({ key: config.vapidPublic });
  });

  // ========== 自定义预设同步 API ==========

  app.get('/api/custom-presets', (_req, res) => {
    res.json(config.customPresets || []);
  });

  app.put('/api/custom-presets', (req, res) => {
    const list = req.body;
    if (!Array.isArray(list)) { res.status(400).json({ error: '需要数组' }); return; }
    config.customPresets = list;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    res.json({ ok: true });
  });

  app.post('/api/push/subscribe', (req, res) => {
    const subscription = req.body.subscription as webpush.PushSubscription;
    if (!subscription) { res.status(400).json({ error: '缺少 subscription' }); return; }
    const exists = config.pushSubscriptions.some(s => s.endpoint === subscription.endpoint);
    if (!exists) {
      config.pushSubscriptions.push(subscription);
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    }
    res.json({ ok: true });
  });

  // 获取会话的 UI 状态（busy/unread/idle），由 renderer 同步到 main
  function getSessionStatus(id: string, ptyProcess: any): string {
    if (ptyProcess.exitState) return 'exited';
    const statuses = (global as any).__sessionStatuses || {};
    return statuses[id] || 'idle';
  }

  function mapSessionToApi(s: any) {
    return {
      id: s.id,
      title: s.title,
      cwd: s.cwd,
      presetCommand: s.presetCommand,
      displayName: resolveSessionDisplayName(s.presetCommand, config.customPresets),
      provider: s.provider || getCliProvider(s.presetCommand),
      status: getSessionStatus(s.id, s.ptyProcess),
      createdAt: s.createdAt || Date.now(),
    };
  }

  // 会话列表 — 直接读 ptyManager
  app.get('/api/sessions', (_req, res) => {
    const sessions = ptyManager.getAllSessions().map(s => mapSessionToApi(s));
    res.json(sessions);
  });

  // 手机端只读预览会话 cwd 内的文本文件
  app.get('/api/sessions/:id/file-preview', (req, res) => {
    const session = ptyManager.getSession(req.params.id);
    if (!session) { res.status(404).json({ error: '会话不存在' }); return; }
    const resolved = resolvePreviewPath(session.cwd, String(req.query.path || ''));
    if (!resolved || !isPreviewableFile(resolved.filePath)) {
      res.status(400).json({ error: '只支持工作目录内的文本文件' }); return;
    }
    try {
      const stat = fs.statSync(resolved.filePath);
      if (!stat.isFile()) { res.status(400).json({ error: '目标不是文件' }); return; }
      if (stat.size > MAX_PREVIEW_BYTES) {
        res.status(413).json({ error: '文件过大，无法在手机端预览' }); return;
      }
      const content = fs.readFileSync(resolved.filePath);
      if (content.includes(0)) {
        res.status(400).json({ error: '该文件不是文本文件' }); return;
      }
      res.json({
        name: path.basename(resolved.filePath),
        path: resolved.filePath,
        content: content.toString('utf8'),
        size: stat.size,
      });
    } catch (e: any) {
      res.status(404).json({ error: '文件读取失败: ' + (e.message || e) });
    }
  });

  // 最近工作目录（桌面端同步 + 运行中会话 cwd 去重合并）
  app.get('/api/recent-cwds', (_req, res) => {
    const fromSessions = ptyManager.getAllSessions().map(s => normalizeCwd(s.cwd)).filter(Boolean);
    const merged = [...fromSessions, ...config.recentCwds];
    const uniq: string[] = [];
    for (const p of merged) {
      if (p && !uniq.includes(p)) uniq.push(p);
      if (uniq.length >= MAX_RECENT_CWDS) break;
    }
    res.json({ items: uniq });
  });

  // 创建会话 — 通过 ptyManager 创建，通知桌面端
  app.post('/api/sessions', (req, res) => {
    const { cwd, presetCommand, themeId, providerEnv } = req.body;
    const targetCwd = cwd || process.env.HOME || os.homedir();
    try {
      const session = ptyManager.create(
        targetCwd,
        presetCommand || '',
        typeof themeId === 'string' && themeId ? themeId : 'default',
        providerEnv && typeof providerEnv === 'object' ? providerEnv : undefined,
      );
      const info = {
        id: session.id,
        title: session.title,
        themeId: session.themeId,
        cwd: session.cwd,
        displayName: getDisplayName(session.presetCommand),
      };
      addRecentCwdInConfig(config, session.cwd);
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
      onRemoteCreate?.(info);
      res.json(info);
    } catch (e: any) {
      res.status(500).json({ error: '创建失败: ' + (e.message || e) });
    }
  });

  // 输入
  app.post('/api/sessions/:id/input', (req, res) => {
    const { input } = req.body;
    if (typeof input !== 'string') { res.status(400).json({ error: '缺少 input' }); return; }
    const data = input.endsWith('\r') || input.endsWith('\n') ? input : input + '\r';
    ptyManager.write(req.params.id, data);
    res.json({ ok: true });
  });

  // 原始键码
  app.post('/api/sessions/:id/key', (req, res) => {
    const { key } = req.body;
    if (typeof key !== 'string') { res.status(400).json({ error: '缺少 key' }); return; }
    ptyManager.write(req.params.id, key);
    res.json({ ok: true });
  });

  // 文件上传 — 存到会话的 cwd
  app.post('/api/sessions/:id/upload', express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
    const session = ptyManager.getSession(req.params.id);
    if (!session) { res.status(404).json({ error: '会话不存在' }); return; }
    const rawName = (req.headers['x-filename'] as string) || `upload_${Date.now()}`;
    // 路径穿越防护：只取 basename，再校验落点必须在 cwd 下
    const filename = path.basename(rawName);
    if (!filename || filename === '.' || filename === '..') {
      res.status(400).json({ error: '非法文件名' }); return;
    }
    const decoded = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
    const dest = path.resolve(session.cwd, filename);
    const cwdReal = path.resolve(session.cwd);
    if (!dest.startsWith(cwdReal + path.sep) && dest !== cwdReal) {
      res.status(400).json({ error: '非法路径' }); return;
    }
    try {
      fs.writeFileSync(dest, decoded);
      res.json({ ok: true, path: dest, size: decoded.length });
    } catch (e: any) {
      res.status(500).json({ error: '写入失败: ' + (e.message || e) });
    }
  });

  // 重命名会话标题
  app.put('/api/sessions/:id/title', (req, res) => {
    const { title } = req.body;
    if (typeof title !== 'string' || !title.trim()) {
      res.status(400).json({ error: '缺少 title' });
      return;
    }
    const session = ptyManager.getSession(req.params.id);
    if (!session) { res.status(404).json({ error: '会话不存在' }); return; }
    ptyManager.rename(req.params.id, title.trim());
    res.json({ ok: true });
  });

  // 删除会话
  app.delete('/api/sessions/:id', (req, res) => {
    ptyManager.destroy(req.params.id);
    onRemoteDestroy?.(req.params.id);
    res.json({ ok: true });
  });

  // ========== Chat Session API ==========

  function getChatManager(): ChatSessionManager | null {
    return (global as any).__chatSessionManager || null;
  }

  // 健康检查
  app.get('/api/chat/health', async (_req, res) => {
    const mgr = getChatManager();
    if (!mgr) { res.json({ ok: false, error: 'Chat manager not ready' }); return; }
    const health = await mgr.healthCheck();
    const proxyMgr = (global as any).__windsurfProxyManager;
    res.json({
      ...health,
      autoManaged: proxyMgr?.isAvailable() ?? false,
      proxyDir: proxyMgr?.getProxyDir() ?? null,
    });
  });

  // 手动重启/启动代理
  app.post('/api/chat/proxy/start', async (_req, res) => {
    const proxyMgr = (global as any).__windsurfProxyManager;
    if (!proxyMgr) { res.status(500).json({ error: 'Proxy manager not available' }); return; }
    const result = await proxyMgr.start();
    res.json(result);
  });

  // 模型列表
  app.get('/api/chat/models', async (_req, res) => {
    const mgr = getChatManager();
    if (!mgr) { res.json([]); return; }
    const models = await mgr.listModels();
    res.json(models);
  });

  // 会话列表
  app.get('/api/chat/sessions', (_req, res) => {
    const mgr = getChatManager();
    if (!mgr) { res.json([]); return; }
    const sessions = mgr.getAllSessions().map(s => ({
      id: s.id,
      title: s.title,
      model: s.model,
      workspace: s.workspace,
      createdAt: s.createdAt,
      messageCount: s.messages.length,
    }));
    res.json(sessions);
  });

  // 创建会话
  app.post('/api/chat/sessions', (req, res) => {
    const mgr = getChatManager();
    if (!mgr) { res.status(500).json({ error: 'Chat manager not ready' }); return; }
    const { workspace, model } = req.body || {};
    const session = mgr.create(workspace || os.homedir(), model);
    res.json({
      id: session.id,
      title: session.title,
      model: session.model,
      workspace: session.workspace,
      createdAt: session.createdAt,
    });
  });

  // 获取会话消息
  app.get('/api/chat/sessions/:id/messages', (req, res) => {
    const mgr = getChatManager();
    const session = mgr?.getSession(req.params.id);
    if (!session) { res.status(404).json({ error: '会话不存在' }); return; }
    res.json({ messages: session.messages });
  });

  // 发送消息（SSE 流式返回）
  app.post('/api/chat/sessions/:id/messages', (req, res) => {
    const mgr = getChatManager();
    if (!mgr) { res.status(500).json({ error: 'Chat manager not ready' }); return; }
    const content = req.body?.content;
    if (typeof content !== 'string' || !content.trim()) {
      res.status(400).json({ error: '缺少 content' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const sessionId = req.params.id;

    // 监听器在 manager 上是全局共享的，必须按 sid 过滤，
    // 否则其他并发会话的 delta 会窜进当前 SSE 响应
    const onDelta = (sid: string, text: string) => {
      if (sid !== sessionId) return;
      res.write(`data: ${JSON.stringify({ type: 'delta', text })}\n\n`);
    };
    const onDone = (sid: string, contentStr: string) => {
      if (sid !== sessionId) return;
      res.write(`data: ${JSON.stringify({ type: 'done', content: contentStr })}\n\n`);
      res.end();
      cleanup();
    };
    const onError = (sid: string, error: string) => {
      if (sid !== sessionId) return;
      res.write(`data: ${JSON.stringify({ type: 'error', error })}\n\n`);
      res.end();
      cleanup();
    };

    const cleanup = () => {
      mgr.removeListener('onDelta', onDelta);
      mgr.removeListener('onDone', onDone);
      mgr.removeListener('onError', onError);
    };

    mgr.on('onDelta', onDelta);
    mgr.on('onDone', onDone);
    mgr.on('onError', onError);

    mgr.sendMessage(sessionId, content).catch((err) => {
      onError(sessionId, err.message || String(err));
    });

    req.on('close', () => {
      mgr.abortStream(sessionId);
      cleanup();
    });
  });

  // 终止会话
  app.delete('/api/chat/sessions/:id', (req, res) => {
    const mgr = getChatManager();
    if (!mgr) { res.status(500).json({ error: 'Chat manager not ready' }); return; }
    mgr.destroy(req.params.id);
    res.json({ ok: true });
  });

  // 重命名会话
  app.put('/api/chat/sessions/:id/title', (req, res) => {
    const mgr = getChatManager();
    const { title } = req.body || {};
    if (typeof title !== 'string' || !title.trim()) {
      res.status(400).json({ error: '缺少 title' });
      return;
    }
    mgr?.rename(req.params.id, title.trim());
    res.json({ ok: true });
  });

  // 中断流
  app.post('/api/chat/sessions/:id/abort', (req, res) => {
    const mgr = getChatManager();
    mgr?.abortStream(req.params.id);
    res.json({ ok: true });
  });

  // ========== Android 设备 API ==========

  app.get('/api/android/devices', (_req, res) => {
    try {
      const out = execFileSync(ADB, ['devices', '-l'], { encoding: 'utf8' });
      const devices = out.split('\n').slice(1).filter(l => l.trim() && !l.startsWith('*')).map(l => {
        const [id, ...rest] = l.trim().split(/\s+/);
        return { id, info: rest.join(' ') };
      });
      res.json({ devices });
    } catch (e: any) {
      res.status(500).json({ error: '获取设备失败: ' + (e.message || e) });
    }
  });

  app.get('/api/android/screenshot', async (req, res) => {
    try {
      const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId.trim() : '';
      const quality = Math.min(100, Math.max(1, parseInt(req.query.quality as string) || 80));
      const scale = Math.min(1, Math.max(0.1, parseFloat(req.query.scale as string) || 1));
      const args: string[] = [];
      if (deviceId) args.push('-s', deviceId);
      args.push('exec-out', 'screencap', '-p');
      const png = execFileSync(ADB, args, { maxBuffer: 8 * 1024 * 1024 });
      let pipeline = sharp(png);
      if (scale < 1) {
        const meta = await sharp(png).metadata();
        if (meta.width && meta.height) {
          pipeline = pipeline.resize(Math.round(meta.width * scale), Math.round(meta.height * scale));
        }
      }
      const jpeg = await pipeline.jpeg({ quality }).toBuffer();
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'no-store');
      res.send(jpeg);
    } catch (e: any) {
      res.status(500).json({ error: '截图失败: ' + (e.message || e) });
    }
  });

  app.post('/api/android/tap', (req, res) => {
    try {
      const deviceId = typeof req.body.deviceId === 'string' ? req.body.deviceId.trim() : '';
      const x = Math.round(Number(req.body.x));
      const y = Math.round(Number(req.body.y));
      if (!deviceId || isNaN(x) || isNaN(y)) { res.status(400).json({ error: '参数错误' }); return; }
      execFileSync(ADB, ['-s', deviceId, 'shell', 'input', 'tap', String(x), String(y)]);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: '点击失败: ' + (e.message || e) });
    }
  });

  app.post('/api/android/swipe', (req, res) => {
    try {
      const deviceId = typeof req.body.deviceId === 'string' ? req.body.deviceId.trim() : '';
      const x1 = Math.round(Number(req.body.x1));
      const y1 = Math.round(Number(req.body.y1));
      const x2 = Math.round(Number(req.body.x2));
      const y2 = Math.round(Number(req.body.y2));
      const duration = Math.max(100, Math.min(3000, Math.round(Number(req.body.duration) || 300)));
      if (!deviceId || [x1, y1, x2, y2].some(isNaN)) { res.status(400).json({ error: '参数错误' }); return; }
      execFileSync(ADB, ['-s', deviceId, 'shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(duration)]);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: '滑动失败: ' + (e.message || e) });
    }
  });

  app.post('/api/android/shell', (req, res) => {
    try {
      const deviceId = typeof req.body.deviceId === 'string' ? req.body.deviceId.trim() : '';
      const command = typeof req.body.command === 'string' ? req.body.command.trim() : '';
      if (!deviceId || !command) { res.status(400).json({ error: '参数错误' }); return; }
      const out = execSync(`${ADB} -s ${deviceId} shell ${command}`, { encoding: 'utf8', timeout: 30000 });
      res.json({ output: out });
    } catch (e: any) {
      res.json({ output: e.stdout || e.message || String(e) });
    }
  });

  app.post('/api/android/input-text', (req, res) => {
    try {
      const deviceId = typeof req.body.deviceId === 'string' ? req.body.deviceId.trim() : '';
      const text = typeof req.body.text === 'string' ? req.body.text : '';
      if (!deviceId || !text) { res.status(400).json({ error: '参数错误' }); return; }
      // 切到 ADBKeyboard 发送文字，再切回搜狗
      execFileSync(ADB, ['-s', deviceId, 'shell', 'ime', 'set', 'com.android.adbkeyboard/.AdbIME']);
      execFileSync(ADB, ['-s', deviceId, 'shell', 'am', 'broadcast', '-a', 'ADB_INPUT_TEXT', '--es', 'msg', text]);
      execFileSync(ADB, ['-s', deviceId, 'shell', 'ime', 'set', 'com.sohu.inputmethod.sogouoem/.SogouIME']);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  // ========== 催工配置 API ==========

  // 读取催工配置（从桌面端 renderer）
  app.get('/api/sessions/:id/auto-continue', async (req, res) => {
    const getConfig = (global as any).__getAutoContinueConfig;
    if (!getConfig) { res.json(null); return; }
    const config = await getConfig(req.params.id);
    res.json(config);
  });

  // 写入催工配置（同步到桌面端 renderer）
  app.put('/api/sessions/:id/auto-continue', (req, res) => {
    const setConfig = (global as any).__setAutoContinueConfig;
    if (!setConfig) { res.status(500).json({ error: '桌面端未就绪' }); return; }
    setConfig(req.params.id, req.body);
    res.json({ ok: true });
  });

  // SSE 事件流
  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    const sendSessions = () => {
      const sessions = ptyManager.getAllSessions().map(s => mapSessionToApi(s));
      res.write(`event: sessions\ndata: ${JSON.stringify(sessions)}\n\n`);
    };
    const heartbeat = setInterval(() => { res.write(': heartbeat\n\n'); }, 3000);
    const statusInterval = setInterval(sendSessions, 2000);
    req.on('close', () => { clearInterval(heartbeat); clearInterval(statusInterval); });
  });

  // ========== 推送通知 ==========

  // 导出推送方法供外部调用
  (startRemoteServer as any)._sendPush = (title: string, body: string, sessionId: string) => {
    const payload = JSON.stringify({ title, body, sessionId });
    for (const sub of config.pushSubscriptions) {
      webpush.sendNotification(sub, payload).catch((err: any) => {
        if (err.statusCode === 410 || err.statusCode === 404) {
          config.pushSubscriptions = config.pushSubscriptions.filter(s => s.endpoint !== sub.endpoint);
          fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        }
      });
    }
  };

  // ========== 启动 ==========

  // 启动前清理：杀掉旧 DuoCLI 实例残留的 9800 端口进程
  killPortOccupants(PORT);

  server.on('error', (err: any) => {
    console.error('[RemoteServer] Server error:', err.code, err.message);
    // 端口被占用（旧实例崩溃残留），杀掉占用进程后重试一次
    if (err.code === 'EADDRINUSE') {
      console.log('[RemoteServer] Port in use, killing occupant and retrying...');
      killPortOccupants(PORT);
      setTimeout(() => {
        server.listen(PORT, '0.0.0.0', () => {
          const lanUrl = `http://${LOCAL_IP}:${PORT}`;
          console.log('[RemoteServer] Server started (retry), URL:', lanUrl);
          if (onServerStarted) {
            onServerStarted({ lanUrl, token: config.token, port: PORT });
          }
        });
      }, 500);
    }
  });

  server.listen(PORT, '0.0.0.0', () => {
    const lanUrl = `http://${LOCAL_IP}:${PORT}`;
    console.log('[RemoteServer] Server started, URL:', lanUrl);
    // 通过回调返回连接信息，不再输出到终端
    if (onServerStarted) {
      onServerStarted({ lanUrl, token: config.token, port: PORT });
    }
  });
}

/** 推送 pty 原始数据给远程 WebSocket 客户端 */
export function pushRawDataToRemote(id: string, data: string): void {
  (startRemoteServer as any)._pushRawData?.(id, data);
}

/** 发送推送通知 */
export function sendRemotePush(title: string, body: string, sessionId: string): void {
  (startRemoteServer as any)._sendPush?.(title, body, sessionId);
}

/** 桌面端同步最近目录到远程配置（供手机端新建会话下拉使用） */
export function addRemoteRecentCwd(cwd: string): void {
  const normalized = normalizeCwd(cwd);
  if (!normalized) return;
  const config = loadOrCreateConfig();
  const prev = config.recentCwds.join('\n');
  addRecentCwdInConfig(config, normalized);
  if (config.recentCwds.join('\n') !== prev) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  }
}
