import type { Terminal, IDisposable } from '@xterm/xterm';

// Following is user intent, not a snapshot of the viewport during an xterm refresh.
export class TerminalScrollController {
  private following = true;
  private frame: number | null = null;
  private gesture = 0;
  private pointerDown = false;
  private disposed = false;
  private layoutTimer: ReturnType<typeof setTimeout> | null = null;
  private events = new AbortController();
  private subscriptions: IDisposable[] = [];

  constructor(
    private terminal: Terminal,
    container: HTMLElement,
    private button: HTMLButtonElement,
  ) {
    const options = { capture: true, signal: this.events.signal };
    // The rendered screen and viewport are siblings. Listen above both, before
    // xterm processes the gesture or an asynchronous write can complete.
    container.addEventListener('wheel', (event) => {
      if (event.deltaY === 0 || terminal.buffer.active.type === 'alternate') return;
      const version = this.pause();
      this.checkAfterGesture(version, event.deltaY > 0 ? 3 : 0);
    }, { ...options, passive: true });

    container.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !(event.target instanceof Element)
        || !event.target.closest('.xterm')) return;
      this.pointerDown = true;
      this.pause();
    }, options);
    const endPointer = () => {
      if (!this.pointerDown) return;
      this.pointerDown = false;
      this.checkAfterGesture(this.gesture, 0);
    };
    document.addEventListener('pointerup', endPointer, options);
    document.addEventListener('pointercancel', endPointer, options);

    container.addEventListener('keydown', (event) => {
      if (!event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key !== 'PageUp' && event.key !== 'PageDown'
        && event.key !== 'Home' && event.key !== 'End') return;
      const version = this.pause();
      if (event.key === 'PageDown' || event.key === 'End') this.checkAfterGesture(version, 0);
    }, options);

    button.addEventListener('click', () => this.follow(), { signal: this.events.signal });
    this.subscriptions.push(
      terminal.onScroll(() => {
        this.updateButton();
        this.scheduleSync();
      }),
      terminal.onWriteParsed(() => this.sync()),
      terminal.buffer.onBufferChange(() => {
        const buffer = terminal.buffer.active;
        if (!this.following && buffer.type === 'normal' && buffer.viewportY < buffer.baseY) {
          // The alternate viewport can reset xterm's internal user-scrolling
          // flag. Reapply the saved normal position through public scroll APIs
          // before the parser appends output to this buffer again.
          const viewportY = buffer.viewportY;
          terminal.scrollToBottom();
          terminal.scrollToLine(viewportY);
        }
        this.scheduleSync();
      }),
    );
  }

  private pause(): number {
    this.following = false;
    this.gesture++;
    this.cancelFrame();
    return this.gesture;
  }

  private checkAfterGesture(version: number, tolerance: number): void {
    // Native scroll events and xterm's DOM scroll area settle on later frames.
    const check = () => {
      if (this.disposed || version !== this.gesture) return;
      if (!this.pointerDown && !this.terminal.hasSelection()
        && this.terminal.buffer.active.type === 'normal' && this.distance() <= tolerance) {
        this.follow();
      }
      this.updateButton();
    };
    this.frame = requestAnimationFrame(() => {
      this.frame = requestAnimationFrame(() => {
        this.frame = null;
        check();
      });
    });
  }

  follow(): void {
    if (this.disposed) return;
    this.gesture++;
    this.following = true;
    this.cancelFrame();
    this.cancelLayoutTimer();
    this.sync();
  }

  /** Re-follow after mount, fit or pane focus when xterm may still be settling. */
  followAfterLayout(): void {
    this.follow();
    this.cancelLayoutTimer();
    const scroll = () => {
      if (this.disposed || !this.following || this.pointerDown) return;
      this.terminal.scrollToBottom();
      this.updateButton();
    };
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scroll();
        this.layoutTimer = setTimeout(() => {
          this.layoutTimer = null;
          scroll();
        }, 50);
      });
    });
  }

  sync(): void {
    if (this.disposed) return;
    if (this.following && !this.pointerDown) {
      this.terminal.scrollToBottom();
      this.scheduleSync();
    }
    this.updateButton();
  }

  private scheduleSync(): void {
    if (this.disposed || !this.following || this.pointerDown || this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      // Keep frame set during scrollToBottom: its synchronous onScroll must
      // not schedule another frame. Read current intent, never an old snapshot.
      if (this.following && !this.pointerDown) this.terminal.scrollToBottom();
      this.updateButton();
      this.frame = null;
    });
  }

  private distance(): number {
    const buffer = this.terminal.buffer.active;
    return buffer.baseY - buffer.viewportY;
  }

  private updateButton(): void {
    this.button.style.display = this.distance() <= 0 ? 'none' : 'flex';
  }

  private cancelFrame(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  private cancelLayoutTimer(): void {
    if (this.layoutTimer !== null) clearTimeout(this.layoutTimer);
    this.layoutTimer = null;
  }

  dispose(): void {
    this.disposed = true;
    this.cancelFrame();
    this.cancelLayoutTimer();
    this.events.abort();
    this.subscriptions.forEach(subscription => subscription.dispose());
  }
}
