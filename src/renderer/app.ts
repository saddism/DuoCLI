import { TerminalManager } from './terminal-manager';
import { ChatView } from './chat-view';

let remoteServerInfo: { lanUrl: string; token: string; port: number; publicUrl?: string; tunnel?: { running: boolean; url: string; message?: string } } | null = null;

declare global {
  interface Window {
    duocli: {
      setWindowTitle: (title: string) => void;
      createPty: (cwd: string, presetCommand: string, themeId: string) => Promise<{ id: string; title: string; themeId: string; cwd: string; displayName: string }>;
      writePty: (id: string, data: string) => void;
      resizePty: (id: string, cols: number, rows: number) => void;
      destroyPty: (id: string) => void;
      renamePty: (id: string, title: string) => void;
      regenerateTitle: (id: string) => Promise<void>;
      getSessions: () => Promise<Array<{ id: string; title: string; themeId: string; cwd: string; displayName: string }>>;
      selectFolder: (currentPath?: string) => Promise<string | null>;
      fileTreeListDir: (dirPath: string) => Promise<Array<{ name: string; path: string; isDir: boolean }>>;
      remoteAddRecentCwd: (cwd: string) => Promise<boolean>;
      onPtyData: (cb: (id: string, data: string) => void) => void;
      onTitleUpdate: (cb: (id: string, title: string) => void) => void;
      onPtyExit: (cb: (id: string) => void) => void;
      onRemoteCreated: (cb: (sessionInfo: { id: string; title: string; themeId: string; cwd: string; displayName: string }) => void) => void;
      onRemoteServerInfo: (cb: (info: { lanUrl: string; token: string; port: number; publicUrl?: string; tunnel?: { running: boolean; url: string; message?: string } }) => void) => void;
      getRemoteServerInfo: () => Promise<{ lanUrl: string; token: string; port: number; publicUrl?: string; tunnel?: { running: boolean; url: string; message?: string } } | null>;
      clipboardSaveImage: () => Promise<string | null>;
      clipboardGetFilePath: () => Promise<string | null>;
      // 文件监听 API
      filewatcherStart: (cwd: string) => Promise<void>;
      filewatcherStop: () => Promise<void>;
      filewatcherOpen: (filePath: string) => Promise<void>;
      filewatcherSelectEditor: () => Promise<string | null>;
      filewatcherGetEditor: () => Promise<string | null>;
      openFolder: (folderPath: string) => Promise<void>;
      openUrl: (url: string) => Promise<void>;
      onFileChange: (cb: (filename: string, eventType: string) => void) => void;
      // AI 配置 API
      aiApplyConfig: (config: { apiFormat: string; baseUrl: string; apiKey: string; model: string }) => Promise<boolean>;
      aiTestConfig: (config: { apiFormat: string; baseUrl: string; apiKey: string; model: string }) => Promise<{ ok: boolean; error?: string; response?: string }>;
      aiGetCurrentConfig: () => Promise<{ apiFormat: string; baseUrl: string; apiKey: string; model: string; providerId: string | null } | null>;
      getCliProvider: (presetCommand: string) => Promise<string | null>;
      // Claude 供应商配置
      claudeProvidersList: () => Promise<Array<{ id: string; name: string; baseUrl: string; apiKey: string; model?: string }>>;
      claudeProvidersSave: (providers: Array<{ id: string; name: string; baseUrl: string; apiKey: string; model?: string }>) => Promise<boolean>;
      // Devin 账号管理
      devinAccountsList: () => Promise<{ accounts: Array<{ email: string; enabled: boolean; addedAt: number; lastLogin?: string; lastError?: string; quota?: { daily: number; weekly: number }; planName?: string; lastSwitchAt?: number }>; currentIndex: number }>;
      devinAccountsAdd: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>;
      devinAccountsAddBatch: (text: string) => Promise<{ ok: boolean; output?: string; error?: string }>;
      devinAccountsRemove: (email: string) => Promise<{ ok: boolean; error?: string }>;
      devinAccountsSwitch: (opts: { email?: string; next?: boolean }) => Promise<{ ok: boolean; error?: string; email?: string; quota?: { daily: number; weekly: number } }>;
      devinAccountsQuota: () => Promise<{ ok: boolean; daily?: number; weekly?: number; planName?: string; error?: string }>;
      devinAccountsQuotaAll: () => Promise<{ ok: boolean; results?: Array<{ email: string; ok: boolean; quota?: { daily: number; weekly: number; planName?: string }; error?: string }>; error?: string }>;
      devinAccountsQuotaOne: (email: string) => Promise<{ ok: boolean; daily?: number; weekly?: number; planName?: string; error?: string }>;
      devinAccountsRotateDevice: () => Promise<{ ok: boolean }>;
      // 文件操作
      openFile: (filePath: string) => Promise<void>;
      readDirectory: (dirPath: string) => Promise<Array<{ name: string; isDirectory: boolean; isFile: boolean }>>;
      // 会话状态同步
      syncSessionStatus: (statuses: Record<string, string>) => void;
      // 催工配置中转
      onGetAutoContinueConfig: (cb: (sessionId: string) => void) => void;
      sendAutoContinueConfig: (sessionId: string, config: any) => void;
      onSetAutoContinueConfig: (cb: (sessionId: string, config: any) => void) => void;
      // Chat API
      chatCreate: (opts: { workspace: string; model?: string }) => Promise<{ id: string; title: string; model: string; workspace: string; createdAt: number } | null>;
      chatSend: (sessionId: string, content: string) => Promise<void>;
      chatList: () => Promise<Array<{ id: string; title: string; model: string; workspace: string; createdAt: number; messageCount: number }>>;
      chatMessages: (sessionId: string) => Promise<Array<{ role: string; content: string; timestamp: number }>>;
      chatDestroy: (sessionId: string) => Promise<boolean>;
      chatAbort: (sessionId: string) => Promise<boolean>;
      chatRename: (sessionId: string, title: string) => Promise<boolean>;
      chatHealth: () => Promise<{ ok: boolean; error?: string }>;
      chatModels: () => Promise<Array<{ id: string; credits: string }>>;
      onChatDelta: (cb: (sessionId: string, text: string) => void) => void;
      onChatDone: (cb: (sessionId: string, content: string) => void) => void;
      onChatError: (cb: (sessionId: string, error: string) => void) => void;
      onChatTitleUpdate: (cb: (sessionId: string, title: string) => void) => void;
      // 已关闭会话
      closedSessionsList: () => Promise<Array<{ id: string; title: string; cwd: string; presetCommand: string; resumeId: string; resumeCommand: string; displayName: string; closedAt: number }>>;
      closedSessionsRemove: (id: string) => Promise<Array<{ id: string; title: string; cwd: string; presetCommand: string; resumeId: string; resumeCommand: string; displayName: string; closedAt: number }>>;
      closedSessionsClear: () => Promise<Array<{ id: string; title: string; cwd: string; presetCommand: string; resumeId: string; resumeCommand: string; displayName: string; closedAt: number }>>;
      onClosedSessionsUpdate: (cb: (sessions: Array<{ id: string; title: string; cwd: string; presetCommand: string; resumeId: string; resumeCommand: string; displayName: string; closedAt: number }>) => void) => void;
      // 已关闭 Chat 会话
      closedChatList: () => Promise<Array<{ id: string; title: string; model: string; workspace: string; messages: Array<{ role: string; content: string; timestamp: number }>; closedAt: number }>>;
      closedChatRemove: (id: string) => Promise<Array<{ id: string; title: string; model: string; workspace: string; messages: Array<{ role: string; content: string; timestamp: number }>; closedAt: number }>>;
      closedChatClear: () => Promise<Array<{ id: string; title: string; model: string; workspace: string; messages: Array<{ role: string; content: string; timestamp: number }>; closedAt: number }>>;
      chatRestore: (closedId: string) => Promise<{ id: string; title: string; model: string; workspace: string; createdAt: number } | null>;
      onClosedChatUpdate: (cb: (sessions: Array<{ id: string; title: string; model: string; workspace: string; messages: Array<{ role: string; content: string; timestamp: number }>; closedAt: number }>) => void) => void;
      // 自动切号状态
      onAutoSwitchStatus: (cb: (id: string, status: string, detail?: string) => void) => void;
      onCloseCurrentSession: (cb: () => void) => void;
    };
  }
}

// 状态
const savedCwd = localStorage.getItem('duocli_cwd') || '';
let currentCwd = savedCwd;
let lastPreset = localStorage.getItem('duocli_preset') || '';
const sessionTitles: Map<string, string> = new Map();
const sessionThemes: Map<string, string> = new Map();
const sessionUpdateTimes: Map<string, number> = new Map();
const sessionCreateTimes: Map<string, number> = new Map();
// 会话工作目录
const sessionCwds: Map<string, string> = new Map();
// 会话显示名称（如 Claude全自动、Codex 等）
const sessionDisplayNames: Map<string, string> = new Map();
// 会话实际使用的模型提供商（如 MiniMax、GLM、Anthropic 等）
const sessionProviders: Map<string, string> = new Map();
// 每个会话使用的自定义供应商 ID（用于切换终端时恢复选择）
const sessionClaudeProviderIds: Map<string, string> = new Map();

// ========== Chat 会话状态 ==========
const chatViews: Map<string, ChatView> = new Map();
const chatSessionTitles: Map<string, string> = new Map(); // chat session id → title
const chatSessionCreateTimes: Map<string, number> = new Map();
let activeChatId: string | null = null;

// ========== 已关闭会话（可恢复） ==========
interface ClosedSessionInfo {
  id: string;
  title: string;
  cwd: string;
  presetCommand: string;
  resumeId: string;
  resumeCommand: string;
  displayName: string;
  closedAt: number;
}
let closedSessions: ClosedSessionInfo[] = [];
let closedSessionsCollapsed = false;

// ========== 已关闭 Chat 会话（可恢复） ==========
interface ClosedChatSessionInfo {
  id: string;
  title: string;
  model: string;
  workspace: string;
  messages: Array<{ role: string; content: string; timestamp: number }>;
  closedAt: number;
}
let closedChatSessions: ClosedChatSessionInfo[] = [];

// 自动切号状态：sessionId → { status, detail }
const sessionAutoSwitchStatus: Map<string, { status: string; detail?: string }> = new Map();

// 自动继续配置
const sessionAutoContinue: Map<string, { enabled: boolean; messages: string[]; intervalMs: number; commandIntervalMs: number; lastSendTime: number; autoAgree: boolean; autoAgreeDelaySec: number; sendDelaySec: number; maxDurationMs: number; enabledAt: number }> = new Map();
const AUTO_CONTINUE_DEFAULT_MESSAGES = ['继续'];
const AUTO_CONTINUE_DEFAULT_INTERVAL = 10 * 60 * 1000; // 10 分钟
const AUTO_CONTINUE_DEFAULT_COMMAND_INTERVAL = 2000; // 命令间隔 2 秒
const AUTO_AGREE_DEFAULT_DELAY_SEC = 5; // 自动同意默认延后 5 秒
const AUTO_CONTINUE_SEND_DELAY_SEC = 2; // 发送回车前默认延迟 2 秒
const AUTO_CONTINUE_DEFAULT_MAX_DURATION = 0; // 0 表示不限制
const AUTO_CONTINUE_STORAGE_KEY = 'duocli_auto_continue';

function hasSessionInUI(sessionId: string): boolean {
  return sessionTitles.has(sessionId);
}

function getSessionCreateTime(id: string): number {
  const exists = sessionCreateTimes.get(id);
  if (exists != null) return exists;
  const fallback = sessionUpdateTimes.get(id) || Date.now();
  sessionCreateTimes.set(id, fallback);
  return fallback;
}

// 持久化催工配置到 localStorage
function saveAutoContinueToStorage(): void {
  const data: Record<string, any> = {};
  sessionAutoContinue.forEach((config, sessionId) => {
    // lastSendTime / enabledAt 是运行时状态，不持久化
    data[sessionId] = {
      enabled: config.enabled,
      messages: config.messages,
      intervalMs: config.intervalMs,
      commandIntervalMs: config.commandIntervalMs,
      autoAgree: config.autoAgree,
      autoAgreeDelaySec: config.autoAgreeDelaySec,
      sendDelaySec: config.sendDelaySec,
      maxDurationMs: config.maxDurationMs,
    };
  });
  localStorage.setItem(AUTO_CONTINUE_STORAGE_KEY, JSON.stringify(data));
}

// 从 localStorage 恢复催工配置
function loadAutoContinueFromStorage(): void {
  try {
    const raw = localStorage.getItem(AUTO_CONTINUE_STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw) as Record<string, any>;
    for (const [sessionId, config] of Object.entries(data)) {
      // 兼容旧版 message → messages 迁移
      const msgs = Array.isArray(config.messages)
        ? config.messages
        : (config.message ? [config.message] : [...AUTO_CONTINUE_DEFAULT_MESSAGES]);
      sessionAutoContinue.set(sessionId, {
        enabled: config.enabled ?? false,
        messages: msgs,
        intervalMs: config.intervalMs ?? AUTO_CONTINUE_DEFAULT_INTERVAL,
        commandIntervalMs: config.commandIntervalMs ?? AUTO_CONTINUE_DEFAULT_COMMAND_INTERVAL,
        lastSendTime: Date.now(),
        autoAgree: config.autoAgree ?? true,
        autoAgreeDelaySec: config.autoAgreeDelaySec ?? AUTO_AGREE_DEFAULT_DELAY_SEC,
        sendDelaySec: config.sendDelaySec ?? AUTO_CONTINUE_SEND_DELAY_SEC,
        maxDurationMs: config.maxDurationMs ?? AUTO_CONTINUE_DEFAULT_MAX_DURATION,
        enabledAt: Date.now(),
      });
    }
  } catch {}
}

// 启动时恢复催工配置并启动定时器
loadAutoContinueFromStorage();
// 旧逻辑会无条件清空磁盘配置，导致用户的催工设置永远丢失。
// 现状：冷启动时 sessionTitles 为空 → loadAutoContinueFromStorage 写入的旧 session-id 配置
// 不会命中任何当前会话，定时器自然 no-op；当 onRemoteCreated/createPty 创建新会话时
// 会通过 onSetAutoContinueConfig 同步推送新配置覆盖旧条目。
// 检查是否有启用的配置，如果有则启动定时器
const hasEnabledConfig = Array.from(sessionAutoContinue.values()).some(c => c.enabled);
if (hasEnabledConfig) initAutoContinueTimer();

// 自动继续定时器
let autoContinueTimer: ReturnType<typeof setInterval> | null = null;

// 写入 PTY 并重置自动继续计时器
function writePtyWithAutoReset(id: string, data: string): void {
  termManager.notifyInput(id);
  window.duocli.writePty(id, data);
  // 重置该会话的自动继续计时器
  const config = sessionAutoContinue.get(id);
  if (config && config.enabled) {
    config.lastSendTime = Date.now();
  }
}

// 初始化自动继续定时器
function initAutoContinueTimer(): void {
  if (autoContinueTimer) {
    clearInterval(autoContinueTimer);
  }
  autoContinueTimer = setInterval(() => {
    const now = Date.now();
    const staleSessionIds: string[] = [];
    sessionAutoContinue.forEach((config, sessionId) => {
      if (!config.enabled) return;
      if (!hasSessionInUI(sessionId)) {
        staleSessionIds.push(sessionId);
        return;
      }
      // 检查最大持续时间，超时自动关闭催工
      if (config.maxDurationMs > 0 && config.enabledAt > 0 && (now - config.enabledAt >= config.maxDurationMs)) {
        console.log(`[循环] 会话 ${sessionId} 已达最大持续时间 ${config.maxDurationMs}ms，自动关闭催工`);
        config.enabled = false;
        saveAutoContinueToStorage();
        renderSessionList();
        return;
      }
      // 检查是否超时
      if (now - config.lastSendTime >= config.intervalMs) {
        const messages = config.messages || AUTO_CONTINUE_DEFAULT_MESSAGES;
        const cmdInterval = config.commandIntervalMs ?? AUTO_CONTINUE_DEFAULT_COMMAND_INTERVAL;
        const sendDelay = (config.sendDelaySec ?? AUTO_CONTINUE_SEND_DELAY_SEC) * 1000;
        console.log(`[循环] 准备发送 ${messages.length} 条命令到会话 ${sessionId}`);

        // 依次发送每条命令，命令之间有间隔
        let cmdIdx = 0;
        const sendNextCommand = () => {
          if (cmdIdx >= messages.length) {
            console.log(`[循环] 已发送全部 ${messages.length} 条命令`);
            return;
          }
          const msg = messages[cmdIdx];
          cmdIdx++;
          window.duocli.writePty(sessionId, msg);
          // 延迟发送回车
          setTimeout(() => {
            const enterKeys = [
              '\r', '\n', '\r\n', '\x0d', '\x0a', '\x1b\n', '\x1b\r',
            ];
            let ei = 0;
            const sendNextEnter = () => {
              if (ei < enterKeys.length) {
                window.duocli.writePty(sessionId, enterKeys[ei]);
                ei++;
                setTimeout(sendNextEnter, 15);
              } else {
                // 这条命令回车完成，发送下一条命令
                setTimeout(sendNextCommand, cmdInterval);
              }
            };
            sendNextEnter();
          }, sendDelay);
        };
        sendNextCommand();
        config.lastSendTime = now;
      }
    });
    if (staleSessionIds.length > 0) {
      staleSessionIds.forEach((id) => sessionAutoContinue.delete(id));
      saveAutoContinueToStorage();
      renderSessionList();
    }
  }, 1000); // 每秒检查一次
}

// 切换自动继续开关
function toggleAutoContinue(sessionId: string, enabled: boolean): void {
  let config = sessionAutoContinue.get(sessionId);
  if (!config) {
    config = {
      enabled: false,
      messages: [...AUTO_CONTINUE_DEFAULT_MESSAGES],
      intervalMs: AUTO_CONTINUE_DEFAULT_INTERVAL,
      commandIntervalMs: AUTO_CONTINUE_DEFAULT_COMMAND_INTERVAL,
      lastSendTime: Date.now(),
      autoAgree: true,
      autoAgreeDelaySec: AUTO_AGREE_DEFAULT_DELAY_SEC,
      sendDelaySec: AUTO_CONTINUE_SEND_DELAY_SEC,
      maxDurationMs: AUTO_CONTINUE_DEFAULT_MAX_DURATION,
      enabledAt: 0,
    };
    sessionAutoContinue.set(sessionId, config);
  }
  config.enabled = enabled;
  config.lastSendTime = Date.now();
  if (enabled) {
    config.enabledAt = Date.now();
  }
  saveAutoContinueToStorage();

  // 启动定时器（如果尚未启动）
  initAutoContinueTimer();

  // 重新渲染会话列表以更新开关状态
  renderSessionList();
}

// 显示自动继续配置对话框
function showAutoContinueConfigDialog(sessionId: string): void {
  const config = sessionAutoContinue.get(sessionId) || {
    enabled: false,
    messages: [...AUTO_CONTINUE_DEFAULT_MESSAGES],
    intervalMs: AUTO_CONTINUE_DEFAULT_INTERVAL,
    commandIntervalMs: AUTO_CONTINUE_DEFAULT_COMMAND_INTERVAL,
    lastSendTime: Date.now(),
    autoAgree: true,
    autoAgreeDelaySec: AUTO_AGREE_DEFAULT_DELAY_SEC,
    sendDelaySec: AUTO_CONTINUE_SEND_DELAY_SEC,
    maxDurationMs: AUTO_CONTINUE_DEFAULT_MAX_DURATION,
    enabledAt: 0,
  };

  const currentMessages = config.messages || AUTO_CONTINUE_DEFAULT_MESSAGES;
  const currentInterval = config.intervalMs || AUTO_CONTINUE_DEFAULT_INTERVAL;
  const currentIntervalMinutes = Math.round(currentInterval / 60000);
  const currentCommandInterval = Math.round((config.commandIntervalMs ?? AUTO_CONTINUE_DEFAULT_COMMAND_INTERVAL) / 1000);
  const currentAutoAgree = config.autoAgree ?? true;
  const currentAutoAgreeDelay = config.autoAgreeDelaySec ?? AUTO_AGREE_DEFAULT_DELAY_SEC;
  const currentSendDelay = config.sendDelaySec ?? AUTO_CONTINUE_SEND_DELAY_SEC;
  const currentMaxDuration = config.maxDurationMs ?? AUTO_CONTINUE_DEFAULT_MAX_DURATION;
  const currentMaxDurationMinutes = currentMaxDuration > 0 ? Math.round(currentMaxDuration / 60000) : 0;

  const overlay = document.getElementById('auto-continue-overlay')!;
  const messageInput = document.getElementById('auto-continue-message') as HTMLTextAreaElement;
  const intervalInput = document.getElementById('auto-continue-interval') as HTMLInputElement;
  const commandIntervalInput = document.getElementById('auto-continue-command-interval') as HTMLInputElement;
  const autoAgreeCheckbox = document.getElementById('auto-continue-auto-agree') as HTMLInputElement;
  const autoAgreeDelayInput = document.getElementById('auto-continue-agree-delay') as HTMLInputElement;
  const autoAgreeDelayRow = document.getElementById('auto-agree-delay-row')!;
  const sendDelayInput = document.getElementById('auto-continue-send-delay') as HTMLInputElement;
  const maxDurationInput = document.getElementById('auto-continue-max-duration') as HTMLInputElement;
  const saveBtn = document.getElementById('auto-continue-save')!;
  const stopBtn = document.getElementById('auto-continue-stop')!;
  const cancelBtn = document.getElementById('auto-continue-cancel')!;
  const closeBtn = document.getElementById('auto-continue-dialog-close')!;

  messageInput.value = currentMessages.join('\n');
  messageInput.placeholder = '每行一条命令，按顺序发送';
  intervalInput.value = String(currentIntervalMinutes);
  if (commandIntervalInput) commandIntervalInput.value = String(currentCommandInterval);
  autoAgreeCheckbox.checked = currentAutoAgree;
  autoAgreeDelayInput.value = String(currentAutoAgreeDelay);
  autoAgreeDelayRow.style.display = currentAutoAgree ? '' : 'none';
  sendDelayInput.value = String(currentSendDelay);
  maxDurationInput.value = String(currentMaxDurationMinutes);

  // 根据当前状态设置按钮文字和显示
  if (config.enabled) {
    saveBtn.textContent = '保存';
    stopBtn.style.display = '';
  } else {
    saveBtn.textContent = '保存并开启';
    stopBtn.style.display = 'none';
  }

  autoAgreeCheckbox.onchange = () => {
    autoAgreeDelayRow.style.display = autoAgreeCheckbox.checked ? '' : 'none';
  };

  overlay.classList.add('active');
  messageInput.focus();

  function close(): void {
    overlay.classList.remove('active');
    saveBtn.removeEventListener('click', onSave);
    stopBtn.removeEventListener('click', onStop);
    cancelBtn.removeEventListener('click', close);
    closeBtn.removeEventListener('click', close);
    autoAgreeCheckbox.onchange = null;
  }

  function onSave(): void {
    const messages = messageInput.value.split('\n').map(m => m.trim()).filter(Boolean);
    if (!messages.length) { messageInput.focus(); return; }
    const intervalMinutes = parseInt(intervalInput.value, 10);
    if (isNaN(intervalMinutes) || intervalMinutes < 1) { intervalInput.focus(); return; }

    const agreeDelay = parseInt(autoAgreeDelayInput.value, 10);
    if (autoAgreeCheckbox.checked && (isNaN(agreeDelay) || agreeDelay < 0)) { autoAgreeDelayInput.focus(); return; }

    const sendDelay = parseInt(sendDelayInput.value, 10);
    if (isNaN(sendDelay) || sendDelay < 0) { sendDelayInput.focus(); return; }

    const maxDurationMinutes = parseInt(maxDurationInput.value, 10);
    if (isNaN(maxDurationMinutes) || maxDurationMinutes < 0) { maxDurationInput.focus(); return; }

    config.messages = messages;
    config.intervalMs = intervalMinutes * 60000;
    if (commandIntervalInput) {
      const cmdIntervalSec = parseInt(commandIntervalInput.value, 10);
      config.commandIntervalMs = isNaN(cmdIntervalSec) || cmdIntervalSec < 0 ? AUTO_CONTINUE_DEFAULT_COMMAND_INTERVAL : cmdIntervalSec * 1000;
    }
    config.lastSendTime = Date.now();
    config.autoAgree = autoAgreeCheckbox.checked;
    config.autoAgreeDelaySec = isNaN(agreeDelay) ? AUTO_AGREE_DEFAULT_DELAY_SEC : agreeDelay;
    config.sendDelaySec = sendDelay;
    config.maxDurationMs = maxDurationMinutes > 0 ? maxDurationMinutes * 60000 : 0;
    sessionAutoContinue.set(sessionId, config);

    if (!config.enabled) {
      config.enabled = true;
      config.enabledAt = Date.now();
      initAutoContinueTimer();
    }

    saveAutoContinueToStorage();
    close();
    renderSessionList();
  }

  function onStop(): void {
    config.enabled = false;
    config.lastSendTime = Date.now();
    sessionAutoContinue.set(sessionId, config);
    saveAutoContinueToStorage();
    initAutoContinueTimer();
    close();
    renderSessionList();
  }

  saveBtn.addEventListener('click', onSave);
  stopBtn.addEventListener('click', onStop);
  cancelBtn.addEventListener('click', close);
  closeBtn.addEventListener('click', close);
}

// 当前正在编辑标题的会话 ID
let editingTitleId: string | null = null;

// ========== 自定义预设 ==========

interface CustomPreset {
  id: string;
  name: string;
  command: string;
  autoFlag: string;
}

interface FileTreeItem {
  name: string;
  path: string;
  isDir: boolean;
}

const CUSTOM_PRESETS_KEY = 'duocli_custom_presets';
const PRESET_SYNC_INTERVAL_MS = 30 * 1000;
let customPresetNextId = 1;
let presetSyncInFlight = false;
let presetSyncTimer: ReturnType<typeof setInterval> | null = null;

function getCustomPresets(): CustomPreset[] {
  try { return JSON.parse(localStorage.getItem(CUSTOM_PRESETS_KEY) || '[]'); } catch { return []; }
}

function saveCustomPresets(list: CustomPreset[]): void {
  localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(list));
  // 同步到远程服务器，供手机端读取
  syncPresetsToServer(list);
}

async function syncPresetsToServer(list: CustomPreset[]): Promise<void> {
  if (!remoteServerInfo) {
    console.log('[Preset Sync] Remote server not ready, skipping sync');
    return;
  }
  
  console.log('[Preset Sync] Syncing presets to server:', list.length, 'items');
  
  let retries = 3;
  while (retries > 0) {
    try {
      const response = await fetch(`http://127.0.0.1:${remoteServerInfo.port}/api/custom-presets`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${remoteServerInfo.token}` },
        body: JSON.stringify(list),
      });
      
      if (response.ok) {
        console.log('[Preset Sync] Successfully synced presets to server');
        return;
      } else {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    } catch (error) {
      retries--;
      console.warn(`[Preset Sync] Failed to sync presets (${3 - retries}/3):`, error);
      
      if (retries > 0) {
        // 等待 1 秒后重试
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }
  
  console.error('[Preset Sync] Failed to sync presets after 3 attempts');
}

async function pullPresetsFromServer(): Promise<CustomPreset[] | null> {
  if (!remoteServerInfo) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${remoteServerInfo.port}/api/custom-presets`, {
      headers: { 'Authorization': `Bearer ${remoteServerInfo.token}` },
    });
    if (res.ok) return await res.json();
  } catch { /* ignore */ }
  return null;
}

function arePresetListsEqual(a: CustomPreset[], b: CustomPreset[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function reconcilePresetsWithServer(reason: string): Promise<void> {
  if (!remoteServerInfo || presetSyncInFlight) return;
  presetSyncInFlight = true;
  try {
    const localPresets = getCustomPresets();
    const serverPresets = await pullPresetsFromServer();
    if (!serverPresets) return;

    const merged = new Map<string, CustomPreset>();
    for (const p of localPresets) merged.set(p.id, p);
    for (const p of serverPresets) merged.set(p.id, p);
    const list = Array.from(merged.values());

    if (!arePresetListsEqual(localPresets, list)) {
      console.log('[Preset Sync] Updating local presets from server:', reason);
      localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(list));
      renderPresetSelect();
    }

    if (!arePresetListsEqual(serverPresets, list)) {
      console.log('[Preset Sync] Updating server presets from local:', reason);
      await syncPresetsToServer(list);
    }
  } finally {
    presetSyncInFlight = false;
  }
}

function startPresetSyncTimer(): void {
  if (presetSyncTimer) return;
  presetSyncTimer = setInterval(() => {
    void reconcilePresetsWithServer('timer');
  }, PRESET_SYNC_INTERVAL_MS);
}

// 内置 option 的 HTML（从 index.html 中提取，作为 renderPresetSelect 的基础）
const BUILTIN_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '空终端' },
  { value: 'claude --dangerously-skip-permissions', label: 'Claude (全自动)' },
  { value: 'codex -c sandbox_mode="danger-full-access" -c approval="never" -c network="enabled"', label: 'Codex (全自动)' },
  { value: 'copilot --allow-all --autopilot', label: 'Copilot (全自动)' },
  { value: 'devin --permission-mode bypass', label: 'Devin (全自动)' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'kiro-cli chat --trust-all-tools', label: 'Kiro (全自动)' },
];

// 渲染远程服务器连接信息
function renderRemoteServerInfo(): void {
  if (!remoteServerInfo) {
    remoteServerInfoEl.style.display = 'none';
    return;
  }
  remoteServerInfoEl.style.display = 'block';
  const urlEl = remoteServerInfoEl.querySelector('.remote-info-url') as HTMLElement;
  const tokenEl = remoteServerInfoEl.querySelector('.remote-info-token')!;
  const tunnelReady = Boolean(remoteServerInfo.tunnel?.running && remoteServerInfo.publicUrl);
  urlEl.textContent = tunnelReady
    ? remoteServerInfo.publicUrl!
    : `${remoteServerInfo.lanUrl}${remoteServerInfo.tunnel?.message ? ` | ${remoteServerInfo.tunnel.message}` : ''}`;
  urlEl.title = tunnelReady ? remoteServerInfo.lanUrl : '';
  tokenEl.textContent = `Token: ${remoteServerInfo.token}`;
}

function renderPresetSelect(): void {
  const prev = presetSelect.value;
  presetSelect.innerHTML = '';

  // 内置选项
  for (const opt of BUILTIN_OPTIONS) {
    const el = document.createElement('option');
    el.value = opt.value;
    el.textContent = opt.label;
    presetSelect.appendChild(el);
  }

  // 自定义预设
  const customs = getCustomPresets();
  if (customs.length > 0) {
    const sep = document.createElement('option');
    sep.disabled = true;
    sep.textContent = '── 自定义 ──';
    presetSelect.appendChild(sep);

    for (const p of customs) {
      const el = document.createElement('option');
      el.value = p.autoFlag ? p.command + ' ' + p.autoFlag : p.command;
      el.textContent = p.autoFlag ? p.name + ' (全自动)' : p.name;
      presetSelect.appendChild(el);
    }
  }

  // 恢复之前的选中值
  presetSelect.value = prev;
  // 如果之前的值不存在了，回退到空终端
  if (presetSelect.selectedIndex === -1) presetSelect.value = '';

  // 只在远程服务器可用时同步到服务端
  if (remoteServerInfo) {
    console.log('[Preset Sync] Remote server available, syncing presets');
    syncPresetsToServer(customs);
  } else {
    console.log('[Preset Sync] Remote server not available, will sync when ready');
  }
}

function showPresetDialog(preset?: CustomPreset): Promise<CustomPreset | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog';

    const isEdit = !!preset;
    dialog.innerHTML = `
      <h3>${isEdit ? '编辑' : '新建'}自定义 CLI 预设</h3>
      <div class="preset-form">
        <div class="preset-form-field">
          <label>名称</label>
          <input type="text" id="preset-name-input" placeholder="如 Aider、自定义 CLI 等" value="${preset?.name || ''}" />
        </div>
        <div class="preset-form-field">
          <label>命令</label>
          <input type="text" id="preset-cmd-input" placeholder="如 aider、my-cli 等" value="${preset?.command || ''}" />
        </div>
        <div class="preset-form-field">
          <label>全自动参数（可选）</label>
          <input type="text" id="preset-auto-input" placeholder="如 --yes、--yolo 等，留空表示无全自动模式" value="${preset?.autoFlag || ''}" />
        </div>
      </div>
      <div class="confirm-buttons" style="margin-top:16px">
        <button class="btn-cancel">取消</button>
        <button class="btn-close-confirm" style="background:var(--accent)">保存</button>
      </div>`;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const nameInput = dialog.querySelector('#preset-name-input') as HTMLInputElement;
    const cmdInput = dialog.querySelector('#preset-cmd-input') as HTMLInputElement;
    const autoInput = dialog.querySelector('#preset-auto-input') as HTMLInputElement;

    nameInput.focus();

    const cleanup = (result: CustomPreset | null) => { overlay.remove(); resolve(result); };

    dialog.querySelector('.btn-cancel')!.addEventListener('click', () => cleanup(null));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(null); });

    dialog.querySelector('.btn-close-confirm')!.addEventListener('click', () => {
      const name = nameInput.value.trim();
      const command = cmdInput.value.trim();
      if (!name || !command) {
        nameInput.style.borderColor = name ? '' : 'var(--danger)';
        cmdInput.style.borderColor = command ? '' : 'var(--danger)';
        return;
      }
      const id = preset?.id || `custom-${customPresetNextId++}`;
      cleanup({ id, name, command, autoFlag: autoInput.value.trim() });
    });

    // Enter 键保存
    const handleEnter = (e: KeyboardEvent) => {
      if (e.key === 'Enter') dialog.querySelector<HTMLButtonElement>('.btn-close-confirm')!.click();
      if (e.key === 'Escape') cleanup(null);
    };
    nameInput.addEventListener('keydown', handleEnter);
    cmdInput.addEventListener('keydown', handleEnter);
    autoInput.addEventListener('keydown', handleEnter);
  });
}

function showPresetManageDialog(): void {
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'confirm-dialog';
  dialog.style.minWidth = '360px';

  function render() {
    const customs = getCustomPresets();
    dialog.innerHTML = `<h3>管理自定义预设</h3>`;

    const listEl = document.createElement('div');
    listEl.className = 'preset-manage-list';

    if (customs.length === 0) {
      listEl.innerHTML = '<div class="preset-manage-empty">暂无自定义预设，点击工具栏 "+" 按钮新建</div>';
    } else {
      for (const p of customs) {
        const item = document.createElement('div');
        item.className = 'preset-manage-item';

        const info = document.createElement('div');
        info.className = 'preset-manage-item-info';
        const nameEl = document.createElement('div');
        nameEl.className = 'preset-manage-item-name';
        nameEl.textContent = p.name;
        const cmdEl = document.createElement('div');
        cmdEl.className = 'preset-manage-item-cmd';
        cmdEl.textContent = p.command + (p.autoFlag ? ` (全自动: ${p.autoFlag})` : '');
        info.appendChild(nameEl);
        info.appendChild(cmdEl);

        const actions = document.createElement('div');
        actions.className = 'preset-manage-item-actions';

        const editBtn = document.createElement('button');
        editBtn.textContent = '编辑';
        editBtn.addEventListener('click', async () => {
          const edited = await showPresetDialog(p);
          if (edited) {
            const list = getCustomPresets();
            const idx = list.findIndex(x => x.id === p.id);
            if (idx !== -1) { list[idx] = edited; saveCustomPresets(list); }
            renderPresetSelect();
            render();
          }
        });

        const delBtn = document.createElement('button');
        delBtn.className = 'danger';
        delBtn.textContent = '删除';
        delBtn.addEventListener('click', () => {
          const list = getCustomPresets().filter(x => x.id !== p.id);
          saveCustomPresets(list);
          renderPresetSelect();
          render();
        });

        actions.appendChild(editBtn);
        actions.appendChild(delBtn);
        item.appendChild(info);
        item.appendChild(actions);
        listEl.appendChild(item);
      }
    }

    dialog.appendChild(listEl);

    const btns = document.createElement('div');
    btns.className = 'confirm-buttons';
    btns.style.marginTop = '16px';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn-cancel';
    closeBtn.textContent = '关闭';
    closeBtn.addEventListener('click', () => overlay.remove());
    btns.appendChild(closeBtn);
    dialog.appendChild(btns);
  }

  render();
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// 初始化自定义预设 ID 计数器
(function initCustomPresetId() {
  const customs = getCustomPresets();
  for (const p of customs) {
    const m = p.id.match(/^custom-(\d+)$/);
    if (m) customPresetNextId = Math.max(customPresetNextId, parseInt(m[1]) + 1);
  }
})();

// 最近工作目录
const RECENT_CWD_KEY = 'duocli_recent_cwds';
const MAX_RECENT_CWDS = 8;

function getRecentCwds(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_CWD_KEY) || '[]'); } catch { return []; }
}

function addRecentCwd(cwd: string): void {
  const list = getRecentCwds().filter(p => p !== cwd);
  list.unshift(cwd);
  if (list.length > MAX_RECENT_CWDS) list.length = MAX_RECENT_CWDS;
  localStorage.setItem(RECENT_CWD_KEY, JSON.stringify(list));
  // 同步到主进程远程服务配置，供手机端新建会话时复用
  window.duocli.remoteAddRecentCwd(cwd).catch(() => { /* ignore */ });
}

function syncRecentCwdsToRemote(): void {
  const list = getRecentCwds();
  // 按“旧 -> 新”顺序回放，保证远程端最终顺序与桌面端一致
  list.slice().reverse().forEach((cwd) => {
    window.duocli.remoteAddRecentCwd(cwd).catch(() => { /* ignore */ });
  });
}

// DOM 元素
const cwdInput = document.getElementById('cwd-input') as HTMLInputElement;
const cwdBrowseBtn = document.getElementById('cwd-browse-btn')!;
const cwdOpenBtn = document.getElementById('cwd-open-btn')!;
const cwdRecentBtn = document.getElementById('cwd-recent-btn')!;
const cwdRecentDropdown = document.getElementById('cwd-recent-dropdown')!;
const presetSelect = document.getElementById('preset-select') as HTMLSelectElement;
const presetAddBtn = document.getElementById('preset-add-btn')!;
const presetManageBtn = document.getElementById('preset-manage-btn')!;
const themeSelect = document.getElementById('theme-select')!;
const themeDisplay = document.getElementById('theme-display')!;
const themeDropdown = document.getElementById('theme-dropdown')!;
const toolbarNewBtn = document.getElementById('toolbar-new-btn')!;
const remoteServerInfoEl = document.getElementById('remote-server-info')!;
const newSessionOverlay = document.getElementById('new-session-overlay')!;
const newSessionCloseBtn = document.getElementById('new-session-close')!;
const newSessionCancelBtn = document.getElementById('new-session-cancel')!;
const newSessionCreateBtn = document.getElementById('new-session-create')!;
const fileTreeList = document.getElementById('file-tree-list')!;
const fileTreeRefreshBtn = document.getElementById('file-tree-refresh-btn')!;
const fileTreeOpenBtn = document.getElementById('file-tree-open-btn')!;
const fileTreePath = document.getElementById('file-tree-path')!;
const fileTreePanel = document.getElementById('file-tree-panel')!;
const fileTreeToggle = document.getElementById('file-tree-toggle')!;
const fileTreeResizer = document.getElementById('file-tree-resizer')!;
const terminalArea = document.getElementById('terminal-area')!;
const terminalContent = document.getElementById('terminal-content')!;
const emptyState = document.getElementById('empty-state')!;
const sessionList = document.getElementById('session-list')!;
const chatContent = document.getElementById('chat-content')!;
const chatEmptyState = document.getElementById('chat-empty-state')!;
const sidebar = document.getElementById('sidebar')!;;
const sidebarToggle = document.getElementById('sidebar-toggle')!;
const sidebarResizer = document.getElementById('sidebar-resizer')!;

// 文件状态栏 DOM
const fileStatusbar = document.getElementById('file-statusbar')!;
const fileStatusbarFiles = document.getElementById('file-statusbar-files')!;

const sidebarTabs = document.querySelectorAll('.sidebar-tab');
const tabSessions = document.getElementById('tab-sessions')!;

// AI 配置相关 DOM
const tabAiConfig = document.getElementById('tab-ai-config')!;

// Devin 账号管理相关 DOM
const tabDevinAccounts = document.getElementById('tab-devin-accounts')!;
const devinAccountsList = document.getElementById('devin-accounts-list')!;
const devinCurrentLabel = document.getElementById('devin-current-label')!;
const devinRefreshBtn = document.getElementById('devin-refresh-btn') as HTMLButtonElement;
const devinQuotaBtn = document.getElementById('devin-quota-btn') as HTMLButtonElement;
const devinQuotaAllBtn = document.getElementById('devin-quota-all-btn') as HTMLButtonElement;
const devinAddEmail = document.getElementById('devin-add-email') as HTMLInputElement;
const devinAddPassword = document.getElementById('devin-add-password') as HTMLInputElement;
const devinAddBtn = document.getElementById('devin-add-btn') as HTMLButtonElement;
const devinBatchInput = document.getElementById('devin-batch-input') as HTMLTextAreaElement;
const devinBatchBtn = document.getElementById('devin-batch-btn') as HTMLButtonElement;
const aiApplyBtn = document.getElementById('ai-apply-btn')!;
const aiTestBtn = document.getElementById('ai-test-btn')!;
const aiFormatSelect = document.getElementById('ai-format-select') as HTMLSelectElement;
const aiBaseurlInput = document.getElementById('ai-baseurl-input') as HTMLInputElement;
const aiApikeyInput = document.getElementById('ai-apikey-input') as HTMLInputElement;
const aiModelInput = document.getElementById('ai-model-input') as HTMLInputElement;
const aiKeyToggle = document.getElementById('ai-key-toggle')!;


// 文件监听状态（全局）
let globalRecentFiles: string[] = [];
const MAX_RECENT_FILES = 5;
let currentEditorName: string | null = null;
let fileTreeRootCwd: string | null = null;
const fileTreeExpandedDirs: Set<string> = new Set();
const fileTreeChildrenCache: Map<string, FileTreeItem[]> = new Map();

// 未读消息状态（绿点：AI 完成工作，等待输入）
const sessionUnread: Set<string> = new Set();
// 工作中状态（黄点：AI 正在输出）
const sessionBusy: Set<string> = new Set();
// 未读延迟计时器（静默超时检测）
const unreadTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
// 最近收到的数据缓冲（用于提示符检测）
const recentDataBuffer: Map<string, string> = new Map();
// 手动改过标题的会话（不再自动更新）
const sessionTitleLocked: Set<string> = new Set();
// 置顶会话
const pinnedSessions: Set<string> = new Set();

// 同步会话状态到 main 进程（供手机端 remote-server 读取）
function syncSessionStatusToMain(): void {
  const statuses: Record<string, string> = {};
  for (const id of sessionTitles.keys()) {
    if (sessionBusy.has(id)) {
      statuses[id] = 'running';   // 黄灯：AI 正在工作
    } else if (sessionUnread.has(id)) {
      statuses[id] = 'idle';      // 绿灯：等待输入
    } else {
      statuses[id] = 'inactive';  // 灰灯：已查看
    }
  }
  window.duocli.syncSessionStatus(statuses);
}

// 终端管理器
const termManager = new TerminalManager(terminalContent, (id, cols, rows) => {
  window.duocli.resizePty(id, cols, rows);
});

// 恢复上次的工作目录和预设命令
if (savedCwd) {
  cwdInput.value = savedCwd;
}
syncRecentCwdsToRemote();
// 初始化 preset select（含自定义预设），然后恢复上次选中
renderPresetSelect();
if (lastPreset) {
  presetSelect.value = lastPreset;
}

// 自定义配色下拉组件
const themeColorMap: Record<string, string> = {
  'auto': '',
  'vscode-dark': '#0078d4',
  'monokai': '#a6e22e',
  'dracula': '#bd93f9',
  'solarized-dark': '#268bd2',
  'one-dark': '#61afef',
  'nord': '#88c0d0',
};
let currentThemeId = 'auto';

function setThemeValue(value: string): void {
  currentThemeId = value;
  const opt = themeDropdown.querySelector(`[data-value="${value}"]`);
  if (opt) {
    themeDisplay.innerHTML = opt.innerHTML;
  }
  themeDropdown.querySelectorAll('.custom-select-option').forEach((el) => {
    el.classList.toggle('selected', el.getAttribute('data-value') === value);
  });
}

themeDisplay.addEventListener('click', (e) => {
  e.stopPropagation();
  themeSelect.classList.toggle('open');
});

themeDropdown.addEventListener('click', (e) => {
  const target = (e.target as HTMLElement).closest('.custom-select-option') as HTMLElement | null;
  if (!target) return;
  const value = target.getAttribute('data-value');
  if (value) setThemeValue(value);
  themeSelect.classList.remove('open');
});

document.addEventListener('click', () => {
  themeSelect.classList.remove('open');
});

// 启动时恢复保存的配色
setThemeValue(currentThemeId);

// ========== CLI 标签颜色 ==========

// 已知 CLI → 固定颜色（文字色, 背景色）
const CLI_TAG_COLORS: Record<string, [string, string]> = {
  'Claude':       ['#d4a574', '#3d2e1e'],
  'Claude全自动':  ['#e5a100', '#3d3010'],
  'Codex':        ['#73c991', '#1e3328'],
  'Codex全自动':   ['#56d4a0', '#1a3d2e'],
  'Copilot':      ['#7ee787', '#17361f'],
  'Copilot全自动': ['#3fb950', '#12351f'],
};

function getCliTagColors(displayName: string): [string, string] {
  // 精确匹配
  if (CLI_TAG_COLORS[displayName]) return CLI_TAG_COLORS[displayName];
  // 前缀匹配（自定义预设的"全自动"变体）
  for (const key of Object.keys(CLI_TAG_COLORS)) {
    if (displayName.startsWith(key)) return CLI_TAG_COLORS[key];
  }
  // 未知 CLI：用 hash 从色板中选一个
  let h = 0;
  for (let i = 0; i < displayName.length; i++) {
    h = ((h << 5) - h + displayName.charCodeAt(i)) | 0;
  }
  const palette: Array<[string, string]> = [
    ['#e06c75', '#3d1e22'], ['#e5c07b', '#3d3520'], ['#98c379', '#253320'],
    ['#f78c6c', '#3d2518'], ['#c792ea', '#2e1e3d'], ['#ff5370', '#3d1825'],
  ];
  return palette[Math.abs(h) % palette.length];
}

// ========== 路径自动颜色 ==========

// 高区分度色板（12 色，HSL 均匀分布，饱和度高）
const PATH_COLORS = [
  '#e06c75', '#e5c07b', '#98c379', '#56b6c2',
  '#61afef', '#c678dd', '#f78c6c', '#d19a66',
  '#7ec699', '#82aaff', '#c792ea', '#ff5370',
];

function cwdToColor(cwd: string): string {
  const key = normalizeCwd(cwd);
  if (!key) return PATH_COLORS[0];
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  return PATH_COLORS[Math.abs(hash) % PATH_COLORS.length];
}

// 归一化目录路径，避免同一目录因末尾斜杠 / macOS /private 前缀差异被拆成多组
function normalizeCwd(cwd: string): string {
  if (!cwd) return '';
  let p = cwd.trim();
  if (p.startsWith('/private/')) p = p.slice('/private'.length);
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p;
}

// 取路径最后一段作为项目名
function cwdShortName(cwd: string): string {
  if (!cwd) return '未知项目';
  const parts = cwd.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || cwd;
}

// 自动配色：根据 cwd 映射到一个实际主题，尽量让不同项目分配到不同主题
const AUTO_THEME_LIST = ['vscode-dark', 'monokai', 'dracula', 'solarized-dark', 'one-dark', 'nord'];
const autoThemeCache: Map<string, string> = new Map(); // cwd → themeId

function cwdHash(cwd: string): number {
  let h = 0;
  for (let i = 0; i < cwd.length; i++) {
    h = ((h << 5) - h + cwd.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function cwdToThemeId(cwd: string): string {
  if (!cwd) return AUTO_THEME_LIST[0];
  const cached = autoThemeCache.get(cwd);
  if (cached) return cached;

  // 已被占用的主题
  const usedThemes = new Set(autoThemeCache.values());
  // 优先选未被占用的主题
  const available = AUTO_THEME_LIST.filter(t => !usedThemes.has(t));
  const hash = cwdHash(cwd);
  let theme: string;
  if (available.length > 0) {
    theme = available[hash % available.length];
  } else {
    theme = AUTO_THEME_LIST[hash % AUTO_THEME_LIST.length];
  }
  autoThemeCache.set(cwd, theme);
  return theme;
}

// 解析实际 themeId：auto 时根据 cwd 决定
function resolveThemeId(themeId: string, cwd: string): string {
  return themeId === 'auto' ? cwdToThemeId(cwd) : themeId;
}

// ========== 工具函数 ==========

function friendlyTime(ts: number): string {
  const now = Date.now();
  const diff = Math.floor((now - ts) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}天前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function updateEmptyState(): void {
  emptyState.style.display = termManager.hasInstances() ? 'none' : 'flex';
}

function updateSessionTitleBar(): void {
  const activeId = termManager.getActiveId();
  if (activeId) {
    const cwd = sessionCwds.get(activeId) || '';
    // 左侧目录树顶部：显示最右侧目录名
    const cwdDisplay = cwd ? cwd.split('/').filter(Boolean).pop() : '';
    fileTreePath.textContent = cwdDisplay || '目录';
    fileTreePath.title = cwd || '';
    // macOS 系统窗口标题：保留完整信息
    const title = sessionTitles.get(activeId) || '';
    const displayName = sessionDisplayNames.get(activeId) || '';
    const parts = ['DuoCLI'];
    if (displayName) parts.push(displayName);
    if (title && title !== '新会话' && title !== '新对话') parts.push(title);
    window.duocli.setWindowTitle(parts.join('-'));
  } else {
    fileTreePath.textContent = '目录';
    fileTreePath.title = '';
    window.duocli.setWindowTitle('DuoCLI');
  }
}

function getActiveSessionId(): string | null {
  return termManager.getActiveId();
}

function getActiveSessionCwd(): string {
  const activeId = getActiveSessionId();
  if (activeId) return sessionCwds.get(activeId) || currentCwd;
  return currentCwd;
}

function quotePathForShell(filePath: string): string {
  // Windows/cmd 用双引号；类 Unix shell 用单引号
  if (/^[a-zA-Z]:\\/.test(filePath)) return `"${filePath.replace(/"/g, '\\"')}"`;
  return `'${filePath.replace(/'/g, `'\"'\"'`)}'`;
}

function insertPathToActiveTerminal(filePath: string): void {
  const activeId = getActiveSessionId();
  if (!activeId) return;
  writePtyWithAutoReset(activeId, quotePathForShell(filePath) + ' ');
}

function showTreeContextMenu(e: MouseEvent, itemPath: string, isDir: boolean): void {
  // 移除已有菜单
  document.querySelectorAll('.term-context-menu').forEach(m => m.remove());

  const menu = document.createElement('div');
  menu.className = 'term-context-menu';

  const items: Array<{ label: string; action: () => void }> = [];

  if (isDir) {
    items.push(
      { label: '复制绝对路径', action: () => { navigator.clipboard.writeText(itemPath); } },
      { label: '在 Finder 中打开', action: () => window.duocli.openFolder(itemPath) },
      { label: '插入路径到终端', action: () => insertPathToActiveTerminal(itemPath) },
    );
  } else {
    items.push(
      { label: '复制绝对路径', action: () => { navigator.clipboard.writeText(itemPath); } },
      { label: '用默认应用打开', action: () => window.duocli.openFile(itemPath) },
      { label: '用编辑器打开', action: () => window.duocli.filewatcherOpen(itemPath) },
      { label: '插入路径到终端', action: () => insertPathToActiveTerminal(itemPath) },
    );
  }

  for (const it of items) {
    const el = document.createElement('div');
    el.className = 'term-context-item';
    el.textContent = it.label;
    el.addEventListener('click', () => { menu.remove(); it.action(); });
    menu.appendChild(el);
  }

  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
  document.body.appendChild(menu);

  const dismiss = (ev: Event) => {
    if (!menu.contains(ev.target as Node)) { menu.remove(); document.removeEventListener('mousedown', dismiss); }
  };
  setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
}

async function loadDirItems(dirPath: string): Promise<FileTreeItem[]> {
  if (fileTreeChildrenCache.has(dirPath)) return fileTreeChildrenCache.get(dirPath)!;
  const items = await window.duocli.fileTreeListDir(dirPath);
  fileTreeChildrenCache.set(dirPath, items);
  return items;
}

async function renderFileTree(): Promise<void> {
  const rootCwd = getActiveSessionCwd();
  if (!rootCwd) {
    fileTreeList.innerHTML = '<div class="file-tree-empty">选择会话后显示当前目录</div>';
    return;
  }

  if (fileTreeRootCwd !== rootCwd) {
    fileTreeRootCwd = rootCwd;
    fileTreeChildrenCache.clear();
    fileTreeExpandedDirs.clear();
    fileTreeExpandedDirs.add(rootCwd);
  }

  fileTreeList.innerHTML = '';

  // 先渲染根目录行
  const rootRow = document.createElement('div');
  rootRow.className = 'file-tree-row dir active-dir';
  rootRow.style.paddingLeft = '6px';

  const rootArrow = document.createElement('span');
  rootArrow.className = 'file-tree-arrow';
  rootArrow.textContent = '▼';
  rootRow.appendChild(rootArrow);

  const rootName = document.createElement('span');
  rootName.className = 'file-tree-name';
  rootName.textContent = rootCwd.split(/[/\\]/).pop() || rootCwd;
  rootName.title = rootCwd;
  rootRow.appendChild(rootName);

  const rootOpenBtn = document.createElement('span');
  rootOpenBtn.className = 'file-tree-open-folder';
  rootOpenBtn.textContent = '\u{1F4C2}';
  rootOpenBtn.title = '在 Finder 中打开';
  rootOpenBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    window.duocli.openFolder(rootCwd);
  });
  rootRow.appendChild(rootOpenBtn);

  rootRow.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showTreeContextMenu(e as MouseEvent, rootCwd, true);
  });

  fileTreeList.appendChild(rootRow);

  const rootItems = await loadDirItems(rootCwd);

  const appendRows = async (items: FileTreeItem[], level: number): Promise<void> => {
    for (const item of items) {
      const row = document.createElement('div');
      row.className = `file-tree-row ${item.isDir ? 'dir' : 'file'}`;
      row.style.paddingLeft = `${6 + level * 14}px`;
      if (item.isDir && fileTreeExpandedDirs.has(item.path)) row.classList.add('active-dir');

      const arrow = document.createElement('span');
      arrow.className = 'file-tree-arrow';
      if (item.isDir) arrow.textContent = fileTreeExpandedDirs.has(item.path) ? '▼' : '▶';
      row.appendChild(arrow);

      const name = document.createElement('span');
      name.className = 'file-tree-name';
      name.textContent = item.name;
      name.title = item.path;
      row.appendChild(name);

      // 目录行：添加"在 Finder 中打开"图标按钮
      if (item.isDir) {
        const openFolderBtn = document.createElement('span');
        openFolderBtn.className = 'file-tree-open-folder';
        openFolderBtn.textContent = '\u{1F4C2}';
        openFolderBtn.title = '在 Finder 中打开';
        openFolderBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          window.duocli.openFolder(item.path);
        });
        row.appendChild(openFolderBtn);
      }

      row.addEventListener('click', async () => {
        if (item.isDir) {
          const wasExpanded = fileTreeExpandedDirs.has(item.path);
          if (wasExpanded) fileTreeExpandedDirs.delete(item.path);
          else fileTreeExpandedDirs.add(item.path);
          await renderFileTree();
          // 展开后滚动到该目录位置
          if (!wasExpanded) {
            requestAnimationFrame(() => {
              row.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
          }
        } else {
          window.duocli.openFile(item.path);
        }
      });

      // 右键菜单：文件和目录都支持
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showTreeContextMenu(e as MouseEvent, item.path, item.isDir);
      });

      fileTreeList.appendChild(row);

      if (item.isDir && fileTreeExpandedDirs.has(item.path)) {
        const children = await loadDirItems(item.path);
        await appendRows(children, level + 1);
      }
    }
  };

  await appendRows(rootItems, 0);
  if (!fileTreeList.children.length) {
    fileTreeList.innerHTML = '<div class="file-tree-empty">目录为空</div>';
  }
}

async function refreshFileTree(force = false): Promise<void> {
  if (force) {
    fileTreeChildrenCache.clear();
  }
  await renderFileTree();
}

// 确认弹窗
function showConfirmDialog(title: string, kind = '终端'): Promise<'close' | 'cancel'> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog';
    dialog.innerHTML = `
      <h3>关闭${kind}</h3>
      <p>确定要关闭「${title}」吗？</p>
      <div class="confirm-buttons">
        <button class="btn-cancel">取消</button>
        <button class="btn-close-confirm" autofocus>关闭</button>
      </div>`;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    const cleanup = (r: 'close' | 'cancel') => { overlay.remove(); resolve(r); };
    dialog.querySelector('.btn-cancel')!.addEventListener('click', () => cleanup('cancel'));
    const closeBtn = dialog.querySelector<HTMLButtonElement>('.btn-close-confirm')!;
    closeBtn.addEventListener('click', () => cleanup('close'));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup('cancel'); });
    // 键盘操作：Enter 关闭，Escape 取消
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); cleanup('close'); }
      else if (e.key === 'Escape') { e.preventDefault(); cleanup('cancel'); }
    };
    overlay.addEventListener('keydown', handleKey);
    closeBtn.focus();
  });
}

// ========== 渲染 ==========

function startTitleEdit(id: string, titleSpan: HTMLElement): void {
  // 如果正在编辑其他会话，先取消
  if (editingTitleId && editingTitleId !== id) {
    renderSessionList();
  }
  editingTitleId = id;
  const current = sessionTitles.get(id) || '';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'session-title-input';
  input.value = current;
  input.dataset.sessionId = id;
  titleSpan.replaceWith(input);
  input.focus();
  input.select();
  let committed = false;
  const commit = () => {
    if (committed) return;
    committed = true;
    editingTitleId = null;
    const val = input.value.trim();
    if (val && val !== current) {
      sessionTitles.set(id, val);
      sessionTitleLocked.add(id);
      window.duocli.renamePty(id, val);
    }
    renderSessionList();
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { editingTitleId = null; input.value = current; input.blur(); }
  });
}

function showSessionContextMenu(e: MouseEvent, targetId: string): void {
  document.querySelectorAll('.term-context-menu').forEach(m => m.remove());

  const menu = document.createElement('div');
  menu.className = 'term-context-menu';
  const targetCwd = sessionCwds.get(targetId) || '';
  const targetCwdKey = normalizeCwd(targetCwd);

  const items: Array<{ label: string; action: () => void }> = [
    {
      label: '重新生成标题',
      action: () => {
        void window.duocli.regenerateTitle(targetId);
      },
    },
    {
      label: '关闭其他对话',
      action: () => {
        destroySessions(Array.from(sessionTitles.keys()).filter(id => id !== targetId));
      },
    },
    {
      label: '关闭本项目下其他对话',
      action: () => {
        destroySessions(Array.from(sessionTitles.keys()).filter(id =>
          id !== targetId && normalizeCwd(sessionCwds.get(id) || '') === targetCwdKey
        ));
      },
    },
    {
      label: '关闭所有对话',
      action: () => {
        destroySessions(Array.from(sessionTitles.keys()));
      },
    },
  ];

  for (const it of items) {
    const el = document.createElement('div');
    el.className = 'term-context-item';
    el.textContent = it.label;
    el.addEventListener('click', () => { menu.remove(); it.action(); });
    menu.appendChild(el);
  }

  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
  document.body.appendChild(menu);

  const dismiss = (ev: Event) => {
    if (!menu.contains(ev.target as Node)) { menu.remove(); document.removeEventListener('mousedown', dismiss); }
  };
  setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
}

function renderSessionList(): void {
  const activeId = termManager.getActiveId();

  // 同步会话状态到 main 进程（供手机端读取）
  syncSessionStatusToMain();

  // 如果有正在编辑的标题，检查 input 是否还在 DOM 中
  if (editingTitleId) {
    const existingInput = sessionList.querySelector(`input[data-session-id="${editingTitleId}"]`) as HTMLInputElement | null;
    if (existingInput && document.activeElement === existingInput) {
      // 正在编辑中，跳过渲染以保留编辑状态
      return;
    }
    // input 不在 DOM 中或已失去焦点，清除编辑状态
    editingTitleId = null;
  }
  sessionList.innerHTML = '';

  // pinned 优先，其余按创建时间降序（新创建的排最上面）
  const allIds = Array.from(sessionTitles.keys());
  const byCreated = (a: string, b: string) =>
    getSessionCreateTime(b) - getSessionCreateTime(a);
  const sortedIds = [
    ...allIds.filter(id => pinnedSessions.has(id)).sort(byCreated),
    ...allIds.filter(id => !pinnedSessions.has(id)).sort(byCreated),
  ];

  // 按 cwd 分组（组间顺序固定：按该组最早会话的创建时间排序，新建不改变组顺序）
  // 同一目录可能因末尾斜杠 / macOS /private 前缀差异被拆成多组，先归一化再分组
  const groups: Map<string, string[]> = new Map();
  const groupDisplayCwd: Map<string, string> = new Map();
  const groupFirstCreatedAt: Map<string, number> = new Map(); // 组排序键：该组最早会话的创建时间
  for (const id of sortedIds) {
    const rawCwd = sessionCwds.get(id) || '';
    const key = normalizeCwd(rawCwd);
    if (!groups.has(key)) {
      groups.set(key, []);
      groupDisplayCwd.set(key, rawCwd);
      // 记录该组第一个出现的会话创建时间（sortedIds 已按时间排好，第一个就是最早的）
      groupFirstCreatedAt.set(key, getSessionCreateTime(id));
    }
    groups.get(key)!.push(id);
  }

  // 组间排序：置顶组优先，其余按首个会话创建时间升序（先创建的组在上面）
  const pinnedGroupKeys = new Set<string>();
  for (const id of pinnedSessions) {
    const key = normalizeCwd(sessionCwds.get(id) || '');
    if (key) pinnedGroupKeys.add(key);
  }
  const sortedGroupKeys = Array.from(groups.keys()).sort((a, b) => {
    const aPinned = pinnedGroupKeys.has(a);
    const bPinned = pinnedGroupKeys.has(b);
    if (aPinned !== bPinned) return aPinned ? -1 : 1;
    return (groupFirstCreatedAt.get(a) || 0) - (groupFirstCreatedAt.get(b) || 0);
  });

  for (const groupKey of sortedGroupKeys) {
    const ids = groups.get(groupKey)!;
    const cwd = groupDisplayCwd.get(groupKey) || groupKey;
    const color = cwdToColor(cwd);

    // 分组头
    const groupHeader = document.createElement('div');
    groupHeader.className = 'session-group-header';
    groupHeader.style.borderLeftColor = color;
    const groupName = document.createElement('span');
    groupName.className = 'session-group-name';
    groupName.textContent = cwdShortName(cwd);
    groupName.title = cwd;
    // 添加按钮：点击在该目录下创建新终端
    const groupAddBtn = document.createElement('button');
    groupAddBtn.className = 'session-group-add-btn';
    groupAddBtn.textContent = '+';
    groupAddBtn.title = '在此目录下创建新终端';
    groupAddBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openNewSessionDialog(cwd);
    });
    const groupCount = document.createElement('span');
    groupCount.className = 'session-group-count';
    groupCount.textContent = String(ids.length);
    groupHeader.appendChild(groupName);
    groupHeader.appendChild(groupAddBtn);
    groupHeader.appendChild(groupCount);
    sessionList.appendChild(groupHeader);

    // 该组下的会话
    for (const id of ids) {
      const title = sessionTitles.get(id)!;
      const isPinned = pinnedSessions.has(id);
      const item = document.createElement('div');
      item.className = 'session-item' + (id === activeId ? ' active' : '') + (isPinned ? ' pinned' : '');
      item.dataset.sessionId = id;
      item.dataset.sessionType = 'pty';

      const dot = document.createElement('span');
      dot.className = 'session-color-dot';
      if (sessionBusy.has(id)) {
        dot.style.backgroundColor = '#e5a100';
      } else if (sessionUnread.has(id)) {
        dot.style.backgroundColor = '#73c991';
      } else {
        dot.style.backgroundColor = '#666';
      }

      const pinBtn = document.createElement('button');
      pinBtn.className = 'session-pin' + (isPinned ? ' pinned' : '');
      pinBtn.textContent = '\u{1F4CC}';
      pinBtn.title = isPinned ? '取消置顶' : '置顶';
      pinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (pinnedSessions.has(id)) pinnedSessions.delete(id);
        else pinnedSessions.add(id);
        renderSessionList();
      });

      const titleSpan = document.createElement('span');
      titleSpan.className = 'session-title';
      titleSpan.textContent = title;

      // 铅笔图标按钮，点击修改名称
      const editBtn = document.createElement('button');
      editBtn.className = 'session-edit-btn';
      editBtn.textContent = '✏️';
      editBtn.title = '修改名称';
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        startTitleEdit(id, titleSpan);
      });

      const metaRow = document.createElement('div');
      metaRow.className = 'session-meta-row';
      const timeSpan = document.createElement('span');
      timeSpan.className = 'session-time';
      timeSpan.textContent = friendlyTime(sessionUpdateTimes.get(id) || Date.now());
      metaRow.appendChild(timeSpan);
      const displayName = sessionDisplayNames.get(id);
      if (displayName) {
        const nameSpan = document.createElement('span');
        nameSpan.className = 'session-display-name';
        nameSpan.textContent = displayName;
        const [tagColor, tagBg] = getCliTagColors(displayName);
        nameSpan.style.setProperty('--cli-tag-color', tagColor);
        nameSpan.style.setProperty('--cli-tag-bg', tagBg);
        metaRow.appendChild(nameSpan);
      }

      // 显示实际使用的模型提供商（如 MiniMax、GLM、Anthropic 等）
      const provider = sessionProviders.get(id);
      if (provider) {
        const providerSpan = document.createElement('span');
        providerSpan.className = 'session-provider-tag';
        providerSpan.textContent = provider;
        providerSpan.title = '实际使用的模型提供商';
        metaRow.appendChild(providerSpan);
      }

      // 第一行：dot + 置顶 + 标题 + 编辑 + 关闭按钮
      const topRow = document.createElement('div');
      topRow.className = 'session-item-top';

      const closeBtn = document.createElement('button');
      closeBtn.className = 'session-close';
      closeBtn.textContent = '\u00d7';
      closeBtn.addEventListener('click', (e) => { e.stopPropagation(); handleCloseClick(id); });

      const titleRow = document.createElement('div');
      titleRow.className = 'session-title-row';
      titleRow.appendChild(titleSpan);
      titleRow.appendChild(editBtn);
      topRow.appendChild(dot);
      topRow.appendChild(pinBtn);
      topRow.appendChild(titleRow);
      topRow.appendChild(closeBtn);

      // 第二行：时间/标签 + 催工按钮（点击弹配置弹窗）
      const autoContinueConfig = sessionAutoContinue.get(id);
      const autoContinueEnabled = autoContinueConfig?.enabled ?? false;

      const autoContinueLabel = document.createElement('span');
      autoContinueLabel.className = 'session-auto-continue-label' + (autoContinueEnabled ? ' enabled' : '');
      autoContinueLabel.textContent = '催';
      autoContinueLabel.title = autoContinueEnabled ? '循环已开启，点击配置' : '点击配置循环';
      autoContinueLabel.addEventListener('click', (e) => {
        e.stopPropagation();
        showAutoContinueConfigDialog(id);
      });

      // 自动切号状态标签（显示在"催"胶囊右侧）
      const switchStatus = sessionAutoSwitchStatus.get(id);
      let switchStatusLabel: HTMLSpanElement | null = null;
      if (switchStatus) {
        switchStatusLabel = document.createElement('span');
        switchStatusLabel.className = 'session-switch-status ' + switchStatus.status;
        switchStatusLabel.textContent = switchStatus.detail || (switchStatus.status === 'switching' ? '换号中...' : switchStatus.status === 'switched' ? '已切换' : switchStatus.status === 'exhausted' ? '账号耗尽' : '切号失败');
        switchStatusLabel.title = `自动切号: ${switchStatus.status}`;
      }

      const bottomRow = document.createElement('div');
      bottomRow.className = 'session-item-bottom';
      bottomRow.appendChild(metaRow);
      bottomRow.appendChild(autoContinueLabel);
      if (switchStatusLabel) bottomRow.appendChild(switchStatusLabel);

      // 右键菜单
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showSessionContextMenu(e, id);
      });

      // 组装
      item.addEventListener('click', () => switchSession(id));
      item.appendChild(topRow);
      item.appendChild(bottomRow);
      sessionList.appendChild(item);
    }
  }

  // Chat 会话区域
  if (chatSessionTitles.size > 0) {
    const chatHeader = document.createElement('div');
    chatHeader.className = 'session-group-header';
    chatHeader.style.borderLeftColor = '#a78bfa';
    const chatName = document.createElement('span');
    chatName.className = 'session-group-name';
    chatName.textContent = '💬 Chat 对话';
    chatHeader.appendChild(chatName);
    sessionList.appendChild(chatHeader);

    const sortedChatIds = Array.from(chatSessionTitles.keys()).sort((a, b) =>
      (chatSessionCreateTimes.get(b) || 0) - (chatSessionCreateTimes.get(a) || 0)
    );

    for (const id of sortedChatIds) {
      const title = chatSessionTitles.get(id)! || '';
      const item = document.createElement('div');
      item.className = 'session-item session-item-chat' + (id === activeChatId ? ' active' : '');
      item.dataset.sessionId = id;
      item.dataset.sessionType = 'chat';
      item.style.setProperty('--group-color', '#a78bfa12');
      const titleSpan = document.createElement('span');
      titleSpan.className = 'session-title chat-session-title';
      titleSpan.textContent = title || '新对话';
      titleSpan.style.opacity = title ? '1' : '0.5';

      const delBtn = document.createElement('button');
      delBtn.className = 'session-close-btn';
      delBtn.textContent = '✕';
      delBtn.title = '删除对话';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void handleChatCloseClick(id);
      });

      const topRow = document.createElement('div');
      topRow.className = 'session-top-row';
      topRow.appendChild(titleSpan);
      topRow.appendChild(delBtn);

      const metaRow = document.createElement('div');
      metaRow.className = 'session-meta-row';
      const timeSpan = document.createElement('span');
      timeSpan.className = 'session-time';
      timeSpan.textContent = friendlyTime(chatSessionCreateTimes.get(id) || Date.now());
      metaRow.appendChild(timeSpan);

      item.addEventListener('click', () => {
        switchToTerminal();
        switchToChat(id);
      });
      item.appendChild(topRow);
      item.appendChild(metaRow);
      sessionList.appendChild(item);
    }
  }

  // ========== 已关闭会话（可恢复） ==========
  if (closedSessions.length > 0) {
    const header = document.createElement('div');
    header.className = 'session-group-header closed-sessions-header';
    header.style.borderLeftColor = '#888';

    const name = document.createElement('span');
    name.className = 'session-group-name';
    name.textContent = `🔄 已关闭 (${closedSessions.length})`;

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'session-group-add-btn';
    toggleBtn.textContent = closedSessionsCollapsed ? '▸' : '▾';
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closedSessionsCollapsed = !closedSessionsCollapsed;
      renderSessionList();
    });

    const clearBtn = document.createElement('button');
    clearBtn.className = 'session-group-add-btn';
    clearBtn.textContent = '✕';
    clearBtn.title = '清空全部';
    clearBtn.style.color = '#f87171';
    clearBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      closedSessions = await window.duocli.closedSessionsClear();
      renderSessionList();
    });

    header.appendChild(name);
    header.appendChild(toggleBtn);
    header.appendChild(clearBtn);
    sessionList.appendChild(header);

    if (!closedSessionsCollapsed) {
      // 按关闭时间降序（最近关闭排最前）
      const sorted = [...closedSessions].sort((a, b) => b.closedAt - a.closedAt);
      for (const cs of sorted) {
        const item = document.createElement('div');
        item.className = 'session-item session-item-closed';
        item.style.setProperty('--group-color', '#88888812');

        const titleSpan = document.createElement('span');
        titleSpan.className = 'session-title';
        titleSpan.textContent = cs.title || '新对话';
        titleSpan.style.opacity = cs.title ? '1' : '0.5';

        const metaRow = document.createElement('div');
        metaRow.className = 'session-meta-row';
        const timeSpan = document.createElement('span');
        timeSpan.className = 'session-time';
        timeSpan.textContent = friendlyTime(cs.closedAt);
        metaRow.appendChild(timeSpan);
        if (cs.displayName) {
          const nameSpan = document.createElement('span');
          nameSpan.className = 'session-display-name';
          nameSpan.textContent = cs.displayName;
          const [tagColor, tagBg] = getCliTagColors(cs.displayName);
          nameSpan.style.setProperty('--cli-tag-color', tagColor);
          nameSpan.style.setProperty('--cli-tag-bg', tagBg);
          metaRow.appendChild(nameSpan);
        }

        const restoreBtn = document.createElement('button');
        restoreBtn.className = 'session-edit-btn';
        restoreBtn.textContent = '↩';
        restoreBtn.title = '恢复会话';
        restoreBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          restoreClosedSession(cs);
        });

        const delBtn = document.createElement('button');
        delBtn.className = 'session-close';
        delBtn.textContent = '×';
        delBtn.title = '删除记录';
        delBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          closedSessions = await window.duocli.closedSessionsRemove(cs.id);
          renderSessionList();
        });

        const titleRow = document.createElement('div');
        titleRow.className = 'session-title-row';
        titleRow.appendChild(titleSpan);
        titleRow.appendChild(restoreBtn);

        const topRow = document.createElement('div');
        topRow.className = 'session-item-top';
        const dot = document.createElement('span');
        dot.className = 'session-color-dot';
        dot.style.backgroundColor = '#555';
        topRow.appendChild(dot);
        topRow.appendChild(titleRow);
        topRow.appendChild(delBtn);

        item.appendChild(topRow);
        item.appendChild(metaRow);
        sessionList.appendChild(item);
      }
    }
  }

  // ========== 已关闭 Chat 会话（可恢复） ==========
  if (closedChatSessions.length > 0) {
    const header = document.createElement('div');
    header.className = 'session-group-header closed-sessions-header';
    header.style.borderLeftColor = '#a78bfa';

    const name = document.createElement('span');
    name.className = 'session-group-name';
    name.textContent = `💬 已关闭对话 (${closedChatSessions.length})`;

    const clearBtn = document.createElement('button');
    clearBtn.className = 'session-group-add-btn';
    clearBtn.textContent = '✕';
    clearBtn.title = '清空全部';
    clearBtn.style.color = '#f87171';
    clearBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      closedChatSessions = await window.duocli.closedChatClear();
      renderSessionList();
    });

    header.appendChild(name);
    header.appendChild(clearBtn);
    sessionList.appendChild(header);

    const sorted = [...closedChatSessions].sort((a, b) => b.closedAt - a.closedAt);
    for (const cs of sorted) {
      const item = document.createElement('div');
      item.className = 'session-item session-item-closed session-item-chat';
      item.style.setProperty('--group-color', '#a78bfa12');

      const titleSpan = document.createElement('span');
      titleSpan.className = 'session-title chat-session-title';
      titleSpan.textContent = cs.title || '新对话';
      titleSpan.style.opacity = cs.title ? '1' : '0.5';

      const metaRow = document.createElement('div');
      metaRow.className = 'session-meta-row';
      const timeSpan = document.createElement('span');
      timeSpan.className = 'session-time';
      timeSpan.textContent = friendlyTime(cs.closedAt);
      metaRow.appendChild(timeSpan);

      const restoreBtn = document.createElement('button');
      restoreBtn.className = 'session-edit-btn';
      restoreBtn.textContent = '↩';
      restoreBtn.title = '恢复对话';
      restoreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        restoreClosedChatSession(cs);
      });

      const delBtn = document.createElement('button');
      delBtn.className = 'session-close';
      delBtn.textContent = '×';
      delBtn.title = '删除记录';
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        closedChatSessions = await window.duocli.closedChatRemove(cs.id);
        renderSessionList();
      });

      const titleRow = document.createElement('div');
      titleRow.className = 'session-title-row';
      titleRow.appendChild(titleSpan);
      titleRow.appendChild(restoreBtn);

      const topRow = document.createElement('div');
      topRow.className = 'session-item-top';
      const dot = document.createElement('span');
      dot.className = 'session-color-dot';
      dot.style.backgroundColor = '#a78bfa';
      topRow.appendChild(dot);
      topRow.appendChild(titleRow);
      topRow.appendChild(delBtn);

      // 点击整个 item 也可恢复
      item.addEventListener('click', () => {
        restoreClosedChatSession(cs);
      });

      item.appendChild(topRow);
      item.appendChild(metaRow);
      sessionList.appendChild(item);
    }
  }
}

// ========== 核心操作 ==========

// 恢复已关闭的会话
async function restoreClosedSession(cs: ClosedSessionInfo): Promise<void> {
  // 优先用终端输出的完整恢复命令，兜底自己拼
  const resumeCmd = cs.resumeCommand
    || (cs.presetCommand
      ? `${cs.presetCommand} --resume ${cs.resumeId}`
      : `claude --resume ${cs.resumeId}`);
  const cwd = cs.cwd || sessionCwds.get(termManager.getActiveId() || '') || '';
  const themeId = resolveThemeId(currentThemeId, cwd);

  const result = await window.duocli.createPty(cwd, resumeCmd, themeId);
  const now = Date.now();
  sessionTitles.set(result.id, cs.title);
  sessionThemes.set(result.id, result.themeId);
  sessionUpdateTimes.set(result.id, now);
  sessionCreateTimes.set(result.id, now);
  sessionCwds.set(result.id, result.cwd);
  sessionDisplayNames.set(result.id, cs.displayName || result.displayName);
  termManager.create(result.id, result.themeId, cwd, (data) => { writePtyWithAutoReset(result.id, data); });

  // 从已关闭列表中移除
  closedSessions = await window.duocli.closedSessionsRemove(cs.id);

  updateEmptyState();
  renderSessionList();
  updateSessionTitleBar();
  void renderFileTree();
  setTimeout(() => {
    const dims = termManager.getActiveDimensions();
    if (dims) window.duocli.resizePty(result.id, dims.cols, dims.rows);
  }, 100);
}

// 恢复已关闭的 Chat 会话
async function restoreClosedChatSession(cs: ClosedChatSessionInfo): Promise<void> {
  try {
    const result = await window.duocli.chatRestore(cs.id);
    if (!result) return;
    const now = Date.now();
    chatSessionTitles.set(result.id, result.title);
    chatSessionCreateTimes.set(result.id, now);
    // 从已关闭列表中移除
    closedChatSessions = await window.duocli.closedChatRemove(cs.id);
    switchToTerminal();
    switchToChat(result.id);
    renderSessionList();
  } catch (e) {
    console.error('恢复 Chat 会话失败:', e);
  }
}

async function createSession(): Promise<boolean> {
  if (!currentCwd) { alert('请先选择工作目录'); return false; }

  addRecentCwd(currentCwd);
  const preset = presetSelect.value;
  const themeId = resolveThemeId(currentThemeId, currentCwd);
  lastPreset = preset;
  localStorage.setItem('duocli_preset', preset);
  const result = await window.duocli.createPty(currentCwd, preset, themeId);
  const now = Date.now();
  sessionTitles.set(result.id, result.title);
  sessionThemes.set(result.id, result.themeId);
  sessionUpdateTimes.set(result.id, now);
  sessionCreateTimes.set(result.id, now);
  sessionCwds.set(result.id, result.cwd);
  sessionDisplayNames.set(result.id, result.displayName);
  // 自定义预设：用用户定义的名称覆盖后端 fallback
  const customPreset = getCustomPresets().find(p =>
    preset === p.command || (p.autoFlag && preset === p.command + ' ' + p.autoFlag)
  );
  if (customPreset) {
    const isAuto = customPreset.autoFlag && preset === customPreset.command + ' ' + customPreset.autoFlag;
    const displayName = isAuto ? customPreset.name + '全自动' : customPreset.name;
    sessionDisplayNames.set(result.id, displayName);
  }
  // 初始化终端
  termManager.create(result.id, result.themeId, currentCwd, (data) => { writePtyWithAutoReset(result.id, data); });
  updateEmptyState();
  renderSessionList();
  updateSessionTitleBar();
  void renderFileTree();
  setTimeout(() => {
    const dims = termManager.getActiveDimensions();
    if (dims) window.duocli.resizePty(result.id, dims.cols, dims.rows);
  }, 100);
  return true;
}

function switchSession(id: string): void {
  // 确保从 chat 视图切回终端视图
  switchToTerminal();

  const prev = termManager.getActiveId();
  termManager.switchTo(id);

  // 用户切换到该会话 → 清除所有状态指示灯（黄/绿→灰）
  const hadUnread = sessionUnread.delete(id);
  const hadBusy = sessionBusy.delete(id);
  // 切换到不同会话才重渲染列表，避免重建 DOM 导致 dblclick 无法触发
  if (prev !== id || hadUnread || hadBusy) renderSessionList();
  updateSessionTitleBar();
  void renderFileTree();
  renderFileStatusbar();
  const dims = termManager.getActiveDimensions();
  if (dims) window.duocli.resizePty(id, dims.cols, dims.rows);
}

// 点击 × 时弹确认
async function handleCloseClick(id: string): Promise<void> {
  const title = sessionTitles.get(id) || '终端';
  const action = await showConfirmDialog(title);
  if (action === 'cancel') return;
  destroySession(id);
}

async function handleChatCloseClick(id: string): Promise<void> {
  const title = chatSessionTitles.get(id) || '新对话';
  const action = await showConfirmDialog(title, '对话');
  if (action === 'cancel') return;
  destroyChatSession(id);
}

async function closeCurrentSession(): Promise<void> {
  if (document.querySelector('.confirm-overlay')) return;

  if (activeChatId) {
    await handleChatCloseClick(activeChatId);
    return;
  }

  const activeId = termManager.getActiveId();
  if (activeId) await handleCloseClick(activeId);
}

// 彻底关闭终端
function clearSessionState(id: string): void {
  sessionTitles.delete(id);
  sessionThemes.delete(id);
  sessionUpdateTimes.delete(id);
  sessionCreateTimes.delete(id);
  sessionUnread.delete(id);
  sessionBusy.delete(id);
  clearTimeout(unreadTimers.get(id));
  unreadTimers.delete(id);
  recentDataBuffer.delete(id);
  sessionTitleLocked.delete(id);
  pinnedSessions.delete(id);
  sessionCwds.delete(id);
  sessionDisplayNames.delete(id);
  sessionProviders.delete(id);
  sessionClaudeProviderIds.delete(id);
  sessionAutoContinue.delete(id);
  sessionAutoSwitchStatus.delete(id);
}

function destroySession(id: string): void {
  window.duocli.destroyPty(id);
  clearSessionState(id);
  saveAutoContinueToStorage();
  termManager.destroy(id);
  updateEmptyState();
  renderSessionList();
  updateSessionTitleBar();
  void renderFileTree();
}

function destroySessions(ids: string[]): void {
  const uniqIds = Array.from(new Set(ids)).filter(id => sessionTitles.has(id));
  if (uniqIds.length === 0) return;
  for (const id of uniqIds) {
    window.duocli.destroyPty(id);
    clearSessionState(id);
    termManager.destroy(id);
  }
  saveAutoContinueToStorage();
  updateEmptyState();
  renderSessionList();
  updateSessionTitleBar();
  void renderFileTree();
}

// ========== Chat 会话管理 ==========

async function createChatSession(workspace?: string): Promise<void> {
  const ws = workspace || currentCwd || '';
  try {
    const result = await window.duocli.chatCreate({ workspace: ws });
    if (!result) return;
    const now = Date.now();
    chatSessionTitles.set(result.id, result.title);
    chatSessionCreateTimes.set(result.id, now);
    switchToChat(result.id);
    renderSessionList();
  } catch (e) {
    console.error('创建聊天会话失败:', e);
  }
}

function switchToChat(id: string): void {
  // 隐藏终端区域，显示聊天区域
  terminalContent.style.display = 'none';
  chatContent.style.display = 'flex';
  chatContent.style.flexDirection = 'column';
  chatContent.style.height = '100%';
  chatEmptyState.style.display = 'none';

  // 销毁旧的 chat view
  if (activeChatId && activeChatId !== id) {
    const oldView = chatViews.get(activeChatId);
    oldView?.destroy();
    chatViews.delete(activeChatId);
  }

  activeChatId = id;

  // 创建或恢复 chat view
  let view = chatViews.get(id);
  if (!view) {
    view = new ChatView(chatContent, id, {
      onTitleChange: (sessionId, title) => {
        chatSessionTitles.set(sessionId, title);
        renderSessionList();
      },
    });
    chatViews.set(id, view);
  }
  view.focus();
}

function switchToTerminal(): void {
  chatContent.style.display = 'none';
  terminalContent.style.display = '';
  activeChatId = null;
  updateEmptyState();
}

function destroyChatSession(id: string): void {
  window.duocli.chatDestroy(id);
  const view = chatViews.get(id);
  view?.destroy();
  chatViews.delete(id);
  chatSessionTitles.delete(id);
  chatSessionCreateTimes.delete(id);
  if (activeChatId === id) {
    activeChatId = null;
    switchToTerminal();
  }
  renderSessionList();
}

async function browseCwd(): Promise<void> {
  const folder = await window.duocli.selectFolder(currentCwd || undefined);
  if (folder) {
    currentCwd = folder;
    cwdInput.value = folder;
    localStorage.setItem('duocli_cwd', folder);
    addRecentCwd(folder);
    startFileWatcher(folder);
    void renderFileTree();
  }
}

// ========== 文件监听 ==========

function startFileWatcher(cwd: string): void {
  globalRecentFiles = [];
  renderFileStatusbar();
  window.duocli.filewatcherStart(cwd);
}

// ========== AI 配置 ==========

async function refreshAiConfig(): Promise<void> {
  // 从主进程加载当前生效的配置，填充到表单
  const config = await window.duocli.aiGetCurrentConfig();
  if (config) {
    aiFormatSelect.value = config.apiFormat || 'anthropic';
    aiBaseurlInput.value = config.baseUrl || '';
    aiApikeyInput.value = config.apiKey || '';
    aiModelInput.value = config.model || '';
  }
}


async function handleAiApply(): Promise<void> {
  const config = {
    apiFormat: aiFormatSelect.value,
    baseUrl: aiBaseurlInput.value.trim(),
    apiKey: aiApikeyInput.value.trim(),
    model: aiModelInput.value.trim(),
  };
  if (!config.baseUrl) {
    aiApplyBtn.textContent = '请填写 Base URL';
    setTimeout(() => { aiApplyBtn.textContent = '保存'; }, 1500);
    return;
  }
  await window.duocli.aiApplyConfig(config);
  aiApplyBtn.textContent = '已保存';
  setTimeout(() => { aiApplyBtn.textContent = '保存'; }, 1500);
}

async function handleAiTest(): Promise<void> {
  const config = {
    apiFormat: aiFormatSelect.value,
    baseUrl: aiBaseurlInput.value.trim(),
    apiKey: aiApikeyInput.value.trim(),
    model: aiModelInput.value.trim(),
  };
  if (!config.baseUrl) {
    aiTestBtn.textContent = '请先填写配置';
    setTimeout(() => { aiTestBtn.textContent = '测试'; }, 1500);
    return;
  }
  aiTestBtn.textContent = '测试中...';
  aiTestBtn.setAttribute('disabled', 'true');
  try {
    const result = await window.duocli.aiTestConfig(config);
    if (result.ok) {
      aiTestBtn.textContent = '✓ 连接成功';
    } else {
      aiTestBtn.textContent = '✗ 失败';
      alert('AI 配置测试失败：\n' + (result.error || '未知错误'));
    }
  } catch (e: any) {
    aiTestBtn.textContent = '✗ 失败';
    alert('AI 配置测试失败：\n' + (e.message || '未知错误'));
  } finally {
    aiTestBtn.removeAttribute('disabled');
    setTimeout(() => { aiTestBtn.textContent = '测试'; }, 2000);
  }
}

function switchTab(tabName: string): void {
  sidebarTabs.forEach((tab) => {
    tab.classList.toggle('active', tab.getAttribute('data-tab') === tabName);
  });
  tabSessions.classList.toggle('active', tabName === 'sessions');
  tabAiConfig.classList.toggle('active', tabName === 'ai-config');
  tabDevinAccounts.classList.toggle('active', tabName === 'devin-accounts');
  if (tabName === 'ai-config') refreshAiConfig();
  if (tabName === 'devin-accounts') refreshDevinAccounts();
}

// ========== 事件绑定 ==========

cwdBrowseBtn.addEventListener('click', browseCwd);
cwdOpenBtn.addEventListener('click', () => { if (currentCwd) window.duocli.openFolder(currentCwd); });

// 最近工作目录下拉
function renderRecentCwdDropdown(): void {
  cwdRecentDropdown.innerHTML = '';
  const list = getRecentCwds();
  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'cwd-recent-empty';
    empty.textContent = '暂无最近目录';
    cwdRecentDropdown.appendChild(empty);
    return;
  }
  for (const path of list) {
    const item = document.createElement('div');
    item.className = 'cwd-recent-item';
    item.textContent = path;
    item.title = path;
    item.addEventListener('click', () => {
      currentCwd = path;
      cwdInput.value = path;
      localStorage.setItem('duocli_cwd', path);
      addRecentCwd(path);
      startFileWatcher(path);
      void renderFileTree();
      cwdRecentDropdown.classList.remove('open');
    });
    cwdRecentDropdown.appendChild(item);
  }
}

cwdRecentBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const isOpen = cwdRecentDropdown.classList.contains('open');
  if (isOpen) {
    cwdRecentDropdown.classList.remove('open');
  } else {
    renderRecentCwdDropdown();
    cwdRecentDropdown.classList.add('open');
  }
});

document.addEventListener('click', () => {
  cwdRecentDropdown.classList.remove('open');
});
cwdRecentDropdown.addEventListener('click', (e) => { e.stopPropagation(); });
cwdInput.addEventListener('change', () => {
  const v = cwdInput.value.trim();
  if (v) {
    currentCwd = v;
    localStorage.setItem('duocli_cwd', v);
    addRecentCwd(v);
    startFileWatcher(v);
    void renderFileTree();
  }
});
cwdInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') cwdInput.blur(); });

// ========== 面板收起/展开与拖拽功能 ==========

// 左侧目录树收起/展开
let fileTreeCollapsed = false;
let fileTreeLastWidth = 220;

fileTreeToggle.addEventListener('click', () => {
  fileTreeCollapsed = !fileTreeCollapsed;
  if (fileTreeCollapsed) {
    fileTreeLastWidth = fileTreePanel.offsetWidth;
    fileTreePanel.classList.add('collapsed');
    fileTreeToggle.classList.add('collapsed');
    fileTreeToggle.textContent = '\u25B6';
  } else {
    fileTreePanel.style.width = fileTreeLastWidth + 'px';
    fileTreePanel.classList.remove('collapsed');
    fileTreeToggle.classList.remove('collapsed');
    fileTreeToggle.textContent = '\u25C4';
  }
  localStorage.setItem('duocli_filetree_collapsed', String(fileTreeCollapsed));
});

// 右侧边栏收起/展开
let sidebarCollapsed = false;
let sidebarLastWidth = 260;

sidebarToggle.addEventListener('click', () => {
  sidebarCollapsed = !sidebarCollapsed;
  if (sidebarCollapsed) {
    sidebarLastWidth = sidebar.offsetWidth;
    sidebar.classList.add('collapsed');
    sidebarToggle.classList.add('collapsed');
    sidebarToggle.textContent = '\u25C0';
  } else {
    sidebar.style.width = sidebarLastWidth + 'px';
    sidebar.classList.remove('collapsed');
    sidebarToggle.classList.remove('collapsed');
    sidebarToggle.textContent = '\u25B6';
  }
  localStorage.setItem('duocli_sidebar_collapsed', String(sidebarCollapsed));
});

// 拖拽调整宽度
interface DragState {
  isDragging: boolean;
  panel: HTMLElement | null;
  startX: number;
  startWidth: number;
  minWidth: number;
  maxWidth: number;
}

const dragState: DragState = {
  isDragging: false,
  panel: null,
  startX: 0,
  startWidth: 0,
  minWidth: 0,
  maxWidth: 0
};

// 左侧目录树拖拽
fileTreeResizer.addEventListener('mousedown', (e) => {
  if (fileTreeCollapsed) return;
  e.preventDefault();
  dragState.isDragging = true;
  dragState.panel = fileTreePanel;
  dragState.startX = e.clientX;
  dragState.startWidth = fileTreePanel.offsetWidth;
  dragState.minWidth = 160;
  dragState.maxWidth = 500;
  fileTreeResizer.classList.add('active');
});

// 右侧边栏拖拽
sidebarResizer.addEventListener('mousedown', (e) => {
  if (sidebarCollapsed) return;
  e.preventDefault();
  dragState.isDragging = true;
  dragState.panel = sidebar;
  dragState.startX = e.clientX;
  dragState.startWidth = sidebar.offsetWidth;
  dragState.minWidth = 180;
  dragState.maxWidth = 500;
  sidebarResizer.classList.add('active');
});

document.addEventListener('mousemove', (e) => {
  if (!dragState.isDragging || !dragState.panel) return;
  const deltaX = e.clientX - dragState.startX;
  let newWidth;
  if (dragState.panel === fileTreePanel) {
    newWidth = dragState.startWidth + deltaX;
  } else {
    newWidth = dragState.startWidth - deltaX;
  }
  newWidth = Math.max(dragState.minWidth, Math.min(dragState.maxWidth, newWidth));
  dragState.panel.style.width = newWidth + 'px';
});

document.addEventListener('mouseup', () => {
  if (dragState.isDragging) {
    dragState.isDragging = false;
    fileTreeResizer.classList.remove('active');
    sidebarResizer.classList.remove('active');
    if (dragState.panel === fileTreePanel) {
      localStorage.setItem('duocli_filetree_width', String(fileTreePanel.offsetWidth));
    } else if (dragState.panel === sidebar) {
      localStorage.setItem('duocli_sidebar_width', String(sidebar.offsetWidth));
    }
    dragState.panel = null;
  }
});

// 恢复保存的面板状态
(function restorePanelStates() {
  const savedFileTreeWidth = localStorage.getItem('duocli_filetree_width');
  if (savedFileTreeWidth) {
    fileTreePanel.style.width = savedFileTreeWidth + 'px';
    fileTreeLastWidth = parseInt(savedFileTreeWidth);
  }
  const savedSidebarWidth = localStorage.getItem('duocli_sidebar_width');
  if (savedSidebarWidth) {
    sidebar.style.width = savedSidebarWidth + 'px';
    sidebarLastWidth = parseInt(savedSidebarWidth);
  }
  const savedFileTreeCollapsed = localStorage.getItem('duocli_filetree_collapsed');
  if (savedFileTreeCollapsed === 'true') {
    fileTreeCollapsed = true;
    fileTreePanel.classList.add('collapsed');
    fileTreeToggle.classList.add('collapsed');
    fileTreeToggle.textContent = '\u25B6';
  }
  const savedSidebarCollapsed = localStorage.getItem('duocli_sidebar_collapsed');
  if (savedSidebarCollapsed === 'true') {
    sidebarCollapsed = true;
    sidebar.classList.add('collapsed');
    sidebarToggle.classList.add('collapsed');
    sidebarToggle.textContent = '\u25C0';
  }
})();

fileTreeRefreshBtn.addEventListener('click', () => { void refreshFileTree(true); });

// 打开目录按钮
fileTreeOpenBtn.addEventListener('click', () => {
  const activeId = termManager.getActiveId();
  if (activeId) {
    const cwd = sessionCwds.get(activeId);
    if (cwd) {
      window.duocli.openFolder(cwd);
    }
  }
});

// 目录自动刷新 - 每30秒刷新一次
let fileTreeAutoRefreshTimer: ReturnType<typeof setInterval> | null = null;
function startFileTreeAutoRefresh(): void {
  if (fileTreeAutoRefreshTimer) return;
  fileTreeAutoRefreshTimer = setInterval(() => {
    const activeId = termManager.getActiveId();
    if (activeId) {
      void refreshFileTree(true);
    }
  }, 30000);
}
function stopFileTreeAutoRefresh(): void {
  if (fileTreeAutoRefreshTimer) {
    clearInterval(fileTreeAutoRefreshTimer);
    fileTreeAutoRefreshTimer = null;
  }
}
// 启动自动刷新
startFileTreeAutoRefresh();

// 桌面端拖拽文件到终端区域：自动粘贴文件路径
// 在 document 层面监听，确保拖拽到 xterm 内部也能捕获
document.addEventListener('dragover', (e) => {
  if (!e.dataTransfer) return;
  // 只有当数据来自外部文件时才处理
  if (e.dataTransfer.types.includes('Files')) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    terminalArea.classList.add('drag-over');
  }
});

document.addEventListener('dragleave', (e) => {
  if (e.target === document && !terminalArea.contains(e.relatedTarget as Node)) {
    terminalArea.classList.remove('drag-over');
  }
});

document.addEventListener('drop', (e) => {
  e.preventDefault();
  terminalArea.classList.remove('drag-over');
  // 只有当数据来自外部文件时才处理
  const files = Array.from(e.dataTransfer?.files || []);
  if (!files.length) return;
  const activeId = getActiveSessionId();
  if (!activeId) {
    alert('请先选择一个终端会话');
    return;
  }
  const payload = files.map((f) => quotePathForShell(f.path)).join(' ') + ' ';
  writePtyWithAutoReset(activeId, payload);
});

function openNewSessionDialog(cwd?: string): void {
  const targetCwd = (cwd || currentCwd || '').trim();
  cwdInput.value = targetCwd;
  // 程序设值不触发 change 事件，需手动同步 currentCwd，
  // 否则点击分组头加号创建的终端仍走旧 currentCwd
  if (targetCwd && targetCwd !== currentCwd) {
    currentCwd = targetCwd;
    localStorage.setItem('duocli_cwd', targetCwd);
    addRecentCwd(targetCwd);
    startFileWatcher(targetCwd);
    void renderFileTree();
  }
  presetSelect.value = lastPreset || presetSelect.value || '';
  setThemeValue(currentThemeId);
  newSessionOverlay.classList.add('active');
  setTimeout(() => cwdInput.focus(), 0);
}

function closeNewSessionDialog(): void {
  newSessionOverlay.classList.remove('active');
  cwdRecentDropdown.classList.remove('open');
  themeSelect.classList.remove('open');
}

toolbarNewBtn.addEventListener('click', () => { openNewSessionDialog(); });
newSessionCloseBtn.addEventListener('click', () => { closeNewSessionDialog(); });
newSessionCancelBtn.addEventListener('click', () => { closeNewSessionDialog(); });
newSessionOverlay.addEventListener('click', (e) => {
  if (e.target === newSessionOverlay) closeNewSessionDialog();
});
newSessionCreateBtn.addEventListener('click', async () => {
  const ok = await createSession();
  if (ok) closeNewSessionDialog();
});

// 自定义预设按钮
presetAddBtn.addEventListener('click', async () => {
  const result = await showPresetDialog();
  if (result) {
    const list = getCustomPresets();
    list.push(result);
    saveCustomPresets(list);
    renderPresetSelect();
    // 自动选中新建的预设
    presetSelect.value = result.autoFlag ? result.command + ' ' + result.autoFlag : result.command;
  }
});

presetManageBtn.addEventListener('click', () => {
  showPresetManageDialog();
});

// Tab 切换
sidebarTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const tabName = tab.getAttribute('data-tab');
    if (tabName) switchTab(tabName);
  });
});

// AI 配置按钮
aiTestBtn.addEventListener('click', () => handleAiTest());
aiApplyBtn.addEventListener('click', () => handleAiApply());
aiKeyToggle.addEventListener('click', () => {
  aiApikeyInput.type = aiApikeyInput.type === 'password' ? 'text' : 'password';
});

// ========== IPC 监听 ==========

window.duocli.onPtyData((id, data) => {
  termManager.write(id, data);
  if (sessionTitles.has(id)) {
    sessionUpdateTimes.set(id, Date.now());
  }
  // 所有会话都追踪状态（工作中/等待输入），确保切换查看后状态不丢失
  const activeId = termManager.getActiveId();
  if (sessionTitles.has(id)) {
    // 有新输出就优先显示"工作中"（黄点），并清掉旧的"待处理"（绿点）
    const prevBusy = sessionBusy.has(id);
    const prevUnread = sessionUnread.has(id);
    sessionBusy.add(id);
    sessionUnread.delete(id);
    if (!prevBusy || prevUnread) renderSessionList();

    // 累积最近数据用于提示符检测（保留最后 500 字符）
    const prev = recentDataBuffer.get(id) || '';
    recentDataBuffer.set(id, (prev + data).slice(-500));

    // 去掉 ANSI 转义后检测 AI CLI 提示符
    // 改进：只匹配真正的提示符，排除 HTML 标签等误判
    const plain = recentDataBuffer.get(id)!.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
    // 催工开启时，自动确认 CLI 各类确认提示（proceed / make this edit / 等）
    const acConfig = sessionAutoContinue.get(id);
    if (acConfig?.enabled && (acConfig.autoAgree ?? true) && /Do you want to .*\?/.test(plain)) {
      // 数选项行数（格式: "  1. xxx"、"  2. xxx"...）
      const optionCount = (plain.match(/^\s+\d+\.\s/gm) || []).length;
      // 3个选项: 1=Yes, 2=Yes永久, 3=No → 选2
      // 2个选项: 1=Yes, 2=No → 选1
      const choice = optionCount >= 3 ? '2' : '1';
      const delayMs = (acConfig.autoAgreeDelaySec ?? AUTO_AGREE_DEFAULT_DELAY_SEC) * 1000;
      setTimeout(() => {
        window.duocli.writePty(id, choice);
        window.duocli.writePty(id, String.fromCharCode(0x0d));
        console.log(`[AutoConfirm] 会话 ${id} 检测到${optionCount}个选项，选择 ${choice}，延后 ${delayMs}ms`);
      }, delayMs);
      // 清除 buffer 避免重复触发
      recentDataBuffer.delete(id);
    }

    // 提示符检测：按行拆分，检查最后几行是否包含提示符
    const lines = plain.split('\n').map(l => l.trimEnd()).filter(l => l.length > 0);
    const lastLines = lines.slice(-3).join('\n');
    // 排除 Claude Code 工作中状态：xxx… (xxx) 等 spinner 模式
    const cliWorking = /\w+…\s*\(/.test(lastLines);
    // Shell 提示符
    const promptLike = /(^|[\s\n])(❯|›|▷|\$|>|%|➜)\s*$/.test(lastLines) && !/>\s*[a-zA-Z]/.test(lastLines);
    const shellPrompt = /[\]#$%>❯›]\s*$/.test(lastLines);
    const hasPrompt = (promptLike || shellPrompt) && !cliWorking;

    if (hasPrompt) {
      // 检测到提示符 → 从工作中转为等待输入（黄→绿/灰）
      clearTimeout(unreadTimers.get(id));
      unreadTimers.delete(id);
      recentDataBuffer.delete(id);
      const wasBusy = sessionBusy.delete(id);
      const hadUnread = sessionUnread.has(id);
      // 当前活跃会话直接变灰（用户正在看着）；非活跃会话标记为待处理（绿点）
      if (id !== activeId && !sessionUnread.has(id)) {
        sessionUnread.add(id);
      }
      const nowUnread = sessionUnread.has(id);
      if (wasBusy || hadUnread !== nowUnread) renderSessionList();
    } else {
      // 未检测到提示符：用静默超时兜底（15秒无新输出 → 黄→绿/灰）
      // 避免提示符匹配不到时永远卡在黄灯
      clearTimeout(unreadTimers.get(id));
      unreadTimers.set(id, setTimeout(() => {
        unreadTimers.delete(id);
        recentDataBuffer.delete(id);
        // 超时兜底：如果仍然是黄灯状态，转为绿灯或灰灯
        if (sessionBusy.has(id)) {
          sessionBusy.delete(id);
          const currentActiveId = termManager.getActiveId();
          if (id !== currentActiveId) {
            sessionUnread.add(id);
          }
          renderSessionList();
        }
      }, 3000));
    }
  }
});

window.duocli.onTitleUpdate((id, title) => {
  if (sessionTitleLocked.has(id)) return;
  if (sessionTitles.has(id)) {
    sessionTitles.set(id, title);
    sessionUpdateTimes.set(id, Date.now());
    renderSessionList();
    updateSessionTitleBar();
  }
});

// Chat 会话标题更新（全局处理，避免只在 ChatView 内部监听导致丢失）
window.duocli.onChatTitleUpdate((id, title) => {
  if (chatSessionTitles.has(id)) {
    chatSessionTitles.set(id, title);
    renderSessionList();
  }
});

window.duocli.onPtyExit((id) => {
  clearSessionState(id);
  saveAutoContinueToStorage();
  termManager.destroy(id);
  updateEmptyState();
  renderSessionList();
  updateSessionTitleBar();
  void renderFileTree();
});

// 手机端远程创建了会话，桌面端同步显示
window.duocli.onRemoteCreated((info) => {
  const now = Date.now();
  sessionTitles.set(info.id, info.title);
  sessionThemes.set(info.id, info.themeId);
  sessionUpdateTimes.set(info.id, now);
  sessionCreateTimes.set(info.id, now);
  sessionCwds.set(info.id, info.cwd);
  sessionDisplayNames.set(info.id, info.displayName);
  // 创建 xterm 实例（桌面端也能看到和操作）
  termManager.create(info.id, info.themeId, info.cwd, (data) => { writePtyWithAutoReset(info.id, data); });
  updateEmptyState();
  renderSessionList();
  updateSessionTitleBar();
  void renderFileTree();
  setTimeout(() => {
    const dims = termManager.getActiveDimensions();
    if (dims) window.duocli.resizePty(info.id, dims.cols, dims.rows);
  }, 100);
});

// 远程服务器信息处理：合并推送/拉取预设
async function handleRemoteServerInfo(info: typeof remoteServerInfo) {
  if (!info) return;
  console.log('[Renderer] Remote server info:', info);
  remoteServerInfo = info;
  renderRemoteServerInfo();
  startPresetSyncTimer();
  
  console.log('[Preset Sync] Remote server started, initiating preset sync');
  await reconcilePresetsWithServer('remote-ready');
}

// 方式1：IPC 推送（可能因竞态丢失）
window.duocli.onRemoteServerInfo(handleRemoteServerInfo);

// 方式2：渲染进程加载后主动拉取；服务器启动和页面加载都有竞态，需短时重试。
async function waitForRemoteServerInfo(): Promise<void> {
  for (let i = 0; i < 40 && !remoteServerInfo; i++) {
    const info = await window.duocli.getRemoteServerInfo();
    if (info && !remoteServerInfo) {
      await handleRemoteServerInfo(info);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!remoteServerInfo) {
    console.warn('[Preset Sync] Remote server info unavailable after retry, presets may not sync to mobile');
  }
}

void waitForRemoteServerInfo();

// ========== 已关闭会话：启动加载 + 实时更新 ==========
window.duocli.closedSessionsList().then(sessions => {
  closedSessions = sessions;
  renderSessionList();
});
window.duocli.onClosedSessionsUpdate((sessions) => {
  closedSessions = sessions;
  renderSessionList();
});

// ========== 已关闭 Chat 会话：启动加载 + 实时更新 ==========
window.duocli.closedChatList().then(sessions => {
  closedChatSessions = sessions;
  renderSessionList();
});
window.duocli.onClosedChatUpdate((sessions) => {
  closedChatSessions = sessions;
  renderSessionList();
});

// 自动切号状态监听
window.duocli.onAutoSwitchStatus((id, status, detail) => {
  if (status === 'idle') {
    sessionAutoSwitchStatus.delete(id);
  } else {
    sessionAutoSwitchStatus.set(id, { status, detail });
  }
  renderSessionList();
});

// 催工配置：手机端通过 main 进程读取桌面端配置
window.duocli.onGetAutoContinueConfig((sessionId) => {
  const config = sessionAutoContinue.get(sessionId);
  window.duocli.sendAutoContinueConfig(sessionId, config || null);
});

// 催工配置：手机端通过 main 进程写入桌面端配置
window.duocli.onSetAutoContinueConfig((sessionId, config) => {
  if (!config || !hasSessionInUI(sessionId)) return;
  const existing = sessionAutoContinue.get(sessionId) || {
    enabled: false,
    messages: [...AUTO_CONTINUE_DEFAULT_MESSAGES],
    intervalMs: AUTO_CONTINUE_DEFAULT_INTERVAL,
    commandIntervalMs: AUTO_CONTINUE_DEFAULT_COMMAND_INTERVAL,
    lastSendTime: Date.now(),
    autoAgree: true,
    autoAgreeDelaySec: AUTO_AGREE_DEFAULT_DELAY_SEC,
    sendDelaySec: AUTO_CONTINUE_SEND_DELAY_SEC,
    maxDurationMs: AUTO_CONTINUE_DEFAULT_MAX_DURATION,
    enabledAt: 0,
  };
  Object.assign(existing, config);
  existing.lastSendTime = Date.now();
  if (config.enabled && !existing.enabledAt) {
    existing.enabledAt = Date.now();
  }
  sessionAutoContinue.set(sessionId, existing);
  saveAutoContinueToStorage();
  if (existing.enabled) initAutoContinueTimer();
  renderSessionList();
});

// 监听文件变化（归到当前活跃会话）
window.duocli.onFileChange((filename) => {
  const idx = globalRecentFiles.indexOf(filename);
  if (idx !== -1) globalRecentFiles.splice(idx, 1);
  globalRecentFiles.unshift(filename);
  if (globalRecentFiles.length > MAX_RECENT_FILES) {
    globalRecentFiles.length = MAX_RECENT_FILES;
  }
  renderFileStatusbar();
});

// 右键状态栏 → 切换编辑器
fileStatusbar.addEventListener('contextmenu', async (e) => {
  e.preventDefault();
  await selectEditor();
});

async function selectEditor(): Promise<void> {
  const editorPath = await window.duocli.filewatcherSelectEditor();
  if (editorPath) {
    currentEditorName = editorPath.split(/[/\\]/).pop()?.replace(/\.(app|exe)$/, '') || editorPath;
    updateEditorStatusbar();
  }
}

function updateEditorStatusbar(): void {
  const icon = document.getElementById('file-statusbar-icon')!;
  if (currentEditorName) {
    icon.title = `编辑器: ${currentEditorName}（右键更换）`;
  } else {
    icon.title = '点击选择编辑器';
  }
}

function renderFileStatusbar(): void {
  fileStatusbarFiles.innerHTML = '';
  const files = globalRecentFiles;
  if (files.length === 0) {
    const placeholder = document.createElement('span');
    placeholder.className = 'file-statusbar-placeholder';
    placeholder.textContent = '等待文件变化...';
    fileStatusbarFiles.appendChild(placeholder);
    return;
  }
  for (const filePath of files) {
    const item = document.createElement('span');
    item.className = 'file-statusbar-item';
    item.textContent = filePath;
    item.title = filePath;
    item.addEventListener('click', async () => {
      if (!currentCwd) return;
      if (!currentEditorName) {
        await selectEditor();
        if (!currentEditorName) return;
      }
      window.duocli.filewatcherOpen(currentCwd + '/' + filePath);
    });
    fileStatusbarFiles.appendChild(item);
  }
}

// 启动时如果已有工作目录，开始监听
if (currentCwd) {
  startFileWatcher(currentCwd);
}
void renderFileTree();

// 启动时加载已保存的编辑器偏好
window.duocli.filewatcherGetEditor().then((editorPath) => {
  if (editorPath) {
    currentEditorName = editorPath.split(/[/\\]/).pop()?.replace(/\.(app|exe)$/, '') || editorPath;
    updateEditorStatusbar();
  }
});

// 每60秒刷新时间显示
setInterval(() => {
  if (sessionTitles.size > 0) renderSessionList();
}, 60000);

// ========== 侧边栏箭头键切换会话 ==========

// 根据当前活跃会话，切换到上一个/下一个（跳过已关闭等不可导航条目）
function navigateSession(direction: 'up' | 'down'): void {
  const items = sessionList.querySelectorAll<HTMLElement>('.session-item');
  if (items.length === 0) return;

  // 只收集可导航的条目（有 data-session-id 的）
  const navigable = Array.from(items).filter(el => el.dataset.sessionId);
  if (navigable.length === 0) return;

  // 找当前活跃条目在可导航列表中的索引
  let activeIdx = -1;
  for (let i = 0; i < navigable.length; i++) {
    if (navigable[i].classList.contains('active')) {
      activeIdx = i;
      break;
    }
  }

  // 计算目标索引
  let targetIdx: number;
  if (activeIdx === -1) {
    targetIdx = direction === 'down' ? 0 : navigable.length - 1;
  } else {
    targetIdx = direction === 'down' ? activeIdx + 1 : activeIdx - 1;
  }

  if (targetIdx < 0 || targetIdx >= navigable.length) return;

  const targetItem = navigable[targetIdx];
  const sessionId = targetItem.dataset.sessionId!;
  const sessionType = targetItem.dataset.sessionType;

  // 触发切换
  if (sessionType === 'chat') {
    switchToTerminal();
    switchToChat(sessionId);
  } else {
    switchSession(sessionId);
  }

  // 滚动到可见区域
  targetItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// 在 renderSessionList 中给每个 session-item 打上 data 属性
// （在 renderSessionList 末尾的 PTY 和 Chat 渲染处已有点击事件，
//   这里需要在创建 DOM 时标记 sessionId 和 sessionType）

// 全局键盘监听：侧边栏有焦点时拦截上下箭头
sessionList.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    navigateSession(e.key === 'ArrowUp' ? 'up' : 'down');
  }
});

// 让 sessionList 可以获取焦点（箭头导航的前提）
sessionList.setAttribute('tabindex', '0');

window.duocli.onCloseCurrentSession(() => {
  void closeCurrentSession();
});

// ========== 版权信息交互 ==========

// GitHub 链接
document.getElementById('footer-github')!.addEventListener('click', (e) => {
  e.preventDefault();
  window.duocli.openUrl('https://github.com/saddism/DuoCLI');
});

// 点击提示文字弹出二维码
document.querySelector('.footer-tip')!.addEventListener('click', () => {
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'qrcode-dialog';
  dialog.innerHTML = `
    <img src="qrcode.jpg" class="qrcode-img" />
    <div class="qrcode-text">扫码关注「壮哥的壮」</div>
    <div class="qrcode-sub">心中默念"大壮好大"，祈祷 +1</div>
  `;
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  dialog.addEventListener('click', () => overlay.remove());
});

// ========== Devin 账号管理 ==========

let devinLoading = false;

async function refreshDevinAccounts(): Promise<void> {
  if (devinLoading) return;
  devinLoading = true;
  try {
    const data = await window.duocli.devinAccountsList();
    renderDevinAccountsList(data);
  } catch {
    devinAccountsList.innerHTML = '<div class="devin-accounts-empty">加载失败</div>';
  } finally {
    devinLoading = false;
  }
}

function renderDevinAccountsList(data: { accounts: any[]; currentIndex: number }): void {
  devinAccountsList.innerHTML = '';
  if (!data.accounts || data.accounts.length === 0) {
    devinAccountsList.innerHTML = '<div class="devin-accounts-empty">暂无账号，请在下方添加</div>';
    devinCurrentLabel.textContent = '当前: 无';
    return;
  }
  const cur = data.accounts[data.currentIndex];
  devinCurrentLabel.textContent = `当前: ${cur ? cur.email.split('@')[0] : '无'}`;

  for (let i = 0; i < data.accounts.length; i++) {
    const acc = data.accounts[i];
    const isActive = i === data.currentIndex;

    // 状态圆点
    let dotClass = 'idle';
    if (acc.lastLogin && !acc.lastError) dotClass = 'ok';
    else if (acc.lastError) dotClass = 'err';

    // 配额
    const quota = acc.quota;
    let quotaText = '--';
    let quotaClass = '';
    if (quota) {
      quotaText = `D${quota.daily}% W${quota.weekly}%`;
      if (quota.daily <= 10 || quota.weekly <= 10) quotaClass = ' low';
    }

    const item = document.createElement('div');
    item.className = 'devin-account-item' + (isActive ? ' active' : '');

    // 时间信息
    let meta = '';
    if (acc.planName) meta = acc.planName;
    if (acc.lastLogin) {
      const d = new Date(acc.lastLogin);
      meta += (meta ? ' · ' : '') + `${d.getMonth()+1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`;
    }
    if (acc.lastError) meta = `❌ ${acc.lastError.slice(0, 30)}`;

    item.innerHTML = `
      <div class="devin-account-top">
        <div class="devin-account-dot ${dotClass}"></div>
        <span class="devin-account-email">${escHtml(acc.email)}</span>
        <span class="devin-account-quota-tag${quotaClass}">${quotaText}</span>
      </div>
      <div class="devin-account-bottom">
        <span class="devin-account-meta">${escHtml(meta)}</span>
        <div class="devin-account-actions">
          <button class="devin-quota-one-btn" title="刷新额度">&#8635;</button>
          <button class="devin-switch-btn" ${isActive ? 'disabled' : ''}>切换</button>
          <button class="devin-delete-btn">删除</button>
        </div>
      </div>
    `;

    // 切换按钮
    const switchBtn = item.querySelector('.devin-switch-btn') as HTMLButtonElement;
    switchBtn.addEventListener('click', async () => {
      switchBtn.textContent = '切换中...';
      switchBtn.disabled = true;
      try {
        const result = await window.duocli.devinAccountsSwitch({ email: acc.email });
        if (result.ok) {
          switchBtn.textContent = '✓';
          await refreshDevinAccounts();
        } else {
          switchBtn.textContent = '失败';
          alert('切换失败：' + (result.error || '未知错误'));
          setTimeout(() => { switchBtn.textContent = '切换'; switchBtn.disabled = false; }, 1500);
        }
      } catch {
        switchBtn.textContent = '切换';
        switchBtn.disabled = false;
      }
    });

    // 删除按钮
    const deleteBtn = item.querySelector('.devin-delete-btn') as HTMLButtonElement;
    deleteBtn.addEventListener('click', async () => {
      if (!confirm(`确认删除账号 ${acc.email}？`)) return;
      deleteBtn.textContent = '...';
      deleteBtn.disabled = true;
      try {
        const result = await window.duocli.devinAccountsRemove(acc.email);
        if (result.ok) {
          await refreshDevinAccounts();
        } else {
          alert('删除失败：' + (result.error || '未知错误'));
          deleteBtn.textContent = '删除';
          deleteBtn.disabled = false;
        }
      } catch {
        deleteBtn.textContent = '删除';
        deleteBtn.disabled = false;
      }
    });

    // 单个账号刷新额度按钮
    const quotaOneBtn = item.querySelector('.devin-quota-one-btn') as HTMLButtonElement;
    quotaOneBtn.addEventListener('click', async () => {
      quotaOneBtn.disabled = true;
      quotaOneBtn.textContent = '...';
      try {
        const result = await window.duocli.devinAccountsQuotaOne(acc.email);
        if (result.ok) {
          quotaOneBtn.textContent = '✓';
          await refreshDevinAccounts();
          setTimeout(() => { quotaOneBtn.innerHTML = '&#8635;'; quotaOneBtn.disabled = false; }, 2000);
        } else {
          quotaOneBtn.innerHTML = '&#8635;';
          quotaOneBtn.disabled = false;
          alert('查询失败：' + (result.error || '未知错误'));
        }
      } catch {
        quotaOneBtn.innerHTML = '&#8635;';
        quotaOneBtn.disabled = false;
      }
    });

    devinAccountsList.appendChild(item);
  }
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 刷新按钮
devinRefreshBtn.addEventListener('click', () => refreshDevinAccounts());

// 配额查询
devinQuotaBtn.addEventListener('click', async () => {
  devinQuotaBtn.disabled = true;
  devinQuotaBtn.textContent = '查询中...';
  try {
    const result = await window.duocli.devinAccountsQuota();
    if (result.ok) {
      devinQuotaBtn.textContent = `D${result.daily}% W${result.weekly}%`;
      await refreshDevinAccounts();
      setTimeout(() => { devinQuotaBtn.textContent = '配额'; }, 5000);
    } else {
      devinQuotaBtn.textContent = '失败';
      setTimeout(() => { devinQuotaBtn.textContent = '配额'; }, 2000);
    }
  } catch {
    devinQuotaBtn.textContent = '配额';
  } finally {
    devinQuotaBtn.disabled = false;
  }
});

// 刷新全部额度
devinQuotaAllBtn.addEventListener('click', async () => {
  devinQuotaAllBtn.disabled = true;
  devinQuotaAllBtn.textContent = '刷新中...';
  try {
    const result = await window.duocli.devinAccountsQuotaAll();
    if (result.ok) {
      const total = result.results?.length || 0;
      const success = result.results?.filter(r => r.ok).length || 0;
      devinQuotaAllBtn.textContent = `${success}/${total} 完成`;
      await refreshDevinAccounts();
      setTimeout(() => { devinQuotaAllBtn.textContent = '刷新全部额度'; }, 4000);
    } else {
      devinQuotaAllBtn.textContent = '失败';
      setTimeout(() => { devinQuotaAllBtn.textContent = '刷新全部额度'; }, 2000);
    }
  } catch {
    devinQuotaAllBtn.textContent = '刷新全部额度';
  } finally {
    devinQuotaAllBtn.disabled = false;
  }
});

// 添加账号
devinAddBtn.addEventListener('click', async () => {
  const email = devinAddEmail.value.trim();
  const password = devinAddPassword.value.trim();
  if (!email || !password) return;
  devinAddBtn.textContent = '添加中...';
  devinAddBtn.disabled = true;
  try {
    const result = await window.duocli.devinAccountsAdd(email, password);
    if (result.ok) {
      devinAddEmail.value = '';
      devinAddPassword.value = '';
      devinAddBtn.textContent = '✓ 已添加';
      await refreshDevinAccounts();
    } else {
      devinAddBtn.textContent = '失败';
      alert('添加失败：' + (result.error || '未知错误'));
    }
  } catch {
    devinAddBtn.textContent = '失败';
  }
  setTimeout(() => { devinAddBtn.textContent = '添加账号'; devinAddBtn.disabled = false; }, 1500);
});

// 批量添加账号
devinBatchBtn.addEventListener('click', async () => {
  const text = devinBatchInput.value.trim();
  if (!text) return;
  // 基本校验：至少包含一个 @
  if (!text.includes('@')) {
    alert('请输入有效的账号数据（每行：邮箱 密码）');
    return;
  }
  devinBatchBtn.textContent = '导入中...';
  devinBatchBtn.disabled = true;
  try {
    const result = await window.duocli.devinAccountsAddBatch(text);
    if (result.ok) {
      devinBatchInput.value = '';
      devinBatchBtn.textContent = '✓ 完成';
      await refreshDevinAccounts();
      // 显示统计信息
      if (result.output) {
        const statsMatch = result.output.match(/已添加\s*\d+\s*\|.*/);
        if (statsMatch) {
          devinBatchBtn.textContent = statsMatch[0];
        }
      }
    } else {
      devinBatchBtn.textContent = '失败';
      alert('批量导入失败：' + (result.error || '未知错误'));
    }
  } catch {
    devinBatchBtn.textContent = '失败';
  }
  setTimeout(() => { devinBatchBtn.textContent = '批量导入'; devinBatchBtn.disabled = false; }, 3000);
});
