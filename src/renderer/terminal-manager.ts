import { Terminal, ILinkProvider, ILink } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { TerminalScrollController } from './terminal-scroll-controller';

const terminalContentHelpers = require('../../mobile/client/terminal-content-helpers.js') as {
  readLogicalLine: (buffer: any, line: number) => any;
  getSelectionText: (buffer: any, selection: any) => string;
  findLinks: (text: string) => Array<any>;
  matchRange: (logicalLine: any, match: any) => any;
};

// 终端配色方案
const THEMES: Record<string, any> = {
  'vscode-dark': {
    background: '#1e1e1e',
    foreground: '#cccccc',
    cursor: '#aeafad',
    cursorAccent: '#1e1e1e',
    selectionBackground: '#264f78',
    black: '#000000',
    red: '#cd3131',
    green: '#0dbc79',
    yellow: '#e5e510',
    blue: '#2472c8',
    magenta: '#bc3fbc',
    cyan: '#11a8cd',
    white: '#e5e5e5',
    brightBlack: '#666666',
    brightRed: '#f14c4c',
    brightGreen: '#23d18b',
    brightYellow: '#f5f543',
    brightBlue: '#3b8eea',
    brightMagenta: '#d670d6',
    brightCyan: '#29b8db',
    brightWhite: '#e5e5e5',
  },
  'monokai': {
    background: '#272822',
    foreground: '#f8f8f2',
    cursor: '#f8f8f0',
    selectionBackground: '#49483e',
    black: '#272822',
    red: '#f92672',
    green: '#a6e22e',
    yellow: '#f4bf75',
    blue: '#66d9ef',
    magenta: '#ae81ff',
    cyan: '#a1efe4',
    white: '#f8f8f2',
    brightBlack: '#75715e',
    brightRed: '#f92672',
    brightGreen: '#a6e22e',
    brightYellow: '#f4bf75',
    brightBlue: '#66d9ef',
    brightMagenta: '#ae81ff',
    brightCyan: '#a1efe4',
    brightWhite: '#f9f8f5',
  },
  'dracula': {
    background: '#282a36',
    foreground: '#f8f8f2',
    cursor: '#f8f8f2',
    selectionBackground: '#44475a',
    black: '#21222c',
    red: '#ff5555',
    green: '#50fa7b',
    yellow: '#f1fa8c',
    blue: '#bd93f9',
    magenta: '#ff79c6',
    cyan: '#8be9fd',
    white: '#f8f8f2',
    brightBlack: '#6272a4',
    brightRed: '#ff6e6e',
    brightGreen: '#69ff94',
    brightYellow: '#ffffa5',
    brightBlue: '#d6acff',
    brightMagenta: '#ff92df',
    brightCyan: '#a4ffff',
    brightWhite: '#ffffff',
  },
  'solarized-dark': {
    background: '#002b36',
    foreground: '#839496',
    cursor: '#839496',
    selectionBackground: '#073642',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
    brightBlack: '#586e75',
    brightRed: '#cb4b16',
    brightGreen: '#586e75',
    brightYellow: '#657b83',
    brightBlue: '#839496',
    brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1',
    brightWhite: '#fdf6e3',
  },
  'one-dark': {
    background: '#282c34',
    foreground: '#abb2bf',
    cursor: '#528bff',
    selectionBackground: '#3e4451',
    black: '#282c34',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#abb2bf',
    brightBlack: '#5c6370',
    brightRed: '#e06c75',
    brightGreen: '#98c379',
    brightYellow: '#e5c07b',
    brightBlue: '#61afef',
    brightMagenta: '#c678dd',
    brightCyan: '#56b6c2',
    brightWhite: '#ffffff',
  },
  'nord': {
    background: '#2e3440',
    foreground: '#d8dee9',
    cursor: '#d8dee9',
    selectionBackground: '#434c5e',
    black: '#3b4252',
    red: '#bf616a',
    green: '#a3be8c',
    yellow: '#ebcb8b',
    blue: '#81a1c1',
    magenta: '#b48ead',
    cyan: '#88c0d0',
    white: '#e5e9f0',
    brightBlack: '#4c566a',
    brightRed: '#bf616a',
    brightGreen: '#a3be8c',
    brightYellow: '#ebcb8b',
    brightBlue: '#81a1c1',
    brightMagenta: '#b48ead',
    brightCyan: '#8fbcbb',
    brightWhite: '#eceff4',
  },
};

// 配色对应的标识色（用于侧边栏圆点）
const THEME_DOTS: Record<string, string> = {
  'vscode-dark': '#0078d4',
  'monokai': '#a6e22e',
  'dracula': '#bd93f9',
  'solarized-dark': '#268bd2',
  'one-dark': '#61afef',
  'nord': '#88c0d0',
};

// 文件路径链接检测器
class FilePathLinkProvider implements ILinkProvider {
  private onClickCallback: (resolvedPath: string) => void;
  private getCwd: () => string;
  private terminal: Terminal;

  constructor(terminal: Terminal, getCwd: () => string, onClick: (resolvedPath: string) => void) {
    this.terminal = terminal;
    this.getCwd = getCwd;
    this.onClickCallback = onClick;
  }

  provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void {
    const buffer = this.terminal.buffer.active;
    const line = buffer.getLine(y - 1);
    if (!line) { callback(undefined); return; }
    const logical = terminalContentHelpers.readLogicalLine(buffer, y - 1);
    const cwd = this.getCwd();
    const links: ILink[] = [];
    for (const match of terminalContentHelpers.findLinks(logical.text)) {
      if (match.filePath?.includes('node_modules')) continue;
      const range = terminalContentHelpers.matchRange(logical, match);
      if (!range) continue;
      if (match.kind === 'url') {
        links.push({
          range: {
            start: { x: range.start.cell + 1, y: range.start.line + 1 },
            end: { x: range.end.cell + 1, y: range.end.line + 1 },
          },
          text: match.display,
          activate: () => { (window as any).duocli?.openUrl?.(match.url); },
        });
      } else {
        let resolved = match.filePath;
        const separator = cwd.includes('\\') ? '\\' : '/';
        if (/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(resolved)) {
          // 绝对路径
        } else if (/^~[\\/]/.test(resolved)) {
          const homeDir = cwd.match(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)/)?.[1] || '';
          resolved = homeDir ? homeDir + separator + resolved.slice(2) : resolved.slice(2);
        } else if (/^@[\\/]/.test(resolved)) {
          resolved = cwd + separator + resolved.replace(/^@[\\/]?/, '');
        } else if (/^\.[\\/]/.test(resolved)) {
          resolved = cwd + separator + resolved.replace(/^\.[\\/]/, '');
        } else {
          resolved = cwd + separator + resolved;
        }
        if (/[\\/]$/.test(resolved)) resolved = resolved.slice(0, -1);
        links.push({
          range: {
            start: { x: range.start.cell + 1, y: range.start.line + 1 },
            end: { x: range.end.cell + 1, y: range.end.line + 1 },
          },
          text: match.display,
          activate: () => { this.onClickCallback(resolved); },
        });
      }
    }
    callback(links.length > 0 ? links : undefined);
  }
}

// 终端右键菜单（文件链接上右键）
function showTermContextMenu(x: number, y: number, fileName: string, openFn: () => void): void {
  // 移除已有菜单
  document.querySelectorAll('.term-context-menu').forEach(el => el.remove());

  const menu = document.createElement('div');
  menu.className = 'term-context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const openItem = document.createElement('div');
  openItem.className = 'term-context-item';
  openItem.textContent = `打开 ${fileName.split('/').pop() || fileName}`;
  openItem.addEventListener('click', () => { menu.remove(); openFn(); });

  const editorItem = document.createElement('div');
  editorItem.className = 'term-context-item';
  editorItem.textContent = '更换编辑器...';
  editorItem.addEventListener('click', async () => {
    menu.remove();
    await (window as any).duocli.filewatcherSelectEditor();
  });

  menu.appendChild(openItem);
  menu.appendChild(editorItem);
  document.body.appendChild(menu);

  // 点击其他地方关闭
  const close = () => { menu.remove(); document.removeEventListener('click', close); };
  setTimeout(() => document.addEventListener('click', close), 0);
}

interface Cell {
  col: number;
  row: number;
}

// Cmd+方向键：把行首/行尾发给 CLI。xterm 对 meta+方向键直接 break，一个字节都不发。
// Shift+方向键：键盘扩展终端高亮选区。xterm 默认把它转成 ESC[1;2D 交给 CLI，
// 而多数 CLI 并不处理，所以在终端侧自己维护选区并把按键吞掉。
function attachCursorKeyBindings(
  terminal: Terminal,
  container: HTMLElement,
  onData: (data: string) => void,
): void {
  let selection: { anchor: Cell; focus: Cell } | null = null;

  const cursorCell = (): Cell => {
    const buffer = terminal.buffer.active;
    // cursorY 已是 buffer 绝对行号（= buffer.y），不要再加 baseY
    return { col: buffer.cursorX, row: buffer.cursorY };
  };

  // 鼠标选区另起一套，点一下就丢掉键盘锚点，避免下次从旧位置接着扩
  container.addEventListener('mousedown', () => { selection = null; });
  // 松开 Shift 后清掉键盘选区，否则下次 Shift+方向键会从旧锚点接着扩
  container.addEventListener('keyup', (e) => {
    if (e.key === 'Shift') selection = null;
  });

  terminal.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    // 拼音等 IME 组合期间一律交回 xterm，插手会把组合中的文字截断
    if (e.isComposing || e.keyCode === 229) return true;

    if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return true;
      selection = null;
      // iTerm2 Natural Text Editing 同款：行首 Ctrl+A，行尾 Ctrl+E
      onData(e.key === 'ArrowLeft' ? '\x01' : '\x05');
      e.preventDefault();
      return false;
    }

    const isShiftArrow = e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey
      && (e.key === 'ArrowLeft' || e.key === 'ArrowRight'
        || e.key === 'ArrowUp' || e.key === 'ArrowDown');
    if (!isShiftArrow) {
      selection = null;
      return true;
    }

    const buffer = terminal.buffer.active;
    const cols = terminal.cols;
    const cursor = cursorCell();
    if (!selection) selection = { anchor: cursor, focus: cursor };

    const dCol = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    const dRow = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    selection.focus = {
      col: Math.min(cols, Math.max(0, selection.focus.col + dCol)),
      row: Math.min(buffer.length - 1, Math.max(0, selection.focus.row + dRow)),
    };

    // select() 只接受 (起点, 长度)，长度超过一行会自动折行，所以反向选择要交换锚点
    const linear = (p: Cell) => p.row * cols + p.col;
    const { anchor, focus } = selection;
    const start = linear(anchor) <= linear(focus) ? anchor : focus;
    const length = Math.abs(linear(focus) - linear(anchor));
    if (length === 0) {
      terminal.clearSelection();
    } else {
      terminal.select(start.col, start.row, length);
    }

    // 不 preventDefault 的话浏览器会去动那个隐藏的 textarea，把光标挪走
    e.preventDefault();
    return false;
  });
}

interface TermInstance {
  id: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  container: HTMLDivElement;
  themeId: string;
  scroll: TerminalScrollController;
}

export class TerminalManager {
  private instances: Map<string, TermInstance> = new Map();
  private activeId: string | null = null;
  private terminalArea: HTMLElement;
  private detachedHost: HTMLElement;
  private resizeObserver: ResizeObserver;
  private onResize: ((id: string, cols: number, rows: number) => void) | null = null;
  private lastFitSizes: Map<string, { w: number; h: number }> = new Map();
  private fitCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor(terminalArea: HTMLElement, onResize?: (id: string, cols: number, rows: number) => void) {
    this.terminalArea = terminalArea;
    this.onResize = onResize || null;
    this.detachedHost = document.createElement('div');
    this.detachedHost.className = 'terminal-detached-host';
    (terminalArea.parentElement || terminalArea).appendChild(this.detachedHost);
    this.resizeObserver = new ResizeObserver(() => {
      this.fitVisible();
    });
    this.resizeObserver.observe(terminalArea);

    // 窗口重新获得焦点时，重新 fit 并同步 pty 尺寸
    // 解决手机端远程控制后桌面端终端尺寸不同步的问题
    window.addEventListener('focus', () => {
      this.fitVisible();
    });

    // 定时检查容器尺寸变化（兜底：ResizeObserver 可能漏掉某些布局变化）
    this.fitCheckTimer = setInterval(() => {
      this.fitVisibleIfSizeChanged();
    }, 3000);
  }

  create(id: string, themeId: string, cwd: string, onData: (data: string) => void): void {
    const theme = THEMES[themeId] || THEMES['vscode-dark'];
    const terminal = new Terminal({
      theme,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    const container = document.createElement('div');
    container.className = 'terminal-container pane-detached';
    container.id = `tc-${id}`;
    this.detachedHost.appendChild(container);

    terminal.open(container);
    terminal.onData((data) => onData(data));
    attachCursorKeyBindings(terminal, container, onData);

    // 注册文件路径链接检测
    const linkProvider = new FilePathLinkProvider(
      terminal,
      () => cwd,
      (filePath) => { (window as any).duocli.filewatcherOpen(filePath); },
    );
    terminal.registerLinkProvider(linkProvider);

    // 右键菜单：在文件链接上右键可更换编辑器
    container.addEventListener('contextmenu', (e: MouseEvent) => {
      // 获取鼠标所在行
      const cellHeight = terminal.element?.querySelector('.xterm-rows')?.children[0]?.getBoundingClientRect().height || 17;
      const viewportEl = terminal.element?.querySelector('.xterm-viewport') as HTMLElement | null;
      const rowsEl = terminal.element?.querySelector('.xterm-rows') as HTMLElement | null;
      if (!rowsEl || !viewportEl) return;
      const rect = rowsEl.getBoundingClientRect();
      const relY = e.clientY - rect.top;
      const row = Math.floor(relY / cellHeight);
      const bufferY = row + terminal.buffer.active.viewportY + 1;

      // 用 linkProvider 检测该行是否有链接
      linkProvider.provideLinks(bufferY, (links) => {
        if (!links || links.length === 0) return;
        e.preventDefault();
        showTermContextMenu(e.clientX, e.clientY, links[0].text, () => {
          (links[0] as any).activate(undefined, links[0].text);
        });
      });
    });

    // 拦截粘贴事件，检测剪贴板图片或文件
    container.addEventListener('paste', async (e: ClipboardEvent) => {
      if (!e.clipboardData) return;
      const hasImage = Array.from(e.clipboardData.items).some(
        (item) => item.type.startsWith('image/')
      );
      // 优先处理图片
      if (hasImage) {
        e.preventDefault();
        e.stopPropagation();
        try {
          const filePath = await (window as any).duocli.clipboardSaveImage();
          if (filePath) {
            onData(filePath);
          }
        } catch { /* 静默失败 */ }
        return;
      }
      // 尝试处理文件（从剪贴板获取文件路径）
      try {
        const filePath = await (window as any).duocli.clipboardGetFilePath();
        if (filePath) {
          e.preventDefault();
          e.stopPropagation();
          // 对路径进行 shell 转义
          const escapedPath = filePath.includes("'") ? `"${filePath.replace(/"/g, '\\"')}"` : `'${filePath}'`;
          onData(escapedPath + ' ');
        }
      } catch { /* 静默失败 */ }
    }, true);

    // 拦截复制事件：将 isWrapped 的软换行合并为连贯文本
    container.addEventListener('copy', (e: ClipboardEvent) => {
      if (!terminal.hasSelection()) return;
      const selPos = terminal.getSelectionPosition();
      if (!selPos) return;

      const result = terminalContentHelpers.getSelectionText(terminal.buffer.active, selPos);

      e.preventDefault();
      e.stopPropagation();
      e.clipboardData?.setData('text/plain', result);
    }, true);

    // 浮动"滚到底部"按钮
    const scrollBtn = document.createElement('button');
    scrollBtn.className = 'scroll-bottom-btn';
    scrollBtn.innerHTML = '<svg class="ui-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v13"></path><polyline points="6 11 12 17 18 11"></polyline><path d="M5 20h14"></path></svg>';
    scrollBtn.title = '滚到底部';
    scrollBtn.style.display = 'none';
    container.appendChild(scrollBtn);

    const scroll = new TerminalScrollController(terminal, container, scrollBtn);
    this.instances.set(id, { id, terminal, fitAddon, container, themeId, scroll });
    // Keep the manager independently usable by the existing xterm tests and
    // embedders. The desktop app mounts views through PaneWorkspace instead.
    if (!this.terminalArea.classList.contains('pane-workspace-root')) this.switchTo(id);
  }

  /** Move an existing xterm view into a Pane body without recreating its PTY or buffer. */
  mountTo(id: string, host: HTMLElement): boolean {
    const instance = this.instances.get(id);
    if (!instance) return false;
    host.appendChild(instance.container);
    instance.container.classList.remove('pane-detached');
    this.fitTerminal(id, false);
    return true;
  }

  /** Detach a view while keeping the PTY alive in the session list. */
  detach(id: string): boolean {
    const instance = this.instances.get(id);
    if (!instance) return false;
    this.detachedHost.appendChild(instance.container);
    instance.container.classList.add('pane-detached');
    return true;
  }

  switchTo(id: string): void {
    const target = this.instances.get(id);
    if (!target) return;
    target.container.classList.add('active');
    target.container.classList.remove('pane-detached');
    this.activeId = id;
    target.scroll.followAfterLayout();
    setTimeout(() => {
      if (this.instances.get(id) !== target) return;
      this.fitTerminal(id, true);
      target.scroll.followAfterLayout();
    }, 50);
  }

  /** Keep the active session pinned to the latest output after sidebar switches. */
  followSession(id: string): void {
    if (this.activeId !== id) return;
    this.instances.get(id)?.scroll.followAfterLayout();
  }

  write(id: string, data: string): void {
    const inst = this.instances.get(id);
    if (!inst) return;
    // onWriteParsed follows the latest user intent after the whole parse batch.
    inst.terminal.write(data);
  }

  notifyInput(id: string): void {
    this.instances.get(id)?.scroll.follow();
  }

  destroy(id: string): string | null {
    const inst = this.instances.get(id);
    if (!inst) return this.activeId;
    inst.scroll.dispose();
    inst.terminal.dispose();
    inst.container.remove();
    this.instances.delete(id);
    this.lastFitSizes.delete(id);

    // Prefer a still-mounted pane when the focused terminal is destroyed.
    // Detached instances belong to another workspace and must stay hidden
    // until PaneWorkspace explicitly mounts/focuses them.
    if (this.activeId === id) {
      const remaining = Array.from(this.instances.values())
        .filter((instance) => !instance.container.classList.contains('pane-detached'));
      if (remaining.length > 0) {
        const next = remaining[remaining.length - 1];
        this.switchTo(next.id);
      } else this.activeId = null;
    }
    return this.activeId;
  }

  fitActive(): void {
    if (this.activeId) this.fitTerminal(this.activeId, false);
  }

  fitVisible(): void {
    for (const [id, instance] of this.instances) {
      if (instance.container.classList.contains('pane-detached')) continue;
      const rect = instance.container.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      this.fitTerminal(id, false);
    }
  }

  // 定时兜底：检查每个可见 Pane 尺寸是否变化，变了就重新 fit。
  private fitVisibleIfSizeChanged(): void {
    for (const [id, instance] of this.instances) {
      if (instance.container.classList.contains('pane-detached')) continue;
      const rect = instance.container.getBoundingClientRect();
      const previous = this.lastFitSizes.get(id) || { w: 0, h: 0 };
      if (Math.abs(rect.width - previous.w) > 1 || Math.abs(rect.height - previous.h) > 1) {
        this.fitTerminal(id, false);
      }
    }
  }

  private fitTerminal(id: string, focus: boolean): void {
    const instance = this.instances.get(id);
    if (!instance) return;
    try {
      instance.fitAddon.fit();
      instance.scroll.sync();
      const rect = instance.container.getBoundingClientRect();
      this.lastFitSizes.set(id, { w: rect.width, h: rect.height });
      if (this.onResize) {
        const { cols, rows } = instance.terminal;
        if (cols > 0 && rows > 0) this.onResize(instance.id, cols, rows);
      }
      if (focus) instance.terminal.focus();
    } catch {}
  }

  getActiveId(): string | null {
    return this.activeId;
  }

  getActiveDimensions(): { cols: number; rows: number } | null {
    if (!this.activeId) return null;
    const inst = this.instances.get(this.activeId);
    if (!inst) return null;
    return { cols: inst.terminal.cols, rows: inst.terminal.rows };
  }

  hasInstances(): boolean {
    return this.instances.size > 0;
  }

  setTheme(id: string, themeId: string): void {
    const instance = this.instances.get(id);
    if (!instance) return;
    const theme = THEMES[themeId] || THEMES['vscode-dark'];
    instance.themeId = themeId;
    instance.terminal.options.theme = theme;
  }

  static getThemeDotColor(themeId: string): string {
    return THEME_DOTS[themeId] || '#0078d4';
  }
}
