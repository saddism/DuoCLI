export type SessionUiStatus = 'running' | 'idle' | 'inactive' | 'exited';

// 切换会话 / fit / resize 常会吐出 CSI、光标和清空序列，没有真正的新输出。
export function isTransientTerminalOutput(data: string): boolean {
  const plain = String(data || '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[PX^_][^\x1b]*(?:\x1b\\)?/g, '')
    .replace(/\x1b./g, '')
    .replace(/[\x00-\x1f\x7f]/g, '');
  return !plain.trim();
}

export function resolveSessionUiStatus(
  synced: string | undefined,
  options: { exited?: boolean; viewing?: boolean } = {},
): SessionUiStatus {
  if (options.exited) return 'exited';
  if (synced === 'running') return 'running';
  // 黄灯只表示「已停止且还没看过」。正在看、或桌面还没同步，都不该黄。
  if (synced === 'idle' && !options.viewing) return 'idle';
  return 'inactive';
}
