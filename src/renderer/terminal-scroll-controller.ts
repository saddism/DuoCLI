import type { Terminal, IDisposable } from '@xterm/xterm';

// Following is user intent, not a snapshot of the viewport during an xterm refresh.
export class TerminalScrollController {
  private following = true;
  private frame: number | null = null;
  private gesture = 0;
  private pointerDown = false;
  private disposed = false;
  private lastBufferType: string | null = null;
  private layoutTimer: ReturnType<typeof setTimeout> | null = null;
  private events = new AbortController();
  private subscriptions: IDisposable[] = [];

  constructor(
    private terminal: Terminal,
    container: HTMLElement,
    private button: HTMLButtonElement,
    private onHistoryIntent?: () => void,
  ) {
    const options = { capture: true, signal: this.events.signal };
    // The rendered screen and viewport are siblings. Listen above both, before
    // xterm processes the gesture or an asynchronous write can complete.
    container.addEventListener('wheel', (event) => {
      if (event.target instanceof Element && event.target.closest('.terminal-history-layer')) return;
      if (event.deltaY === 0 || terminal.buffer.active.type === 'alternate') return;
      const version = this.pause();
      if (event.deltaY < 0 && terminal.buffer.active.viewportY <= 3) this.onHistoryIntent?.();
      this.checkAfterGesture(version, event.deltaY > 0 ? 3 : 0);
    }, { ...options, passive: true });

    container.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !(event.target instanceof Element)
        || event.target.closest('.terminal-history-layer')
        || !event.target.closest('.xterm')) return;
      this.pointerDown = true;
      this.pause();
    }, options);
    const endPointer = () => {
      if (!this.pointerDown) return;
      this.pointerDown = false;
      // A pane switch can request following while the focus click is held.
      // Honor that request on release even when an old selection is present.
      if (this.following) {
        this.sync();
        return;
      }
      this.checkAfterGesture(this.gesture, 0);
    };
    document.addEventListener('pointerup', endPointer, options);
    document.addEventListener('pointercancel', endPointer, options);
    window.addEventListener('blur', endPointer, options);

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
        const typeChanged = this.lastBufferType != null && this.lastBufferType !== buffer.type;
        this.lastBufferType = buffer.type;
        if (typeChanged && !this.following && buffer.type === 'normal' && buffer.viewportY < buffer.baseY) {
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
      const buffer = this.terminal.buffer.active;
      if (!this.pointerDown && !this.terminal.hasSelection()
        && buffer.type === 'normal' && this.distance() <= tolerance) {
        this.follow();
      } else if (!this.pointerDown && buffer.type === 'normal' && buffer.viewportY <= 3) {
        this.onHistoryIntent?.();
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

  gestureVersion(): number {
    return this.gesture;
  }

  stopFollowing(): void {
    if (this.disposed) return;
    this.following = false;
    this.gesture++;
    this.cancelFrame();
    this.updateButton();
  }

  scrollToLine(line: number): void {
    if (this.disposed) return;
    this.stopFollowing();
    const buffer = this.terminal.buffer.active;
    const max = Math.max(0, buffer.baseY);
    this.terminal.scrollToLine(Math.min(Math.max(0, line), max));
    this.updateButton();
  }

  /** Re-follow after mount, fit or pane focus when xterm may still be settling. */
  followAfterLayout(): void {
    this.follow();
    this.cancelLayoutTimer();
    const version = this.gesture;
    const scroll = () => {
      if (this.disposed || version !== this.gesture || !this.following || this.pointerDown) return;
      if (this.distance() > 0) this.safeScrollToBottom();
      this.updateButton();
    };
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (this.disposed || version !== this.gesture) return;
        scroll();
      });
    });
  }

  sync(): void {
    if (this.disposed) return;
    if (this.following && !this.pointerDown) {
      this.safeScrollToBottom();
      if (this.distance() > 0) this.scheduleSync();
    }
    this.updateButton();
  }

  private safeScrollToBottom(): void {
    const renderService = (this.terminal as unknown as { _core?: { _renderService?: { dimensions?: unknown } } })._core?._renderService;
    if (!renderService?.dimensions) return;
    try {
      if (this.terminal.options) this.terminal.options.smoothScrollDuration = 0;
    } catch { /* options may be read-only during dispose */ }
    const baseY = this.terminal.buffer.active.baseY;
    if (this.distance() <= 0) {
      // Already on the live edge: still tell xterm the user is not scrolling,
      // otherwise a full live buffer recycles one row on the next write.
      try { this.terminal.scrollToLine(baseY); } catch { /* renderer may not exist yet */ }
      return;
    }
    const viewport = (this.terminal as unknown as { _core?: { _viewport?: { scrollToLine?: (y: number, force?: boolean) => void } } })._core?._viewport;
    try {
      if (typeof viewport?.scrollToLine === 'function') viewport.scrollToLine(baseY, true);
      else this.terminal.scrollToLine(baseY);
    } catch {
      try { this.terminal.scrollToBottom(); } catch { /* renderer may not exist yet */ }
    }
  }

  private scheduleSync(): void {
    if (this.disposed || !this.following || this.pointerDown || this.frame !== null || this.distance() <= 0) return;
    this.frame = requestAnimationFrame(() => {
      // Keep frame set during scrollToBottom: its synchronous onScroll must
      // not schedule another frame. Read current intent, never an old snapshot.
      if (this.following && !this.pointerDown && this.distance() > 0) this.safeScrollToBottom();
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
