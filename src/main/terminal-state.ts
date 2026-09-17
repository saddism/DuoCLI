import { Terminal, ITerminalAddon } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { TerminalSequence } from './terminal-sequence';
import {
  TERMINAL_CAPABILITY_VERSION,
  TerminalHistoryArchive,
  type HistoryPage,
} from './terminal-history';

export interface TerminalSnapshot {
  sessionId?: string;
  data: string;
  cols: number;
  rows: number;
  sequence: number;
  /** How many scrollback rows were included above the viewport. */
  scrollback: number;
  /** Total scrollback rows currently available in the parsed buffer. */
  scrollbackTotal: number;
  hasMoreHistory: boolean;
  epoch: number;
  geometryRevision: number;
  historyCursor: string | null;
  historyHasMore: boolean;
  earliestAvailable: boolean;
  truncated: boolean;
  fallback?: 'raw';
  capabilityVersion: number;
}

export interface TerminalHistoryMeta {
  epoch: number;
  historyCursor: string | null;
  historyHasMore: boolean;
  truncated: boolean;
}

export interface TerminalSnapshotOptions {
  /**
   * Scrollback rows to include above the current viewport, counted from the
   * bottom of the scrollback. Omit to serialize the entire buffer (used by
   * tests and rare full restores). Use 0 for "latest screen only".
   */
  scrollback?: number;
}

/** Ordered terminal parser: snapshots and resize operations cannot overtake output. */
export class TerminalState {
  readonly terminal = new Terminal({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true });
  readonly history: TerminalHistoryArchive;
  private readonly serializer = new SerializeAddon();
  private pending: Promise<void> = Promise.resolve();
  private sequence = 0;
  private disposed = false;
  private geometryRevision = 0;
  private readonly inputSequence = new TerminalSequence();

  constructor(epoch = 1) {
    this.history = new TerminalHistoryArchive(epoch);
    this.terminal.loadAddon(new Unicode11Addon() as unknown as ITerminalAddon);
    this.terminal.unicode.activeVersion = '11';
    this.terminal.loadAddon(this.serializer as unknown as ITerminalAddon);
  }

  get epoch(): number {
    return this.history.epoch;
  }

  private historyMarker: { line: number; isDisposed: boolean; dispose(): void } | undefined;
  private historyBaseY = -1;
  private historyAnchorY = -1;
  private historyLineId = 0;

  private syncHistory(force = false): void {
    const buffer = this.terminal.buffer.normal;
    const marker = this.historyMarker;
    // Public xterm markers move when the ring buffer trims. Text comparison
    // alone cannot detect scrolling when consecutive output lines are equal.
    if (!force && marker && !marker.isDisposed && marker.line >= 0
        && marker.line < buffer.baseY && this.historyLineId === this.history.lastLineId) {
      if (buffer.baseY === this.historyBaseY && marker.line === this.historyAnchorY) return;
      this.history.syncTailFromBuffer(buffer, marker.line);
    } else {
      this.history.syncFromBuffer(buffer);
    }
    marker?.dispose();
    this.historyMarker = undefined;
    this.historyBaseY = buffer.baseY;
    this.historyLineId = this.history.lastLineId;
    if (this.terminal.buffer.active.type === 'normal' && buffer.baseY > 0) {
      let row = buffer.baseY - 1;
      while (row > 0 && buffer.getLine(row)?.isWrapped) row--;
      this.historyAnchorY = row;
      this.historyMarker = this.terminal.registerMarker(row - buffer.baseY - buffer.cursorY);
    }
  }

  write(data: string, onParsed: (sequence: number) => void): void {
    this.pending = this.pending.then(() => new Promise<void>(resolve => {
      if (this.disposed) { resolve(); return; }
      this.terminal.write(data, () => {
        this.inputSequence.feed(data);
        this.syncHistory();
        if (!this.disposed) onParsed(++this.sequence);
        resolve();
      });
    }));
  }

  resize(cols: number, rows: number, onResize: () => void = () => {}): void {
    this.pending = this.pending.then(() => {
      if (this.disposed) return;
      this.terminal.resize(cols, rows);
      this.geometryRevision++;
      this.syncHistory(true);
      onResize();
    });
  }

  snapshot(consume: (snapshot: TerminalSnapshot) => void, options?: TerminalSnapshotOptions): Promise<void> {
    this.pending = this.pending.then(() => {
      if (this.disposed) return;
      const scrollbackTotal = Math.max(0, this.terminal.buffer.active.baseY);
      const limited = options?.scrollback !== undefined;
      const scrollback = limited
        ? Math.max(0, Math.min(scrollbackTotal, Math.floor(options.scrollback!)))
        : scrollbackTotal;
      const data = (
        limited
          ? this.serializer.serialize({ scrollback })
          : this.serializer.serialize()
      ) + this.inputSequence.suffix();
      consume({
        data,
        cols: this.terminal.cols,
        rows: this.terminal.rows,
        sequence: this.sequence,
        scrollback,
        scrollbackTotal,
        hasMoreHistory: scrollback < scrollbackTotal,
        epoch: this.history.epoch,
        geometryRevision: this.geometryRevision,
        historyCursor: this.history.historyCursor,
        historyHasMore: this.history.hasMore,
        earliestAvailable: !this.history.truncated && !this.history.hasMore,
        truncated: this.history.truncated,
        capabilityVersion: TERMINAL_CAPABILITY_VERSION,
      });
    });
    return this.pending;
  }

  historyBefore(query: {
    beforeCursor?: string | null;
    limitRows?: number;
    requestId?: string;
    epoch?: number;
  } = {}): Promise<HistoryPage> {
    this.pending = this.pending.then(() => undefined);
    return this.pending.then(() => this.disposed
      ? {
          items: [],
          nextCursor: null,
          hasMore: false,
          earliestAvailable: true,
          truncated: false,
          stale: true,
          requestId: typeof query.requestId === 'string' ? query.requestId : '',
          epoch: this.history.epoch,
        }
      : this.history.pageBefore(query));
  }

  historyMeta(): Promise<TerminalHistoryMeta> {
    this.pending = this.pending.then(() => undefined);
    return this.pending.then(() => ({
      epoch: this.history.epoch,
      historyCursor: this.disposed ? null : this.history.historyCursor,
      historyHasMore: !this.disposed && this.history.hasMore,
      truncated: !this.disposed && this.history.truncated,
    }));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.pending.then(() => this.terminal.dispose());
  }
}
