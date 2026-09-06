import { TerminalManager } from './terminal-manager';
import { PaneWorkspace } from './pane-workspace';
import { countPanes, listPanes, type PaneContent } from './pane-layout';
import { AndroidMirrorClient } from './android-mirror-client';
import {
  cancelAutoContinueRun,
  resolveNextRunAt,
  scheduleAutoContinueRunTimeout,
  shouldResetAfterManualInput,
} from './auto-continue-runtime';

let remoteServerInfo: {
  lanUrl: string;
  token: string;
  port: number;
  publicUrl?: string;
  tunnel?: { installed?: boolean; running: boolean; url: string; message?: string };
  health?: RemoteSyncHealth;
} | null = null;

type RemoteSyncStatus = 'healthy' | 'lan-only' | 'degraded' | 'retrying' | 'error';

interface RemoteSyncHealth {
  status: RemoteSyncStatus;
  localOk: boolean;
  tunnelRunning: boolean;
  publicOk: boolean;
  publicUrl?: string;
  message: string;
  lastCheckedAt: number;
}

let remoteTokenVisible = false;
let remoteTokenValue = '';

declare global {
  interface Window {
    duocli: {
      setWindowTitle: (title: string) => void;
      createPty: (cwd: string, presetCommand: string, themeId: string) => Promise<{ id: string; title: string; themeId: string; cwd: string; displayName: string; cli?: string; resumeId?: string | null }>;
      writePty: (id: string, data: string) => void;
      resizePty: (id: string, cols: number, rows: number) => void;
      destroyPty: (id: string) => Promise<boolean>;
      renamePty: (id: string, title: string) => void;
      regenerateTitle: (id: string) => Promise<void>;
      getSessions: () => Promise<Array<{ id: string; title: string; themeId: string; cwd: string; displayName: string; cli?: string; resumeId?: string | null }>>;
      selectFolder: (currentPath?: string) => Promise<string | null>;
      fileTreeListDir: (dirPath: string) => Promise<Array<{ name: string; path: string; isDir: boolean }>>;
      remoteAddRecentCwd: (cwd: string) => Promise<boolean>;
      onPtyData: (cb: (id: string, data: string) => void) => void;
      onTitleUpdate: (cb: (id: string, title: string) => void) => void;
      onPtyExit: (cb: (id: string) => void) => void;
      onRemoteCreated: (cb: (sessionInfo: { id: string; title: string; themeId: string; cwd: string; displayName: string; cli?: string; resumeId?: string | null }) => void) => void;
      onRemoteServerInfo: (cb: (info: NonNullable<typeof remoteServerInfo>) => void) => void;
      onRemoteHealthUpdate: (cb: (health: RemoteSyncHealth) => void) => void;
      getRemoteServerInfo: () => Promise<NonNullable<typeof remoteServerInfo> | null>;
      getRemoteHealth: () => Promise<RemoteSyncHealth | null>;
      retryRemoteSync: () => Promise<RemoteSyncHealth | null>;
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
      terminalAutoResponseGetConfig: () => Promise<TerminalAutoResponseConfig>;
      terminalAutoResponseSaveConfig: (config: TerminalAutoResponseConfig) => Promise<TerminalAutoResponseConfig>;
      getCliProvider: (presetCommand: string) => Promise<string | null>;
      getAvailableBuiltinPresets: () => Promise<Array<{ value: string; label: string }>>;
      // Claude 供应商配置
      claudeProvidersList: () => Promise<Array<{ id: string; name: string; baseUrl: string; apiKey: string; model?: string }>>;
      claudeProvidersSave: (providers: Array<{ id: string; name: string; baseUrl: string; apiKey: string; model?: string }>) => Promise<boolean>;
      // 文件操作
      openFile: (filePath: string) => Promise<void>;
      readFilePreview: (cwd: string, filePath: string) => Promise<any>;
      readDirectory: (dirPath: string) => Promise<Array<{ name: string; isDirectory: boolean; isFile: boolean }>>;
      androidListDevices: () => Promise<{ ok: boolean; error?: string; devices: Array<{ id: string; state: string; info: string; available: boolean }> }>;
      androidScreenshot: (deviceId?: string) => Promise<{ ok: boolean; error?: string; dataUrl?: string }>;
      androidTap: (deviceId: string, x: number, y: number) => Promise<{ ok: boolean; error?: string }>;
      androidSwipe: (deviceId: string, x1: number, y1: number, x2: number, y2: number, duration?: number) => Promise<{ ok: boolean; error?: string }>;
      androidInputText: (deviceId: string, text: string) => Promise<{ ok: boolean; error?: string }>;
      // 会话状态同步
      syncSessionStatus: (statuses: Record<string, string>) => void;
      // 催工配置中转
      onGetAutoContinueConfig: (cb: (sessionId: string) => void) => void;
      sendAutoContinueConfig: (sessionId: string, config: any) => void;
      onSetAutoContinueConfig: (cb: (sessionId: string, config: any) => void) => void;
      // 已关闭会话
      closedSessionsList: () => Promise<Array<{ id: string; title: string; cwd: string; presetCommand: string; resumeId: string; resumeCommand: string; displayName: string; closedAt: number }>>;
      closedSessionsBeginRestore: (id: string) => Promise<boolean>;
      closedSessionsCancelRestore: (id: string) => Promise<boolean>;
      closedSessionsRemove: (id: string) => Promise<Array<{ id: string; title: string; cwd: string; presetCommand: string; resumeId: string; resumeCommand: string; displayName: string; closedAt: number }>>;
      closedSessionsClear: () => Promise<Array<{ id: string; title: string; cwd: string; presetCommand: string; resumeId: string; resumeCommand: string; displayName: string; closedAt: number }>>;
      closedSessionsConfirmRestore: (closedId: string, sessionId: string) => Promise<boolean>;
      onClosedSessionsUpdate: (cb: (sessions: Array<{ id: string; title: string; cwd: string; presetCommand: string; resumeId: string; resumeCommand: string; displayName: string; closedAt: number }>) => void) => void;
      onCloseCurrentSession: (cb: () => void) => void;
    };
  }
}

interface TerminalAutoResponseRule {
  keyword: string;
  response: string;
}

interface TerminalAutoResponseConfig {
  enabled: boolean;
  rules: TerminalAutoResponseRule[];
  delaySeconds: number;
  cooldownSeconds: number;
}

// 状态
const savedCwd = localStorage.getItem('duocli_cwd') || '';
let currentCwd = savedCwd;
const LEGACY_QODER_AUTO_COMMAND = 'qoder chat --dangerously-skip-permissions';
const QODERCN_AUTO_COMMAND = 'qodercn --dangerously-skip-permissions';

function migrateLegacyQoderPreset(value: string): string {
  return value === LEGACY_QODER_AUTO_COMMAND ? QODERCN_AUTO_COMMAND : value;
}

const savedPreset = localStorage.getItem('duocli_preset') || '';
let lastPreset = migrateLegacyQoderPreset(savedPreset);
if (lastPreset !== savedPreset) localStorage.setItem('duocli_preset', lastPreset);
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
  state?: 'closed' | 'restoring';
}
let closedSessions: ClosedSessionInfo[] = [];
let closedSessionsCollapsed = false;
const restoringClosedSessionIds = new Set<string>();

// 自动继续配置
interface AutoContinueConfig {
  enabled: boolean;
  messages: string[];
  intervalMs: number;
  commandIntervalMs: number;
  autoAgree: boolean;
  autoAgreeDelaySec: number;
  sendDelaySec: number;
  maxLoops: number;
  initialDelayMs: number;
  loopCount: number;
  nextRunAt: number;
  sending: boolean;
  runVersion: number;
  timeoutIds: Set<ReturnType<typeof setTimeout>>;
}

const sessionAutoContinue: Map<string, AutoContinueConfig> = new Map();
const AUTO_CONTINUE_DEFAULT_MESSAGES = ['继续'];
const AUTO_CONTINUE_DEFAULT_INTERVAL = 10 * 60 * 1000; // 10 分钟
const AUTO_CONTINUE_DEFAULT_COMMAND_INTERVAL = 2000; // 命令间隔 2 秒
const AUTO_AGREE_DEFAULT_DELAY_SEC = 5; // 自动同意默认延后 5 秒
const AUTO_CONTINUE_SEND_DELAY_SEC = 2; // 发送回车前默认延迟 2 秒
const AUTO_CONTINUE_DEFAULT_MAX_LOOPS = -1; // -1 表示不限制
const AUTO_CONTINUE_DEFAULT_INITIAL_DELAY = 0; // 首次循环立即执行
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

function serializeAutoContinueConfig(config: AutoContinueConfig): Record<string, unknown> {
  return {
    enabled: config.enabled,
    messages: config.messages,
    intervalMs: config.intervalMs,
    commandIntervalMs: config.commandIntervalMs,
    autoAgree: config.autoAgree,
    autoAgreeDelaySec: config.autoAgreeDelaySec,
    sendDelaySec: config.sendDelaySec,
    maxLoops: config.maxLoops,
    initialDelayMs: config.initialDelayMs,
    loopCount: config.loopCount,
    nextRunAt: config.nextRunAt,
  };
}

// 持久化催工配置到 localStorage
function saveAutoContinueToStorage(): void {
  const data: Record<string, any> = {};
  sessionAutoContinue.forEach((config, sessionId) => {
    data[sessionId] = serializeAutoContinueConfig(config);
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
      const intervalMs = config.intervalMs ?? AUTO_CONTINUE_DEFAULT_INTERVAL;
      const initialDelayMs = config.initialDelayMs ?? AUTO_CONTINUE_DEFAULT_INITIAL_DELAY;
      sessionAutoContinue.set(sessionId, {
        enabled: config.enabled ?? false,
        messages: msgs,
        intervalMs,
        commandIntervalMs: config.commandIntervalMs ?? AUTO_CONTINUE_DEFAULT_COMMAND_INTERVAL,
        autoAgree: config.autoAgree ?? true,
        autoAgreeDelaySec: config.autoAgreeDelaySec ?? AUTO_AGREE_DEFAULT_DELAY_SEC,
        sendDelaySec: config.sendDelaySec ?? AUTO_CONTINUE_SEND_DELAY_SEC,
        maxLoops: config.maxLoops ?? AUTO_CONTINUE_DEFAULT_MAX_LOOPS,
        initialDelayMs,
        loopCount: config.loopCount ?? 0,
        nextRunAt: resolveNextRunAt(config.nextRunAt, Date.now(), initialDelayMs),
        sending: false,
        runVersion: 0,
        timeoutIds: new Set(),
      });
    }
  } catch {}
}

// 自动继续定时器
let autoContinueTimer: ReturnType<typeof setInterval> | null = null;

// 启动时恢复催工配置并启动定时器
loadAutoContinueFromStorage();
// 旧逻辑会无条件清空磁盘配置，导致用户的催工设置永远丢失。
// 现状：冷启动时 sessionTitles 为空 → loadAutoContinueFromStorage 写入的旧 session-id 配置
// 不会命中任何当前会话，定时器自然 no-op；当 onRemoteCreated/createPty 创建新会话时
// 会通过 onSetAutoContinueConfig 同步推送新配置覆盖旧条目。
// 检查是否有启用的配置，如果有则启动定时器
const hasEnabledConfig = Array.from(sessionAutoContinue.values()).some(c => c.enabled);
if (hasEnabledConfig) initAutoContinueTimer();

// 首次循环有独立的启动时间；首次完成后，手动输入才重置下一轮计时。
function writePtyWithAutoReset(id: string, data: string): void {
  termManager.notifyInput(id);
  window.duocli.writePty(id, data);
  const config = sessionAutoContinue.get(id);
  if (config?.enabled && shouldResetAfterManualInput(config.loopCount, config.sending)) {
    config.nextRunAt = Date.now() + config.intervalMs;
    saveAutoContinueToStorage();
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
      if (config.sending) return;
      const maxLoops = config.maxLoops ?? AUTO_CONTINUE_DEFAULT_MAX_LOOPS;
      if (maxLoops > 0 && config.loopCount >= maxLoops) {
        config.enabled = false;
        cancelAutoContinueRun(config);
        saveAutoContinueToStorage();
        renderSessionList();
        return;
      }
      if (now >= config.nextRunAt) {
        const messages = config.messages || AUTO_CONTINUE_DEFAULT_MESSAGES;
        const cmdInterval = config.commandIntervalMs ?? AUTO_CONTINUE_DEFAULT_COMMAND_INTERVAL;
        const sendDelay = (config.sendDelaySec ?? AUTO_CONTINUE_SEND_DELAY_SEC) * 1000;
        config.runVersion++;
        const runVersion = config.runVersion;
        config.loopCount++;
        config.sending = true;
        // 若本轮中途退出，重启后至少等待一个循环间隔再继续。
        config.nextRunAt = now + config.intervalMs;
        const stopAfterCycle = maxLoops > 0 && config.loopCount >= maxLoops;
        saveAutoContinueToStorage();
        console.log(`[循环] 准备发送 ${messages.length} 条命令到会话 ${sessionId}`);

        const isCurrentRun = () => (
          config.enabled
          && config.runVersion === runVersion
          && sessionAutoContinue.get(sessionId) === config
          && hasSessionInUI(sessionId)
        );
        const scheduleRunTimeout = (callback: () => void, delayMs: number) => {
          scheduleAutoContinueRunTimeout(config, runVersion, () => {
            if (isCurrentRun()) callback();
          }, delayMs);
        };

        let cmdIdx = 0;
        const sendNextCommand = () => {
          if (!isCurrentRun()) return;
          if (cmdIdx >= messages.length) {
            console.log(`[循环] 已发送全部 ${messages.length} 条命令`);
            config.sending = false;
            if (stopAfterCycle) {
              config.enabled = false;
              cancelAutoContinueRun(config);
              renderSessionList();
            } else {
              config.nextRunAt = Date.now() + config.intervalMs;
            }
            saveAutoContinueToStorage();
            return;
          }
          const msg = messages[cmdIdx];
          cmdIdx++;
          window.duocli.writePty(sessionId, msg);
          // 所有 PTY CLI 都以 CR (0x0d) 提交一条命令。
          // 过去依次发送多种换行/转义序列，会让部分 Agent 接收到多次提交。
          scheduleRunTimeout(() => {
            window.duocli.writePty(sessionId, '\r');
            // 这条命令回车完成，发送下一条命令
            scheduleRunTimeout(sendNextCommand, cmdInterval);
          }, sendDelay);
        };
        sendNextCommand();
      }
    });
    if (staleSessionIds.length > 0) {
      staleSessionIds.forEach((id) => {
        const config = sessionAutoContinue.get(id);
        if (config) cancelAutoContinueRun(config);
        sessionAutoContinue.delete(id);
      });
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
      autoAgree: true,
      autoAgreeDelaySec: AUTO_AGREE_DEFAULT_DELAY_SEC,
      sendDelaySec: AUTO_CONTINUE_SEND_DELAY_SEC,
      maxLoops: AUTO_CONTINUE_DEFAULT_MAX_LOOPS,
      initialDelayMs: AUTO_CONTINUE_DEFAULT_INITIAL_DELAY,
      loopCount: 0,
      nextRunAt: Date.now() + AUTO_CONTINUE_DEFAULT_INITIAL_DELAY,
      sending: false,
      runVersion: 0,
      timeoutIds: new Set(),
    };
    sessionAutoContinue.set(sessionId, config);
  }
  cancelAutoContinueRun(config);
  config.enabled = enabled;
  config.loopCount = 0;
  config.nextRunAt = Date.now() + (config.initialDelayMs ?? AUTO_CONTINUE_DEFAULT_INITIAL_DELAY);
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
    autoAgree: true,
    autoAgreeDelaySec: AUTO_AGREE_DEFAULT_DELAY_SEC,
    sendDelaySec: AUTO_CONTINUE_SEND_DELAY_SEC,
    maxLoops: AUTO_CONTINUE_DEFAULT_MAX_LOOPS,
    initialDelayMs: AUTO_CONTINUE_DEFAULT_INITIAL_DELAY,
    loopCount: 0,
    nextRunAt: Date.now() + AUTO_CONTINUE_DEFAULT_INITIAL_DELAY,
    sending: false,
    runVersion: 0,
    timeoutIds: new Set(),
  };

  const currentMessages = config.messages || AUTO_CONTINUE_DEFAULT_MESSAGES;
  const currentInterval = config.intervalMs || AUTO_CONTINUE_DEFAULT_INTERVAL;
  const currentIntervalMinutes = Math.round(currentInterval / 60000);
  const currentCommandInterval = Math.round((config.commandIntervalMs ?? AUTO_CONTINUE_DEFAULT_COMMAND_INTERVAL) / 1000);
  const currentAutoAgree = config.autoAgree ?? true;
  const currentAutoAgreeDelay = config.autoAgreeDelaySec ?? AUTO_AGREE_DEFAULT_DELAY_SEC;
  const currentSendDelay = config.sendDelaySec ?? AUTO_CONTINUE_SEND_DELAY_SEC;
  const currentMaxLoops = config.maxLoops ?? AUTO_CONTINUE_DEFAULT_MAX_LOOPS;
  const currentInitialDelay = config.initialDelayMs ?? AUTO_CONTINUE_DEFAULT_INITIAL_DELAY;

  const overlay = document.getElementById('auto-continue-overlay')!;
  const messageInput = document.getElementById('auto-continue-message') as HTMLTextAreaElement;
  const intervalInput = document.getElementById('auto-continue-interval') as HTMLInputElement;
  const commandIntervalInput = document.getElementById('auto-continue-command-interval') as HTMLInputElement;
  const autoAgreeCheckbox = document.getElementById('auto-continue-auto-agree') as HTMLInputElement;
  const autoAgreeDelayInput = document.getElementById('auto-continue-agree-delay') as HTMLInputElement;
  const autoAgreeDelayRow = document.getElementById('auto-agree-delay-row')!;
  const sendDelayInput = document.getElementById('auto-continue-send-delay') as HTMLInputElement;
  const maxLoopsInput = document.getElementById('auto-continue-max-loops') as HTMLInputElement;
  const initialDelayInput = document.getElementById('auto-continue-initial-delay') as HTMLInputElement;
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
  maxLoopsInput.value = String(currentMaxLoops);
  initialDelayInput.value = String(Math.round(currentInitialDelay / 60000));

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

    const maxLoops = parseInt(maxLoopsInput.value, 10);
    if (isNaN(maxLoops) || maxLoops === 0 || maxLoops < -1) { maxLoopsInput.focus(); return; }

    const initialDelayMinutes = parseInt(initialDelayInput.value, 10);
    if (isNaN(initialDelayMinutes) || initialDelayMinutes < 0) { initialDelayInput.focus(); return; }

    cancelAutoContinueRun(config);
    config.messages = messages;
    config.intervalMs = intervalMinutes * 60000;
    if (commandIntervalInput) {
      const cmdIntervalSec = parseInt(commandIntervalInput.value, 10);
      config.commandIntervalMs = isNaN(cmdIntervalSec) || cmdIntervalSec < 0 ? AUTO_CONTINUE_DEFAULT_COMMAND_INTERVAL : cmdIntervalSec * 1000;
    }
    config.loopCount = 0;
    config.autoAgree = autoAgreeCheckbox.checked;
    config.autoAgreeDelaySec = isNaN(agreeDelay) ? AUTO_AGREE_DEFAULT_DELAY_SEC : agreeDelay;
    config.sendDelaySec = sendDelay;
    config.maxLoops = maxLoops;
    config.initialDelayMs = initialDelayMinutes * 60000;
    config.nextRunAt = Date.now() + config.initialDelayMs;
    config.enabled = true;
    sessionAutoContinue.set(sessionId, config);

    saveAutoContinueToStorage();
    initAutoContinueTimer();
    close();
    renderSessionList();
  }

  function onStop(): void {
    config.enabled = false;
    cancelAutoContinueRun(config);
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

// 内置 option：启动时从主进程拉取（按本机 CLI 是否存在过滤）
const FALLBACK_BUILTIN_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '空终端' },
];
let BUILTIN_OPTIONS: Array<{ value: string; label: string }> = FALLBACK_BUILTIN_OPTIONS.slice();

async function refreshBuiltinOptions(): Promise<void> {
  try {
    const list = await window.duocli.getAvailableBuiltinPresets();
    if (Array.isArray(list) && list.length > 0) {
      BUILTIN_OPTIONS = list;
    }
  } catch (err) {
    console.warn('[Preset] Failed to load available builtins:', err);
  }
}

// 渲染远程服务器连接信息
function renderRemoteServerInfo(): void {
  if (!remoteServerInfo) {
    remoteServerInfoEl.style.display = 'none';
    return;
  }
  remoteServerInfoEl.style.display = 'block';

  const pulseEl = remoteServerInfoEl.querySelector('.remote-status-pulse') as HTMLElement;
  const statusEl = remoteServerInfoEl.querySelector('.remote-info-status') as HTMLElement;
  const urlEl = remoteServerInfoEl.querySelector('.remote-info-url') as HTMLElement;
  const tokenValueEl = remoteServerInfoEl.querySelector('.remote-info-token-value') as HTMLElement;
  const tokenToggleBtn = remoteServerInfoEl.querySelector('.remote-info-token-toggle') as HTMLButtonElement;
  const retryBtn = remoteServerInfoEl.querySelector('.remote-info-retry') as HTMLButtonElement;

  const health = remoteServerInfo.health;
  const syncStatus = health?.status ?? 'degraded';

  pulseEl.className = 'remote-status-pulse';
  remoteServerInfoEl.classList.remove('status-error', 'status-warning', 'status-retrying');
  if (syncStatus === 'healthy') pulseEl.classList.add('status-healthy');
  else if (syncStatus === 'retrying') {
    pulseEl.classList.add('status-retrying');
    remoteServerInfoEl.classList.add('status-retrying');
  } else if (syncStatus === 'error') {
    pulseEl.classList.add('status-error');
    remoteServerInfoEl.classList.add('status-error');
  } else {
    pulseEl.classList.add('status-warning');
    remoteServerInfoEl.classList.add('status-warning');
  }

  statusEl.textContent = health?.message
    ?? (syncStatus === 'healthy' ? '公网与局域网均正常' : '正在检测连接状态…');

  const tunnelReady = syncStatus === 'healthy' && Boolean(remoteServerInfo.publicUrl);
  urlEl.textContent = tunnelReady
    ? remoteServerInfo.publicUrl!
    : remoteServerInfo.lanUrl;
  urlEl.title = tunnelReady
    ? `公网地址（局域网：${remoteServerInfo.lanUrl}）`
    : '点击复制局域网地址';

  if (remoteTokenValue !== remoteServerInfo.token) {
    remoteTokenValue = remoteServerInfo.token;
    remoteTokenVisible = false;
  }
  tokenValueEl.textContent = remoteTokenVisible
    ? remoteServerInfo.token
    : '•'.repeat(Math.min(Math.max(remoteServerInfo.token.length, 8), 24));
  tokenValueEl.dataset.visible = remoteTokenVisible ? 'true' : 'false';
  tokenValueEl.title = remoteTokenVisible ? '点击复制 Token' : 'Token 已隐藏';
  tokenToggleBtn.setAttribute('aria-pressed', remoteTokenVisible ? 'true' : 'false');
  tokenToggleBtn.title = remoteTokenVisible ? '隐藏 Token' : '显示 Token';
  tokenToggleBtn.setAttribute('aria-label', tokenToggleBtn.title);

  const showRetry = syncStatus === 'error' || syncStatus === 'degraded';
  retryBtn.hidden = !showRetry;
  retryBtn.disabled = syncStatus === 'retrying';
  retryBtn.textContent = syncStatus === 'retrying' ? '恢复中…' : '重试';
}

async function handleRemoteRetryClick(): Promise<void> {
  const retryBtn = remoteServerInfoEl.querySelector('.remote-info-retry') as HTMLButtonElement;
  retryBtn.disabled = true;
  retryBtn.textContent = '恢复中…';
  try {
    const health = await window.duocli.retryRemoteSync();
    if (health && remoteServerInfo) {
      remoteServerInfo = { ...remoteServerInfo, health };
      renderRemoteServerInfo();
    }
    const info = await window.duocli.getRemoteServerInfo();
    if (info) {
      remoteServerInfo = info;
      renderRemoteServerInfo();
    }
  } catch (err) {
    console.warn('[RemoteSync] Manual retry failed:', err);
  } finally {
    renderRemoteServerInfo();
  }
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
const paneLayoutToolbar = document.getElementById('pane-layout-toolbar')!;
const paneLayoutSummary = document.getElementById('pane-layout-summary')!;
const paneTileBtn = document.getElementById('pane-tile-btn') as HTMLButtonElement;
const paneWorkspaceRoot = document.getElementById('pane-workspace')!;
const terminalContent = document.getElementById('terminal-content')!;
const emptyState = document.getElementById('empty-state')!;
const sessionList = document.getElementById('session-list')!;
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

const aiApplyBtn = document.getElementById('ai-apply-btn')!;
const aiTestBtn = document.getElementById('ai-test-btn')!;
const aiFormatSelect = document.getElementById('ai-format-select') as HTMLSelectElement;
const aiBaseurlInput = document.getElementById('ai-baseurl-input') as HTMLInputElement;
const aiApikeyInput = document.getElementById('ai-apikey-input') as HTMLInputElement;
const aiModelInput = document.getElementById('ai-model-input') as HTMLInputElement;
const aiKeyToggle = document.getElementById('ai-key-toggle')!;
const terminalAutoResponseEnabled = document.getElementById('terminal-auto-response-enabled') as HTMLInputElement;
const terminalAutoResponseRules = document.getElementById('terminal-auto-response-rules') as HTMLTextAreaElement;
const terminalAutoResponseDelay = document.getElementById('terminal-auto-response-delay') as HTMLInputElement;
const terminalAutoResponseCooldown = document.getElementById('terminal-auto-response-cooldown') as HTMLInputElement;
const terminalAutoResponseSave = document.getElementById('terminal-auto-response-save') as HTMLButtonElement;


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
const termManager = new TerminalManager(paneWorkspaceRoot, (id, cols, rows) => {
  window.duocli.resizePty(id, cols, rows);
});

let paneWorkspace: PaneWorkspace;

function mountPaneContent(paneId: string, content: PaneContent, body: HTMLElement): void {
  delete body.dataset.previewToken;
  body.innerHTML = '';
  if (content.kind === 'terminal') {
    if (!termManager.mountTo(content.sessionId, body)) {
      renderPaneMessage(body, '终端会话已结束', '请从右侧会话列表恢复或创建新终端。');
    }
    return;
  }
  if (content.kind === 'file') {
    renderFilePane(body, content.path);
    return;
  }
  if (content.kind === 'android') {
    renderAndroidPane(paneId, body, content.deviceId || '');
    return;
  }
  renderEmptyPane(body, paneId);
}

function unmountPaneContent(paneId: string, content: PaneContent): void {
  if (content.kind === 'terminal') {
    termManager.detach(content.sessionId);
  } else if (content.kind === 'android') {
    androidPanes.get(paneId)?.dispose();
    androidPanes.delete(paneId);
  }
}

function handlePaneFocus(paneId: string, content: PaneContent): void {
  for (const [id, pane] of androidPanes) pane.setActive(id === paneId && content.kind === 'android');
  if (content.kind === 'terminal') {
    termManager.switchTo(content.sessionId);
    updateSessionTitleBar();
    void renderFileTree();
    renderFileStatusbar();
  } else {
    updateSessionTitleBar();
    void renderFileTree();
    renderFileStatusbar();
  }
  updatePaneAccents();
}

function renderPaneMessage(body: HTMLElement, title: string, detail?: string): void {
  body.innerHTML = '';
  const message = document.createElement('div');
  message.className = 'pane-error-content';
  const heading = document.createElement('strong');
  heading.textContent = title;
  message.appendChild(heading);
  if (detail) {
    const text = document.createElement('span');
    text.textContent = detail;
    message.appendChild(text);
  }
  body.appendChild(message);
}

function renderEmptyPane(body: HTMLElement, paneId: string): void {
  body.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'pane-empty-content';
  empty.innerHTML = '<strong>空 Pane</strong><span>从右侧选择会话，或使用拆分按钮创建内容。</span>';
  const actions = document.createElement('div');
  actions.className = 'pane-empty-actions';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '创建终端';
  button.addEventListener('click', () => {
    paneWorkspace.focusPane(paneId);
    openNewSessionDialog(paneWorkspace.getWorkspaceKey() || currentCwd);
  });
  const androidButton = document.createElement('button');
  androidButton.type = 'button';
  androidButton.textContent = 'Android 设备';
  androidButton.addEventListener('click', () => {
    paneWorkspace.focusPane(paneId);
    paneWorkspace.replaceContent(paneId, { kind: 'android', label: 'Android 设备' });
  });
  actions.append(button, androidButton);
  empty.appendChild(actions);
  body.appendChild(empty);
}

function renderFilePane(body: HTMLElement, filePath: string): void {
  const requestToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  body.dataset.previewToken = requestToken;
  body.innerHTML = '<div class="pane-empty-content">正在读取文件…</div>';
  const workspace = body.dataset.workspaceKey || currentCwd;
  void window.duocli.readFilePreview(workspace, filePath).then((result) => {
    if (body.dataset.previewToken !== requestToken) return;
    if (!result?.ok) {
      renderPaneMessage(body, '文件无法预览', result?.error || '读取失败');
      return;
    }
    body.innerHTML = '';
    if (result.kind === 'media') {
      const media = document.createElement(result.mediaType === 'application/pdf' ? 'iframe' : 'img');
      if (media instanceof HTMLIFrameElement) {
        media.src = result.dataUrl;
        media.className = 'pane-file-media pane-file-pdf';
      } else {
        media.src = result.dataUrl;
        media.alt = result.name || filePath;
        media.className = 'pane-file-media';
      }
      body.appendChild(media);
      return;
    }
    const pre = document.createElement('pre');
    pre.className = 'pane-file-text';
    pre.textContent = result.content || '';
    body.appendChild(pre);
  }).catch((error) => {
    if (body.dataset.previewToken === requestToken) renderPaneMessage(body, '文件无法预览', String(error));
  });
}

const androidPanes = new Map<string, { setActive: (active: boolean) => void; dispose: () => void }>();

function renderAndroidPane(paneId: string, body: HTMLElement, selectedDeviceId: string): void {
  body.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'pane-android';
  const toolbar = document.createElement('div');
  toolbar.className = 'pane-android-toolbar';
  const select = document.createElement('select');
  select.className = 'pane-android-select';
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'pane-action';
  refresh.title = '刷新设备和画面';
  setIcon(refresh, 'refresh', 13);
  const hint = document.createElement('span');
  hint.className = 'pane-android-hint';
  toolbar.append(select, refresh, hint);
  const preview = document.createElement('canvas');
  preview.className = 'pane-android-preview';
  preview.setAttribute('aria-label', 'Android 设备画面');
  const fallback = document.createElement('img');
  fallback.className = 'pane-android-preview pane-android-fallback';
  fallback.alt = 'Android 设备截图回退';
  fallback.style.display = 'none';
  const controls = document.createElement('div');
  controls.className = 'pane-android-controls';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = '输入文字后回车';
  controls.appendChild(input);
  wrap.append(toolbar, preview, fallback, controls);
  body.appendChild(wrap);

  let currentDevice = selectedDeviceId;
  let isPaneActive = false;
  let mirror: AndroidMirrorClient | null = null;
  let mirrorLastError = '';
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  let fallbackInFlight = false;
  let fallbackGeneration = 0;
  let androidSession: { deviceId: string; sessionId: string; subscriptionId: string; expiresAt: number } | null = null;
  let androidSessionPromise: Promise<typeof androidSession> | null = null;

  const setHint = (value: string) => { hint.textContent = value; };
  const setPreviewVisible = (live: boolean) => {
    preview.hidden = !live;
    fallback.style.display = live ? 'none' : (fallback.src ? 'block' : 'none');
  };
  const stopFallback = () => {
    if (fallbackTimer) clearTimeout(fallbackTimer);
    fallbackTimer = null;
    fallbackGeneration++;
  };
  const loadScreenshot = async () => {
    if (!currentDevice || fallbackInFlight) return;
    fallbackInFlight = true;
    try {
      const result = await window.duocli.androidScreenshot(currentDevice);
      if (result.ok && result.dataUrl) {
        fallback.onload = () => {
          fallback.dataset.deviceWidth = String(fallback.naturalWidth || '');
          fallback.dataset.deviceHeight = String(fallback.naturalHeight || '');
          fallback.dataset.latestGeometryVersion = '0';
          fallback.dataset.presentedGeometryVersion = '0';
        };
        fallback.src = result.dataUrl;
        if (!mirror?.hasFrame) setPreviewVisible(false);
        if (!mirror?.isReady()) setHint('');
      } else if (!mirror?.hasFrame) {
        setHint(result.error || '截图失败');
      }
    } finally {
      fallbackInFlight = false;
    }
  };
  const startFallback = () => {
    if (fallbackTimer) return;
    const generation = ++fallbackGeneration;
    setPreviewVisible(false);
    const tick = async () => {
      if (!fallbackTimer || generation !== fallbackGeneration) return;
      await loadScreenshot();
      if (fallbackTimer && generation === fallbackGeneration) fallbackTimer = setTimeout(tick, 450);
    };
    fallbackTimer = setTimeout(tick, 0);
  };
  const getServerInfo = async () => {
    if (remoteServerInfo) return { port: remoteServerInfo.port, token: remoteServerInfo.token };
    const info = await window.duocli.getRemoteServerInfo();
    if (info) remoteServerInfo = info;
    return info ? { port: info.port, token: info.token } : null;
  };
  const releaseSession = () => {
    const session = androidSession;
    androidSession = null;
    if (!session) return;
    void fetch(`http://127.0.0.1:${remoteServerInfo?.port || 0}/api/android/sessions/${encodeURIComponent(session.sessionId)}/unsubscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${remoteServerInfo?.token || ''}` },
      body: JSON.stringify({ subscriptionId: session.subscriptionId }),
    }).catch(() => {});
  };
  const getTicket = async (deviceId: string, purpose: string) => {
    const info = await getServerInfo();
    if (!info) return '';
    const id = String(deviceId || '').trim();
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${info.token}` };
    const issue = async (session: NonNullable<typeof androidSession>) => {
      const response = await fetch(`http://127.0.0.1:${info.port}/api/android/sessions/${encodeURIComponent(session.sessionId)}/socket-tickets`, {
        method: 'POST', headers, body: JSON.stringify({ subscriptionId: session.subscriptionId, purpose }),
      });
      if (!response.ok) throw new Error(`Android socket ticket 获取失败 (${response.status})`);
      const data = await response.json();
      return data?.ticket || '';
    };
    if (androidSession && androidSession.deviceId === id && androidSession.expiresAt > Date.now() + 5000) {
      try { return await issue(androidSession); } catch { releaseSession(); }
    }
    if (androidSessionPromise) {
      const session = await androidSessionPromise;
      return session ? issue(session) : '';
    }
    androidSessionPromise = (async () => {
      const response = await fetch(`http://127.0.0.1:${info.port}/api/android/sessions`, {
        method: 'POST', headers,
        body: JSON.stringify({ deviceId: id, videoPreference: 'balanced', clientCapabilities: { secureContext: true, webCodecs: true, webRtc: true } }),
      });
      if (!response.ok) throw new Error(`Android 会话创建失败 (${response.status})`);
      const data = await response.json();
      if (!data?.sessionId || !data?.subscriptionId) throw new Error('Android 会话响应无效');
      const session = { deviceId: id, sessionId: data.sessionId, subscriptionId: data.subscriptionId, expiresAt: Number(data.expiresAt) || Date.now() + 30 * 60 * 1000 };
      androidSession = session;
      return session;
    })();
    try {
      const session = await androidSessionPromise;
      return session ? issue(session) : '';
    } finally {
      androidSessionPromise = null;
    }
  };
  const ensureMirror = () => {
    if (mirror) return mirror;
    mirror = new AndroidMirrorClient({
      getServerInfo,
      getTicket,
      protocolVersion: 2,
      onStatus: (message) => {
        if (message.error) mirrorLastError = String(message.error);
        if (message.status === 'ready') mirrorLastError = '';
        if (message.status === 'starting') setHint('正在建立实时镜像…');
        else if (message.status === 'ready') {
          setHint('');
        } else if (message.status === 'error') {
          setHint(mirrorLastError || '实时镜像不可用，已切换截图回退');
          startFallback();
        } else if (message.status === 'disconnected') {
          setHint(mirrorLastError ? `${mirrorLastError}，实时镜像重连中…` : '实时镜像重连中…');
          startFallback();
        } else if (message.status === 'control-owner' && message.controller === false) {
          setHint('设备正在由其他客户端控制');
        }
      },
      onMeta: (meta) => {
        if (meta?.geometryVersion) {
          preview.dataset.latestGeometryVersion = String(meta.geometryVersion);
        }
        if (mirror?.hasFrame) setPreviewVisible(true);
      },
      onFrame: (meta) => {
        if (meta?.geometryVersion) preview.dataset.presentedGeometryVersion = String(meta.geometryVersion);
        setPreviewVisible(true);
        stopFallback();
        setHint('');
      },
      onError: (error) => {
        setHint(error.message || '实时镜像失败，已切换截图回退');
        startFallback();
      },
    });
    mirror.attachCanvas(preview);
    return mirror;
  };
  const startMirror = () => {
    if (!isPaneActive || !currentDevice) return;
    setPreviewVisible(false);
    setHint('正在建立实时镜像…');
    ensureMirror().connect(currentDevice);
  };
  const loadDevices = async () => {
    const result = await window.duocli.androidListDevices();
    select.innerHTML = '';
    if (!result.ok || result.devices.length === 0) {
      currentDevice = '';
      hint.textContent = result.error || '未找到 Android 设备';
      return;
    }
    for (const device of result.devices) {
      const option = document.createElement('option');
      option.value = device.id;
      option.textContent = `${device.id}${device.info ? ` · ${device.info}` : ''}`;
      option.disabled = !device.available;
      select.appendChild(option);
    }
    const preferred = result.devices.find((device) => device.id === currentDevice && device.available)
      || result.devices.find((device) => device.available);
    const nextDevice = preferred?.id || '';
    const changed = currentDevice !== nextDevice;
    currentDevice = nextDevice;
    if (currentDevice) {
      select.value = currentDevice;
      if (changed) {
        paneWorkspace.replaceContent(paneId, {
          kind: 'android',
          deviceId: currentDevice,
          label: `Android · ${currentDevice}`,
        });
        return;
      }
      startMirror();
      if (!mirror?.isReady()) await loadScreenshot();
    }
  };
  select.addEventListener('change', () => {
    releaseSession();
    currentDevice = select.value;
    mirror?.close();
    stopFallback();
    setPreviewVisible(false);
    paneWorkspace.replaceContent(paneId, {
      kind: 'android',
      deviceId: currentDevice,
      label: currentDevice ? `Android · ${currentDevice}` : 'Android 设备',
    });
  });
  refresh.addEventListener('click', () => { void loadDevices(); });
  const surfacePoint = (surface: HTMLCanvasElement | HTMLImageElement, event: PointerEvent): { x: number; y: number } | null => {
    if (!currentDevice) return null;
    const width = surface instanceof HTMLCanvasElement ? surface.width : surface.naturalWidth;
    const height = surface instanceof HTMLCanvasElement ? surface.height : surface.naturalHeight;
    if (!width || !height) return null;
    const rect = surface.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const scale = Math.min(rect.width / width, rect.height / height);
    const renderedWidth = width * scale;
    const renderedHeight = height * scale;
    const offsetX = (rect.width - renderedWidth) / 2;
    const offsetY = (rect.height - renderedHeight) / 2;
    const renderedLeft = rect.left + offsetX;
    const renderedTop = rect.top + offsetY;
    if (event.clientX < renderedLeft || event.clientX > renderedLeft + renderedWidth
      || event.clientY < renderedTop || event.clientY > renderedTop + renderedHeight) return null;
    const deviceWidth = Number(surface.dataset.deviceWidth) || width;
    const deviceHeight = Number(surface.dataset.deviceHeight) || height;
    const latestGeometry = Number(surface.dataset.latestGeometryVersion) || 0;
    const presentedGeometry = Number(surface.dataset.presentedGeometryVersion) || 0;
    if (latestGeometry && presentedGeometry !== latestGeometry) return null;
    return {
      x: Math.max(0, Math.min(deviceWidth - 1, Math.round((event.clientX - renderedLeft) / renderedWidth * (deviceWidth - 1)))),
      y: Math.max(0, Math.min(deviceHeight - 1, Math.round((event.clientY - renderedTop) / renderedHeight * (deviceHeight - 1)))),
    };
  };
  const sendLegacyGesture = (deviceId: string, start: { x: number; y: number }, end: { x: number; y: number }) => {
    const moved = Math.hypot(end.x - start.x, end.y - start.y);
    const action = moved >= 12
      ? window.duocli.androidSwipe(deviceId, start.x, start.y, end.x, end.y)
      : window.duocli.androidTap(deviceId, end.x, end.y);
    void action.then(() => loadScreenshot());
  };
  const bindSurface = (surface: HTMLCanvasElement | HTMLImageElement) => {
    surface.style.touchAction = 'none';
    const activePointers = new Map<number, { deviceId: string; start: { x: number; y: number }; last: { x: number; y: number }; sentDown: boolean }>();
    const pendingMoves = new Map<number, { x: number; y: number }>();
    let moveFrame = 0;
    const flushMoves = () => {
      moveFrame = 0;
      for (const [pointerId, point] of pendingMoves) {
        pendingMoves.delete(pointerId);
        const state = activePointers.get(pointerId);
        if (state?.sentDown && mirror?.isReady()) {
          mirror.sendInput({ type: 'touch', action: 'move', pointerId, x: point.x, y: point.y, pressure: 1 });
        }
      }
    };
    surface.addEventListener('pointerdown', (event) => {
      if ((event.pointerType === 'mouse' && event.button !== 0) || !currentDevice) return;
      const point = surfacePoint(surface, event);
      if (!point) return;
      event.preventDefault();
      const deviceId = currentDevice;
      const sentDown = mirror?.isReady()
        ? (mirror.isController
          ? mirror.sendInput({ type: 'touch', action: 'down', pointerId: event.pointerId, x: point.x, y: point.y, pressure: 1 }) != null
          : (mirror.claimControl(true), false))
        : false;
      activePointers.set(event.pointerId, { deviceId, start: point, last: point, sentDown });
      surface.setPointerCapture?.(event.pointerId);
    });
    surface.addEventListener('pointermove', (event) => {
      const state = activePointers.get(event.pointerId);
      if (!state) return;
      const point = surfacePoint(surface, event);
      if (!point) return;
      event.preventDefault();
      state.last = point;
      pendingMoves.set(event.pointerId, point);
      if (!moveFrame) moveFrame = requestAnimationFrame(flushMoves);
    });
    surface.addEventListener('pointerup', (event) => {
      const state = activePointers.get(event.pointerId);
      if (!state) return;
      const point = surfacePoint(surface, event) || state.last;
      activePointers.delete(event.pointerId);
      pendingMoves.delete(event.pointerId);
      if (moveFrame) { cancelAnimationFrame(moveFrame); moveFrame = 0; flushMoves(); }
      surface.releasePointerCapture?.(event.pointerId);
      event.preventDefault();
      if (state.sentDown && mirror?.isReady()) {
        mirror.sendInput({ type: 'touch', action: 'up', pointerId: event.pointerId, x: point.x, y: point.y, pressure: 0 });
      } else if (!state.sentDown) {
        sendLegacyGesture(state.deviceId, state.start, point);
      }
    });
    surface.addEventListener('pointercancel', (event) => {
      const state = activePointers.get(event.pointerId);
      activePointers.delete(event.pointerId);
      pendingMoves.delete(event.pointerId);
      if (state?.sentDown && mirror?.isReady()) {
        mirror.sendInput({ type: 'touch', action: 'cancel', pointerId: event.pointerId, x: state.last.x, y: state.last.y, pressure: 0 });
      }
    });
  };
  bindSurface(preview);
  bindSurface(fallback);
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !input.value.trim() || !currentDevice) return;
    const value = input.value;
    if (mirror?.isReady()) {
      const sequence = mirror.sendInput({ type: 'text', text: value });
      if (sequence == null) { setHint('文字发送失败'); return; }
      void mirror.waitForAck(sequence).then((ack) => {
        if (ack?.ok === false) throw new Error(ack.error || '设备未接受文字');
        input.value = '';
      }).catch((error) => setHint(error.message || '文字发送结果未知'));
      return;
    }
    void window.duocli.androidInputText(currentDevice, value).then((result) => {
      if (result.ok) input.value = '';
      else setHint(result.error || '文字发送失败');
      return loadScreenshot();
    });
  });
  const setActive = (nextActive: boolean) => {
    isPaneActive = Boolean(nextActive);
    // The pane is the owner of its live stream. Closing an unfocused stream
    // keeps a split workspace from sending duplicate H.264 video.
    if (isPaneActive) {
      startMirror();
      if (!mirror?.isReady()) void loadScreenshot();
      return;
    }
    mirror?.close();
    stopFallback();
    releaseSession();
    setPreviewVisible(false);
  };
  androidPanes.get(paneId)?.dispose();
  androidPanes.set(paneId, {
    setActive,
    dispose: () => {
      setActive(false);
      mirror?.close();
      releaseSession();
    },
  });
  // A restored Android pane can mount synchronously while PaneWorkspace is
  // still constructing. The workspace is available by the time the async
  // device discovery resolves, but do not dereference it during that first
  // render.
  setActive(paneWorkspace?.getFocusedPaneId() === paneId);
  void loadDevices();
}

paneWorkspace = new PaneWorkspace(paneWorkspaceRoot, currentCwd, {
  onContentMount: mountPaneContent,
  onContentUnmount: unmountPaneContent,
  onFocus: handlePaneFocus,
  getAgentTagColors: getCliTagColors,
  onLayoutChange: (layout) => {
    const count = countPanes(layout.root);
    const isEmptyLayout = layout.root.type === 'pane' && layout.root.content.kind === 'empty';
    paneLayoutToolbar.hidden = count < 2;
    paneLayoutSummary.textContent = `${count} 个窗口`;
    // Keep the existing welcome card as the single-pane insertion state. Once
    // real content exists, the pane workspace owns the entire terminal area.
    paneWorkspaceRoot.style.display = isEmptyLayout ? 'none' : '';
    terminalContent.style.display = isEmptyLayout ? 'flex' : 'none';
    emptyState.style.display = isEmptyLayout ? 'flex' : 'none';
    requestAnimationFrame(() => updatePaneAccents());
  },
  onRequestClose: (paneId, content) => {
    if (content.kind === 'terminal') {
      void handleCloseClick(content.sessionId);
      return;
    }
    paneWorkspace.closePane(paneId);
  },
});

paneTileBtn.addEventListener('click', () => paneWorkspace.arrangeTiled());

function applyCurrentCwd(cwd: string): void {
  const next = cwd.trim();
  if (!next) return;
  currentCwd = next;
  cwdInput.value = next;
  localStorage.setItem('duocli_cwd', next);
  addRecentCwd(next);
  paneWorkspace.setWorkspace(next);
  startFileWatcher(next);
  updateSessionTitleBar();
  void renderFileTree();
}

// 恢复上次的工作目录和预设命令
if (savedCwd) {
  cwdInput.value = savedCwd;
}
syncRecentCwdsToRemote();
// 初始化 preset select（含自定义预设），然后恢复上次选中
void (async () => {
  await refreshBuiltinOptions();
  renderPresetSelect();
  if (lastPreset) {
    presetSelect.value = lastPreset;
  }
})();

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
  'Kimi':         ['#c678dd', '#2e1e3d'],
  'Kimi全自动':    ['#d19ae8', '#33204a'],
  'Gemini':       ['#82aaff', '#1e2540'],
  'Gemini全自动':  ['#99bbff', '#222d4a'],
  'OpenCode':     ['#61afef', '#1e2e3d'],
  'Qoder':        ['#e5c07b', '#3d3520'],
  'Qoder全自动':   ['#d4a020', '#3d3520'],
  'QoderCN':      ['#e5c07b', '#3d3520'],
  'QoderCN全自动': ['#d4a020', '#3d3520'],
  'Cursor':       ['#56b6c2', '#1e3338'],
  'Cursor全自动':  ['#56b6c2', '#1e3338'],
  '反重力':       ['#c792ea', '#2e1e3d'],
  '反重力全自动':  ['#c792ea', '#2e1e3d'],
  'Kiro':         ['#f78c6c', '#3d2518'],
  'Kiro全自动':    ['#ff9e7a', '#4a2a1a'],
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

function buildTerminalPaneContent(sessionId: string): Extract<PaneContent, { kind: 'terminal' }> {
  return {
    kind: 'terminal',
    sessionId,
    label: sessionTitles.get(sessionId) || '终端',
    agentLabel: sessionDisplayNames.get(sessionId) || '',
  };
}

function syncTerminalPaneHeaders(): void {
  for (const pane of listPanes(paneWorkspace.getLayout().root)) {
    if (pane.content.kind !== 'terminal') continue;
    const meta = buildTerminalPaneContent(pane.content.sessionId);
    paneWorkspace.updateTerminalPaneMeta(pane.content.sessionId, {
      label: meta.label,
      agentLabel: meta.agentLabel,
    });
  }
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

// 自动配色：多窗口分割时优先给每个终端分配不同主题，便于辨认
const AUTO_THEME_LIST = ['vscode-dark', 'monokai', 'dracula', 'solarized-dark', 'one-dark', 'nord'];

function nextAutoThemeId(): string {
  const usedThemes = new Set(sessionThemes.values());
  const available = AUTO_THEME_LIST.filter((theme) => !usedThemes.has(theme));
  if (available.length > 0) {
    return available[sessionThemes.size % available.length];
  }
  return AUTO_THEME_LIST[sessionThemes.size % AUTO_THEME_LIST.length];
}

// 解析实际 themeId：auto 时为当前工作区里的下一个未占用主题
function resolveThemeId(themeId: string, _cwd: string): string {
  return themeId === 'auto' ? nextAutoThemeId() : themeId;
}

function paneAccentForContent(content: PaneContent): string {
  if (content.kind === 'terminal') {
    const themeId = sessionThemes.get(content.sessionId);
    if (themeId) return TerminalManager.getThemeDotColor(themeId);
  }
  if (content.kind === 'android') return '#34d399';
  if (content.kind === 'file') return cwdToColor(content.path.replace(/[/\\][^/\\]+$/, ''));
  return '#60a5fa';
}

function updatePaneAccents(): void {
  if (!paneWorkspace) return;
  const layout = paneWorkspace.getLayout();
  for (const pane of listPanes(layout.root)) {
    const leaf = document.querySelector<HTMLElement>(`.pane-leaf[data-pane-id="${pane.id}"]`);
    if (!leaf) continue;
    leaf.style.setProperty('--pane-accent', paneAccentForContent(pane.content));
    leaf.dataset.paneKind = pane.content.kind;
  }
}

/** 自动配色模式下，恢复会话后把重复主题重新分配成不同配色。 */
function rebalanceDistinctAutoThemes(): void {
  if (currentThemeId !== 'auto') return;
  const sessionIds = Array.from(sessionThemes.keys());
  if (sessionIds.length < 2) return;
  const used = new Set<string>();
  for (const id of sessionIds) {
    const current = sessionThemes.get(id);
    if (!current) continue;
    if (!used.has(current)) {
      used.add(current);
      continue;
    }
    const available = AUTO_THEME_LIST.filter((theme) => !used.has(theme));
    const next = available.length > 0
      ? available[sessionIds.indexOf(id) % available.length]
      : AUTO_THEME_LIST[sessionIds.indexOf(id) % AUTO_THEME_LIST.length];
    sessionThemes.set(id, next);
    termManager.setTheme(id, next);
    used.add(next);
  }
  updatePaneAccents();
}

// ========== 工具函数 ==========

type UiIconName =
  | 'archive'
  | 'audio'
  | 'chevron-down'
  | 'chevron-left'
  | 'chevron-right'
  | 'edit'
  | 'file'
  | 'folder'
  | 'image'
  | 'pin'
  | 'plus'
  | 'refresh'
  | 'restore'
  | 'trash'
  | 'video'
  | 'x';

const UI_ICON_PATHS: Record<UiIconName, string> = {
  archive: '<path d="M4 7h16v13H4z"></path><path d="M3 4h18v3H3z"></path><path d="M9 11h6"></path>',
  audio: '<path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle>',
  'chevron-down': '<polyline points="6 9 12 15 18 9"></polyline>',
  'chevron-left': '<polyline points="15 18 9 12 15 6"></polyline>',
  'chevron-right': '<polyline points="9 18 15 12 9 6"></polyline>',
  edit: '<path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline>',
  folder: '<path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2h6.5A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z"></path>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><path d="m21 15-5-5L5 21"></path>',
  pin: '<path d="m15 4 5 5-3 1-3.5 3.5.5 3.5-1.5 1.5-2.5-2.5L7 20l-1-1 4-4.5L7.5 12 9 10.5l3.5.5L16 7.5 15 4z"></path>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line>',
  refresh: '<path d="M23 4v6h-6"></path><path d="M1 20v-6h6"></path><path d="M3.5 9A9 9 0 0 1 18.8 5.2L23 10M1 14l4.2 4.8A9 9 0 0 0 20.5 15"></path>',
  restore: '<polyline points="1 4 1 10 7 10"></polyline><path d="M3.5 15A9 9 0 1 0 2 10"></path>',
  trash: '<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14H5V6m3 0V3h8v3"></path><line x1="10" y1="10" x2="10" y2="17"></line><line x1="14" y1="10" x2="14" y2="17"></line>',
  video: '<rect x="3" y="5" width="13" height="14" rx="2"></rect><polygon points="16 10 21 7 21 17 16 14"></polygon>',
  x: '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>',
};

function iconSvg(name: UiIconName, size = 14): string {
  return `<svg class="ui-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${UI_ICON_PATHS[name]}</svg>`;
}

function setIcon(element: HTMLElement, name: UiIconName, size = 14): void {
  element.innerHTML = iconSvg(name, size);
}

function appendIcon(element: HTMLElement, name: UiIconName, size = 14): void {
  const wrapper = document.createElement('span');
  wrapper.className = 'ui-icon-wrap';
  wrapper.innerHTML = iconSvg(name, size);
  element.appendChild(wrapper);
}

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
  const root = paneWorkspace?.getLayout().root;
  const isEmptyLayout = !root || (root.type === 'pane' && root.content.kind === 'empty');
  emptyState.style.display = isEmptyLayout ? 'flex' : 'none';
}

function updateSessionTitleBar(): void {
  const focused = paneWorkspace.getFocusedContent();
  const activeId = focused?.kind === 'terminal' ? focused.sessionId : null;
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
  } else if (focused?.kind === 'file') {
    fileTreePath.textContent = focused.path.split(/[/\\]/).pop() || '文件';
    fileTreePath.title = focused.path;
    window.duocli.setWindowTitle(`DuoCLI-${focused.label || fileTreePath.textContent}`);
  } else if (focused?.kind === 'android') {
    fileTreePath.textContent = 'Android';
    fileTreePath.title = focused.deviceId || '';
    window.duocli.setWindowTitle(`DuoCLI-${focused.label || 'Android'}`);
  } else {
    fileTreePath.textContent = '目录';
    fileTreePath.title = '';
    window.duocli.setWindowTitle('DuoCLI');
  }
}

function getActiveSessionId(): string | null {
  const focused = paneWorkspace.getFocusedContent();
  return focused?.kind === 'terminal' ? focused.sessionId : null;
}

function getActiveSessionCwd(): string {
  const activeId = getActiveSessionId();
  if (activeId) return sessionCwds.get(activeId) || currentCwd;
  return paneWorkspace.getWorkspaceKey() || currentCwd;
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

function openFileInPane(filePath: string): void {
  const workspace = getActiveSessionCwd() || currentCwd || paneWorkspace.getWorkspaceKey();
  if (workspace && workspace !== paneWorkspace.getWorkspaceKey()) paneWorkspace.setWorkspace(workspace);
  const label = filePath.split(/[/\\]/).pop() || filePath;
  paneWorkspace.openContent({ kind: 'file', path: filePath, label });
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
      { label: '在 Finder 中显示', action: () => window.duocli.openFolder(itemPath) },
      { label: '插入路径到终端', action: () => insertPathToActiveTerminal(itemPath) },
    );
  } else {
    items.push(
      { label: '复制绝对路径', action: () => { navigator.clipboard.writeText(itemPath); } },
      { label: '在 Finder 中显示', action: () => window.duocli.openFolder(itemPath) },
      { label: '在 Pane 中预览', action: () => openFileInPane(itemPath) },
      { label: '插入路径到终端', action: () => insertPathToActiveTerminal(itemPath) },
      { label: '用默认应用打开', action: () => window.duocli.openFile(itemPath) },
      { label: '用编辑器打开', action: () => window.duocli.filewatcherOpen(itemPath) },
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
  setIcon(rootArrow, 'chevron-down', 12);
  rootRow.appendChild(rootArrow);

  const rootName = document.createElement('span');
  rootName.className = 'file-tree-name';
  rootName.textContent = rootCwd.split(/[/\\]/).pop() || rootCwd;
  rootName.title = rootCwd;
  rootRow.appendChild(rootName);

  const rootOpenBtn = document.createElement('span');
  rootOpenBtn.className = 'file-tree-open-folder';
  setIcon(rootOpenBtn, 'folder', 13);
  rootOpenBtn.title = '在 Finder 中显示';
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
      setIcon(arrow, item.isDir
        ? (fileTreeExpandedDirs.has(item.path) ? 'chevron-down' : 'chevron-right')
        : 'file', item.isDir ? 12 : 11);
      row.appendChild(arrow);

      const name = document.createElement('span');
      name.className = 'file-tree-name';
      name.textContent = item.name;
      name.title = item.path;
      row.appendChild(name);

      // 目录行：添加「在 Finder 中显示」图标按钮
      if (item.isDir) {
        const openFolderBtn = document.createElement('span');
        openFolderBtn.className = 'file-tree-open-folder';
        setIcon(openFolderBtn, 'folder', 13);
        openFolderBtn.title = '在 Finder 中显示';
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
      paneWorkspace.updateContentLabel('terminal', id, val);
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
      label: '关闭本项目下方所有对话',
      action: () => {
        // 与侧栏一致：置顶优先，其余按创建时间从新到旧。
        const byCreated = (a: string, b: string) => getSessionCreateTime(b) - getSessionCreateTime(a);
        const projectIds = Array.from(sessionTitles.keys()).filter(id =>
          normalizeCwd(sessionCwds.get(id) || '') === targetCwdKey
        );
        const displayOrder = [
          ...projectIds.filter(id => pinnedSessions.has(id)).sort(byCreated),
          ...projectIds.filter(id => !pinnedSessions.has(id)).sort(byCreated),
        ];
        const targetIndex = displayOrder.indexOf(targetId);
        if (targetIndex >= 0) destroySessions(displayOrder.slice(targetIndex + 1));
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
  const activeId = getActiveSessionId();

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

  // 置顶会话单独放在列表顶部，其余会话按创建时间降序（新创建的排最上面）
  const allIds = Array.from(sessionTitles.keys());
  const byCreated = (a: string, b: string) =>
    getSessionCreateTime(b) - getSessionCreateTime(a);
  const pinnedIds = allIds.filter(id => pinnedSessions.has(id)).sort(byCreated);
  const unpinnedIds = allIds.filter(id => !pinnedSessions.has(id)).sort(byCreated);

  // 按 cwd 分组（组间顺序固定：按该组最早会话的创建时间排序，新建不改变组顺序）
  // 同一目录可能因末尾斜杠 / macOS /private 前缀差异被拆成多组，先归一化再分组
  const groups: Map<string, string[]> = new Map();
  const groupDisplayCwd: Map<string, string> = new Map();
  const groupFirstCreatedAt: Map<string, number> = new Map(); // 组排序键：该组最早会话的创建时间
  for (const id of unpinnedIds) {
    const rawCwd = sessionCwds.get(id) || '';
    const key = normalizeCwd(rawCwd);
    if (!groups.has(key)) {
      groups.set(key, []);
      groupDisplayCwd.set(key, rawCwd);
      // 记录该组第一个出现的会话创建时间（unpinnedIds 已按时间排好，第一个就是最早的）
      groupFirstCreatedAt.set(key, getSessionCreateTime(id));
    }
    groups.get(key)!.push(id);
  }

  // 插入一个独立的置顶区域，避免置顶会话继续混在各自的项目分组中。
  const pinnedGroupKey = '__duocli_pinned__';
  if (pinnedIds.length > 0) {
    groups.set(pinnedGroupKey, pinnedIds);
    groupDisplayCwd.set(pinnedGroupKey, '');
    groupFirstCreatedAt.set(pinnedGroupKey, -Infinity);
  }

  // 组间排序：置顶区域固定在最上方，其余按首个会话创建时间升序（先创建的组在上面）
  const sortedGroupKeys = Array.from(groups.keys()).sort((a, b) => {
    if (a === pinnedGroupKey) return -1;
    if (b === pinnedGroupKey) return 1;
    return (groupFirstCreatedAt.get(a) || 0) - (groupFirstCreatedAt.get(b) || 0);
  });

  for (const groupKey of sortedGroupKeys) {
    const ids = groups.get(groupKey)!;
    const isPinnedGroup = groupKey === pinnedGroupKey;
    const cwd = isPinnedGroup ? '' : (groupDisplayCwd.get(groupKey) || groupKey);
    const color = isPinnedGroup ? '#e5a100' : cwdToColor(cwd);

    // 分组头
    const groupHeader = document.createElement('div');
    groupHeader.className = 'session-group-header' + (isPinnedGroup ? ' session-pinned-header' : '');
    groupHeader.style.borderLeftColor = color;
    const groupName = document.createElement('span');
    groupName.className = 'session-group-name';
    appendIcon(groupName, isPinnedGroup ? 'pin' : 'folder', 12);
    const groupLabel = document.createElement('span');
    groupLabel.textContent = isPinnedGroup ? '置顶会话' : cwdShortName(cwd);
    groupName.appendChild(groupLabel);
    groupName.title = isPinnedGroup ? '置顶会话' : cwd;
    // 添加按钮：点击在该目录下创建新终端
    const groupAddBtn = document.createElement('button');
    groupAddBtn.className = 'session-group-add-btn';
    setIcon(groupAddBtn, 'plus', 13);
    groupAddBtn.title = '在此目录下创建新终端';
    groupAddBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openNewSessionDialog(cwd);
    });
    const groupCount = document.createElement('span');
    groupCount.className = 'session-group-count';
    groupCount.textContent = String(ids.length);
    groupHeader.appendChild(groupName);
    if (!isPinnedGroup) groupHeader.appendChild(groupAddBtn);
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
      setIcon(pinBtn, 'pin', 12);
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
      setIcon(editBtn, 'edit', 11);
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
        nameSpan.title = displayName;
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
      setIcon(closeBtn, 'x', 12);
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

      const bottomRow = document.createElement('div');
      bottomRow.className = 'session-item-bottom';
      bottomRow.appendChild(metaRow);
      bottomRow.appendChild(autoContinueLabel);

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

  // ========== 已关闭会话（可恢复） ==========
  if (closedSessions.length > 0) {
    const header = document.createElement('div');
    header.className = 'session-group-header closed-sessions-header';
    header.style.borderLeftColor = '#888';

    const name = document.createElement('span');
    name.className = 'session-group-name';
    appendIcon(name, 'archive', 12);
    const closedLabel = document.createElement('span');
    closedLabel.textContent = `已关闭 (${closedSessions.length})`;
    name.appendChild(closedLabel);

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'session-group-add-btn';
    setIcon(toggleBtn, closedSessionsCollapsed ? 'chevron-right' : 'chevron-down', 12);
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closedSessionsCollapsed = !closedSessionsCollapsed;
      renderSessionList();
    });

    const clearBtn = document.createElement('button');
    clearBtn.className = 'session-group-add-btn';
    setIcon(clearBtn, 'trash', 12);
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
          nameSpan.title = cs.displayName;
          const [tagColor, tagBg] = getCliTagColors(cs.displayName);
          nameSpan.style.setProperty('--cli-tag-color', tagColor);
          nameSpan.style.setProperty('--cli-tag-bg', tagBg);
          metaRow.appendChild(nameSpan);
        }

        const restoreBtn = document.createElement('button');
        restoreBtn.className = 'session-edit-btn';
        const restoring = restoringClosedSessionIds.has(cs.id) || cs.state === 'restoring';
        if (restoring) restoreBtn.textContent = '…';
        else setIcon(restoreBtn, 'restore', 12);
        restoreBtn.title = '恢复会话';
        restoreBtn.disabled = restoring;
        restoreBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          void restoreClosedSession(cs);
        });

        const delBtn = document.createElement('button');
        delBtn.className = 'session-close';
        setIcon(delBtn, 'x', 12);
        delBtn.title = '删除记录';
        delBtn.disabled = restoring;
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

  syncTerminalPaneHeaders();
}

// ========== 核心操作 ==========

function getClosedSessionResumeCommand(cs: ClosedSessionInfo): string {
  return (cs.resumeCommand || '').trim();
}

function syncPaneLiveSessions(): void {
  paneWorkspace.setLiveSessions(sessionTitles.keys());
}

// 恢复已关闭的会话
async function restoreClosedSession(cs: ClosedSessionInfo): Promise<void> {
  if (restoringClosedSessionIds.has(cs.id) || cs.state === 'restoring') return;
  const resumeCmd = getClosedSessionResumeCommand(cs);
  if (!resumeCmd) {
    console.warn('[Renderer] 无法确定该 CLI 的恢复命令，保留关闭记录:', cs);
    return;
  }

  restoringClosedSessionIds.add(cs.id);
  renderSessionList();
  let claimed = false;
  let restored = false;
  let resultId: string | null = null;
  try {
    // Claim the record before creating a PTY so duplicate requests cannot
    // create two provider processes.
    claimed = await window.duocli.closedSessionsBeginRestore(cs.id);
    if (!claimed) return;

    const cwd = cs.cwd || sessionCwds.get(getActiveSessionId() || '') || paneWorkspace.getWorkspaceKey() || '';
    const themeId = resolveThemeId(currentThemeId, cwd);
    const result = await window.duocli.createPty(cwd, resumeCmd, themeId);
    resultId = result.id;
    const now = Date.now();
    sessionTitles.set(result.id, cs.title);
    sessionThemes.set(result.id, result.themeId);
    sessionUpdateTimes.set(result.id, now);
    sessionCreateTimes.set(result.id, now);
    sessionCwds.set(result.id, result.cwd);
    sessionDisplayNames.set(result.id, cs.displayName || result.displayName);
    syncPaneLiveSessions();
    termManager.create(result.id, result.themeId, cwd, (data) => { writePtyWithAutoReset(result.id, data); });
    paneWorkspace.setWorkspace(result.cwd || cwd);
    paneWorkspace.openContent(buildTerminalPaneContent(result.id));
    paneWorkspace.focusContent('terminal', result.id);
    termManager.followSession(result.id);
    updatePaneAccents();

    // The main process only confirms after the launch handshake has produced
    // post-launch output and has not reported a provider error.
    restored = await window.duocli.closedSessionsConfirmRestore(cs.id, result.id);
    if (!restored) return;

    closedSessions = await window.duocli.closedSessionsRemove(cs.id);
    updateEmptyState();
    renderSessionList();
    updateSessionTitleBar();
    void renderFileTree();
    syncPaneLiveSessions();
    setTimeout(() => {
      const dims = termManager.getActiveDimensions();
      if (dims) window.duocli.resizePty(result.id, dims.cols, dims.rows);
    }, 100);
  } catch (error) {
    console.error('恢复终端会话失败:', error);
  } finally {
    if (claimed && !restored) {
      await window.duocli.closedSessionsCancelRestore(cs.id).catch(() => false);
      showCopyToast('恢复未确认，请查看终端输出');
      updateEmptyState();
      updateSessionTitleBar();
    }
    restoringClosedSessionIds.delete(cs.id);
    syncPaneLiveSessions();
    renderSessionList();
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
  paneWorkspace.setWorkspace(currentCwd);
  paneWorkspace.openContent(buildTerminalPaneContent(result.id));
  updatePaneAccents();
  updateEmptyState();
  renderSessionList();
  updateSessionTitleBar();
  void renderFileTree();
  syncPaneLiveSessions();
  setTimeout(() => {
    const dims = termManager.getActiveDimensions();
    if (dims) window.duocli.resizePty(result.id, dims.cols, dims.rows);
  }, 100);
  return true;
}

function switchSession(id: string): void {
  const cwd = sessionCwds.get(id) || currentCwd;
  if (cwd) paneWorkspace.setWorkspace(cwd);
  const prev = getActiveSessionId();
  const content = buildTerminalPaneContent(id);
  if (!paneWorkspace.focusContent('terminal', id)) paneWorkspace.openContent(content);

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
  termManager.followSession(id);
}

// 点击 × 时弹确认
async function handleCloseClick(id: string): Promise<void> {
  const title = sessionTitles.get(id) || '终端';
  const action = await showConfirmDialog(title);
  if (action === 'cancel') return;
  await destroySession(id);
}

async function closeCurrentSession(): Promise<void> {
  if (document.querySelector('.confirm-overlay')) return;

  const activeId = getActiveSessionId();
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
  const autoContinueConfig = sessionAutoContinue.get(id);
  if (autoContinueConfig) cancelAutoContinueRun(autoContinueConfig);
  sessionAutoContinue.delete(id);
}

async function destroySession(id: string): Promise<void> {
  try {
    await window.duocli.destroyPty(id);
  } catch (error) {
    console.error('关闭终端失败:', error);
  }
  paneWorkspace.removeContent('terminal', id);
  clearSessionState(id);
  saveAutoContinueToStorage();
  termManager.destroy(id);
  updateEmptyState();
  renderSessionList();
  updateSessionTitleBar();
  void renderFileTree();
  syncPaneLiveSessions();
}

function destroySessions(ids: string[]): void {
  const uniqIds = Array.from(new Set(ids)).filter(id => sessionTitles.has(id));
  if (uniqIds.length === 0) return;
  for (const id of uniqIds) {
    void Promise.resolve(window.duocli.destroyPty(id)).catch((error) => console.error('关闭终端失败:', error));
    paneWorkspace.removeContent('terminal', id);
    clearSessionState(id);
    termManager.destroy(id);
  }
  saveAutoContinueToStorage();
  updateEmptyState();
  renderSessionList();
  updateSessionTitleBar();
  void renderFileTree();
  syncPaneLiveSessions();
}

async function browseCwd(): Promise<void> {
  const folder = await window.duocli.selectFolder(currentCwd || undefined);
  if (folder) {
    applyCurrentCwd(folder);
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
  const [config, autoResponseConfig] = await Promise.all([
    window.duocli.aiGetCurrentConfig(),
    window.duocli.terminalAutoResponseGetConfig(),
  ]);
  if (config) {
    aiFormatSelect.value = config.apiFormat || 'anthropic';
    aiBaseurlInput.value = config.baseUrl || '';
    aiApikeyInput.value = config.apiKey || '';
    aiModelInput.value = config.model || '';
  }
  applyTerminalAutoResponseConfig(autoResponseConfig);
}

function applyTerminalAutoResponseConfig(config: TerminalAutoResponseConfig): void {
  terminalAutoResponseEnabled.checked = config.enabled;
  terminalAutoResponseRules.value = config.rules
    .map((rule) => `${rule.keyword} => ${rule.response}`)
    .join('\n');
  terminalAutoResponseDelay.value = String(config.delaySeconds);
  terminalAutoResponseCooldown.value = String(config.cooldownSeconds);
}

function parseTerminalAutoResponseRules(text: string): TerminalAutoResponseRule[] {
  const rules: TerminalAutoResponseRule[] = [];
  for (const line of text.split('\n')) {
    const separatorIndex = line.includes('=>') ? line.indexOf('=>') : line.indexOf('→');
    if (separatorIndex === -1) continue;
    const separatorLength = line.startsWith('=>', separatorIndex) ? 2 : 1;
    const keyword = line.slice(0, separatorIndex).trim();
    const response = line.slice(separatorIndex + separatorLength).trim();
    if (keyword && response) rules.push({ keyword, response });
  }
  return rules;
}

async function saveTerminalAutoResponseConfig(): Promise<void> {
  const config: TerminalAutoResponseConfig = {
    enabled: terminalAutoResponseEnabled.checked,
    rules: parseTerminalAutoResponseRules(terminalAutoResponseRules.value),
    delaySeconds: Number(terminalAutoResponseDelay.value),
    cooldownSeconds: Number(terminalAutoResponseCooldown.value),
  };
  terminalAutoResponseSave.textContent = '保存中...';
  terminalAutoResponseSave.setAttribute('disabled', 'true');
  try {
    const saved = await window.duocli.terminalAutoResponseSaveConfig(config);
    applyTerminalAutoResponseConfig(saved);
    terminalAutoResponseSave.textContent = '已保存';
  } catch (error) {
    console.error('保存终端容错规则失败:', error);
    terminalAutoResponseSave.textContent = '保存失败';
  } finally {
    terminalAutoResponseSave.removeAttribute('disabled');
    setTimeout(() => { terminalAutoResponseSave.textContent = '保存容错规则'; }, 1500);
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
  if (tabName === 'ai-config') refreshAiConfig();
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
      applyCurrentCwd(path);
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
  if (v) applyCurrentCwd(v);
});
cwdInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') cwdInput.blur(); });

// ========== 面板收起/展开与拖拽功能 ==========

// 左侧目录树收起/展开
let fileTreeCollapsed = false;
let fileTreeLastWidth = 220;

function syncPanelTogglePositions(): void {
  const toggleInset = 8;
  const toggleSize = 26;

  if (fileTreeCollapsed) {
    fileTreeToggle.style.left = '10px';
  } else {
    const left = Math.max(8, fileTreePanel.offsetWidth - toggleSize - toggleInset);
    fileTreeToggle.style.left = `${left}px`;
  }

  if (sidebarCollapsed) {
    sidebarToggle.style.right = '10px';
  } else {
    const right = Math.max(8, sidebar.offsetWidth - toggleSize - toggleInset);
    sidebarToggle.style.right = `${right}px`;
  }
}

function updatePanelToggleA11y(toggle: HTMLElement, collapsed: boolean, panelName: string): void {
  const expanded = !collapsed;
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.setAttribute('aria-label', `${expanded ? '收起' : '展开'}${panelName}`);
  toggle.setAttribute('title', `${expanded ? '收起' : '展开'}${panelName}`);
}

fileTreeToggle.addEventListener('click', () => {
  fileTreeCollapsed = !fileTreeCollapsed;
  if (fileTreeCollapsed) {
    fileTreeLastWidth = fileTreePanel.offsetWidth;
    fileTreePanel.classList.add('collapsed');
    fileTreeToggle.classList.add('collapsed');
    setIcon(fileTreeToggle, 'chevron-right', 12);
  } else {
    fileTreePanel.style.width = fileTreeLastWidth + 'px';
    fileTreePanel.classList.remove('collapsed');
    fileTreeToggle.classList.remove('collapsed');
    setIcon(fileTreeToggle, 'chevron-left', 12);
  }
  updatePanelToggleA11y(fileTreeToggle, fileTreeCollapsed, '目录树');
  syncPanelTogglePositions();
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
    setIcon(sidebarToggle, 'chevron-left', 12);
  } else {
    sidebar.style.width = sidebarLastWidth + 'px';
    sidebar.classList.remove('collapsed');
    sidebarToggle.classList.remove('collapsed');
    setIcon(sidebarToggle, 'chevron-right', 12);
  }
  updatePanelToggleA11y(sidebarToggle, sidebarCollapsed, '会话列表');
  syncPanelTogglePositions();
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
  syncPanelTogglePositions();
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
    syncPanelTogglePositions();
    dragState.panel = null;
  }
});

window.addEventListener('resize', syncPanelTogglePositions);

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
    setIcon(fileTreeToggle, 'chevron-right', 12);
    updatePanelToggleA11y(fileTreeToggle, true, '目录树');
  }
  const savedSidebarCollapsed = localStorage.getItem('duocli_sidebar_collapsed');
  if (savedSidebarCollapsed === 'true') {
    sidebarCollapsed = true;
    sidebar.classList.add('collapsed');
    sidebarToggle.classList.add('collapsed');
    setIcon(sidebarToggle, 'chevron-left', 12);
    updatePanelToggleA11y(sidebarToggle, true, '会话列表');
  }
  syncPanelTogglePositions();
})();

fileTreeRefreshBtn.addEventListener('click', () => { void refreshFileTree(true); });

// 打开目录按钮
fileTreeOpenBtn.addEventListener('click', () => {
  const activeId = getActiveSessionId();
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
    const activeId = getActiveSessionId();
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
  // 程序设值不触发 change 事件，需手动同步 currentCwd，
  // 否则点击分组头加号创建的终端仍走旧 currentCwd
  if (targetCwd && targetCwd !== currentCwd) {
    applyCurrentCwd(targetCwd);
  } else {
    cwdInput.value = targetCwd;
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
terminalAutoResponseSave.addEventListener('click', () => { void saveTerminalAutoResponseConfig(); });
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
  const activeId = getActiveSessionId();
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
          const currentActiveId = getActiveSessionId();
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
    paneWorkspace.updateContentLabel('terminal', id, title);
    renderSessionList();
    updateSessionTitleBar();
  }
});

window.duocli.onPtyExit((id) => {
  paneWorkspace.removeContent('terminal', id);
  clearSessionState(id);
  saveAutoContinueToStorage();
  termManager.destroy(id);
  updateEmptyState();
  renderSessionList();
  updateSessionTitleBar();
  void renderFileTree();
  syncPaneLiveSessions();
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
  if (normalizeCwd(paneWorkspace.getWorkspaceKey()) === normalizeCwd(info.cwd || currentCwd)) {
    paneWorkspace.openContent(buildTerminalPaneContent(info.id));
  }
  updateEmptyState();
  renderSessionList();
  updateSessionTitleBar();
  void renderFileTree();
  syncPaneLiveSessions();
  setTimeout(() => {
    const dims = termManager.getActiveDimensions();
    if (dims) window.duocli.resizePty(info.id, dims.cols, dims.rows);
  }, 100);
});

// 远程服务器信息处理：合并推送/拉取预设
async function handleRemoteServerInfo(info: typeof remoteServerInfo) {
  if (!info) return;
  const isInitial = !remoteServerInfo;
  const identityChanged = Boolean(
    remoteServerInfo
    && (remoteServerInfo.port !== info.port || remoteServerInfo.token !== info.token),
  );
  console.log('[Renderer] Remote server info:', info);
  remoteServerInfo = info;
  if (!info.health) {
    const health = await window.duocli.getRemoteHealth();
    if (health) remoteServerInfo = { ...info, health };
  }
  renderRemoteServerInfo();
  if (!isInitial && !identityChanged) return;

  startPresetSyncTimer();
  console.log('[Preset Sync] Remote server started, initiating preset sync');
  await reconcilePresetsWithServer('remote-ready');
}

function handleRemoteHealthUpdate(health: RemoteSyncHealth): void {
  if (!remoteServerInfo) return;
  remoteServerInfo = { ...remoteServerInfo, health };
  renderRemoteServerInfo();
}

// 方式1：IPC 推送（可能因竞态丢失）
window.duocli.onRemoteServerInfo(handleRemoteServerInfo);
window.duocli.onRemoteHealthUpdate(handleRemoteHealthUpdate);

remoteServerInfoEl.querySelector('.remote-info-retry')?.addEventListener('click', () => {
  void handleRemoteRetryClick();
});

remoteServerInfoEl.querySelector('.remote-info-url')?.addEventListener('click', () => {
  if (!remoteServerInfo) return;
  const text = remoteServerInfo.publicUrl && remoteServerInfo.health?.status === 'healthy'
    ? remoteServerInfo.publicUrl
    : remoteServerInfo.lanUrl;
  void navigator.clipboard.writeText(text).catch(() => { /* ignore */ });
});

remoteServerInfoEl.querySelector('.remote-info-token-toggle')?.addEventListener('click', (event) => {
  event.stopPropagation();
  remoteTokenVisible = !remoteTokenVisible;
  renderRemoteServerInfo();
});

remoteServerInfoEl.querySelector('.remote-info-token-value')?.addEventListener('click', () => {
  if (!remoteServerInfo || !remoteTokenVisible) return;
  void navigator.clipboard.writeText(remoteServerInfo.token).catch(() => { /* ignore */ });
});

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

window.duocli.getSessions().then((sessions) => {
  for (const info of sessions) {
    if (sessionTitles.has(info.id)) continue;
    const now = Date.now();
    sessionTitles.set(info.id, info.title);
    sessionThemes.set(info.id, info.themeId);
    sessionUpdateTimes.set(info.id, now);
    sessionCreateTimes.set(info.id, now);
    sessionCwds.set(info.id, info.cwd);
    sessionDisplayNames.set(info.id, info.displayName);
    termManager.create(info.id, info.themeId, info.cwd, (data) => { writePtyWithAutoReset(info.id, data); });
  }
  syncPaneLiveSessions();
  rebalanceDistinctAutoThemes();
  paneWorkspace.remountAll();
  updatePaneAccents();
  updateEmptyState();
  renderSessionList();
}).catch(() => {
  syncPaneLiveSessions();
});

// 催工配置：手机端通过 main 进程读取桌面端配置
window.duocli.onGetAutoContinueConfig((sessionId) => {
  const config = sessionAutoContinue.get(sessionId);
  window.duocli.sendAutoContinueConfig(sessionId, config ? serializeAutoContinueConfig(config) : null);
});

// 催工配置：手机端通过 main 进程写入桌面端配置
window.duocli.onSetAutoContinueConfig((sessionId, config) => {
  if (!config || !hasSessionInUI(sessionId)) return;
  const existing = sessionAutoContinue.get(sessionId) || {
    enabled: false,
    messages: [...AUTO_CONTINUE_DEFAULT_MESSAGES],
    intervalMs: AUTO_CONTINUE_DEFAULT_INTERVAL,
    commandIntervalMs: AUTO_CONTINUE_DEFAULT_COMMAND_INTERVAL,
    autoAgree: true,
    autoAgreeDelaySec: AUTO_AGREE_DEFAULT_DELAY_SEC,
    sendDelaySec: AUTO_CONTINUE_SEND_DELAY_SEC,
    maxLoops: AUTO_CONTINUE_DEFAULT_MAX_LOOPS,
    initialDelayMs: AUTO_CONTINUE_DEFAULT_INITIAL_DELAY,
    loopCount: 0,
    nextRunAt: Date.now() + AUTO_CONTINUE_DEFAULT_INITIAL_DELAY,
    sending: false,
    runVersion: 0,
    timeoutIds: new Set(),
  };
  cancelAutoContinueRun(existing);
  Object.assign(existing, config);
  existing.maxLoops ??= AUTO_CONTINUE_DEFAULT_MAX_LOOPS;
  existing.initialDelayMs ??= AUTO_CONTINUE_DEFAULT_INITIAL_DELAY;
  existing.loopCount = 0;
  existing.sending = false;
  existing.nextRunAt = Date.now() + existing.initialDelayMs;
  existing.timeoutIds = new Set();
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
  switchSession(sessionId);

  // 滚动到可见区域
  targetItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// 在 renderSessionList 中给每个 session-item 打上 data-session-id 属性

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
