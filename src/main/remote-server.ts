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
import { PtyManager, getDisplayName } from './pty-manager';

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

const PORT = parseInt(process.env.DUOCLI_REMOTE_PORT || '9800');

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

interface RemoteConfig {
  token: string;
  vapidPublic: string;
  vapidPrivate: string;
  pushSubscriptions: webpush.PushSubscription[];
  recentCwds: string[];
}

function loadOrCreateConfig(): RemoteConfig {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) as Partial<RemoteConfig>;
      const fallbackKeys = webpush.generateVAPIDKeys();
      return {
        token: raw.token || crypto.randomBytes(32).toString('hex'),
        vapidPublic: raw.vapidPublic || fallbackKeys.publicKey,
        vapidPrivate: raw.vapidPrivate || fallbackKeys.privateKey,
        pushSubscriptions: Array.isArray(raw.pushSubscriptions) ? raw.pushSubscriptions : [],
        recentCwds: Array.isArray(raw.recentCwds) ? raw.recentCwds.filter(Boolean).slice(0, 20) : [],
      };
    } catch {}
  }
  const vapidKeys = webpush.generateVAPIDKeys();
  const config: RemoteConfig = {
    token: crypto.randomBytes(32).toString('hex'),
    vapidPublic: vapidKeys.publicKey,
    vapidPrivate: vapidKeys.privateKey,
    pushSubscriptions: [],
    recentCwds: [],
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  return config;
}

const MAX_RECENT_CWDS = 20;

function normalizeCwd(cwd: string): string {
  return (cwd || '').trim().replace(/\/+$/, '');
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

  const wss = new WebSocketServer({ server, path: '/ws' });
  const wsClients = new Map<string, Set<WebSocket>>();

  wss.on('connection', (ws, req) => {
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
      } catch {}
    });

    ws.on('close', () => {
      if (subscribedSession) wsClients.get(subscribedSession)?.delete(ws);
    });
  });

  // pty rawData → 推送给 WebSocket 客户端（由 index.ts 中 onRawData 回调触发）
  // 这里导出一个方法供外部调用
  (startRemoteServer as any)._pushRawData = (id: string, data: string) => {
    const clients = wsClients.get(id);
    if (!clients) return;
    const msg = JSON.stringify({ type: 'output', data });
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  };

  // ========== API 路由 ==========

  app.get('/api/server-info', (_req, res) => {
    res.json({ ip: LOCAL_IP, port: PORT, hostname: os.hostname() });
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

  // 会话列表 — 直接读 ptyManager
  app.get('/api/sessions', (_req, res) => {
    const sessions = ptyManager.getAllSessions().map(s => ({
      id: s.id,
      title: s.title,
      cwd: s.cwd,
      presetCommand: s.presetCommand,
      displayName: getDisplayName(s.presetCommand),
      provider: (s as any).provider || getCliProvider(s.presetCommand),
      status: getSessionStatus(s.id, s.ptyProcess),
      createdAt: (s as any).createdAt || Date.now(),
    }));
    res.json(sessions);
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
    const { cwd, presetCommand } = req.body;
    const targetCwd = cwd || process.env.HOME || os.homedir();
    try {
      const session = ptyManager.create(targetCwd, presetCommand || '', 'default');
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
    const filename = (req.headers['x-filename'] as string) || `upload_${Date.now()}`;
    const decoded = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
    const dest = path.join(session.cwd, filename);
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

  app.get('/api/android/screenshot', (req, res) => {
    try {
      const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId.trim() : '';
      const args: string[] = [];
      if (deviceId) args.push('-s', deviceId);
      args.push('exec-out', 'screencap', '-p');
      const png = execFileSync(ADB, args, { maxBuffer: 8 * 1024 * 1024 });
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'no-store');
      res.send(png);
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
      const sessions = ptyManager.getAllSessions().map(s => ({
        id: s.id,
        title: s.title,
        cwd: s.cwd,
        presetCommand: s.presetCommand,
        displayName: getDisplayName(s.presetCommand),
        provider: (s as any).provider || getCliProvider(s.presetCommand),
        status: getSessionStatus(s.id, s.ptyProcess),
      }));
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

  server.on('error', (err: any) => {
    console.error('[RemoteServer] Server error:', err.code, err.message);
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
