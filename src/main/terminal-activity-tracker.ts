import { isTransientTerminalOutput } from './session-status';

export type TerminalActivityStatus = 'running' | 'stopped';

export interface TerminalActivityState {
  sessionId: string;
  status: TerminalActivityStatus;
  generation: number;
  revision: number;
  lastContentAt: number;
  stoppedAt?: number;
  quietMs: number;
}

export class TerminalActivityTracker {
  private readonly states = new Map<string, TerminalActivityState>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<(state: TerminalActivityState) => void>();

  constructor(
    private readonly defaultQuietMs = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  onChange(listener: (state: TerminalActivityState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(sessionId: string): TerminalActivityState | undefined {
    const state = this.states.get(sessionId);
    return state ? { ...state } : undefined;
  }

  list(): Record<string, TerminalActivityState> {
    return Object.fromEntries(Array.from(this.states, ([id, state]) => [id, { ...state }]));
  }

  noteData(sessionId: string, data: string): void {
    if (!data || isTransientTerminalOutput(data)) return;
    this.markRunning(sessionId, this.states.get(sessionId)?.quietMs ?? this.defaultQuietMs);
  }

  arm(sessionId: string, quietMs = this.defaultQuietMs): TerminalActivityState {
    return this.markRunning(sessionId, quietMs, true);
  }

  remove(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
    this.states.delete(sessionId);
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private markRunning(sessionId: string, quietMs = this.defaultQuietMs, forceNewGeneration = false): TerminalActivityState {
    const previous = this.states.get(sessionId);
    const now = this.now();
    const state: TerminalActivityState = {
      sessionId,
      status: 'running',
      generation: !previous || previous.status === 'stopped' || forceNewGeneration
        ? (previous?.generation || 0) + 1
        : previous.generation,
      revision: (previous?.revision || 0) + 1,
      lastContentAt: now,
      quietMs: Math.max(1000, Math.min(3_600_000, quietMs)),
    };
    this.states.set(sessionId, state);
    this.scheduleStop(state);
    this.emit(state);
    return { ...state };
  }

  private scheduleStop(state: TerminalActivityState): void {
    const oldTimer = this.timers.get(state.sessionId);
    if (oldTimer) clearTimeout(oldTimer);
    const expectedRevision = state.revision;
    const timer = setTimeout(() => {
      this.timers.delete(state.sessionId);
      const current = this.states.get(state.sessionId);
      if (!current || current.revision !== expectedRevision || current.status !== 'running') return;
      const stopped: TerminalActivityState = {
        ...current,
        status: 'stopped',
        revision: current.revision + 1,
        stoppedAt: this.now(),
      };
      this.states.set(state.sessionId, stopped);
      this.emit(stopped);
    }, state.quietMs);
    this.timers.set(state.sessionId, timer);
  }

  private emit(state: TerminalActivityState): void {
    for (const listener of this.listeners) listener({ ...state });
  }
}
