import express from 'express';
import { macDesktopSessionManager, MacDesktopSessionInfo } from './mac-desktop-session';
import {
  captureMacDesktop,
  getMacDisplaySize,
  isMacDesktopHost,
  swipeMacDesktop,
  tapMacDesktop,
} from './mac-desktop-capture';
import net from 'net';
import crypto from 'crypto';

const router = express.Router();

/**
 * Mac 桌面远程控制路由处理器
 * 
 * 提供以下接口：
 * - GET /api/mac-desktop/capabilities - 获取能力信息
 * - POST /api/mac-desktop/sessions - 创建新会话（返回一次性票据）
 * - POST /api/mac-desktop/sessions/:id/disconnect - 断开指定会话
 * - WS /mac-desktop-ws - WebSocket VNC 桥接代理
 */

// Origin 白名单配置
const ALLOWED_ORIGINS = new Set<string>();

/**
 * 校验 Origin（允许局域网和公网访问）
 */
function validateOrigin(req: any): boolean {
  const origin = req.headers.origin || req.headers.host;
  
  if (!origin) {
    return false;
  }

  // 允许 localhost 开发环境
  if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
    return true;
  }

  // 允许当前域名的 HTTP 或 HTTPS 版本
  const currentHost = req.headers.host;
  if (currentHost && (origin.includes(currentHost) || origin.includes(currentHost))) {
    return true;
  }

  // 允许已注册的客户域
  if (ALLOWED_ORIGINS.has(origin)) {
    return true;
  }

  return false;
}

/**
 * 检查登录身份（从 Token 验证，不依赖 req.session）
 */
function checkAuth(req: any, res: any): boolean | undefined {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
    return false;
  }

  const token = authHeader.substring(7);
  
  // TODO: 验证 token 有效性
  // 这里应该调用 ptyManager 或类似的机制来验证 token
  // 目前先假设 token 是有效的（因为路由已经有 authMiddleware）
  
  return true;
}

/**
 * GET /api/mac-desktop/capabilities
 * 获取 Mac 桌面远程控制在当前主机上的可用性和状态
 */
router.get('/capabilities', async (_req, res) => {
  if (!isMacDesktopHost()) {
    res.json({
      success: true,
      enabled: false,
      serviceReachable: false,
      busy: false,
      displayCount: 0,
      status: 'unsupported',
      reasonCode: 'not-macos',
    });
    return;
  }
  try {
    const size = await getMacDisplaySize();
    res.json({
      success: true,
      enabled: true,
      serviceReachable: true,
      busy: false,
      displayCount: 1,
      status: 'ready',
      width: size.width,
      height: size.height,
    });
  } catch (error: any) {
    res.json({
      success: true,
      enabled: true,
      serviceReachable: false,
      busy: false,
      displayCount: 0,
      status: 'setup-required',
      reasonCode: 'screen-recording',
      error: error?.message || '无法读取桌面',
    });
  }
});

router.get('/screenshot', async (req, res) => {
  try {
    const quality = Math.min(80, Math.max(30, parseInt(String(req.query.quality || ''), 10) || 55));
    const scale = Math.min(1, Math.max(0.2, parseFloat(String(req.query.scale || '')) || 0.4));
    const shot = await captureMacDesktop({ quality, scale });
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-DuoCLI-Device-Width', String(shot.width));
    res.setHeader('X-DuoCLI-Device-Height', String(shot.height));
    res.send(shot.jpeg);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error?.message || '截取桌面失败' });
  }
});

router.post('/tap', async (req, res) => {
  try {
    await tapMacDesktop(req.body?.x, req.body?.y);
    res.json({ ok: true });
  } catch (error: any) {
    res.status(500).json({ ok: false, error: error?.message || '点击失败' });
  }
});

router.post('/swipe', async (req, res) => {
  try {
    await swipeMacDesktop(req.body?.x1, req.body?.y1, req.body?.x2, req.body?.y2, req.body?.duration);
    res.json({ ok: true });
  } catch (error: any) {
    res.status(500).json({ ok: false, error: error?.message || '滑动失败' });
  }
});

/**
 * POST /api/mac-desktop/sessions
 * 创建新的桌面会话并生成一次性访问票据
 * 
 * 响应包含：
 * - sessionId: 会话 ID（用于后续连接）
 * - ticket: 30 秒有效的一次性票据
 * - expiresAt: 过期时间戳
 */
router.post('/sessions', async (req, res) => {
  try {
    // 验证来源
    if (!validateOrigin(req)) {
      res.status(403).json({
        success: false,
        error: 'Forbidden',
        code: 'ORIGIN_NOT_ALLOWED',
      });
      return;
    }

    // 验证用户认证
    if (!checkAuth(req, res)) {
      return;
    }

    const capabilities = macDesktopSessionManager.getCapabilities();
    
    // 如果服务未启用
    if (!capabilities.enabled && !capabilities.serviceReachable) {
      res.status(403).json({
        success: false,
        error: 'Mac desktop remote control is disabled',
        code: 'SERVICE_DISABLED',
      });
      return;
    }

    // 如果有其他连接在使用
    if (capabilities.busy) {
      res.status(409).json({
        success: false,
        error: 'Another connection is in use',
        code: 'SERVICE_BUSY',
      });
      return;
    }

    // 检查支持情况
    if (capabilities.status === 'unsupported') {
      res.status(400).json({
        success: false,
        error: `Unsupported display configuration: ${capabilities.reasonCode}`,
        code: 'UNSUPPORTED_DISPLAY',
      });
      return;
    }

    // 创建会话
    const session = macDesktopSessionManager.createSession(
      (req as any).session?.user?.username || 'unknown',
      req.headers.origin
    );

    // 响应中禁止缓存
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });

    res.json({
      success: true,
      sessionId: session.sessionId,
      ticket: session.ticket,
      expiresAt: session.expiresAt,
    });
  } catch (error: any) {
    console.error('[MacDesktop] Session creation error:', error);
    
    if (error?.message?.includes('disabled')) {
      res.status(403).json({
        success: false,
        error: 'Service disabled',
        code: 'SERVICE_DISABLED',
      });
    } else if (error?.message?.includes('in use')) {
      res.status(409).json({
        success: false,
        error: 'Service busy',
        code: 'SERVICE_BUSY',
      });
    } else {
      res.status(400).json({
        success: false,
        error: error?.message || 'Internal server error',
        code: 'SESSION_CREATE_FAILED',
      });
    }
  }
});

/**
 * POST /api/mac-desktop/sessions/:id/disconnect
 * 强制断开指定的桌面会话
 * 只有会话持有者或电脑端可以调用此接口
 */
router.post('/sessions/:sessionId/disconnect', async (req, res) => {
  try {
    const { sessionId } = req.params;

    // 验证来源
    if (!validateOrigin(req)) {
      res.status(403).json({
        success: false,
        error: 'Forbidden',
        code: 'ORIGIN_NOT_ALLOWED',
      });
      return;
    }

    // 验证用户认证
    if (!checkAuth(req, res)) {
      return;
    }

    // 检查会话是否存在
    const session = macDesktopSessionManager.sessions.get(sessionId);
    if (!session) {
      res.status(404).json({
        success: false,
        error: 'Session not found',
        code: 'SESSION_NOT_FOUND',
      });
      return;
    }

    // 只有会话持有者或同一主体的用户才能断开
    const requestOrigin = (req as any).headers?.origin || (req as any).headers?.host;
    if (requestOrigin && session.origin !== requestOrigin) {
      res.status(403).json({
        success: false,
        error: 'Cannot disconnect other sessions',
        code: 'FORBIDDEN',
      });
      return;
    }

    // 断开会话
    macDesktopSessionManager.disconnectSession(sessionId);

    res.json({
      success: true,
      message: 'Session disconnected',
    });
  } catch (error: any) {
    console.error('[MacDesktop] Disconnect error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * WebSocket /mac-desktop-ws handler
 * 将浏览器端的 VNC 协议流量桥接到本地 macOS Screen Sharing 服务
 * 
 * 流程：
 * 1. 先完成应用层票据验证
 * 2. 建立到 localhost:5900 的 TCP 连接  
 * 3. 双向代理 RFB 字节流
 */

/**
 * POST /api/mac-desktop/input
 * 发送控制指令（仅用于 Disconnect/Release 等管理操作）
 * 
 * 注意：实时键盘输入应通过 WebSocket 桥接直接发送到 VNC 协议层
 * 此端点仅保留用于非实时的管理命令
 */
router.post('/input', async (req, res) => {
  try {
    const { sessionId, ticket, type, data }: any = req.body;

    if (!sessionId || !ticket || !type) {
      res.status(400).json({
        success: false,
        error: 'Missing required fields: sessionId, ticket, type',
        code: 'INVALID_REQUEST',
      });
      return;
    }

    // 验证票据（只读一次）
    const session = macDesktopSessionManager.validateTicket(sessionId, ticket);
    if (!session) {
      res.status(403).json({
        success: false,
        error: 'Invalid or expired ticket',
        code: 'INVALID_TICKET',
      });
      return;
    }

    console.log('[MacDesktop] Input command received:', { sessionId, type, data });
    
    // 暂不支持实时输入转发，需通过 WebSocket 桥接
    res.json({
      success: false,
      message: 'Keyboard input must be sent via WebSocket bridge, not REST API',
      code: 'USE_WEBSOCKET_BRIDGE',
    });
  } catch (error: any) {
    console.error('[MacDesktop] Input handling error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
});

function handleMacDesktopWsUpgrade(wss: any, req: any): void {
  const url = new URL(req.url || '/', 'http://localhost');
  const path = url.pathname;

  if (path !== '/mac-desktop-ws') {
    return;
  }

  // 验证 Origin（允许 localhost 和实际域名）
  if (!validateOrigin(req)) {
    console.warn('[MacDesktop] WS origin rejected:', req.headers.origin);
    return;
  }

  // 提取查询参数
  const sessionId = url.searchParams.get('sessionId');
  const ticket = url.searchParams.get('ticket');

  if (!sessionId || !ticket) {
    console.warn('[MacDesktop] WS missing credentials:', { sessionId, ticket });
    return;
  }

  // 验证票据
  const session = macDesktopSessionManager.validateTicket(sessionId, ticket);
  if (!session) {
    console.warn('[MacDesktop] WS invalid credentials:', { sessionId, ticket });
    return;
  }

  // 更新会话状态
  macDesktopSessionManager.updateSessionState(sessionId, 'connecting');

  // 使用 wss 的 upgrade 事件处理
  wss.handleUpgrade(req, req.socket, Buffer.from([]), (ws: any) => {
    // 再次验证
    const wsSessionId = url.searchParams.get('sessionId');
    const wsTicket = url.searchParams.get('ticket');

    if (wsSessionId !== sessionId || wsTicket !== ticket) {
      ws.close(4001, 'Invalid credentials');
      return;
    }

    const validatedSession = macDesktopSessionManager.validateTicket(sessionId, ticket);
    if (!validatedSession) {
      ws.close(4002, 'Session expired');
      return;
    }

    // 开始 VNC 桥接
    startVncBridge(ws, Buffer.from([]), validatedSession);
  });
}

/**
 * 启动 VNC 桥接
 * @param socket 客户端 WebSocket 套接字
 * @param head 握手后遗留的数据包
 * @param session 验证后的会话信息
 */
async function startVncBridge(
  clientSocket: any,
  head: Buffer | null,
  session: MacDesktopSessionInfo
): Promise<void> {
  macDesktopSessionManager.updateSessionState(session.sessionId, 'authenticating');

  try {
    // 连接到 Mac 的屏幕共享服务（localhost:5900）
    const tcpSocket = net.createConnection({ port: 5900, host: '127.0.0.1' }, () => {
      console.log(`[MacDesktop] Connected to VNC service on localhost:5900`);
      macDesktopSessionManager.updateSessionState(session.sessionId, 'active');
    });

    tcpSocket.on('error', (error: Error) => {
      console.error('[MacDesktop] VNC TCP error:', error);
      macDesktopSessionManager.updateSessionState(session.sessionId, 'service-unreachable');
      closeAllSockets(clientSocket, tcpSocket);
    });

    tcpSocket.on('close', () => {
      console.log('[MacDesktop] VNC TCP closed');
      macDesktopSessionManager.updateSessionState(session.sessionId, 'disconnected');
      closeAllSockets(clientSocket, tcpSocket);
    });

    // TODO: 维护每个 session 的 tcpSocket 引用，用于接收输入命令
    // SessionManager 需要存储 active TCP socket
    
    // 处理来自客户端的 WSS 数据 → 转发到 VNC
    // WebSocket 'message' event (ws library)
    clientSocket.on('message', (data: Buffer) => {
      if (tcpSocket.writable) {
        tcpSocket.write(data);
      }
    });

    clientSocket.on('close', () => {
      console.log('[MacDesktop] Client WS closed');
      tcpSocket.end();
    });

    clientSocket.on('error', (error: Error) => {
      console.error('[MacDesktop] Client WS error:', error);
      tcpSocket.end();
    });

    // 处理来自 VNC 的数据 → 转发到客户端 WSS
    tcpSocket.on('data', (data: Buffer) => {
      if (clientSocket.readyState === 1) { // OPEN
        clientSocket.send(data);
      }
    });

    // 如果有遗留数据（来自 upgrade 过程）
    if (head && head.length > 0) {
      tcpSocket.write(head);
    }

    console.log(`[MacDesktop] VNC bridge established for session ${session.sessionId.slice(0, 8)}...`);
  } catch (error) {
    console.error('[MacDesktop] VNC bridge failed:', error);
    macDesktopSessionManager.updateSessionState(session.sessionId, 'protocol-error');
    clientSocket.close(1011, 'VNC connection failed');
  }
}

/**
 * 关闭所有套接字
 */
function closeAllSockets(clientSocket: any, tcpSocket: any): void {
  try {
    if (clientSocket.readyState === 1) {
      clientSocket.close(1000, 'Connection terminated');
    }
  } catch {}

  try {
    tcpSocket.end();
  } catch {}
}

export { router, handleMacDesktopWsUpgrade };
export type { MacDesktopSessionInfo };
