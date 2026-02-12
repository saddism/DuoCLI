import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import { WebSocketServer, WebSocket } from 'ws';
import webpush from 'web-push';
import { PtyManager, getDisplayName } from './pty-manager';

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
}

function loadOrCreateConfig(): RemoteConfig {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (fs.existsSync(CONFIG_FILE)) {
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch {}
  }
  const vapidKeys = webpush.generateVAPIDKeys();
  const config: RemoteConfig = {
    token: crypto.randomBytes(32).toString('hex'),
    vapidPublic: vapidKeys.publicKey,
    vapidPrivate: vapidKeys.privateKey,
    pushSubscriptions: [],
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  return config;
}

/**
 * 启动远程访问服务器，复用桌面端的 ptyManager
 * @param ptyManager 桌面端的终端管理器实例
 * @param onRemoteCreate 手机端创建会话后的回调，通知桌面端 renderer 刷新
 * @param onRemoteDestroy 手机端销毁会话后的回调
 */
export function startRemoteServer(
  ptyManager: PtyManager,
  onRemoteCreate?: (sessionInfo: any) => void,
  onRemoteDestroy?: (id: string) => void,
): void {
  const config = loadOrCreateConfig();
  const LOCAL_IP = getLocalIP();

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

          // 回放历史 buffer
          const session = ptyManager.getSession(data.sessionId);
          if (session && session.rawBuffer) {
            ws.send(JSON.stringify({ type: 'replay', data: session.rawBuffer }));
          }
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

  // 会话列表 — 直接读 ptyManager
  app.get('/api/sessions', (_req, res) => {
    const sessions = ptyManager.getAllSessions().map(s => ({
      id: s.id,
      title: s.title,
      cwd: s.cwd,
      presetCommand: s.presetCommand,
      displayName: getDisplayName(s.presetCommand),
      status: 'running', // 桌面端没有 idle/exited 状态追踪，简化处理
      createdAt: Date.now(), // PtySession 没有 createdAt，用当前时间占位
    }));
    res.json(sessions);
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

  // 删除会话
  app.delete('/api/sessions/:id', (req, res) => {
    ptyManager.destroy(req.params.id);
    onRemoteDestroy?.(req.params.id);
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
        status: 'running',
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

  server.listen(PORT, '0.0.0.0', () => {
    const lanUrl = `http://${LOCAL_IP}:${PORT}`;
    console.log('');
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║        DuoCLI 远程访问服务已启动                  ║');
    console.log('╠══════════════════════════════════════════════════╣');
    console.log(`║  局域网: ${lanUrl}`);
    console.log(`║  Token:  ${config.token}`);
    console.log('╚══════════════════════════════════════════════════╝');
    console.log('');
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
