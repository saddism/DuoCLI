import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import { execFileSync } from 'child_process';
import { parseAndroidDevices, runAdb } from './android-devices';
import { AndroidMirrorClient, AndroidMirrorInput, AndroidMirrorManager, validateAndroidMirrorInput } from './android-mirror';
import { AndroidScreenshotManager } from './android-screenshot';
import { AndroidJpegClient, AndroidJpegManager } from './android-jpeg';
import { resolveAndroidMediaHelper } from './android-media-helper';
import {
  DVM2_FLAG_DISCONTINUITY,
  DVM2_KIND_H264,
  DVM2_MAX_H264_BYTES,
  DVM2_MAX_JPEG_BYTES,
  encodeDvm2Frame,
} from './android-mirror-protocol';
import { WebSocketServer, WebSocket } from 'ws';
import webpush from 'web-push';
import sharp from 'sharp';
import { PtyManager, getDisplayName } from './pty-manager';
import { getAvailableBuiltinPresets } from './cli-detect';
import { buildResumeCommand } from './session-resume';

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

  if (presetCommand.startsWith('qoder')) {
    return 'Qoder';
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

  if (presetCommand.startsWith('agy')) {
    return 'Antigravity';
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

let PORT = parseInt(process.env.DUOCLI_REMOTE_PORT || '9800');
const HOST = process.env.DUOCLI_REMOTE_HOST || '0.0.0.0';

const DUOCLI_APP_ROOT = path.resolve(__dirname, '../..');

function findLsof(): string | null {
  const candidates = process.platform === 'darwin'
    ? ['/usr/sbin/lsof', 'lsof']
    : ['lsof', '/usr/sbin/lsof', '/usr/bin/lsof'];
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['-v'], { stdio: 'ignore', timeout: 1000 });
      return candidate;
    } catch {
      // Try the next well-known location.
    }
  }
  return null;
}

function listPortOccupants(port: number): number[] {
  const lsof = findLsof();
  if (!lsof || !Number.isInteger(port) || port <= 0 || port > 65535) return [];
  try {
    const output = execFileSync(lsof, ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return output.split(/\r?\n/)
      .map(value => Number(value.trim()))
      .filter(pid => Number.isInteger(pid) && pid > 1);
  } catch {
    // lsof returns exit code 1 when nothing is listening.
    return [];
  }
}

function processCommand(pid: number): string {
  if (process.platform === 'win32') return '';
  try {
    return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf-8',
      timeout: 2000,
    }).trim();
  } catch {
    return '';
  }
}

/** Exported for tests: only a command that clearly belongs to this app is killable. */
export function isDuoCliProcessCommand(command: string, appRoot = DUOCLI_APP_ROOT): boolean {
  const normalized = String(command || '').replace(/\\/g, '/');
  const root = path.resolve(appRoot).replace(/\\/g, '/').replace(/\/+$/, '');
  const developmentProcess = normalized.includes(`${root}/node_modules/electron/`)
    || (normalized.includes(`${root}/`) && /(?:^|\/)electron(?:\.exe)?(?:\s|$)/i.test(normalized));
  const packagedProcess = /(?:^|\/)DuoCLI\.app\/Contents\/MacOS\/DuoCLI(?:\s|$)/i.test(normalized)
    || /(?:^|[\\/])DuoCLI(?:\.exe)?(?:\s|$)/i.test(normalized);
  return developmentProcess || packagedProcess;
}

/** Stop only a verified stale DuoCLI listener; unrelated services are left alone. */
function killPortOccupants(port: number): number {
  let killed = 0;
  for (const pid of listPortOccupants(port)) {
    if (pid === process.pid) continue;
    const command = processCommand(pid);
    if (!isDuoCliProcessCommand(command)) {
      console.warn(`[RemoteServer] Port ${port} is occupied by an unrelated process; leaving PID ${pid} untouched`);
      continue;
    }
    try {
      process.kill(pid, 'SIGTERM');
      killed++;
      console.log(`[RemoteServer] Stopping stale DuoCLI listener PID ${pid} on port ${port}`);
    } catch {
      // The process may have exited between lsof and process.kill.
    }
  }
  return killed;
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

const CONFIG_DIR = process.env.DUOCLI_REMOTE_CONFIG_DIR || path.join(process.env.HOME || os.homedir(), '.duocli-mobile');
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
  '.xml', '.csv', '.tsv', '.ini', '.conf', '.config', '.properties',
  '.js', '.jsx', '.ts', '.tsx', '.vue', '.css', '.scss', '.less', '.html', '.htm',
  '.py', '.pyw', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.cc', '.cpp', '.h',
  '.hpp', '.sh', '.bash', '.zsh', '.fish', '.sql', '.nvue', '.wxml', '.wxss',
]);

function normalizeCwd(cwd: string): string {
  return (cwd || '').trim().replace(/\/+$/, '');
}

function isPreviewableFile(filePath: string): boolean {
  const name = path.basename(filePath).toLowerCase();
  if (name === '.env' || name.startsWith('.env.')) return false;
  return PREVIEW_EXTENSIONS.has(path.extname(name));
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

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Decode the mobile upload header once, then accept only a plain filename. */
export function decodeUploadFilename(rawName: string): string | null {
  let decodedName: string;
  try {
    decodedName = decodeURIComponent(String(rawName || ''));
  } catch {
    return null;
  }
  if (decodedName.includes('/') || decodedName.includes('\\') || decodedName.includes('\0')) return null;
  const filename = path.basename(decodedName);
  return filename && filename !== '.' && filename !== '..' ? filename : null;
}

function resolveDirectoryPath(cwd: string, requestedPath: string): { cwdReal: string; dirPath: string } | null {
  try {
    const cwdReal = fs.realpathSync(cwd);
    const raw = String(requestedPath || '').trim().replace(/^['"`]|['"`]$/g, '');
    const expanded = !raw || raw === '.'
      ? cwdReal
      : raw.startsWith('@/') || raw.startsWith('@')
        ? path.join(cwdReal, raw.replace(/^@\/?/, ''))
        : path.isAbsolute(raw) ? raw : path.resolve(cwdReal, raw);
    const dirPath = fs.realpathSync(expanded);
    if (!isPathInside(cwdReal, dirPath) || !fs.statSync(dirPath).isDirectory()) return null;
    return { cwdReal, dirPath };
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
 * @param onSessionClosed 手机端删除会话后保存可恢复元数据的回调
 */
export function startRemoteServer(
  ptyManager: PtyManager,
  onRemoteCreate?: (sessionInfo: any) => void,
  onRemoteDestroy?: (id: string) => void,
  onServerStarted?: (info: { lanUrl: string; token: string; port: number }) => void,
  onSessionClosed?: (session: { title: string; cwd: string; presetCommand: string; resumeId: string; resumeCommand: string; resumeSource?: any }) => void,
): http.Server {
  // 缓存供 Bridge 事件使用
  cachedPtyManager = ptyManager;
  cachedOnRemoteCreate = onRemoteCreate || null;

  const config = loadOrCreateConfig();
  const LOCAL_IP = getLocalIP();

  console.log('[RemoteServer] Starting server, IP:', LOCAL_IP, 'PORT:', PORT);

  webpush.setVapidDetails('mailto:duocli@localhost', config.vapidPublic, config.vapidPrivate);

  const app = express();
  const server = http.createServer(app);

  app.use(express.json({ limit: '256kb' }));

  // 发布版从解包资源读取。express.static 对 app.asar 内的异步文件访问会卡住，
  // 导致包括 /ping.png 在内的全部手机端请求无法返回；开发态仍读取源码目录。
  const packagedClientDir = process.resourcesPath
    ? path.join(process.resourcesPath, 'mobile', 'client')
    : '';
  const clientDir = packagedClientDir && fs.existsSync(packagedClientDir)
    ? packagedClientDir
    : path.join(__dirname, '../../mobile/client');
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

  const wss = new WebSocketServer({
    noServer: true,
    // 关闭 permessage-deflate：部分 WebSocket 客户端（含 iOS Safari）与 Node ws
    // 的压缩帧协商不稳定，会导致连接立刻断开并进入重连循环。
    perMessageDeflate: false,
  });
  const wsClients = new Map<string, Set<WebSocket>>();
  type RemoteWsChunk = { data: string; sequence: number };
  type RemoteWsState = {
    id: string;
    ready: boolean;
    sequence: number;
    revision: number;
    sendQueue: Promise<void>;
    pending: RemoteWsChunk[];
  };
  const remoteStates = new Map<WebSocket, RemoteWsState>();
  const enqueueWsSend = (ws: WebSocket, state: RemoteWsState, payload: string) => {
    const operation = state.sendQueue.then(() => new Promise<void>((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN || remoteStates.get(ws) !== state) {
        resolve();
        return;
      }
      ws.send(payload, (err) => (err ? reject(err) : resolve()));
    }));
    // A failed send must not poison the queue for a later reconnect, but the
    // caller still needs the rejection to invalidate this connection.
    state.sendQueue = operation.catch(() => {});
    return operation;
  };
  const closeBrokenRemoteSocket = (ws: WebSocket, state: RemoteWsState): void => {
    if (remoteStates.get(ws) !== state) return;
    try { ws.terminate(); } catch { /* ignore a closing socket */ }
  };
  const sendRawReplay = (
    ws: WebSocket,
    state: RemoteWsState,
    session: ReturnType<PtyManager['getSession']>,
    preserveViewport = false,
  ) => {
    if (!session || ws.readyState !== WebSocket.OPEN || remoteStates.get(ws) !== state) return;
    const sequence = Math.max(0, session.lastSequence ?? state.sequence);
    state.ready = false;
    state.sequence = sequence;
    state.pending = [];
    void enqueueWsSend(ws, state, JSON.stringify({
      type: 'replay',
      data: session.rawBuffer || '',
      cols: session.currentCols,
      rows: session.currentRows,
      // rawBuffer already contains all output parsed before this replay was
      // requested. Advance the per-connection cursor with that same history;
      // otherwise the first live flush sends the replayed bytes a second time.
      sequence,
      preserveViewport,
    })).then(() => {
      if (remoteStates.get(ws) === state) {
        state.ready = true;
        // Output can arrive while the replay is in flight. Flush the queued
        // tail now that this connection has a stable replay cursor.
        flushClientPending(ws, state);
      }
    }).catch(() => closeBrokenRemoteSocket(ws, state));
  };
  const sendSnapshot = (ws: WebSocket, id: string, preserveViewport = false) => {
    const state = remoteStates.get(ws);
    if (!state || state.id !== id) return;
    const session = ptyManager.getSession(id);
    if (!session || session.closing) {
      if (ws.readyState === WebSocket.OPEN) {
        state.ready = false;
        state.sequence = 0;
        state.pending = [];
        void enqueueWsSend(ws, state, JSON.stringify({ type: 'replay', data: '', cols: 80, rows: 24, sequence: 0, preserveViewport })).then(() => {
          if (remoteStates.get(ws) === state) {
            state.ready = true;
            flushClientPending(ws, state);
          }
        }).catch(() => closeBrokenRemoteSocket(ws, state));
      }
      return;
    }
    // Freeze live delivery while the ordered TerminalState snapshot is being
    // captured. Everything produced after the snapshot boundary is retained
    // in this connection's pending tail until the snapshot is sent.
    state.ready = false;
    state.pending = [];
    const revision = ++state.revision;
    void ptyManager.snapshot(id, snapshot => {
      if (remoteStates.get(ws) !== state || state.revision !== revision || ws.readyState !== WebSocket.OPEN) return;
      state.sequence = snapshot.sequence;
      void enqueueWsSend(ws, state, JSON.stringify({ type: 'replay', ...snapshot, preserveViewport })).then(() => {
        if (remoteStates.get(ws) === state) {
          state.ready = true;
          flushClientPending(ws, state);
        }
      }).catch(() => closeBrokenRemoteSocket(ws, state));
    }).catch(() => sendRawReplay(ws, state, session, preserveViewport));
  };
  (startRemoteServer as any)._pushResize = (id: string) => {
    for (const client of wsClients.get(id) || []) sendSnapshot(client, id, true);
  };
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
    // 订阅后的首次 resize 视为手机端显式接管尺寸，之后的 resize 走归属仲裁
    let pendingSizeClaim = false;

    ws.on('message', (msg) => {
      try {
        const data = JSON.parse(msg.toString());

        if (data.type === 'subscribe' && data.sessionId) {
          if (subscribedSession) wsClients.get(subscribedSession)?.delete(ws);
          subscribedSession = data.sessionId;
          pendingSizeClaim = true;
          const state: RemoteWsState = {
            id: data.sessionId,
            ready: false,
            sequence: 0,
            revision: 0,
            sendQueue: Promise.resolve(),
            pending: [],
          };
          remoteStates.set(ws, state);
          if (!wsClients.has(data.sessionId)) wsClients.set(data.sessionId, new Set());
          wsClients.get(data.sessionId)!.add(ws);

          // 订阅先同步回放 rawBuffer，保证手机端立刻收到 replay 并停止重连。
          const session = ptyManager.getSession(data.sessionId);
          if (session && !session.closing) {
            sendRawReplay(ws, state, session);
          } else if (ws.readyState === WebSocket.OPEN) {
            void enqueueWsSend(ws, state, JSON.stringify({ type: 'replay', data: '', cols: 80, rows: 24, sequence: 0 })).then(() => {
              if (remoteStates.get(ws) === state) {
                state.ready = true;
                flushClientPending(ws, state);
              }
            }).catch(() => closeBrokenRemoteSocket(ws, state));
          }
        }

        if (data.type === 'submit' && subscribedSession && typeof data.id === 'string' && data.id.length <= 128
            && typeof data.text === 'string' && data.text.length > 0 && data.text.length <= 100000) {
          const sessionId = subscribedSession;
          void ptyManager.submit(sessionId, data.id, data.text).then(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'submitted', id: data.id }));
          }).catch((e: Error) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'submitted', id: data.id, error: e.message }));
          });
        }

        if (data.type === 'input' && subscribedSession) {
          ptyManager.write(subscribedSession, data.data, 'mobile');
        }

        // base64 编码的 input，解码后写入 pty（避免控制字符在 JSON 传输中丢失）
        if (data.type === 'input_b64' && subscribedSession && typeof data.data === 'string') {
          const decoded = Buffer.from(data.data, 'base64').toString('utf-8');
          ptyManager.write(subscribedSession, decoded, 'mobile');
        }

        // 手机端 resize — 同步调整 pty 尺寸，让输出按手机列数排版。
        // 首次（订阅后）force 接管；其余走仲裁，避免和桌面端抢尺寸导致
        // TUI 反复重绘、滚动区堆残帧。
        if (data.type === 'resize' && subscribedSession && data.cols && data.rows) {
          const initialClaim = pendingSizeClaim;
          ptyManager.resize(subscribedSession, data.cols, data.rows, 'mobile', pendingSizeClaim);
          pendingSizeClaim = false;
          // 订阅后的首次 resize 紧跟 raw replay，跳过 snapshot，避免首屏连续多帧。
          if (!initialClaim) sendSnapshot(ws, subscribedSession, true);
        }

        // 心跳 ping，忽略即可
        if (data.type === 'ping') {
          const state = remoteStates.get(ws);
          if (state) void enqueueWsSend(ws, state, JSON.stringify({ type: 'pong', ts: Date.now() }));
          else ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        }
      } catch {}
    });

    ws.on('close', () => {
      remoteStates.delete(ws);
      if (subscribedSession) wsClients.get(subscribedSession)?.delete(ws);
    });
  });

  // ========== Android persistent mirror WebSocket ==========
  // The terminal socket above carries JSON/ANSI traffic. Android mirroring has
  // its own socket because video frames are binary H.264 packets and must never
  // be queued behind terminal replay/output.
  const androidMirrorManager = new AndroidMirrorManager();
  const androidScreenshotManager = new AndroidScreenshotManager();
  const androidJpegManager = new AndroidJpegManager(androidScreenshotManager);
  type AndroidV2Subscription = { sessionId: string; clientId: string; subscriptionId: string; deviceId: string; expiresAt: number };
  type AndroidV2Ticket = { sessionId: string; clientId: string; subscriptionId: string; purpose: 'control' | 'video'; expiresAt: number };
  const androidV2Subscriptions = new Map<string, AndroidV2Subscription>();
  const androidV2Tickets = new Map<string, AndroidV2Ticket>();
  const MAX_ANDROID_CONTROL_JSON_BYTES = 64 * 1024;
  const androidVideoConnections = new Map<string, WebSocket>();
  const androidControlConnections = new Map<string, WebSocket>();
  const androidJpegConnections = new Map<string, WebSocket>();
  // A V2 ticket identifies one logical browser client, while video and
  // control may use two physical sockets. Keep one manager registration per
  // clientId and fan its events out to both channel adapters; otherwise the
  // second socket would replace the first entry in AndroidMirrorSession and
  // silently stop video delivery (or control delivery) on the other socket.
  type AndroidV2ClientRecord = {
    clientId: string;
    deviceId: string | null;
    managerClient: AndroidMirrorClient;
    sinks: Set<AndroidMirrorClient>;
  };
  const androidV2ClientRecords = new Map<string, AndroidV2ClientRecord>();
  const getAndroidV2ClientRecord = (clientId: string): AndroidV2ClientRecord => {
    const existing = androidV2ClientRecords.get(clientId);
    if (existing) return existing;
    const record = {} as AndroidV2ClientRecord;
    const managerClient: AndroidMirrorClient = {
      id: clientId,
      sendJson: (message) => {
        for (const sink of record.sinks) {
          try { sink.sendJson(message); } catch { /* a closing channel is removed on close */ }
        }
      },
      sendBinary: (data) => {
        for (const sink of record.sinks) {
          try { sink.sendBinary(data); } catch { /* a closing channel is removed on close */ }
        }
      },
      close: () => {
        for (const sink of record.sinks) {
          try { sink.close?.(); } catch { /* ignore a closing channel */ }
        }
      },
    };
    record.clientId = clientId;
    record.deviceId = null;
    record.managerClient = managerClient;
    record.sinks = new Set();
    androidV2ClientRecords.set(clientId, record);
    return record;
  };
  const closeAndroidV2Connections = (clientId: string, code = 4001, reason = '会话已过期') => {
    for (const connections of [androidVideoConnections, androidControlConnections, androidJpegConnections]) {
      const connection = connections.get(clientId);
      if (!connection) continue;
      try { connection.close(code, reason); } catch { /* ignore a closing socket */ }
    }
  };
  const cleanupAndroidSessions = () => {
    const now = Date.now();
    for (const [subscriptionId, value] of androidV2Subscriptions) {
      if (value.expiresAt > now) continue;
      androidV2Subscriptions.delete(subscriptionId);
      androidMirrorManager.unsubscribe(value.deviceId, value.clientId);
      androidJpegManager.unsubscribe(value.deviceId, value.clientId);
      closeAndroidV2Connections(value.clientId);
    }
    for (const [ticket, value] of androidV2Tickets) {
      if (value.expiresAt <= now || !androidV2Subscriptions.has(value.subscriptionId)) androidV2Tickets.delete(ticket);
    }
  };
  const androidSessionCleanupTimer = setInterval(cleanupAndroidSessions, 30_000);
  androidSessionCleanupTimer.unref?.();
  const androidScreenshotVersions = new Map<string, { width: number; height: number; captureGeneration: number; geometryVersion: number }>();
  const screenshotVersionFor = (deviceId: string, width: number, height: number) => {
    const previous = androidScreenshotVersions.get(deviceId);
    if (!previous || previous.width !== width || previous.height !== height) {
      const next = {
        width,
        height,
        captureGeneration: (previous?.captureGeneration || 0) + 1,
        geometryVersion: (previous?.geometryVersion || 0) + 1,
      };
      androidScreenshotVersions.set(deviceId, next);
      return next;
    }
    return previous;
  };
  const androidWss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
  });
  type AndroidAliveWebSocket = WebSocket & { isAlive?: boolean };
  const androidHeartbeatTimer = setInterval(() => {
    androidWss.clients.forEach((client) => {
      const androidClient = client as AndroidAliveWebSocket;
      if (androidClient.isAlive === false) {
        androidClient.terminate();
        return;
      }
      androidClient.isAlive = false;
      try { androidClient.ping(); } catch { /* ignore */ }
    });
  }, 20000);
  server.on('close', () => {
    clearInterval(androidHeartbeatTimer);
    clearInterval(androidSessionCleanupTimer);
    androidScreenshotManager.clear();
    androidJpegManager.clear();
    androidV2Subscriptions.clear();
    androidV2Tickets.clear();
    androidVideoConnections.clear();
    androidControlConnections.clear();
    androidJpegConnections.clear();
    androidV2ClientRecords.clear();
    androidScreenshotVersions.clear();
    void androidMirrorManager.stopAll();
  });

  androidWss.on('connection', (ws, req) => {
    const aliveWs = ws as AndroidAliveWebSocket;
    aliveWs.isAlive = true;
    ws.on('pong', () => { aliveWs.isAlive = true; });

    const url = new URL(req.url || '', 'http://localhost');
    if (url.searchParams.get('token') !== config.token) {
      ws.close(4001, '未授权');
      return;
    }

    const clientId = crypto.randomUUID();
    let subscribedDevice: string | null = null;
    let waitingForKeyFrame = false;
    const client: AndroidMirrorClient = {
      id: clientId,
      sendJson: (message) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
      },
      sendBinary: (data) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        // Drop only video for a lagging client. The next key frame can recover it
        // without blocking control messages or other subscribers.
        if (ws.bufferedAmount > 1.5 * 1024 * 1024) {
          waitingForKeyFrame = true;
          return;
        }
        if (data.length < 24 || data[0] !== 0x44 || data[1] !== 0x56 || data[2] !== 0x4d || data[3] !== 0x31
          || data[4] !== 1 || (data[5] & ~3) !== 0 || data.readUInt16BE(22) !== 0) return;
        const payloadLength = data.readUInt32BE(18);
        if (!payloadLength || payloadLength > DVM2_MAX_H264_BYTES || data.length !== 24 + payloadLength) return;
        const keyFrame = !!(data[5] & 1);
        if (waitingForKeyFrame && !keyFrame) return;
        if (keyFrame) waitingForKeyFrame = false;
        ws.send(data, { binary: true });
      },
      close: () => {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(1011, 'Android mirror restarting');
        }
      },
    };

    ws.on('message', (message) => {
      let data: any;
      const raw = message.toString();
      if (Buffer.byteLength(raw, 'utf8') > MAX_ANDROID_CONTROL_JSON_BYTES) {
        client.sendJson({ type: 'android:status', status: 'error', code: 'PROTOCOL_UNSUPPORTED', error: 'Android 控制消息过大' });
        try { ws.close(1009, '消息过大'); } catch { /* ignore */ }
        return;
      }
      try { data = JSON.parse(raw); } catch { return; }
      if (!data || typeof data.type !== 'string') return;

      if (data.type === 'android:subscribe') {
        const deviceId = typeof data.deviceId === 'string' ? data.deviceId.trim() : '';
        if (!deviceId || deviceId.length > 256) {
          client.sendJson({ type: 'android:status', status: 'error', error: '设备编号无效' });
          return;
        }
        if (subscribedDevice) androidMirrorManager.unsubscribe(subscribedDevice, clientId);
        subscribedDevice = deviceId;
        const controller = androidMirrorManager.subscribe(deviceId, client);
        client.sendJson({ type: 'android:control-owner', deviceId, controller, controlEpoch: androidMirrorManager.controlEpoch(deviceId), owner: androidMirrorManager.controlOwner(deviceId) });
        return;
      }

      if (data.type === 'android:claim' && subscribedDevice) {
        const controller = androidMirrorManager.claim(subscribedDevice, clientId);
        client.sendJson({ type: 'android:control-owner', deviceId: subscribedDevice, controller, controlEpoch: androidMirrorManager.controlEpoch(subscribedDevice), owner: androidMirrorManager.controlOwner(subscribedDevice) });
        return;
      }

      if (data.type === 'android:input' && subscribedDevice) {
        const sequence = Number.isSafeInteger(data.sequence) ? data.sequence : null;
        const input = data.input as AndroidMirrorInput;
        if (!validateAndroidMirrorInput(input)) {
          client.sendJson({ type: 'android:ack', deviceId: subscribedDevice, sequence, ok: false, controlEpoch: androidMirrorManager.controlEpoch(subscribedDevice), code: 'INVALID_INPUT', error: '控制参数无效' });
          return;
        }
        const device = subscribedDevice;
        void androidMirrorManager.sendInput(device, clientId, input, sequence === null ? undefined : sequence).then(() => {
          client.sendJson({ type: 'android:ack', deviceId: device, sequence, ok: true, controlEpoch: androidMirrorManager.controlEpoch(device) });
        }).catch((error: Error) => {
          client.sendJson({ type: 'android:ack', deviceId: device, sequence, ok: false, controlEpoch: androidMirrorManager.controlEpoch(device), code: (error as Error & { code?: string }).code, error: error.message });
        });
        return;
      }

      if (data.type === 'android:renew' && subscribedDevice) {
        const renewed = androidMirrorManager.renew(subscribedDevice, clientId);
        client.sendJson({ type: 'android:control-owner', deviceId: subscribedDevice, controller: renewed, renewed, controlEpoch: androidMirrorManager.controlEpoch(subscribedDevice), owner: androidMirrorManager.controlOwner(subscribedDevice) });
        return;
      }

      if (data.type === 'android:release' && subscribedDevice) {
        const released = androidMirrorManager.release(subscribedDevice, clientId);
        client.sendJson({ type: 'android:control-owner', deviceId: subscribedDevice, controller: false, released, controlEpoch: androidMirrorManager.controlEpoch(subscribedDevice), owner: androidMirrorManager.controlOwner(subscribedDevice) });
        return;
      }

      if (data.type === 'android:ping') {
        client.sendJson({ type: 'android:pong', ts: Date.now() });
      }
    });

    ws.on('close', () => {
      if (subscribedDevice) androidMirrorManager.unsubscribe(subscribedDevice, clientId);
    });
  });

  // DVM2 H.264 adapter. The capture/session manager still owns one scrcpy
  // source; this adapter only upgrades the per-subscriber envelope and keeps
  // the legacy /android-ws contract untouched.
  const androidVideoWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  androidVideoWss.on('connection', (ws, req) => {
    const url = new URL(req.url || '', 'http://localhost');
    const controlOnly = url.pathname === '/android-control-ws';
    const requiredTicketPurpose: 'control' | 'video' = controlOnly ? 'control' : 'video';
    const queryToken = url.searchParams.get('token');
    const ticket = url.searchParams.get('ticket');
    const ticketRecord = ticket ? androidV2Tickets.get(ticket) : undefined;
    if (queryToken !== config.token && (!ticketRecord || ticketRecord.expiresAt <= Date.now() || ticketRecord.purpose !== requiredTicketPurpose)) {
      ws.close(4001, '未授权');
      return;
    }
    if (ticket) androidV2Tickets.delete(ticket);
    const clientId = ticketRecord?.clientId || crypto.randomUUID();
    const sessionRecord = ticketRecord ? androidV2Subscriptions.get(ticketRecord.subscriptionId) : undefined;
    if (ticketRecord && (!sessionRecord || sessionRecord.sessionId !== ticketRecord.sessionId || sessionRecord.expiresAt <= Date.now())) {
      ws.close(4001, '会话已过期');
      return;
    }
    const connectionMap = controlOnly ? androidControlConnections : androidVideoConnections;
    const previousConnection = connectionMap.get(clientId);
    if (previousConnection && previousConnection !== ws) {
      try { previousConnection.close(4000, 'replaced'); } catch { /* ignore */ }
    }
    connectionMap.set(clientId, ws);
    const logicalClient = getAndroidV2ClientRecord(clientId);
    let subscribedDevice: string | null = null;
    let captureGeneration = 1;
    let geometryVersion = 1;
    let configVersion = 1;
    let frameId = 0;
    let mediaEpoch = 1;
    let lastResyncAt = 0;
    let lastFeedbackAt = 0;
    let lastPresentedFrameId = 0;
    let waitingForKeyFrame = false;
    let width = 0;
    let height = 0;
    const client: AndroidMirrorClient = {
      id: clientId,
      sendJson: (message) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const sessionFields = sessionRecord
          ? { sessionId: sessionRecord.sessionId, subscriptionId: sessionRecord.subscriptionId }
          : {};
        if (message.type === 'android:meta') {
          width = Number(message.width) || width;
          height = Number(message.height) || height;
          const nextCapture = Number(message.captureGeneration);
          const nextGeometry = Number(message.geometryVersion);
          const nextConfig = Number(message.configVersion);
          if (Number.isInteger(nextCapture) && nextCapture > 0) captureGeneration = nextCapture >>> 0;
          if (Number.isInteger(nextGeometry) && nextGeometry > 0) geometryVersion = nextGeometry >>> 0;
          if (Number.isInteger(nextConfig) && nextConfig > 0) configVersion = nextConfig >>> 0;
          ws.send(JSON.stringify({
            v: 2, type: 'video.meta', ...sessionFields, deviceId: message.deviceId, captureGeneration,
            geometryVersion, configVersion, mediaEpoch, codec: message.codec || 'h264', width, height,
          }));
          return;
        }
        if (message.type === 'android:status') {
          ws.send(JSON.stringify({ v: 2, type: 'session.state', ...sessionFields, deviceId: message.deviceId, capture: message.status, control: 'ready', controlEpoch: message.controlEpoch, mediaEpoch, playbackTransport: controlOnly ? 'wss' : 'webcodecs-ws', error: message.error }));
          return;
        }
        if (message.type === 'android:control-owner') {
          ws.send(JSON.stringify({ v: 2, type: 'control.owner', ...sessionFields, deviceId: message.deviceId, ownerClientId: message.owner || null, controlEpoch: message.controlEpoch, isController: message.owner === clientId }));
          return;
        }
        if (message.type === 'android:ack') {
          ws.send(JSON.stringify({ v: 2, type: 'control.ack', ...sessionFields, deviceId: message.deviceId, controlEpoch: message.controlEpoch, seq: message.sequence, status: message.ok ? 'ok' : 'error', stage: message.ok ? 'written-to-device' : 'control', code: message.code, error: message.error }));
          return;
        }
        ws.send(JSON.stringify({ ...sessionFields, ...message }));
      },
      sendBinary: (data) => {
        if (controlOnly) return;
        if (ws.readyState !== WebSocket.OPEN || data.length < 24) return;
        if (ws.bufferedAmount > 1.5 * 1024 * 1024) {
          waitingForKeyFrame = true;
          return;
        }
        if (data.subarray(0, 4).toString('ascii') !== 'DVM1' || data[4] !== 1 || (data[5] & ~3) !== 0
          || data.readUInt16BE(22) !== 0) return;
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const flags = data[5];
        const keyFrame = !!(flags & 1);
        if (waitingForKeyFrame && !keyFrame) return;
        const payloadLength = view.getUint32(18);
        if (!payloadLength || payloadLength > DVM2_MAX_H264_BYTES || data.length !== 24 + payloadLength) return;
        const nextWidth = view.getUint16(6);
        const nextHeight = view.getUint16(8);
        if (nextWidth !== width || nextHeight !== height) {
          width = nextWidth; height = nextHeight;
          geometryVersion = (geometryVersion + 1) >>> 0 || 1;
        }
        frameId = (frameId + 1) >>> 0 || 1;
        const packet = encodeDvm2Frame({
          kind: DVM2_KIND_H264,
          flags: (keyFrame ? 1 : 0) | ((frameId === 1 || waitingForKeyFrame) ? DVM2_FLAG_DISCONTINUITY : 0),
          captureGeneration,
          geometryVersion,
          configVersion,
          frameId,
          ptsUs: data.readBigUInt64BE(10),
          hostFrameReceivedUs: process.hrtime.bigint() / 1000n,
          width,
          height,
          mediaEpoch,
          payload: data.subarray(24),
        });
        if (keyFrame) waitingForKeyFrame = false;
        ws.send(packet, { binary: true });
      },
      close: () => { try { ws.close(1011, 'Android 视频重启'); } catch { /* ignore */ } },
    };
    logicalClient.sinks.add(client);
    ws.on('message', (message) => {
      let data: any;
      const raw = message.toString();
      if (Buffer.byteLength(raw, 'utf8') > MAX_ANDROID_CONTROL_JSON_BYTES) {
        client.sendJson({ type: 'android:status', status: 'error', code: 'PROTOCOL_UNSUPPORTED', error: 'Android 控制消息过大' });
        try { ws.close(1009, '消息过大'); } catch { /* ignore */ }
        return;
      }
      try { data = JSON.parse(raw); } catch { return; }
      const type = data?.type;
      if (sessionRecord && ((data.sessionId !== undefined && data.sessionId !== sessionRecord.sessionId)
        || (data.subscriptionId !== undefined && data.subscriptionId !== sessionRecord.subscriptionId))) {
        client.sendJson({ type: 'android:status', status: 'error', code: 'AUTH_EXPIRED', error: 'Android 会话绑定无效' });
        return;
      }
      if ((type === 'video.subscribe' || type === 'control.subscribe' || type === 'android:subscribe') && typeof data.deviceId === 'string') {
        const deviceId = data.deviceId.trim();
        if (!deviceId || deviceId.length > 256) return;
        if (sessionRecord && deviceId !== sessionRecord.deviceId) {
          client.sendJson({ type: 'android:status', deviceId, status: 'error', code: 'AUTH_EXPIRED', error: '设备与 Android 会话不匹配' });
          return;
        }
        if (logicalClient.deviceId && logicalClient.deviceId !== deviceId) {
          androidMirrorManager.unsubscribe(logicalClient.deviceId, clientId);
        }
        logicalClient.deviceId = deviceId;
        subscribedDevice = deviceId;
        mediaEpoch = (mediaEpoch + 1) >>> 0 || 1;
        frameId = 0;
        try {
          const controller = androidMirrorManager.subscribe(deviceId, logicalClient.managerClient);
          client.sendJson({ v: 2, type: 'control.granted', deviceId, controlEpoch: androidMirrorManager.controlEpoch(deviceId), ownerClientId: androidMirrorManager.controlOwner(deviceId), isController: controller, transport: controlOnly ? 'wss' : 'webcodecs-ws' });
        } catch (error) {
          client.sendJson({ v: 2, type: 'session.state', capture: 'error', playbackTransport: 'webcodecs-ws', error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      if ((type === 'control.claim' || type === 'android:claim') && subscribedDevice) {
        const controller = androidMirrorManager.claim(subscribedDevice, clientId, type === 'android:claim' || data.takeover === true);
        client.sendJson({ v: 2, type: 'control.granted', deviceId: subscribedDevice, controlEpoch: androidMirrorManager.controlEpoch(subscribedDevice), ownerClientId: androidMirrorManager.controlOwner(subscribedDevice), isController: controller, transport: controlOnly ? 'wss' : 'webcodecs-ws' });
        return;
      }
      if ((type === 'control.renew' || type === 'android:renew') && subscribedDevice) {
        const renewed = androidMirrorManager.renew(subscribedDevice, clientId);
        client.sendJson({ v: 2, type: 'control.granted', deviceId: subscribedDevice, controlEpoch: androidMirrorManager.controlEpoch(subscribedDevice), ownerClientId: androidMirrorManager.controlOwner(subscribedDevice), isController: renewed, renewed, transport: controlOnly ? 'wss' : 'webcodecs-ws' });
        return;
      }
      if ((type === 'control.release' || type === 'android:release') && subscribedDevice) {
        const released = androidMirrorManager.release(subscribedDevice, clientId);
        client.sendJson({ v: 2, type: 'control.owner', deviceId: subscribedDevice, controlEpoch: androidMirrorManager.controlEpoch(subscribedDevice), ownerClientId: androidMirrorManager.controlOwner(subscribedDevice), isController: false, released });
        return;
      }
      if (type === 'video.resync' && subscribedDevice && !controlOnly) {
        const now = Date.now();
        if (now - lastResyncAt < 1000) return;
        lastResyncAt = now;
        waitingForKeyFrame = true;
        mediaEpoch = (mediaEpoch + 1) >>> 0 || 1;
        frameId = 0;
        client.sendJson({ type: 'android:meta', deviceId: subscribedDevice, codec: 'h264', width, height, captureGeneration, geometryVersion, configVersion });
        return;
      }
      if (type === 'video.feedback' && subscribedDevice && !controlOnly) {
        const received = Number(data.receivedFrameId);
        const presented = Number(data.presentedFrameId);
        if (Number.isSafeInteger(received) && Number.isSafeInteger(presented)
          && received >= 0 && presented >= 0 && received <= 0xffffffff && presented <= 0xffffffff) {
          lastFeedbackAt = Date.now();
          lastPresentedFrameId = presented;
        }
        return;
      }
      if (type === 'ping') {
        client.sendJson({ v: 2, type: 'pong', pingId: data.pingId, clientSentMs: data.clientSentMs, serverMs: Date.now() });
        return;
      }
      if ((type === 'control.input' || type === 'android:input') && subscribedDevice) {
        const input = (type === 'control.input' ? data.input : data.input) as AndroidMirrorInput;
        const seq = Number.isSafeInteger(data.seq) ? data.seq : (Number.isSafeInteger(data.sequence) ? data.sequence : null);
        const expectedEpoch = type === 'control.input' && Number.isSafeInteger(data.controlEpoch) ? data.controlEpoch : undefined;
        const expectedGeometryVersion = type === 'control.input' && Number.isSafeInteger(data.geometryVersion) ? data.geometryVersion : undefined;
        if (type === 'control.input' && (!Number.isSafeInteger(seq) || (seq as number) <= 0)) {
          client.sendJson({ type: 'android:ack', deviceId: subscribedDevice, sequence: seq, ok: false, code: 'INVALID_INPUT', error: '控制序号无效' });
          return;
        }
        if (type === 'control.input' && (!Number.isSafeInteger(expectedEpoch) || (expectedEpoch as number) <= 0)) {
          client.sendJson({ type: 'android:ack', deviceId: subscribedDevice, sequence: seq, ok: false, code: 'CONTROL_EPOCH_STALE', error: '控制租约版本无效' });
          return;
        }
        if (type === 'control.input' && (!Number.isSafeInteger(expectedGeometryVersion) || (expectedGeometryVersion as number) <= 0)) {
          client.sendJson({ type: 'android:ack', deviceId: subscribedDevice, sequence: seq, ok: false, code: 'GEOMETRY_STALE', error: '画面几何版本无效' });
          return;
        }
        if (!validateAndroidMirrorInput(input)) {
          client.sendJson({ type: 'android:ack', deviceId: subscribedDevice, sequence: seq, ok: false, code: 'INVALID_INPUT', error: '控制参数无效' });
          return;
        }
        const device = subscribedDevice;
        void androidMirrorManager.sendInput(device, clientId, input, seq === null ? undefined : seq, expectedEpoch, expectedGeometryVersion).then(() => {
          client.sendJson({ type: 'android:ack', deviceId: device, sequence: seq, controlEpoch: androidMirrorManager.controlEpoch(device), ok: true });
        }).catch((error: Error) => {
          client.sendJson({ type: 'android:ack', deviceId: device, sequence: seq, controlEpoch: androidMirrorManager.controlEpoch(device), ok: false, code: (error as Error & { code?: string }).code, error: error.message });
        });
      }
    });
    ws.on('close', () => {
      logicalClient.sinks.delete(client);
      if (connectionMap.get(clientId) === ws) {
        connectionMap.delete(clientId);
      }
      if (logicalClient.sinks.size === 0) {
        if (logicalClient.deviceId) androidMirrorManager.unsubscribe(logicalClient.deviceId, clientId);
        if (androidV2ClientRecords.get(clientId) === logicalClient) {
          androidV2ClientRecords.delete(clientId);
        }
      }
    });
  });

  // ========== Android continuous JPEG fallback WebSocket ==========
  // This path is intentionally independent from H.264/WebCodecs. It shares
  // one bounded ADB screenshot task per device and is useful on Safari builds
  // where WebCodecs is unavailable or a media decoder cannot recover.
  const androidJpegWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  androidJpegWss.on('connection', (ws, req) => {
    const url = new URL(req.url || '', 'http://localhost');
    const queryToken = url.searchParams.get('token');
    const ticket = url.searchParams.get('ticket');
    const ticketRecord = ticket ? androidV2Tickets.get(ticket) : undefined;
    if (queryToken !== config.token && (!ticketRecord || ticketRecord.expiresAt <= Date.now() || ticketRecord.purpose !== 'video')) {
      ws.close(4001, '未授权');
      return;
    }
    if (ticket) androidV2Tickets.delete(ticket);
    const clientId = ticketRecord?.clientId || crypto.randomUUID();
    const sessionRecord = ticketRecord ? androidV2Subscriptions.get(ticketRecord.subscriptionId) : undefined;
    if (ticketRecord && (!sessionRecord || sessionRecord.sessionId !== ticketRecord.sessionId || sessionRecord.expiresAt <= Date.now())) {
      ws.close(4001, '会话已过期');
      return;
    }
    const previousConnection = androidJpegConnections.get(clientId);
    if (previousConnection && previousConnection !== ws) {
      try { previousConnection.close(4000, 'replaced'); } catch { /* ignore */ }
    }
    androidJpegConnections.set(clientId, ws);
    let subscribedDevice: string | null = null;
    const client: AndroidJpegClient = {
      id: clientId,
      sendJson: (message) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(sessionRecord
          ? { sessionId: sessionRecord.sessionId, subscriptionId: sessionRecord.subscriptionId, ...message }
          : message));
      },
      sendBinary: (data) => {
        if (ws.readyState !== WebSocket.OPEN || data.length > DVM2_MAX_JPEG_BYTES + 56) return;
        // A JPEG subscriber may fall behind independently. Skip the current
        // image and let the next capture replace it rather than queueing old
        // screenshots behind the tunnel.
        if (ws.bufferedAmount > 768 * 1024) return;
        ws.send(data, { binary: true });
      },
    };
    ws.on('message', (message) => {
      let data: any;
      const raw = message.toString();
      if (Buffer.byteLength(raw, 'utf8') > MAX_ANDROID_CONTROL_JSON_BYTES) {
        client.sendJson({ type: 'android:jpeg-status', status: 'error', code: 'PROTOCOL_UNSUPPORTED', error: 'Android 控制消息过大' });
        try { ws.close(1009, '消息过大'); } catch { /* ignore */ }
        return;
      }
      try { data = JSON.parse(raw); } catch { return; }
      if (!data || data.type !== 'android:jpeg-subscribe') return;
      if (sessionRecord && ((data.sessionId !== undefined && data.sessionId !== sessionRecord.sessionId)
        || (data.subscriptionId !== undefined && data.subscriptionId !== sessionRecord.subscriptionId))) {
        client.sendJson({ type: 'android:jpeg-status', status: 'error', code: 'AUTH_EXPIRED', error: 'Android 会话绑定无效' });
        return;
      }
      const deviceId = typeof data.deviceId === 'string' ? data.deviceId.trim() : '';
      if (!deviceId || deviceId.length > 256) {
        client.sendJson({ type: 'android:jpeg-status', status: 'error', error: '设备编号无效', code: 'DEVICE_OFFLINE' });
        return;
      }
      if (sessionRecord && deviceId !== sessionRecord.deviceId) {
        client.sendJson({ type: 'android:jpeg-status', status: 'error', code: 'AUTH_EXPIRED', error: '设备与 Android 会话不匹配' });
        return;
      }
      if (subscribedDevice) androidJpegManager.unsubscribe(subscribedDevice, clientId);
      subscribedDevice = deviceId;
      try {
        androidJpegManager.subscribe(deviceId, client, {
          fps: data.fps,
          quality: data.quality,
          scale: data.scale,
        });
      } catch (error) {
        client.sendJson({ type: 'android:jpeg-status', status: 'error', error: error instanceof Error ? error.message : String(error) });
      }
    });
    ws.on('close', () => {
      if (androidJpegConnections.get(clientId) !== ws) return;
      androidJpegConnections.delete(clientId);
      if (subscribedDevice) androidJpegManager.unsubscribe(subscribedDevice, clientId);
    });
  });

  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url || '', 'http://localhost').pathname;
    if (pathname === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
      return;
    }
    if (pathname === '/android-ws') {
      androidWss.handleUpgrade(request, socket, head, (ws) => {
        androidWss.emit('connection', ws, request);
      });
      return;
    }
    if (pathname === '/android-jpeg-ws') {
      androidJpegWss.handleUpgrade(request, socket, head, (ws) => {
        androidJpegWss.emit('connection', ws, request);
      });
      return;
    }
    if (pathname === '/android-video-ws' || pathname === '/android-control-ws') {
      androidVideoWss.handleUpgrade(request, socket, head, (ws) => {
        androidVideoWss.emit('connection', ws, request);
      });
      return;
    }
    socket.destroy();
  });

  // pty rawData → 推送给 WebSocket 客户端（由 index.ts 中 onRawData 回调触发）
  // 微批合并：8ms 内的多次 onData 拼成一帧再 send，减少 ws 帧数与 JSON 包头开销。
  // 8ms 在人眼几乎察觉不到，却能把 npm install / 编译刷屏从几百帧压到几十帧。
  const pendingChunks = new Map<string, { data: string; sequence: number }[]>();
  const pendingTimers = new Map<string, NodeJS.Timeout>();
  const FLUSH_DELAY_MS = 8;
  const FLUSH_MAX_BYTES = 32768; // 累积超过 32KB 立即冲刷，避免长期积压
  // 弱网背压：单连接 socket 缓冲区超过 1MB 视为积压，直接 terminate
  // 客户端重连时通过 replay 拿到 rawBuffer 最新 128KB，正好跳过所有堆积的旧帧。
  const WS_BACKPRESSURE_BYTES = 1024 * 1024;

  const sendChunksToClient = (ws: WebSocket, state: RemoteWsState, data: RemoteWsChunk[]): void => {
    if (ws.readyState !== WebSocket.OPEN || remoteStates.get(ws) !== state || !state.ready) return;
    const fresh = data.filter(chunk => chunk.sequence > state.sequence);
    if (!fresh.length) return;
    const sequence = fresh[fresh.length - 1].sequence;
    // Reserve the cursor before enqueueing. Otherwise a second flush can
    // observe the old cursor while the first ws.send callback is still pending
    // and send the same tail twice. If the socket fails, reconnect replay is
    // authoritative and will recover from rawBuffer.
    state.sequence = sequence;
    void enqueueWsSend(ws, state, JSON.stringify({
      type: 'output',
      data: fresh.map(chunk => chunk.data).join(''),
      sequence,
    })).catch(() => closeBrokenRemoteSocket(ws, state));
  };

  const flushClientPending = (ws: WebSocket, state: RemoteWsState): void => {
    if (!state.ready || !state.pending.length) return;
    const pending = state.pending;
    state.pending = [];
    sendChunksToClient(ws, state, pending);
  };

  const flushChunks = (id: string) => {
    const data = pendingChunks.get(id);
    pendingChunks.delete(id);
    const t = pendingTimers.get(id);
    if (t) { clearTimeout(t); pendingTimers.delete(id); }
    if (!data) return;
    const clients = wsClients.get(id);
    if (!clients || clients.size === 0) return;
    for (const ws of clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (ws.bufferedAmount > WS_BACKPRESSURE_BYTES) {
        // 弱网积压：放弃这条连接，触发客户端重连+replay
        ws.terminate();
        clients.delete(ws);
        continue;
      }
      const state = remoteStates.get(ws);
      if (!state) continue;
      if (!state.ready) {
        // Do not discard output while replay/snapshot is in flight. The
        // per-connection cursor is anchored to that replay's sequence, and
        // this tail is sent only after the replay callback completes.
        state.pending.push(...data);
        continue;
      }
      sendChunksToClient(ws, state, data);
    }
  };

  (startRemoteServer as any)._pushRawData = (id: string, data: string, sequence: number) => {
    const clients = wsClients.get(id);
    if (!clients || clients.size === 0) return;
    const merged = pendingChunks.get(id) || [];
    merged.push({ data, sequence });
    pendingChunks.set(id, merged);
    if (merged.reduce((size, chunk) => size + chunk.data.length, 0) >= FLUSH_MAX_BYTES) {
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

  // 本机可用的内置预制（按 CLI 是否安装过滤）
  app.get('/api/builtin-presets', (_req, res) => {
    res.json(getAvailableBuiltinPresets());
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

  // 列出会话当前项目目录的直接子项；路径始终限制在会话 cwd 内。
  app.get('/api/sessions/:id/file-tree', (req, res) => {
    const session = ptyManager.getSession(req.params.id);
    if (!session) { res.status(404).json({ error: '会话不存在' }); return; }
    const resolved = resolveDirectoryPath(session.cwd, String(req.query.path || ''));
    if (!resolved) { res.status(400).json({ error: '目录不在工作目录内或不是目录' }); return; }
    try {
      const items = fs.readdirSync(resolved.dirPath, { withFileTypes: true })
        .filter(entry => entry.name !== '.DS_Store')
        .map(entry => ({
          name: entry.name,
          path: path.join(resolved.dirPath, entry.name),
          isDir: entry.isDirectory(),
        }))
        .sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        });
      res.json({ root: resolved.cwdReal, path: resolved.dirPath, items });
    } catch (e: any) {
      res.status(500).json({ error: '读取目录失败: ' + (e.message || e) });
    }
  });

  // ========== 手机端媒体文件预览（图片/视频/音频/PDF，流式 + Range） ==========
  // 媒体扩展名 → { mime, kind }；kind 供前端分流渲染（image/video/audio/pdf）
  const MEDIA_EXT_MAP: Record<string, { mime: string; kind: string }> = {
    // 图片
    '.jpg': { mime: 'image/jpeg', kind: 'image' },
    '.jpeg': { mime: 'image/jpeg', kind: 'image' },
    '.png': { mime: 'image/png', kind: 'image' },
    '.gif': { mime: 'image/gif', kind: 'image' },
    '.webp': { mime: 'image/webp', kind: 'image' },
    '.bmp': { mime: 'image/bmp', kind: 'image' },
    '.svg': { mime: 'image/svg+xml', kind: 'image' },
    '.avif': { mime: 'image/avif', kind: 'image' },
    '.heic': { mime: 'image/heic', kind: 'image' },   // 原生不可显示，下面转 JPEG
    '.heif': { mime: 'image/heif', kind: 'image' },
    // 视频
    '.mp4': { mime: 'video/mp4', kind: 'video' },
    '.m4v': { mime: 'video/mp4', kind: 'video' },
    '.mov': { mime: 'video/quicktime', kind: 'video' },
    '.webm': { mime: 'video/webm', kind: 'video' },
    // 音频
    '.mp3': { mime: 'audio/mpeg', kind: 'audio' },
    '.m4a': { mime: 'audio/mp4', kind: 'audio' },
    '.aac': { mime: 'audio/aac', kind: 'audio' },
    '.wav': { mime: 'audio/wav', kind: 'audio' },
    '.ogg': { mime: 'audio/ogg', kind: 'audio' },
    '.flac': { mime: 'audio/flac', kind: 'audio' },
    // 文档
    '.pdf': { mime: 'application/pdf', kind: 'pdf' },
  };
  const MEDIA_EXTS = new Set(Object.keys(MEDIA_EXT_MAP));

  function getMediaMeta(filePath: string) {
    const ext = path.extname(filePath).toLowerCase();
    return MEDIA_EXT_MAP[ext] || null;
  }

  // 列出会话 cwd 内的媒体文件（非递归，避免扫到大目录树）
  app.get('/api/sessions/:id/media-list', (req, res) => {
    const session = ptyManager.getSession(req.params.id);
    if (!session) { res.status(404).json({ error: '会话不存在' }); return; }
    try {
      const cwdReal = fs.realpathSync(session.cwd);
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(cwdReal, { withFileTypes: true }); }
      catch (e: any) {
        res.status(500).json({ error: '读取目录失败: ' + (e.message || e) }); return;
      }
      const items: Array<{ name: string; path: string; kind: string; mime: string; size: number; mtime: number }> = [];
      for (const ent of entries) {
        if (!ent.isFile()) continue;
        const ext = path.extname(ent.name).toLowerCase();
        if (!MEDIA_EXTS.has(ext)) continue;
        const meta = MEDIA_EXT_MAP[ext];
        const full = path.join(cwdReal, ent.name);
        let stat: fs.Stats;
        try { stat = fs.statSync(full); } catch { continue; }
        items.push({
          name: ent.name,
          path: full,
          kind: meta.kind,
          mime: meta.mime,
          size: stat.size,
          mtime: stat.mtimeMs,
        });
      }
      items.sort((a, b) => b.mtime - a.mtime); // 新文件在前
      res.json({ items });
    } catch (e: any) {
      res.status(500).json({ error: '列出媒体失败: ' + (e.message || e) });
    }
  });

  // 媒体文件流式输出，支持 HTTP Range（视频拖动进度条）
  app.get('/api/sessions/:id/media', (req, res) => {
    const session = ptyManager.getSession(req.params.id);
    if (!session) { res.status(404).json({ error: '会话不存在' }); return; }
    const resolved = resolvePreviewPath(session.cwd, String(req.query.path || ''));
    if (!resolved) { res.status(400).json({ error: '路径不在工作目录内' }); return; }
    const meta = getMediaMeta(resolved.filePath);
    if (!meta) { res.status(400).json({ error: '不支持的媒体类型' }); return; }

    try {
      const stat = fs.statSync(resolved.filePath);
      if (!stat.isFile()) { res.status(400).json({ error: '目标不是文件' }); return; }

      // HEIC/HEIF 浏览器原生不可显示，转 JPEG 后整体返回（不支持分片）
      if (path.extname(resolved.filePath).toLowerCase() === '.heic' ||
          path.extname(resolved.filePath).toLowerCase() === '.heif') {
        sharp(resolved.filePath)
          .jpeg({ quality: 88 })
          .toBuffer()
          .then((buf) => {
            res.setHeader('Content-Type', 'image/jpeg');
            res.setHeader('Content-Length', String(buf.length));
            res.setHeader('Cache-Control', 'private, max-age=300');
            res.end(buf);
          })
          .catch((e: any) => {
            res.status(500).json({ error: 'HEIC 转码失败: ' + (e.message || e) });
          });
        return;
      }

      const total = stat.size;
      const range = req.headers.range;
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', meta.mime);
      res.setHeader('Cache-Control', 'private, max-age=300');

      if (!range) {
        // 整文件
        res.setHeader('Content-Length', String(total));
        fs.createReadStream(resolved.filePath).pipe(res);
        return;
      }

      // 解析 bytes=start-end
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (!m) { res.status(416).json({ error: 'Range 无效' }); return; }
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : total - 1;
      if (isNaN(start) || isNaN(end)) { res.status(416).json({ error: 'Range 无效' }); return; }
      if (start < 0 || start >= total) { res.status(416).json({ error: 'Range 越界' }); return; }
      if (end >= total) end = total - 1;
      if (end < start) { res.status(416).json({ error: 'Range 无效' }); return; }
      const chunkSize = end - start + 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', String(chunkSize));
      fs.createReadStream(resolved.filePath, { start, end }).pipe(res);
    } catch (e: any) {
      res.status(500).json({ error: '媒体读取失败: ' + (e.message || e) });
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
        cli: session.cliKind,
        resumeId: session.resumeId,
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
  app.post('/api/sessions/:id/input', async (req, res) => {
    const { input, submissionId } = req.body;
    if (typeof input !== 'string') { res.status(400).json({ error: '缺少 input' }); return; }
    if (submissionId !== undefined) {
      if (typeof submissionId !== 'string' || submissionId.length > 128 || !input || input.length > 100000) {
        res.status(400).json({ error: '无效的提交' }); return;
      }
      try {
        await ptyManager.submit(req.params.id, submissionId, input);
        res.json({ ok: true, id: submissionId });
      } catch (e: any) { res.status(409).json({ error: e.message }); }
      return;
    }
    const data = input.endsWith('\r') || input.endsWith('\n') ? input : input + '\r';
    ptyManager.write(req.params.id, data, 'mobile');
    res.json({ ok: true });
  });

  // 原始键码
  app.post('/api/sessions/:id/key', (req, res) => {
    const { key } = req.body;
    if (typeof key !== 'string') { res.status(400).json({ error: '缺少 key' }); return; }
    ptyManager.write(req.params.id, key, 'mobile');
    res.json({ ok: true });
  });

  // 文件上传 — 存到会话的 cwd
  app.post('/api/sessions/:id/upload', express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
    const session = ptyManager.getSession(req.params.id);
    if (!session) { res.status(404).json({ error: '会话不存在' }); return; }
    const rawHeader = req.headers['x-filename'];
    const rawName = typeof rawHeader === 'string' ? rawHeader : `upload_${Date.now()}`;
    const filename = decodeUploadFilename(rawName);
    if (!filename) { res.status(400).json({ error: '非法文件名或编码' }); return; }
    const decoded = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
    let cwdReal: string;
    try {
      cwdReal = fs.realpathSync(session.cwd);
    } catch {
      res.status(400).json({ error: '会话工作目录不存在' }); return;
    }
    const dest = path.resolve(cwdReal, filename);
    if (!dest.startsWith(cwdReal + path.sep) && dest !== cwdReal) {
      res.status(400).json({ error: '非法路径' }); return;
    }
    const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW || 0;
    let fd: number | null = null;
    try {
      try {
        if (fs.lstatSync(dest).isSymbolicLink()) {
          res.status(400).json({ error: '不允许覆盖符号链接' }); return;
        }
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
      }
      fd = fs.openSync(dest, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | noFollow, 0o600);
      fs.writeFileSync(fd, decoded);
      fs.closeSync(fd);
      fd = null;
      res.json({ ok: true, path: dest, size: decoded.length });
    } catch (e: any) {
      res.status(500).json({ error: '写入失败: ' + (e.message || e) });
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* ignore a failed upload close */ }
      }
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
  app.delete('/api/sessions/:id', async (req, res) => {
    const beforeClose = ptyManager.getSession(req.params.id);
    const capture = await ptyManager.close(req.params.id);
    const resumeId = capture?.sessionId || beforeClose?.resumeId || '';
    if (beforeClose && resumeId) {
      const resumeCommand = capture?.resumeCommand || beforeClose.resumeCommand || buildResumeCommand(beforeClose.presetCommand, resumeId);
      onSessionClosed?.({
        title: beforeClose.title,
        cwd: beforeClose.cwd,
        presetCommand: beforeClose.presetCommand,
        resumeId,
        resumeCommand,
        resumeSource: capture?.source || beforeClose.resumeSource || undefined,
      });
    }
    onRemoteDestroy?.(req.params.id);
    res.json({ ok: true, resumable: !!resumeId });
  });

  // ========== Android 设备 API ==========

  app.get('/api/android/capabilities', (_req, res) => {
    const helperPath = resolveAndroidMediaHelper();
    const ffmpegCandidates = [
      process.env.DUOCLI_FFMPEG,
      ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')),
      '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg',
    ].filter((value): value is string => Boolean(value));
    const ffmpeg = ffmpegCandidates.find(candidate => {
      try { return fs.existsSync(candidate) && fs.statSync(candidate).isFile(); } catch { return false; }
    }) || null;
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      serverBuildId: process.env.DUOCLI_BUILD_ID || 'dev',
      runtimeVersion: process.env.DUOCLI_SCRCPY_VERSION?.trim() || '4.1',
      protocolVersions: { legacy: ['dvm1'], current: ['dvm2'] },
      transports: {
        webcodecsWs: true,
        jpegWs: true,
        screenshotHttp: true,
        // The helper is a tested local RTP/signalling prototype; it is not
        // advertised as a browser transport until TURN and peer wiring pass
        // the real-device acceptance suite.
        webRtc: false,
      },
      helper: { available: Boolean(helperPath), enabled: false, kind: 'pion', path: helperPath, reason: helperPath ? '需要启用 WebRTC 专项验收' : '未安装 DuoCLI Android media helper' },
      jpeg: { available: true, source: 'adb-screenshot', ffmpeg: Boolean(ffmpeg), ffmpegPath: ffmpeg },
      turn: { configured: Boolean(process.env.DUOCLI_TURN_URL) },
    });
  });

  // V2 session bookkeeping. The actual capture remains owned by the shared
  // AndroidMirrorManager; these short-lived identifiers bind a browser's
  // control/video subscriptions without exposing the long-lived login token
  // to a media implementation.
  app.post('/api/android/sessions', (req, res) => {
    const now = Date.now();
    for (const [id, value] of androidV2Subscriptions) {
      if (value.expiresAt > now) continue;
      androidV2Subscriptions.delete(id);
      androidMirrorManager.unsubscribe(value.deviceId, value.clientId);
      androidJpegManager.unsubscribe(value.deviceId, value.clientId);
      for (const [ticket, ticketValue] of androidV2Tickets) if (ticketValue.subscriptionId === id) androidV2Tickets.delete(ticket);
    }
    if (androidV2Subscriptions.size >= 256) {
      res.status(429).json({ error: 'Android 会话过多，请稍后重试', code: 'CONTROL_OVERLOADED' });
      return;
    }
    const deviceId = typeof req.body?.deviceId === 'string' ? req.body.deviceId.trim() : '';
    if (!deviceId || deviceId.length > 256) {
      res.status(400).json({ error: '设备编号无效', code: 'DEVICE_OFFLINE' });
      return;
    }
    const sessionId = `android-${crypto.randomUUID()}`;
    const clientId = `client-${crypto.randomUUID()}`;
    const subscriptionId = `sub-${crypto.randomUUID()}`;
    const record = { sessionId, clientId, subscriptionId, deviceId, expiresAt: now + 30 * 60 * 1000 };
    androidV2Subscriptions.set(subscriptionId, record);
    const issue = (purpose: 'control' | 'video') => {
      const ticket = crypto.randomBytes(24).toString('base64url');
      androidV2Tickets.set(ticket, { sessionId, clientId, subscriptionId, purpose, expiresAt: now + 30_000 });
      return ticket;
    };
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({
      v: 2,
      sessionId,
      clientId,
      subscriptionId,
      deviceId,
      transports: { control: 'wss', video: 'webcodecs-ws', jpeg: 'jpeg-ws' },
      socketTickets: { control: issue('control'), video: issue('video') },
      expiresAt: record.expiresAt,
    });
  });

  app.post('/api/android/sessions/:id/socket-tickets', (req, res) => {
    const subscriptionId = typeof req.body?.subscriptionId === 'string' ? req.body.subscriptionId : '';
    const purpose = req.body?.purpose === 'video' || req.body?.purpose === 'control' ? req.body.purpose as 'video' | 'control' : null;
    if (!purpose) {
      res.status(400).json({ error: 'socket ticket 用途无效', code: 'PROTOCOL_UNSUPPORTED' });
      return;
    }
    const record = androidV2Subscriptions.get(subscriptionId);
    if (!record || record.sessionId !== req.params.id || record.expiresAt <= Date.now()) {
      res.status(404).json({ error: 'Android 会话不存在', code: 'AUTH_EXPIRED' });
      return;
    }
    const ticket = crypto.randomBytes(24).toString('base64url');
    androidV2Tickets.set(ticket, { sessionId: record.sessionId, clientId: record.clientId, subscriptionId, purpose, expiresAt: Date.now() + 30_000 });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ticket, purpose, expiresAt: Date.now() + 30_000 });
  });

  app.post('/api/android/sessions/:id/unsubscribe', (req, res) => {
    const subscriptionId = typeof req.body?.subscriptionId === 'string' ? req.body.subscriptionId : '';
    const record = androidV2Subscriptions.get(subscriptionId);
    if (!record || record.sessionId !== req.params.id) {
      res.status(404).json({ error: 'Android 订阅不存在' });
      return;
    }
    androidV2Subscriptions.delete(subscriptionId);
    for (const [ticket, value] of androidV2Tickets) if (value.subscriptionId === subscriptionId) androidV2Tickets.delete(ticket);
    androidMirrorManager.unsubscribe(record.deviceId, record.clientId);
    androidJpegManager.unsubscribe(record.deviceId, record.clientId);
    res.json({ ok: true });
  });

  app.get('/api/android/devices', async (_req, res) => {
    try {
      const out = await runAdb(['devices', '-l']);
      res.json({ devices: parseAndroidDevices(out.toString('utf8')) });
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
      const png = deviceId
        ? await androidScreenshotManager.capture(deviceId, () => runAdb(args, { timeout: 4000, maxBuffer: 8 * 1024 * 1024 }))
        : await runAdb(args, { timeout: 4000, maxBuffer: 8 * 1024 * 1024 });
      const meta = await sharp(png).metadata();
      let pipeline = sharp(png);
      if (scale < 1) {
        if (meta.width && meta.height) {
          pipeline = pipeline.resize(Math.round(meta.width * scale), Math.round(meta.height * scale));
        }
      }
      const jpeg = await pipeline.jpeg({ quality }).toBuffer();
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-DuoCLI-Host-Received-Us', String(process.hrtime.bigint() / 1000n));
      if (meta.width && meta.height) {
        const version = deviceId ? screenshotVersionFor(deviceId, meta.width, meta.height) : null;
        res.setHeader('X-DuoCLI-Device-Width', String(meta.width));
        res.setHeader('X-DuoCLI-Device-Height', String(meta.height));
        res.setHeader('X-DuoCLI-Capture-Generation', String(version?.captureGeneration || 0));
        res.setHeader('X-DuoCLI-Geometry-Version', String(version?.geometryVersion || 0));
      }
      res.send(jpeg);
    } catch (e: any) {
      res.status(500).json({ error: '截图失败: ' + (e.message || e) });
    }
  });

  app.get('/api/android/sessions/:id/screenshot', async (req, res) => {
    const subscriptionId = typeof req.query.subscriptionId === 'string' ? req.query.subscriptionId : '';
    const record = androidV2Subscriptions.get(subscriptionId);
    if (!record || record.sessionId !== req.params.id || record.expiresAt <= Date.now()) {
      res.status(404).json({ error: 'Android 订阅不存在', code: 'AUTH_EXPIRED' });
      return;
    }
    try {
      const quality = Math.min(100, Math.max(1, parseInt(req.query.quality as string) || 80));
      const scale = Math.min(1, Math.max(0.1, parseFloat(req.query.scale as string) || 1));
      const png = await androidScreenshotManager.capture(record.deviceId, () => runAdb([
        '-s', record.deviceId, 'exec-out', 'screencap', '-p',
      ], { timeout: 4000, maxBuffer: 8 * 1024 * 1024 }));
      const meta = await sharp(png).metadata();
      let pipeline = sharp(png);
      if (scale < 1 && meta.width && meta.height) pipeline = pipeline.resize(Math.round(meta.width * scale), Math.round(meta.height * scale));
      const jpeg = await pipeline.jpeg({ quality }).toBuffer();
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-DuoCLI-Session-Id', record.sessionId);
      res.setHeader('X-DuoCLI-Host-Received-Us', String(process.hrtime.bigint() / 1000n));
      if (meta.width && meta.height) {
        const version = screenshotVersionFor(record.deviceId, meta.width, meta.height);
        res.setHeader('X-DuoCLI-Device-Width', String(meta.width));
        res.setHeader('X-DuoCLI-Device-Height', String(meta.height));
        res.setHeader('X-DuoCLI-Capture-Generation', String(version.captureGeneration));
        res.setHeader('X-DuoCLI-Geometry-Version', String(version.geometryVersion));
      }
      res.send(jpeg);
    } catch (error) {
      res.status(500).json({ error: '截图失败: ' + (error instanceof Error ? error.message : String(error)) });
    }
  });

  // Legacy ADB control remains available for clients that cannot establish a
  // media socket, but it must not silently bypass an active mirror lease.
  const legacyControlAllowed = (req: express.Request, res: express.Response, deviceId: string): boolean => {
    const owner = androidMirrorManager.controlOwner(deviceId);
    if (!owner) return true;
    const requester = typeof req.body?.clientId === 'string' ? req.body.clientId : '';
    if (!requester || requester !== owner) {
      res.status(409).json({ error: '当前设备由其他客户端控制', code: 'CONTROL_NOT_OWNER' });
      return false;
    }
    const epoch = req.body?.controlEpoch;
    if (!Number.isSafeInteger(epoch) || epoch !== androidMirrorManager.controlEpoch(deviceId)) {
      res.status(409).json({ error: '控制租约已更新', code: 'CONTROL_EPOCH_STALE' });
      return false;
    }
    return true;
  };

  app.post('/api/android/tap', async (req, res) => {
    try {
      const deviceId = typeof req.body.deviceId === 'string' ? req.body.deviceId.trim() : '';
      const x = Math.round(Number(req.body.x));
      const y = Math.round(Number(req.body.y));
      if (!deviceId || isNaN(x) || isNaN(y)) { res.status(400).json({ error: '参数错误' }); return; }
      if (!legacyControlAllowed(req, res, deviceId)) return;
      await runAdb(['-s', deviceId, 'shell', 'input', 'tap', String(x), String(y)]);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: '点击失败: ' + (e.message || e) });
    }
  });

  app.post('/api/android/swipe', async (req, res) => {
    try {
      const deviceId = typeof req.body.deviceId === 'string' ? req.body.deviceId.trim() : '';
      const x1 = Math.round(Number(req.body.x1));
      const y1 = Math.round(Number(req.body.y1));
      const x2 = Math.round(Number(req.body.x2));
      const y2 = Math.round(Number(req.body.y2));
      const duration = Math.max(100, Math.min(3000, Math.round(Number(req.body.duration) || 300)));
      if (!deviceId || [x1, y1, x2, y2].some(isNaN)) { res.status(400).json({ error: '参数错误' }); return; }
      if (!legacyControlAllowed(req, res, deviceId)) return;
      await runAdb(['-s', deviceId, 'shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(duration)]);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: '滑动失败: ' + (e.message || e) });
    }
  });

  app.post('/api/android/input-text', async (req, res) => {
    try {
      const deviceId = typeof req.body.deviceId === 'string' ? req.body.deviceId.trim() : '';
      const text = typeof req.body.text === 'string' ? req.body.text : '';
      if (!deviceId || !text || Buffer.byteLength(text, 'utf8') > 16 * 1024) { res.status(400).json({ error: '参数错误' }); return; }
      if (!legacyControlAllowed(req, res, deviceId)) return;
      // ADBKeyboard is only a temporary transport. Preserve the user's actual
      // default IME and restore it in finally; never guess a vendor keyboard.
      const currentImeOutput = await runAdb(['-s', deviceId, 'shell', 'settings', 'get', 'secure', 'default_input_method']);
      const previousIme = currentImeOutput.toString('utf8').trim();
      if (!previousIme || previousIme === 'null' || previousIme === 'none') {
        throw new Error('无法读取手机当前默认输入法，已停止文字注入以避免修改系统设置');
      }
      let helperIme = 'com.android.adbkeyboard/.AdbIME';
      try {
        await runAdb(['-s', deviceId, 'shell', 'ime', 'set', helperIme]);
        await runAdb(['-s', deviceId, 'shell', 'am', 'broadcast', '-a', 'ADB_INPUT_TEXT', '--es', 'msg', text]);
      } finally {
        if (previousIme && previousIme !== helperIme) {
          await runAdb(['-s', deviceId, 'shell', 'ime', 'set', previousIme]).catch(() => {});
        }
      }
      res.json({ ok: true, restoredIme: previousIme || undefined });
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

  // 启动前只清理已确认属于 DuoCLI 的残留监听器；其它服务必须保持不动。
  const startupCleanupCount = PORT > 0 ? killPortOccupants(PORT) : 0;
  let retriedAfterPortCleanup = false;

  server.on('error', (err: any) => {
    console.error('[RemoteServer] Server error:', err.code, err.message);
    // 只有确实发现并停止了旧 DuoCLI，才允许重试；不碰无关服务。
    if (err.code === 'EADDRINUSE' && !retriedAfterPortCleanup
        && (startupCleanupCount > 0 || killPortOccupants(PORT) > 0)) {
      retriedAfterPortCleanup = true;
      console.log('[RemoteServer] Stale DuoCLI listener stopped, retrying remote server...');
      setTimeout(() => {
        server.listen(PORT, HOST, () => {
          const lanUrl = `http://${LOCAL_IP}:${PORT}`;
          console.log('[RemoteServer] Server started (retry), URL:', lanUrl);
          if (onServerStarted) {
            onServerStarted({ lanUrl, token: config.token, port: PORT });
          }
        });
      }, 500);
    } else if (err.code === 'EADDRINUSE') {
      console.error(`[RemoteServer] Refusing to kill the unrelated process occupying port ${PORT}; remote server was not started`);
    }
  });

  server.listen(PORT, HOST, () => {
    PORT = (server.address() as import('net').AddressInfo).port;
    const lanUrl = `http://${LOCAL_IP}:${PORT}`;
    console.log('[RemoteServer] Server started, URL:', lanUrl);
    // 通过回调返回连接信息，不再输出到终端
    if (onServerStarted) {
      onServerStarted({ lanUrl, token: config.token, port: PORT });
    }
  });
  return server;
}

/** 推送 pty 原始数据给远程 WebSocket 客户端 */
export function pushRawDataToRemote(id: string, data: string, sequence?: number, size?: { cols: number; rows: number }): void {
  if (size) (startRemoteServer as any)._pushResize?.(id);
  else (startRemoteServer as any)._pushRawData?.(id, data, sequence);
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
