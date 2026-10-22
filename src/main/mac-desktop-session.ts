import crypto from 'crypto';
import net from 'net';
import { execFileSync } from 'child_process';

/**
 * macOS 屏幕共享服务状态码
 */
export type MacDesktopServiceStatus = 
  | 'disabled'           // 功能未启用
  | 'setup-required'     // 需要系统设置
  | 'unavailable'        // 服务不可用（锁屏/睡眠等）
  | 'ready'              // 就绪可连接
  | 'unsupported';       // 不支持的显示配置

/**
 * Mac 桌面会话状态
 */
export type MacDesktopSessionState = 
  | 'created'
  | 'connecting'
  | 'authenticating'
  | 'awaiting-frame'
  | 'active'
  | 'suspended'
  | 'disconnected'
  | 'auth-failed'
  | 'service-unreachable'
  | 'unsupported'
  | 'protocol-error'
  | 'congested';

/**
 * Mac 桌面会话信息
 */
export interface MacDesktopSessionInfo {
  sessionId: string;
  ticket: string;
  createdAt: number;
  expiresAt: number;
  state: MacDesktopSessionState;
  origin?: string;
  loginSubject: string;
}

/**
 * macOS 屏幕共享能力信息
 */
export interface MacDesktopCapabilities {
  enabled: boolean;
  serviceReachable: boolean;
  busy: boolean;
  displayCount: number;
  status: MacDesktopServiceStatus;
  reasonCode?: string;
}

/**
 * Mac 密码认证凭据
 */
export interface MacDesktopCredentials {
  username: string;
  password: string;
}

/**
 * Mac 桌面会话管理器
 * 
 * 职责：
 * - 管理单个远控会话的生命周期
 * - 处理启用/禁用开关
 * - 生成一次性票据
 * - 验证当前桌面可用性
 */
export class MacDesktopSessionManager {
  private static readonly TICKET_TTL_MS = 30_000; // 30 秒票据有效期
  private static readonly MAX_SESSION_AGE_MS = 5 * 60 * 1000; // 5 分钟最大会话年龄
  
  public sessions = new Map<string, MacDesktopSessionInfo>();
  private enabled = false;
  private activeSessionId: string | null = null;
  private sessionGeneration = 0;
  
  constructor() {}

  /**
   * 启用 Mac 桌面远程控制
   * 必须由电脑端通过 IPC 触发，网页不能直接开启
   */
  enable(): void {
    this.enabled = true;
    this.sessionGeneration++;
    console.log(`[MacDesktop] Enabled, generation ${this.sessionGeneration}`);
    
    // 清除所有旧会话
    this.invalidateAllSessions();
  }

  /**
   * 禁用 Mac 桌面远程控制
   */
  disable(): void {
    this.enabled = false;
    this.sessionGeneration++;
    console.log(`[MacDesktop] Disabled, generation ${this.sessionGeneration}`);
    
    // 清除所有旧会话
    this.invalidateAllSessions();
  }

  /**
   * 获取当前启用状态
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * 获取会话代次（用于检测启用/禁用变更）
   */
  getSessionGeneration(): number {
    return this.sessionGeneration;
  }

  /**
   * 获取能力信息
   */
  getCapabilities(): MacDesktopCapabilities {
    const status = this.checkServiceStatus();
    
    return {
      enabled: this.enabled && status.status === 'ready',
      serviceReachable: status.serviceReachable,
      busy: this.activeSessionId !== null,
      displayCount: status.displayCount || 0,
      status: status.status,
      reasonCode: status.reasonCode,
    };
  }

  /**
   * 检查服务状态
   */
  private checkServiceStatus(): {
    status: MacDesktopServiceStatus;
    serviceReachable: boolean;
    displayCount: number;
    reasonCode?: string;
  } {
    if (!this.enabled) {
      return {
        status: 'disabled',
        serviceReachable: false,
        displayCount: 0,
      };
    }

    // 检查系统屏幕共享服务是否可用
    if (!this.isScreenSharingEnabled()) {
      return {
        status: 'setup-required',
        serviceReachable: false,
        displayCount: 0,
        reasonCode: 'screen-sharing-not-configured',
      };
    }

    // 检查 VNC 端口是否在监听（5900）
    const port = this.getVncPort();
    if (!this.isPortListening(port)) {
      return {
        status: 'unavailable',
        serviceReachable: false,
        displayCount: 0,
        reasonCode: 'vnc-not-listening',
      };
    }

    // 检查显示器配置
    const displayCount = this.getDisplayCount();
    if (displayCount === 0) {
      return {
        status: 'unsupported',
        serviceReachable: true,
        displayCount: 0,
        reasonCode: 'no-active-displays',
      };
    }

    if (displayCount > 1) {
      // 首版仅支持单显示器
      return {
        status: 'unsupported',
        serviceReachable: true,
        displayCount,
        reasonCode: 'multi-monitor-not-supported',
      };
    }

    // 检查是否锁屏
    if (this.isLockedOrSleeping()) {
      return {
        status: 'unavailable',
        serviceReachable: true,
        displayCount,
        reasonCode: 'locked-or-sleeping',
      };
    }

    return {
      status: 'ready',
      serviceReachable: true,
      displayCount,
    };
  }

  /**
   * 检查屏幕共享是否已启用
   */
  private isScreenSharingEnabled(): boolean {
    try {
      const output = execFileSync('defaults', [
        'read', 'com.apple.screensharing',
        'Enabled'
      ], { encoding: 'utf-8', timeout: 2000, stdio: ['pipe', 'pipe', 'ignore'] });
      return /1|true/i.test(output.trim());
    } catch {
      try {
        const output = execFileSync('defaults', [
          'read', 'com.apple.screenshare',
          'enabled'
        ], { encoding: 'utf-8', timeout: 2000, stdio: ['pipe', 'pipe', 'ignore'] });
        return output.trim() === '1';
      } catch {
        return false;
      }
    }
  }

  /**
   * 获取 VNC 端口
   */
  private getVncPort(): number {
    try {
      const output = execFileSync('networksetup', ['listnetworkservices'], {
        encoding: 'utf-8',
        timeout: 2000
      });
      // macOS 默认 VNC 端口是 5900 + display number
      // ScreenSharing 通常使用 5900 (display 0)
      return 5900;
    } catch {
      return 5900;
    }
  }

  /**
   * 检查 VNC 端口是否在监听
   */
  private isPortListening(port: number): boolean {
    try {
      const sockets = execFileSync('lsof', ['-i', `:${port}`, '-t'], {
        encoding: 'utf-8',
        timeout: 2000
      }).trim();
      
      // 如果有输出，说明端口正在被监听
      return sockets.length > 0;
    } catch {
      // lsof 失败或没有进程监听该端口
      return false;
    }
  }

  /**
   * 获取显示器数量
   */
  private getDisplayCount(): number {
    try {
      const output = execFileSync('system_profiler', ['SPDisplaysDataType'], {
        encoding: 'utf-8',
        timeout: 3000
      });
      
      // 统计显示器数量（基于主显示器的个数）
      const displayMatches = output.match(/Main:/g) || [];
      return displayMatches.length;
    } catch {
      return 0;
    }
  }

  /**
   * 检查是否锁屏或睡眠
   */
  private isLockedOrSleeping(): boolean {
    try {
      const output = execFileSync('pmcheck', ['-d'], {
        encoding: 'utf-8',
        timeout: 2000
      });
      
      return !output.includes('console_user_present');
    } catch {
      // pmcheck 可能不存在，使用备用方法
      try {
        const output = execFileSync('ioreg', [
          '-n', 'IOHIDMediaEventSource',
          '-r',
          '-a',
          '-c', 'ConsoleUserIsPresent'
        ], { encoding: 'utf-8', timeout: 2000 });
        
        return !output.includes('true');
      } catch {
        // 如果都无法执行，假设有控制台用户
        return false;
      }
    }
  }

  /**
   * 创建新会话并生成一次性票据
   * @param loginSubject 登录主体标识
   * @param origin WebSocket 请求的 Origin
   */
  createSession(loginSubject: string, origin?: string): MacDesktopSessionInfo {
    if (!this.enabled) {
      throw new Error('Mac desktop remote control is disabled');
    }

    const capabilities = this.getCapabilities();
    
    if (capabilities.status !== 'ready') {
      throw new Error(`Service not ready: ${capabilities.reasonCode}`);
    }

    if (this.activeSessionId !== null) {
      throw new Error('Another connection is in use');
    }

    // 生成安全随机 ID 和票据
    const sessionId = this.generateSecureId();
    const ticket = this.generateSecureTicket();
    
    const now = Date.now();
    const sessionInfo: MacDesktopSessionInfo = {
      sessionId,
      ticket,
      createdAt: now,
      expiresAt: now + MacDesktopSessionManager.MAX_SESSION_AGE_MS,
      state: 'created',
      origin,
      loginSubject,
    };

    this.sessions.set(sessionId, sessionInfo);
    this.activeSessionId = sessionId;
    
    console.log(`[MacDesktop] Session created: ${sessionId.slice(0, 8)}...`);
    
    return sessionInfo;
  }

  /**
   * 验证票据
   * @param sessionId 会话 ID
   * @param ticket 票据
   */
  validateTicket(sessionId: string, ticket: string): MacDesktopSessionInfo | null {
    const session = this.sessions.get(sessionId);
    
    if (!session) {
      console.log(`[MacDesktop] Invalid session: ${sessionId.slice(0, 8)}...`);
      return null;
    }

    // 检查票据是否匹配
    if (session.ticket !== ticket) {
      console.log(`[MacDesktop] Invalid ticket for session: ${sessionId.slice(0, 8)}...`);
      return null;
    }

    // 检查是否过期
    if (Date.now() > session.expiresAt) {
      console.log(`[MacDesktop] Expired session: ${sessionId.slice(0, 8)}...`);
      this.removeSession(sessionId);
      return null;
    }

    // 检查是否仍活跃
    if (this.activeSessionId !== sessionId) {
      console.log(`[MacDesktop] Session no longer active: ${sessionId.slice(0, 8)}...`);
      return null;
    }

    return session;
  }

  /**
   * 更新会话状态
   */
  updateSessionState(sessionId: string, state: MacDesktopSessionState): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    session.state = state;
    console.log(`[MacDesktop] Session ${sessionId.slice(0, 8)}... state -> ${state}`);
  }

  /**
   * 完成会话清理
   */
  completeSession(sessionId: string): void {
    this.removeSession(sessionId);
    this.activeSessionId = null;
    console.log(`[MacDesktop] Session completed: ${sessionId.slice(0, 8)}...`);
  }

  /**
   * 强制断开指定会话
   */
  disconnectSession(sessionId: string): void {
    this.updateSessionState(sessionId, 'disconnected');
    this.completeSession(sessionId);
  }

  /**
   * 撤销所有会话
   */
  invalidateAllSessions(): void {
    for (const sessionId of this.sessions.keys()) {
      this.removeSession(sessionId);
    }
    this.activeSessionId = null;
  }

  /**
   * 移除会话
   */
  private removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * 生成安全随机 ID
   */
  private generateSecureId(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  /**
   * 生成一次性票据
   */
  private generateSecureTicket(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * 连接到 Mac 屏幕共享服务
   * 这会建立到 localhost:5900 的 TCP 连接并代理 VNC 协议
   */
  async connectToVnc(credentials: MacDesktopCredentials, onFrame: (frame: Buffer) => void): Promise<{
    ws: any; // WebSocket 实例
    tcpSocket: any; // TCP socket
  }> {
    // TODO: 实现 VNC 握手和认证
    // 1. 连接到 localhost:5900
    // 2. 执行 RFB 协议握手
    // 3. 进行 Apple VNC 认证
    // 4. 开始接收屏幕帧
    
    throw new Error('Not implemented');
  }
}

// 单例导出
export const macDesktopSessionManager = new MacDesktopSessionManager();
