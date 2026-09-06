export interface AutoContinueRunState {
  enabled: boolean;
  sending: boolean;
  runVersion: number;
  timeoutIds: Set<ReturnType<typeof setTimeout>>;
}

export function cancelAutoContinueRun(state: AutoContinueRunState): void {
  state.runVersion++;
  state.timeoutIds.forEach((timeoutId) => clearTimeout(timeoutId));
  state.timeoutIds.clear();
  state.sending = false;
}

export function scheduleAutoContinueRunTimeout(
  state: AutoContinueRunState,
  runVersion: number,
  callback: () => void,
  delayMs: number,
): void {
  const timeoutId = setTimeout(() => {
    state.timeoutIds.delete(timeoutId);
    if (state.enabled && state.runVersion === runVersion) callback();
  }, delayMs);
  state.timeoutIds.add(timeoutId);
}

export function resolveNextRunAt(storedNextRunAt: unknown, now: number, initialDelayMs: number): number {
  const parsed = Number(storedNextRunAt);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : now + initialDelayMs;
}

export function shouldResetAfterManualInput(loopCount: number, sending: boolean): boolean {
  return loopCount > 0 && !sending;
}
