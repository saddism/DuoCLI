import { Terminal, ITerminalAddon } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { TerminalSequence } from './terminal-sequence';

export interface TerminalSnapshot {
  data: string;
  cols: number;
  rows: number;
  sequence: number;
}

/** Ordered terminal parser: snapshots and resize operations cannot overtake output. */
export class TerminalState {
  readonly terminal = new Terminal({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true });
  private readonly serializer = new SerializeAddon();
  private pending: Promise<void> = Promise.resolve();
  private sequence = 0;
  private disposed = false;
  private readonly inputSequence = new TerminalSequence();

  constructor() {
    this.terminal.loadAddon(new Unicode11Addon() as unknown as ITerminalAddon);
    this.terminal.unicode.activeVersion = '11';
    this.terminal.loadAddon(this.serializer as unknown as ITerminalAddon);
  }

  write(data: string, onParsed: (sequence: number) => void): void {
    this.pending = this.pending.then(() => new Promise<void>(resolve => {
      if (this.disposed) { resolve(); return; }
      this.terminal.write(data, () => {
        this.inputSequence.feed(data);
        if (!this.disposed) onParsed(++this.sequence);
        resolve();
      });
    }));
  }

  resize(cols: number, rows: number, onResize: () => void = () => {}): void {
    this.pending = this.pending.then(() => {
      if (this.disposed) return;
      this.terminal.resize(cols, rows);
      onResize();
    });
  }

  snapshot(consume: (snapshot: TerminalSnapshot) => void): Promise<void> {
    this.pending = this.pending.then(() => {
      if (this.disposed) return;
      consume({
        data: this.serializer.serialize() + this.inputSequence.suffix(),
        cols: this.terminal.cols,
        rows: this.terminal.rows,
        sequence: this.sequence,
      });
    });
    return this.pending;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.pending.then(() => this.terminal.dispose());
  }
}
