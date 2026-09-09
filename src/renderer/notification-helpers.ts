/**
 * 通知助手 - 用于处理桌面端和网页端的通知功能
 */

// 音效上下文（浏览器 Web Audio API）
let audioContext: AudioContext | null = null;

// 通知防抖计时器
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
const NOTIFICATION_COOLDOWN = 15000; // 15 秒冷却时间
let lastNotifyTime = 0;

/**
 * 初始化音频上下文
 */
function initAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  return audioContext;
}

/**
 * 播放完成提示音（悦耳的双音调）
 */
export function playCompletionSound(): void {
  try {
    const ctx = initAudioContext();
    
    const now = ctx.currentTime;
    
    // 第一个音调（A5 - 880Hz）
    const oscillator1 = ctx.createOscillator();
    const gainNode1 = ctx.createGain();
    
    oscillator1.type = 'sine';
    oscillator1.frequency.setValueAtTime(880, now);
    gainNode1.gain.setValueAtTime(0.3, now);
    gainNode1.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
    
    oscillator1.connect(gainNode1);
    gainNode1.connect(ctx.destination);
    
    oscillator1.start(now);
    oscillator1.stop(now + 0.1);
    
    // 第二个音调（A#5 - 1100Hz）
    const oscillator2 = ctx.createOscillator();
    const gainNode2 = ctx.createGain();
    
    oscillator2.type = 'sine';
    oscillator2.frequency.setValueAtTime(1100, now + 0.1);
    gainNode2.gain.setValueAtTime(0.3, now + 0.1);
    gainNode2.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
    
    oscillator2.connect(gainNode2);
    gainNode2.connect(ctx.destination);
    
    oscillator2.start(now + 0.1);
    oscillator2.stop(now + 0.3);
    
    console.log('[Notification] 播放完成音效');
  } catch (error) {
    console.warn('[Notification] 播放音效失败:', error);
  }
}

/**
 * 显示系统通知（如果支持的话）
 */
export function showSystemNotification(title: string, body: string): void {
  // 检查浏览器是否支持 Notification API
  if (!('Notification' in window)) {
    console.warn('[Notification] 当前浏览器不支持系统通知');
    return;
  }
  
  // 请求权限
  if (Notification.permission === 'granted') {
    createNotification(title, body);
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then(permission => {
      if (permission === 'granted') {
        createNotification(title, body);
      }
    });
  }
}

/**
 * 创建并显示通知
 */
function createNotification(title: string, body: string): void {
  const notification = new Notification(title, {
    body: body,
    icon: '/icon.png', // 使用应用图标（如果需要）
    badge: '/badge.png', // 徽章图标
    requireInteraction: false,
    silent: false, // 静音时会播放音效
  });
  
  notification.onclick = () => {
    window.focus();
    notification.close();
  };
  
  console.log('[Notification] 显示系统通知:', title);
}

/**
 * 发送并完成一个通知（带防抖）
 */
export function notifyWithCooldown(
  title: string, 
  body: string, 
  sessionId?: string
): void {
  const now = Date.now();
  
  // 防抖检查
  if (now - lastNotifyTime < NOTIFICATION_COOLDOWN) {
    console.log(`[Notification] 忽略重复通知（${now - lastNotifyTime}ms 前刚发过）`);
    return;
  }
  
  lastNotifyTime = now;
  
  // 播放音效
  playCompletionSound();
  
  // 显示系统通知
  showSystemNotification(title, body);
  
  // 记录会话 ID（如果有）
  if (sessionId) {
    console.log(`[Notification] 通知 [${sessionId}]: ${title} - ${body}`);
  } else {
    console.log(`[Notification] ${title}: ${body}`);
  }
}

/**
 * 注册来自 main 进程的通知监听
 */
export function setupNotificationListener(): void {
  if (!window.duocli?.onNotification) {
    console.warn('[Notification] 未找到 onNotification API');
    return;
  }
  
  window.duocli.onNotification((title: string, body: string, sessionId?: string) => {
    notifyWithCooldown(title, body, sessionId);
  });
  
  console.log('[Notification] 已注册通知监听');
}
