import { createQuickCommandComposer } from './quick-command-composer';
import { Terminal, ILinkProvider, ILink } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { TerminalScrollController } from './terminal-scroll-controller';

const terminalContentHelpers = require('../../mobile/client/terminal-content-helpers.js') as {
  readLogicalLine: (buffer: any, line: number) => any;
  getSelectionText: (buffer: any, selection: any) => string;
  findLinks: (text: string) => Array<any>;
  matchRange: (logicalLine: any, match: any) => any;
};
const terminalScrollHelpers = require('../../mobile/client/terminal-scroll-helpers.js') as {
  LIVE_TERMINAL_SCROLLBACK: number;
  HISTORY_EDGE_LINES: number;
  createAlternateScreenScroller: (
    getScreen: () => { bufferType: string; rowHeight: number; rows: number } | null,
    send: (data: string) => void,
  ) => { wheel: (deltaY: number) => boolean; reset: () => void };
};
const terminalHistoryLayer = require('../../mobile/client/terminal-history-layer.js') as {
  createHistoryLayer: (options?: Record<string, unknown>) => {
    root: HTMLElement;
    show: (meta?: Record<string, unknown>) => void;
    hide: () => void;
    reset: () => void;
    prepend: (page: unknown) => { applied: boolean; stale?: boolean };
    setCols: (cols: number) => void;
    setLiveUnread: (value: boolean) => void;
    noteLiveOutput: () => void;
    setLoading: (value: boolean) => void;
    isVisible: () => boolean;
    getSelectionText: () => string;
    findText: (text: string) => number;
    scrollToItem: (index: number) => boolean;
    seekText: (text: string) => Promise<number>;
    isSeeking: () => boolean;
    abandonSeek: () => void;
    requestMore: () => void;
  };
  shouldEnterHistory: (input: Record<string, unknown>) => boolean;
};
const terminalActivityFold = require('../../mobile/client/terminal-activity-fold.js') as {
  createView: (terminal: Terminal, host: HTMLElement, options?: Record<string, unknown>) => {
    root: HTMLElement;
    refresh: () => void;
    follow: () => void;
    returnFromOlder: () => void;
    setExpanded: (expanded: boolean) => void;
    syncMetrics: () => void;
    dispose: () => void;
  };
};
require('../../mobile/client/file-preview-helpers.js');
const userPromptBanner = require('../../mobile/client/user-prompt-banner.js') as {
  looksLikeUserPrompt: (text: string) => boolean;
  normalizePrompt: (text: string) => string;
  findPromptLine: (buffer: any, text: string) => number;
  promptBlockStartLine: (buffer: any, text: string) => number;
  findPromptItemIndex: (items: Array<{ text?: string }>, text: string) => number;
  resolvePromptJumpLine: (buffer: any, text: string, marker?: { line: number; isDisposed: boolean } | null) => number;
  scrollLineToTop: (terminal: Terminal, line: number) => number;
  consumeTypedInput: (currentLine: string, data: string) => { line: string; segments: string[] };
  readStoredPrompt: (sessionId: string) => string;
  writeStoredPrompt: (sessionId: string, text: string) => void;
  markerAtLine: (terminal: Terminal, line: number) => { dispose(): void; line: number; isDisposed: boolean } | null;
  createBanner: () => {
    element: HTMLElement;
    textEl: HTMLElement;
    moreBtn: HTMLButtonElement;
    jumpBtn: HTMLButtonElement;
  };
  renderBanner: (banner: any, state: { text?: string; expanded?: boolean }) => void;
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

export const USER_THEMES_CONFIG = [
  { id: 'theme-0', name: 'VS Code Dark', text: '#ffffff', bg: '#0078d4' },
  { id: 'theme-1', name: 'Monokai', text: '#f8f8f2', bg: '#a6e22e' },
  { id: 'theme-2', name: 'Dracula', text: '#f8f8f2', bg: '#bd93f9' },
  { id: 'theme-3', name: 'Solarized Dark', text: '#fff', bg: '#268bd2' },
  { id: 'theme-4', name: 'One Dark', text: '#abb2bf', bg: '#61afef' },
  { id: 'theme-5', name: 'Nord', text: '#eceff4', bg: '#88c0d0' },
  { id: 'theme-6', name: 'CRT 荧光绿', text: '#0a0a0a', bg: '#39ff14' },
  { id: 'theme-7', name: 'CRT 琥珀色', text: '#0a0a0a', bg: '#ffb000' },
  { id: 'theme-8', name: 'CRT 蓝色', text: '#0a0a0a', bg: '#00ffff' },
  { id: 'theme-9', name: '老式显示器', text: '#0a0a0a', bg: '#00ff00' },
  { id: 'theme-10', name: '霓虹粉', text: '#0a0a0a', bg: '#ff00ff' },
  { id: 'theme-11', name: '赛博青', text: '#0a0a0a', bg: '#00ffff' },
  { id: 'theme-12', name: '电光紫', text: '#f5f5f5', bg: '#bf00ff' },
  { id: 'theme-13', name: '火焰橙', text: '#0a0a0a', bg: '#ff4500' },
  { id: 'theme-14', name: '淡蓝', text: '#0a0a0a', bg: '#6cb2eb' },
  { id: 'theme-15', name: '薄荷绿', text: '#0a0a0a', bg: '#7fffd4' },
  { id: 'theme-16', name: '薰衣草紫', text: '#0a0a0a', bg: '#b39eb5' },
  { id: 'theme-17', name: '珊瑚粉', text: '#0a0a0a', bg: '#ff7f50' },
  { id: 'theme-18', name: '海洋蓝', text: '#f5f5f5', bg: '#1e90ff' },
  { id: 'theme-19', name: '森林绿', text: '#f5f5f5', bg: '#228b22' },
  { id: 'theme-20', name: '日落橙', text: '#0a0a0a', bg: '#ff8c00' },
  { id: 'theme-21', name: '午夜紫', text: '#f5f5f5', bg: '#9370db' },
  { id: 'theme-22', name: '极简白', text: '#000000', bg: '#ffffff' },
  { id: 'theme-23', name: '极简黑', text: '#ffffff', bg: '#000000' },
  { id: 'theme-24', name: '红黑', text: '#ff0000', bg: '#1a1a1a' },
  { id: 'theme-25', name: '黄黑', text: '#ffd700', bg: '#1a1a1a' },
];

const DYNAMIC_THEMES = new Map<string, any>();

function openTerminalExternalUrl(url: string): void {
  const trimmed = String(url || '').trim();
  if (!/^https?:\/\//i.test(trimmed)) return;
  void (window as any).duocli?.openUrl?.(trimmed);
}

const TERMINAL_LINK_HANDLER = {
  activate(_event: MouseEvent, text: string) {
    openTerminalExternalUrl(text);
  },
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
          activate: () => { openTerminalExternalUrl(match.url); },
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
          resolvedPath: resolved,
        } as ILink & { resolvedPath: string });
      }
    }
    callback(links.length > 0 ? links : undefined);
  }
}

// 终端右键菜单（文件链接上右键）
function addTermContextItem(menu: HTMLElement, label: string, action: () => void): void {
  const item = document.createElement('div');
  item.className = 'term-context-item';
  item.textContent = label;
  item.addEventListener('click', () => {
    item.closest('.term-context-menu')?.remove();
    action();
  });
  menu.appendChild(item);
}

function addTermContextSeparator(menu: HTMLElement): void {
  const sep = document.createElement('div');
  sep.className = 'term-context-sep';
  menu.appendChild(sep);
}

function clampTermContextMenu(menu: HTMLElement): void {
  const rect = menu.getBoundingClientRect();
  if (rect.bottom > window.innerHeight) {
    menu.style.top = `${Math.max(8, window.innerHeight - rect.height - 8)}px`;
  }
  if (rect.right > window.innerWidth) {
    menu.style.left = `${Math.max(8, window.innerWidth - rect.width - 8)}px`;
  }
}

async function showTermContextMenu(x: number, y: number, filePath: string, openFn: () => void): Promise<void> {
  document.querySelectorAll('.term-context-menu').forEach(el => el.remove());

  const menu = document.createElement('div');
  menu.className = 'term-context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const fileName = filePath.split(/[\\/]/).pop() || filePath;
  const duocli = (window as any).duocli;

  addTermContextItem(menu, `打开 ${fileName}`, openFn);
  addTermContextItem(menu, '用系统默认应用打开', () => { void duocli?.openFile?.(filePath); });
  addTermContextSeparator(menu);

  const appsHost = document.createElement('div');
  menu.appendChild(appsHost);

  addTermContextItem(menu, '其他应用程序...', () => { void duocli?.openWithSystemDialog?.(filePath); });
  addTermContextSeparator(menu);
  addTermContextItem(menu, '在 Finder 中显示', () => { void duocli?.openFolder?.(filePath); });
  addTermContextItem(menu, '更换默认编辑器...', () => { void duocli?.filewatcherSelectEditor?.(); });

  document.body.appendChild(menu);
  clampTermContextMenu(menu);

  const close = (event: Event) => {
    if (menu.contains(event.target as Node)) return;
    menu.remove();
    document.removeEventListener('mousedown', close);
  };
  setTimeout(() => document.addEventListener('mousedown', close), 0);

  try {
    const apps = await duocli?.listOpenWithApps?.(filePath);
    if (!menu.isConnected || !Array.isArray(apps) || apps.length === 0) return;
    for (const app of apps) {
      addTermContextItem(appsHost, `用 ${app.name} 打开`, () => {
        void duocli?.openWithApp?.(filePath, app.path);
      });
    }
    clampTermContextMenu(menu);
  } catch { /* 系统应用列表失败时仍保留其他打开方式 */ }
}

interface Cell {
  col: number;
  row: number;
}

// Cmd+方向键：把行首/行尾发给 CLI。xterm 对 meta+方向键直接 break，一个字节都不发。
// Shift+方向键：键盘扩展终端高亮选区。xterm 默认把它转成 ESC[1;2D 交给 CLI，
// 而多数 CLI 并不处理，所以在终端侧自己维护选区并把按键吞掉。
function allowSelectionDuringMouseMode(terminal: Terminal): void {
  const selection = (terminal as unknown as {
    _core?: { _selectionService?: { shouldForceSelection: (event: MouseEvent) => boolean } };
  })._core?._selectionService;
  if (!selection) return;
  const original = selection.shouldForceSelection.bind(selection);
  // Reading/copying is the default desktop gesture, even when a CLI enables
  // mouse reporting. Ctrl/Command+click still reaches the CLI when needed.
  selection.shouldForceSelection = (event: MouseEvent) => original(event) || event.shiftKey
    || (event.button === 0 && !event.ctrlKey && !event.metaKey);
}

function resetLinkHoverOnLeave(terminal: Terminal): void {
  const linkifier = (terminal as unknown as {
    _core?: { linkifier?: { _lastBufferCell?: unknown; _activeLine: number } };
  })._core?.linkifier;
  if (!linkifier || !terminal.element) return;
  // xterm 5.5 keeps the old cell and provider cache after mouseleave. Returning
  // to the same cell then skips hover detection, including after output changed.
  terminal.element.addEventListener('mouseleave', () => {
    linkifier._lastBufferCell = undefined;
    linkifier._activeLine = -1;
  });
}

function selectedTerminalText(terminal: Terminal, surface: HTMLElement): string {
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && selection.rangeCount
      && surface.contains(selection.getRangeAt(0).commonAncestorContainer)) {
    return selection.toString().replace(/\u00a0/g, ' ');
  }
  const position = terminal.getSelectionPosition();
  return position ? terminalContentHelpers.getSelectionText(terminal.buffer.active, position) : '';
}

async function writeTerminalClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const input = document.createElement('textarea');
    input.value = text;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    const focused = document.activeElement as HTMLElement | null;
    const selection = window.getSelection();
    const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
    try {
      input.select();
      if (!document.execCommand('copy')) throw new Error('复制失败');
    } finally {
      input.remove();
      focused?.focus({ preventScroll: true });
      if (selection && ranges.length) {
        selection.removeAllRanges();
        ranges.forEach(range => selection.addRange(range));
      }
    }
  }
}

function quoteClipboardPath(filePath: string): string {
  if (/^[a-zA-Z]:\\/.test(filePath)) return `"${filePath.replace(/"/g, '\\"')}"`;
  return `'${filePath.replace(/'/g, `'"'"'`)}'`;
}

// Codex 等全屏 TUI 没有滚动缓存。滚轮默认变成方向键，对话不会动。
// 这里改成翻页。
function attachAlternateScreenControls(
  terminal: Terminal,
  surface: HTMLElement,
  onData: (data: string) => void,
): () => void {
  const scroller = terminalScrollHelpers.createAlternateScreenScroller(() => surface.closest('.pane-detached') ? null : ({
    bufferType: terminal.buffer.active.type,
    rowHeight: (terminal.element?.querySelector('.xterm-screen')?.getBoundingClientRect().height || 0) / terminal.rows || 18,
    rows: terminal.rows,
  }), onData);
  const sync = () => {
    scroller.reset();
    surface.classList.toggle('is-alternate-screen', terminal.buffer.active.type === 'alternate');
  };
  const bufferSubscription = terminal.buffer.onBufferChange(sync);
  sync();
  terminal.attachCustomWheelEventHandler((event) => {
    if (terminal.buffer.active.type !== 'alternate') {
      scroller.reset();
      return true;
    }
    if (event.shiftKey || !event.deltaY) return true;
    const rowHeight = (terminal.element?.querySelector('.xterm-screen')?.getBoundingClientRect().height || 0) / terminal.rows || 18;
    let deltaY = event.deltaY;
    if (event.deltaMode === 1) deltaY *= rowHeight;
    else if (event.deltaMode === 2) deltaY *= terminal.rows * rowHeight;
    scroller.wheel(deltaY);
    event.preventDefault();
    event.stopPropagation();
    return false;
  });

  return () => {
    scroller.reset();
    bufferSubscription.dispose();
  };
}

function attachCursorKeyBindings(
  terminal: Terminal,
  container: HTMLElement,
  onData: (data: string) => void,
): void {
  let selection: { anchor: Cell; focus: Cell } | null = null;

  const cursorCell = (): Cell => {
    const buffer = terminal.buffer.active;
    return { col: buffer.cursorX, row: buffer.baseY + buffer.cursorY };
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

    const isCopy = e.key.toLowerCase() === 'c' && !e.altKey
      && ((e.metaKey && !e.ctrlKey) || (e.ctrlKey && e.shiftKey && !e.metaKey));
    if (isCopy) {
      const surface = container.querySelector<HTMLElement>('.terminal-surface');
      const text = surface ? selectedTerminalText(terminal, surface) : '';
      if (text) {
        // xterm's hidden input may suppress native copy for both grid and
        // transcript selections. Copy the current pane's selected text directly.
        void writeTerminalClipboard(text).catch(() => {});
        e.preventDefault();
        return false;
      }
    }

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

const HIDDEN_WRITE_BUDGET = 32 * 1024;

interface TermInstance {
  id: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  container: HTMLDivElement;
  themeId: string;
  scroll: TerminalScrollController;
  disposeComposer: () => void;
  disposeAlternateScroll: () => void;
  promptBanner: ReturnType<typeof userPromptBanner.createBanner>;
  promptText: string;
  promptExpanded: boolean;
  promptMarker: { dispose(): void; line: number; isDisposed: boolean } | null;
  typedLine: string;
  historyLayer: ReturnType<typeof terminalHistoryLayer.createHistoryLayer>;
  hiddenQueued: string[];
  hiddenBytes: number;
  needsResync: boolean;
  resyncing: boolean;
  appliedSeq: number;
  receivedSeq: number;
  liveTail: Array<{ data: string; sequence: number }>;
  epoch: number;
  historyCursor: string | null;
  historyHasMore: boolean;
  bufferHasMore: boolean;
  historyRequestId: number;
  revealGeneration: number;
  revealPromise: Promise<void> | null;
  lastReportedSize: { cols: number; rows: number } | null;
  serverGeometry: { cols: number; rows: number } | null;
  geometryGeneration: number;
  preferredFontSize: number;
  fittedFontSize: number | null;
  preferredCellSize: { width: number; height: number } | null;
  activityView: ReturnType<typeof terminalActivityFold.createView>;
  disposeActivityView: () => void;
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
    const theme = resolveTheme(themeId);
    const terminal = new Terminal({
      theme,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      cursorBlink: true,
      allowProposedApi: true,
      // Codex 等 TUI 会打开鼠标上报。macOS 上 xterm 默认连 Option 拖选也不放行。
      macOptionClickForcesSelection: true,
      scrollback: terminalScrollHelpers.LIVE_TERMINAL_SCROLLBACK,
      smoothScrollDuration: 0,
      linkHandler: TERMINAL_LINK_HANDLER,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    const container = document.createElement('div');
    container.className = 'terminal-container pane-detached';
    const sendInput = onData;
    onData = data => {
      const instance = this.instances.get(id);
      if (!instance || instance.needsResync || instance.resyncing || this.isDetached(instance)
          || container.classList.contains('terminal-reveal-pending')) return;
      this.trackTypedPrompt(id, data);
      sendInput(data);
    };
    container.id = `tc-${id}`;
    this.detachedHost.appendChild(container);

    const surface = document.createElement('div');
    surface.className = 'terminal-surface';
    const promptBanner = userPromptBanner.createBanner();
    container.appendChild(promptBanner.element);
    container.appendChild(surface);
    const gridViewport = document.createElement('div');
    gridViewport.className = 'terminal-grid-viewport';
    surface.appendChild(gridViewport);
    terminal.open(gridViewport);
    allowSelectionDuringMouseMode(terminal);
    resetLinkHoverOnLeave(terminal);
    const disposeAlternateScroll = attachAlternateScreenControls(terminal, surface, onData);
    this.resizeObserver.observe(surface);
    const composer = createQuickCommandComposer({
      onSendKey: (data) => {
        onData(data);
        terminal.focus();
      },
    });
    const showComposerError = (message: string) => {
      const status = composer.element.querySelector('.compose-status');
      if (status) status.textContent = message;
    };
    container.appendChild(composer.element);
    terminal.onData((data) => {
      onData(data);
    });
    attachCursorKeyBindings(terminal, container, onData);

    // 兜底：拦截 xterm 内部可能生成的 <a> 点击，避免在 Electron 窗口内导航
    container.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const href = anchor.getAttribute('href') || '';
      if (!/^https?:\/\//i.test(href)) return;
      event.preventDefault();
      event.stopPropagation();
      openTerminalExternalUrl(href);
    }, true);

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
        const fileLink = (links || []).find((item) => 'resolvedPath' in item && (item as { resolvedPath?: string }).resolvedPath);
        const resolvedPath = (fileLink as { resolvedPath?: string } | undefined)?.resolvedPath;
        if (!fileLink || !resolvedPath) return;
        e.preventDefault();
        void showTermContextMenu(e.clientX, e.clientY, resolvedPath, () => {
          fileLink.activate(e, fileLink.text);
        });
      });
    });

    // 拦截粘贴事件，检测剪贴板图片或文件
    container.addEventListener('paste', async (e: ClipboardEvent) => {
      if ((e.target as Element)?.closest('.terminal-composer')) return;
      if (!e.clipboardData) return;
      const pasteInstance = this.instances.get(id);
      const pasteGeneration = pasteInstance?.revealGeneration;
      const isCurrentPaste = () => !!pasteInstance && this.instances.get(id) === pasteInstance
        && pasteInstance.revealGeneration === pasteGeneration;
      const fallbackText = e.clipboardData.getData('text/plain');
      const hasImage = Array.from(e.clipboardData.items).some(
        (item) => item.type.startsWith('image/')
      );
      // 优先处理图片
      if (hasImage) {
        e.preventDefault();
        e.stopPropagation();
        try {
          const filePath = await (window as any).duocli.clipboardSaveImage();
          if (!isCurrentPaste()) return;
          if (filePath) {
            onData(quoteClipboardPath(filePath) + ' ');
          }
        } catch (error) {
          if (!isCurrentPaste()) return;
          showComposerError(`图片粘贴失败：${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
      // 尝试处理文件（从剪贴板获取文件路径）
      // Stop xterm before awaiting the native clipboard; otherwise the browser
      // inserts the text once and this handler inserts the resolved path again.
      e.preventDefault();
      e.stopPropagation();
      try {
        const filePath = await (window as any).duocli.clipboardGetFilePath();
        if (!isCurrentPaste()) return;
        if (filePath) {
          // 对路径进行 shell 转义
          const escapedPath = quoteClipboardPath(filePath);
          onData(escapedPath + ' ');
        } else if (fallbackText) {
          terminal.paste(fallbackText);
        }
      } catch {
        if (!isCurrentPaste()) return;
        if (fallbackText) terminal.paste(fallbackText);
        else showComposerError('读取剪贴板文件失败');
      }
    }, true);

    // 浮动"滚到底部"按钮
    const scrollBtn = document.createElement('button');
    scrollBtn.className = 'scroll-bottom-btn';
    scrollBtn.innerHTML = '<svg class="ui-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v13"></path><polyline points="6 11 12 17 18 11"></polyline><path d="M5 20h14"></path></svg>';
    scrollBtn.title = '滚到底部';
    scrollBtn.style.display = 'none';
    surface.appendChild(scrollBtn);

    const historyLayer = terminalHistoryLayer.createHistoryLayer({
      onRequest: (query: { requestId?: string; beforeCursor?: string | null }) => {
        void this.requestHistory(id, query);
      },
      onBackToLive: () => this.exitHistory(id),
      getTerminal: () => terminal,
      findIndex: (items: Array<{ text?: string }>, text: string) => userPromptBanner.findPromptItemIndex(items, text),
      onResumeLive: ({ viewportY, deltaY, rowHeight }: { viewportY: number; deltaY: number; rowHeight: number }) => {
        const instance = this.instances.get(id);
        if (!instance) return;
        surface.classList.remove('is-history');
        instance.scroll.scrollToLine(viewportY + Math.ceil(deltaY / rowHeight));
        if (terminal.buffer.active.viewportY >= terminal.buffer.active.baseY) instance.scroll.follow();
      },
    });
    surface.appendChild(historyLayer.root);
    container.addEventListener('copy', (e: ClipboardEvent) => {
      if ((e.target as Element)?.closest('.terminal-composer')) return;
      const selectedText = historyLayer.getSelectionText?.() || selectedTerminalText(terminal, surface);
      if (selectedText) {
        e.preventDefault();
        e.stopPropagation();
        e.clipboardData?.setData('text/plain', selectedText);
        return;
      }
    }, true);
    const scroll = new TerminalScrollController(terminal, container, scrollBtn, (deltaY) => {
      this.maybeEnterHistory(id, deltaY);
    });
    const activityView = terminalActivityFold.createView(terminal, surface, {
      allowAlternate: true,
      keepLiveInput: true,
      showControls: false,
      onOlder: () => {
        if (terminal.buffer.active.type === 'alternate') onData('\x1b[5~');
        else this.maybeEnterHistory(id, -1);
      },
      onNewer: () => onData('\x1b[6~'),
      onLatest: () => onData('\x1b'),
    });
    activityView.root.addEventListener('duocli-terminal-file', event => {
      const filePath = (event as CustomEvent<{ path?: string }>).detail?.path;
      if (!filePath) return;
      const separator = cwd.includes('\\') ? '\\' : '/';
      let resolved = filePath;
      if (/^~[\\/]/.test(resolved)) {
        const home = cwd.match(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)/)?.[1] || '';
        resolved = home + separator + resolved.slice(2);
      } else if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(resolved)) {
        resolved = cwd + separator + resolved.replace(/^[@.][\\/]/, '');
      }
      void (window as any).duocli?.filewatcherOpen?.(resolved);
    });
    let activityTimer: ReturnType<typeof setTimeout> | null = null;
    const refreshActivity = () => {
      if (activityTimer != null) return;
      activityTimer = setTimeout(() => {
        activityTimer = null;
        if (this.instances.get(id)?.container !== container || container.classList.contains('pane-detached')
            || container.classList.contains('terminal-reveal-pending') || historyLayer.isVisible()) return;
        activityView.refresh();
      }, 80);
    };
    const activityParsed = terminal.onWriteParsed(refreshActivity);
    const activityResize = terminal.onResize(refreshActivity);
    const activityScroll = terminal.onScroll(refreshActivity);
    gridViewport.addEventListener('scroll', refreshActivity, { passive: true });
    const instance: TermInstance = {
      id,
      terminal,
      fitAddon,
      container,
      themeId,
      scroll,
      disposeAlternateScroll,
      disposeComposer: composer.dispose,
      promptBanner,
      promptText: userPromptBanner.readStoredPrompt(id),
      promptExpanded: false,
      promptMarker: null,
      typedLine: '',
      historyLayer,
      hiddenQueued: [],
      hiddenBytes: 0,
      // The PTY can produce output before this renderer instance exists.
      // Hydrate the first visible frame from its authoritative snapshot.
      needsResync: true,
      resyncing: false,
      appliedSeq: 0,
      receivedSeq: 0,
      liveTail: [],
      epoch: 1,
      historyCursor: null,
      historyHasMore: false,
      bufferHasMore: false,
      historyRequestId: 0,
      revealGeneration: 0,
      revealPromise: null,
      lastReportedSize: null,
      serverGeometry: null,
      geometryGeneration: 0,
      preferredFontSize: terminal.options.fontSize || 14,
      fittedFontSize: null,
      preferredCellSize: null,
      activityView,
      disposeActivityView: () => {
        if (activityTimer != null) clearTimeout(activityTimer);
        activityParsed.dispose();
        activityResize.dispose();
        activityScroll.dispose();
        gridViewport.removeEventListener('scroll', refreshActivity);
        activityView.dispose();
      },
    };
    promptBanner.moreBtn.addEventListener('click', () => {
      instance.promptExpanded = !instance.promptExpanded;
      this.renderPromptBanner(instance);
      this.fitTerminal(id, false);
    });
    promptBanner.jumpBtn.addEventListener('click', () => { void this.jumpToUserPrompt(id); });
    this.instances.set(id, instance);
    this.renderPromptBanner(instance);
    this.rebindPromptMarker(instance);
    // Keep the manager independently usable by the existing xterm tests and
    // embedders. The desktop app mounts views through PaneWorkspace instead.
    if (!this.terminalArea.classList.contains('pane-workspace-root')) this.switchTo(id);
  }

  /** Move an existing xterm view into a Pane body without recreating its PTY or buffer. */
  mountTo(id: string, host: HTMLElement): boolean {
    const instance = this.instances.get(id);
    if (!instance) return false;
    instance.container.classList.add('terminal-reveal-pending');
    host.appendChild(instance.container);
    instance.container.classList.remove('pane-detached');
    void this.revealLatest(instance, false);
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
    // Pane pointerdown also focuses the current session while selecting text.
    // Sidebar selections explicitly call followSession, including reselects.
    if (this.activeId === id) return;
    // Standalone users of the manager do not have PaneWorkspace to mount a
    // newly created view. A child of the detached host cannot receive focus.
    if (!this.terminalArea.classList.contains('pane-workspace-root')) {
      for (const instance of this.instances.values()) {
        if (instance === target) continue;
        this.detachedHost.appendChild(instance.container);
        instance.container.classList.add('pane-detached');
        instance.container.classList.remove('active');
      }
      this.terminalArea.appendChild(target.container);
    }
    this.exitHistory(id, !target.needsResync);
    target.container.classList.add('active');
    target.container.classList.add('terminal-reveal-pending');
    target.container.classList.remove('pane-detached');
    this.activeId = id;
    void this.revealLatest(target, true);
  }

  /** Expand or collapse tool records without switching the terminal view. */
  setActivitiesExpanded(id: string, expanded: boolean): void {
    this.instances.get(id)?.activityView.setExpanded(expanded);
  }

  /** Keep the active session pinned to the latest output after sidebar switches. */
  followSession(id: string): void {
    if (this.activeId !== id) return;
    const instance = this.instances.get(id);
    if (!instance || instance.container.classList.contains('terminal-reveal-pending')) return;
    this.exitHistory(id, !instance.needsResync);
    if (instance.needsResync) {
      void this.revealLatest(instance, true);
      return;
    }
  }

  write(id: string, data: string): void {
    const inst = this.instances.get(id);
    if (!inst || inst.needsResync || inst.resyncing) return;
    if (this.isDetached(inst)) {
      if (inst.hiddenBytes + data.length > HIDDEN_WRITE_BUDGET) {
        inst.hiddenQueued = [];
        inst.hiddenBytes = 0;
        inst.needsResync = true;
        return;
      }
      inst.hiddenQueued.push(data);
      inst.hiddenBytes += data.length;
      return;
    }
    this.writeLive(inst, data);
  }

  applyParsed(id: string, data: string, sequence: number): void {
    const inst = this.instances.get(id);
    if (!inst || !Number.isInteger(sequence) || sequence <= inst.appliedSeq) return;
    inst.receivedSeq = Math.max(inst.receivedSeq, sequence);
    if (inst.resyncing || inst.needsResync) {
      inst.liveTail.push({ data, sequence });
      // Keep only a bounded tail while hidden. A sequence gap is reconciled
      // from a fresh snapshot, never treated as successfully rendered output.
      let bytes = 0;
      let start = inst.liveTail.length;
      while (start > 0 && bytes + inst.liveTail[start - 1].data.length <= HIDDEN_WRITE_BUDGET) {
        bytes += inst.liveTail[--start].data.length;
      }
      if (start > 0) inst.liveTail = inst.liveTail.slice(start);
      return;
    }
    if (sequence !== inst.appliedSeq + 1) {
      inst.needsResync = true;
      this.applyParsed(id, data, sequence);
      if (!this.isDetached(inst)) void this.revealLatest(inst, false);
      return;
    }
    inst.appliedSeq = sequence;
    this.write(id, data);
  }

  notifyInput(id: string): void {
    const instance = this.instances.get(id);
    if (!instance || instance.historyLayer.isVisible()) return;
    instance.scroll.follow();
  }

  /** Reconcile a shared PTY geometry change before parsing its next TUI frame. */
  applyPtyGeometry(id: string, geometry?: { cols: number; rows: number }): void {
    const instance = this.instances.get(id);
    if (!instance) return;
    if (geometry && (!Number.isInteger(geometry.cols) || !Number.isInteger(geometry.rows)
        || geometry.cols < 2 || geometry.rows < 1)) return;
    if (geometry && instance.serverGeometry?.cols === geometry.cols && instance.serverGeometry.rows === geometry.rows) return;
    instance.geometryGeneration = (instance.geometryGeneration || 0) + 1;
    instance.needsResync = true;
    if (!instance.resyncing && !this.isDetached(instance)) void this.revealLatest(instance, false);
  }

  private trackTypedPrompt(id: string, data: string): void {
    const instance = this.instances.get(id);
    if (!instance) return;
    const parsed = userPromptBanner.consumeTypedInput(instance.typedLine, data);
    instance.typedLine = parsed.line;
    const last = parsed.segments.filter((segment) => userPromptBanner.looksLikeUserPrompt(segment)).pop();
    if (last) this.noteUserPrompt(id, last);
  }

  private noteUserPrompt(id: string, text: string): void {
    const instance = this.instances.get(id);
    if (!instance || !userPromptBanner.looksLikeUserPrompt(text)) return;
    const normalized = userPromptBanner.normalizePrompt(text);
    instance.promptMarker?.dispose();
    instance.promptText = normalized;
    instance.promptExpanded = false;
    instance.promptMarker = instance.terminal.registerMarker(0);
    userPromptBanner.writeStoredPrompt(id, normalized);
    this.renderPromptBanner(instance);
    this.fitTerminal(id, false);
  }

  private renderPromptBanner(instance: TermInstance): void {
    userPromptBanner.renderBanner(instance.promptBanner, {
      text: instance.promptText,
      expanded: instance.promptExpanded,
    });
  }

  private rebindPromptMarker(instance: TermInstance): void {
    if (!instance.promptText) return;
    const line = userPromptBanner.promptBlockStartLine(instance.terminal.buffer.active, instance.promptText);
    if (line < 0) return;
    instance.promptMarker?.dispose();
    instance.promptMarker = userPromptBanner.markerAtLine(instance.terminal, line);
  }

  private async jumpToUserPrompt(id: string): Promise<void> {
    const instance = this.instances.get(id);
    if (!instance?.promptText) return;
    const prompt = instance.promptText;
    this.rebindPromptMarker(instance);
    const line = userPromptBanner.resolvePromptJumpLine(
      instance.terminal.buffer.active,
      prompt,
      instance.promptMarker,
    );
    if (line >= 0) {
      instance.scroll.scrollToLine(line);
      userPromptBanner.scrollLineToTop(instance.terminal, line);
      return;
    }
    if (instance.historyLayer.isVisible()) {
      const historyIndex = instance.historyLayer.findText(prompt);
      if (historyIndex >= 0) {
        instance.historyLayer.scrollToItem(historyIndex);
        return;
      }
    } else {
      await this.refreshHistoryMeta(instance);
      if (this.instances.get(id) !== instance || instance.promptText !== prompt) return;
    }
    if (!instance.historyLayer.isVisible() && !instance.historyHasMore) {
      this.showJumpMiss(instance, '这段内容不在当前已加载范围');
      return;
    }
    this.enterHistory(id);
    const found = await instance.historyLayer.seekText(prompt);
    if (this.instances.get(id) !== instance) return;
    if (found >= 0 || instance.historyLayer.isSeeking() || !instance.historyLayer.isVisible()) return;
    this.showJumpMiss(instance, '这段内容不在当前已加载范围');
  }

  destroy(id: string): string | null {
    const inst = this.instances.get(id);
    if (!inst) return this.activeId;
    if (inst.terminal.element?.parentElement) this.resizeObserver.unobserve(inst.terminal.element.parentElement);
    inst.disposeComposer();
    inst.disposeAlternateScroll();
    inst.disposeActivityView();
    inst.historyLayer.reset();
    inst.scroll.dispose();
    inst.promptMarker?.dispose();
    const terminal = inst.terminal;
    // xterm Viewport schedules syncScrollArea on a 0-timeout during open.
    // Disposing in the same turn leaves that callback on a dead renderer.
    window.setTimeout(() => {
      try { terminal.dispose(); } catch { /* already torn down */ }
    }, 0);
    inst.container.remove();
    this.instances.delete(id);
    this.lastFitSizes.delete(id);
    userPromptBanner.writeStoredPrompt(id, '');

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
      // The prompt and composer can resize the surface without changing
      // the outer pane. FitAddon measures this same parent of .xterm.
      const surface = instance.terminal.element?.parentElement;
      if (!surface) continue;
      const rect = surface.getBoundingClientRect();
      const previous = this.lastFitSizes.get(id) || { w: 0, h: 0 };
      if (Math.abs(rect.width - previous.w) > 1 || Math.abs(rect.height - previous.h) > 1) {
        this.fitTerminal(id, false);
      }
    }
  }

  private isDetached(instance: TermInstance): boolean {
    return instance.container.classList.contains('pane-detached');
  }

  private writeLive(inst: TermInstance, data: string): Promise<void> {
    const selectedViewport = !inst.scroll.isFollowing() && inst.terminal.hasSelection()
      ? inst.terminal.buffer.active.viewportY : null;
    const gesture = inst.scroll.gestureVersion();
    return new Promise(resolve => {
      inst.terminal.write(data, () => {
        if (this.instances.get(inst.id) !== inst) { resolve(); return; }
        if (selectedViewport !== null && inst.terminal.hasSelection()
            && inst.scroll.gestureVersion() === gesture) {
          inst.scroll.scrollToLine(selectedViewport);
        }
        if (inst.promptText && (!inst.promptMarker || inst.promptMarker.isDisposed)) {
          this.rebindPromptMarker(inst);
        }
        if (inst.historyLayer.isVisible()) inst.historyLayer.noteLiveOutput();
        resolve();
      });
    });
  }

  private flushHidden(instance: TermInstance): Promise<void> {
    if (!instance.hiddenQueued.length) return Promise.resolve();
    const queued = instance.hiddenQueued.join('');
    instance.hiddenQueued = [];
    instance.hiddenBytes = 0;
    return this.writeLive(instance, queued);
  }

  private isRevealStale(instance: TermInstance, generation: number): boolean {
    return this.instances.get(instance.id) !== instance || instance.revealGeneration !== generation;
  }

  private async frames(count = 2): Promise<void> {
    for (let i = 0; i < count; i++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    }
  }

  private async revealLatest(instance: TermInstance, focus: boolean): Promise<void> {
    const generation = ++instance.revealGeneration;
    instance.container.classList.add('terminal-reveal-pending');
    const previous = instance.revealPromise;
    const work = (async () => {
      const gestureAtStart = instance.scroll.gestureVersion();
      await previous?.catch(() => undefined);
      if (this.isRevealStale(instance, generation)) return;
      if (instance.needsResync) {
        const geometryAtStart = instance.geometryGeneration || 0;
        await this.resyncFromSnapshot(instance);
        // Restore can resize the pane several times as fonts and chrome settle.
        // Retry that geometry race once after layout, without accepting stale
        // output or making the user reselect an otherwise healthy session.
        if (instance.needsResync && !this.isRevealStale(instance, generation)
            && (instance.geometryGeneration || 0) !== geometryAtStart) {
          await this.frames(2);
          if (!this.isRevealStale(instance, generation)) await this.resyncFromSnapshot(instance);
        }
      } else await this.flushHidden(instance);
      if (this.isRevealStale(instance, generation)) return;
      if (instance.needsResync) {
        instance.container.classList.remove('terminal-reveal-pending', 'terminal-connecting');
        this.showJumpMiss(instance, '同步未完成，重新选择此会话重试');
        return;
      }
      this.fitTerminal(instance.id, false);
      if (instance.scroll.gestureVersion() === gestureAtStart) instance.scroll.follow();
      await this.frames(2);
      if (this.isRevealStale(instance, generation)) return;
      this.fitTerminal(instance.id, false);
      if (instance.scroll.gestureVersion() === gestureAtStart) instance.scroll.follow();
      void this.refreshHistoryMeta(instance);
      instance.container.classList.remove('terminal-reveal-pending');
      instance.container.classList.remove('terminal-connecting');
      instance.activityView?.refresh();
      if (focus) {
        // The view is now visible. Deliver focus in this transaction rather
        // than leaving the keyboard on <body> until another animation frame.
        if (!this.isRevealStale(instance, generation) && this.activeId === instance.id
            && !this.isDetached(instance)
            && !instance.container.querySelector('.terminal-composer')?.contains(document.activeElement)) {
          try { instance.terminal.focus(); } catch { /* ignore an unmounted renderer */ }
        }
      }
    })();
    instance.revealPromise = work;
    window.setTimeout(() => {
      if (this.isRevealStale(instance, generation)) return;
      if (instance.container.classList.contains('terminal-reveal-pending')) {
        instance.container.classList.add('terminal-connecting');
      }
    }, 150);
    return work;
  }

  private async resyncFromSnapshot(instance: TermInstance): Promise<void> {
    const api = (window as unknown as { duocli?: {
      snapshotPty?: (id: string, options?: { scrollback?: number }) => Promise<any>;
    } }).duocli;
    if (!api?.snapshotPty) {
      instance.needsResync = false;
      this.flushHidden(instance);
      return;
    }
    instance.resyncing = true;
    instance.hiddenQueued = [];
    instance.hiddenBytes = 0;
    let retryReason = 'live output did not settle';
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const geometryGeneration = instance.geometryGeneration || 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let snapshot: any;
        try {
          snapshot = await Promise.race([
            api.snapshotPty(instance.id, { scrollback: terminalScrollHelpers.LIVE_TERMINAL_SCROLLBACK }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('Terminal snapshot timed out')), 8000);
            }),
          ]).finally(() => clearTimeout(timer));
        } catch {
          retryReason = 'snapshot IPC failed or timed out';
          // An IPC timeout/rejection can be transient during renderer restore.
          continue;
        }
        if (this.instances.get(instance.id) !== instance) return;
        if ((instance.geometryGeneration || 0) !== geometryGeneration) {
          retryReason = 'geometry changed during capture';
          continue;
        }
        if (!Number.isInteger(snapshot?.sequence) || typeof snapshot?.data !== 'string') {
          throw new Error('Invalid terminal snapshot');
        }
        // Drain any write submitted before resync before resetting its parser.
        await new Promise<void>(resolve => instance.terminal.write('', resolve));
        if (this.instances.get(instance.id) !== instance) return;
        instance.appliedSeq = snapshot.sequence;
        instance.receivedSeq = Math.max(instance.receivedSeq, snapshot.sequence);
        if (snapshot.epoch && snapshot.epoch !== instance.epoch) instance.historyLayer.reset();
        instance.epoch = Number(snapshot.epoch) || instance.epoch;
        instance.historyCursor = snapshot.historyCursor || null;
        instance.historyHasMore = Boolean(snapshot.historyHasMore);
        instance.bufferHasMore = Boolean(snapshot.hasMoreHistory);
        instance.terminal.reset();
        if (Number.isInteger(snapshot.cols) && Number.isInteger(snapshot.rows)
            && snapshot.cols >= 2 && snapshot.rows > 0) {
          if (typeof (window as any).duocli?.onPtyGeometry === 'function') {
            instance.serverGeometry = { cols: snapshot.cols, rows: snapshot.rows };
          }
          instance.terminal.resize(snapshot.cols, snapshot.rows);
        }
        await new Promise<void>(resolve => instance.terminal.write(snapshot.data, resolve));
        if ((instance.geometryGeneration || 0) !== geometryGeneration) {
          retryReason = 'geometry changed during replay';
          continue;
        }
        // Output arriving DURING an asynchronous tail write belongs to the
        // next batch. Do not clear resyncing until the tail is actually empty.
        for (let batch = 0; batch < 32; batch++) {
          if (this.instances.get(instance.id) !== instance) return;
          const tail = instance.liveTail.filter(chunk => chunk.sequence > instance.appliedSeq);
          instance.liveTail = [];
          let next = instance.appliedSeq + 1;
          const ordered: Array<{ data: string; sequence: number }> = [];
          let gap = false;
          for (const chunk of tail) {
            if (chunk.sequence < next) continue;
            if (chunk.sequence !== next) { gap = true; break; }
            ordered.push(chunk);
            next++;
          }
          if (gap || (!ordered.length && instance.receivedSeq > instance.appliedSeq)) break;
          if (!ordered.length) {
            if ((instance.geometryGeneration || 0) !== geometryGeneration) break;
            instance.needsResync = false;
            return;
          }
          await new Promise<void>(resolve => instance.terminal.write(ordered.map(chunk => chunk.data).join(''), resolve));
          instance.appliedSeq = ordered[ordered.length - 1].sequence;
        }
        // A bounded tail was evicted or the producer outran parsing. Start
        // from another recent screen instead of silently skipping sequences.
      }
      instance.needsResync = true;
      console.warn('[DuoCLI terminal] Snapshot sync needs retry:', retryReason);
    } catch (error) {
      instance.needsResync = true;
      console.warn('[DuoCLI terminal] Snapshot sync failed:', error instanceof Error ? error.message : 'unknown error');
    } finally {
      instance.resyncing = false;
    }
  }

  private async refreshHistoryMeta(instance: TermInstance): Promise<void> {
    const api = (window as unknown as { duocli?: {
      historyMetaPty?: (id: string) => Promise<{
        epoch: number;
        historyCursor: string | null;
        historyHasMore: boolean;
        truncated: boolean;
      }>;
    } }).duocli;
    if (!api?.historyMetaPty) return;
    try {
      const meta = await api.historyMetaPty(instance.id);
      if (this.instances.get(instance.id) !== instance) return;
      instance.epoch = Number(meta?.epoch) || instance.epoch;
      instance.historyCursor = meta?.historyCursor ?? instance.historyCursor;
      instance.historyHasMore = Boolean(meta?.historyHasMore);
    } catch { /* overlay can retry on the next gesture */ }
  }

  private maybeEnterHistory(id: string, deltaY = 0): void {
    void this.maybeEnterHistoryAsync(id, deltaY);
  }

  private async maybeEnterHistoryAsync(id: string, deltaY = 0): Promise<void> {
    const instance = this.instances.get(id);
    if (!instance || instance.historyLayer.isVisible() || !instance.bufferHasMore) return;
    const gesture = instance.scroll.gestureVersion();
    const reveal = instance.revealGeneration;
    // Only a replay that left older rows out of this terminal may open the
    // archive. Lines already in the live scrollback stay on this surface.
    if (this.instances.get(id) !== instance || instance.historyLayer.isVisible()
        || instance.scroll.gestureVersion() !== gesture
        || instance.revealGeneration !== reveal || this.isDetached(instance)) return;
    const buffer = instance.terminal.buffer.active;
    if (!terminalHistoryLayer.shouldEnterHistory({
      explicitIntent: true,
      hasMore: true,
      loading: false,
      touchActive: false,
      bufferType: buffer.type,
      noLocalHistory: buffer.baseY <= 0,
      viewportY: buffer.viewportY,
      edgeLines: terminalScrollHelpers.HISTORY_EDGE_LINES,
    })) return;
    this.enterHistory(id, deltaY);
  }

  private enterHistory(id: string, deltaY = 0): void {
    const instance = this.instances.get(id);
    if (!instance) return;
    instance.scroll.stopFollowing();
    instance.container.querySelector('.terminal-surface')?.classList.add('is-history');
    instance.historyLayer.show({
      deltaY,
      hasMore: instance.historyHasMore,
      nextCursor: instance.historyCursor,
      revision: `${instance.appliedSeq}:${instance.terminal.cols}:${instance.terminal.rows}`,
    });
    instance.historyLayer.setCols(instance.terminal.cols);
  }

  private exitHistory(id: string, follow = true): void {
    const instance = this.instances.get(id);
    if (!instance) return;
    instance.historyLayer.hide();
    instance.container.querySelector('.terminal-surface')?.classList.remove('is-history');
    if (follow) {
      instance.scroll.follow();
      instance.activityView.follow();
    }
  }

  private async requestHistory(id: string, query: { requestId?: string; beforeCursor?: string | null }): Promise<void> {
    const instance = this.instances.get(id);
    const api = (window as unknown as { duocli?: {
      historyBeforePty?: (id: string, query: Record<string, unknown>) => Promise<any>;
    } }).duocli;
    if (!instance || !api?.historyBeforePty) {
      instance?.historyLayer.setLoading(false);
      instance?.historyLayer.abandonSeek?.();
      return;
    }
    const revision = ++instance.historyRequestId;
    const epoch = instance.epoch;
    const requestId = query.requestId || `d${revision}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const isCurrent = () => this.instances.get(id) === instance
      && instance.historyRequestId === revision && instance.epoch === epoch;
    try {
      const page = await Promise.race([
        api.historyBeforePty(id, {
          epoch,
          requestId,
          beforeCursor: query.beforeCursor !== undefined ? query.beforeCursor : instance.historyCursor,
          // The first page must cross the 120-row live xterm window before it
          // can show genuinely older content. Fetching only 80 rows makes the
          // reader wait for a second sequential request on every entry.
          limitRows: query.beforeCursor == null ? 200 : 80,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Terminal history timed out')), 10000);
        }),
      ]);
      if (!isCurrent()) return;
      // The layer owns the older-page cursor. Keep the live snapshot boundary
      // separate so reaching the oldest page cannot disable future history.
      instance.historyLayer.prepend(page);
    } catch {
      // An older request must not unlock a newer request or overwrite its UI.
      if (isCurrent()) {
        instance.historyLayer.setLoading(false);
        if (instance.historyLayer.isSeeking?.()) instance.historyLayer.requestMore?.();
        else this.showJumpMiss(instance, '历史加载中断，继续向上滚动重试');
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private showJumpMiss(instance: TermInstance, message: string): void {
    let hint = instance.container.querySelector('.terminal-jump-miss') as HTMLElement | null;
    if (!hint) {
      hint = document.createElement('div');
      hint.className = 'terminal-jump-miss';
      instance.container.appendChild(hint);
    }
    hint.textContent = message;
    hint.hidden = false;
    window.setTimeout(() => { hint!.hidden = true; }, 2400);
  }

  // xterm samples the scrollbar once, while the terminal is still in the
  // 0×0 detached host. A zero result becomes the 15px fallback, and a
  // not-yet-laid-out scroll area can be reported as the whole viewport.
  // Either value hides or clips the right-hand columns.
  private syncScrollBarWidth(terminal: TermInstance['terminal']): void {
    const viewport = (terminal as unknown as { _core?: { viewport?: { scrollBarWidth: number } } })._core?.viewport;
    const element = terminal.element;
    if (!viewport || !element || element.offsetWidth < 2) return;
    const bar = element.querySelector('.xterm-viewport') as HTMLElement | null;
    const area = element.querySelector('.xterm-scroll-area') as HTMLElement | null;
    const measured = bar && area ? bar.offsetWidth - area.offsetWidth : 0;
    viewport.scrollBarWidth = measured > 0 && measured <= 20 ? measured : 4;
  }

  // Glyph spacing is also measured in that 0×0 host, so "W" has width 0 and
  // every column is given a full extra cell of letter-spacing. Spans created
  // later usually override it; cells that inherit the row value are pushed
  // off the right edge. Measure again once the terminal has a real width.
  private remeasureGlyphSpacing(terminal: TermInstance['terminal']): void {
    const renderer = (terminal as unknown as {
      _core?: { _renderService?: { _renderer?: { value?: {
        _widthCache?: { clear: () => void };
        _setDefaultSpacing?: () => void;
      } } } };
    })._core?._renderService?._renderer?.value;
    if (!renderer?._widthCache || typeof renderer._setDefaultSpacing !== 'function') return;
    if (!terminal.element || terminal.element.offsetWidth < 2) return;
    renderer._widthCache.clear();
    renderer._setDefaultSpacing();
    terminal.refresh(0, terminal.rows - 1);
  }

  private fitTerminal(id: string, focus: boolean): void {
    const instance = this.instances.get(id);
    if (!instance) return;
    try {
      // The prompt and composer can resize the surface without changing
      // the outer pane. FitAddon measures this same parent of .xterm.
      const surface = instance.terminal.element?.parentElement;
      if (!surface) return;
      const rect = surface.getBoundingClientRect();
      const previous = this.lastFitSizes.get(id);
      const sizeChanged = !previous
        || Math.abs(rect.width - previous.w) > 1
        || Math.abs(rect.height - previous.h) > 1;
      // A replay can temporarily restore the remote PTY's larger geometry and
      // a font/DPR change alters FitAddon's calculation without resizing the
      // pane. In both cases the terminal must be returned to the surface it
      // actually occupies, otherwise its final input row sits under the
      // composer and quick-command bars.
      this.syncScrollBarWidth(instance.terminal);
      const canonical = instance.serverGeometry;
      const renderService = (instance.terminal as unknown as { _core?: { _renderService?: {
        dimensions?: { css: { cell: { width: number; height: number } } };
      } } })._core?._renderService;
      const cell = renderService?.dimensions?.css.cell;
      const fontSize = instance.terminal.options.fontSize || 14;
      if (cell?.width && cell.height
          && (instance.fittedFontSize == null || fontSize !== instance.fittedFontSize)) {
        instance.preferredFontSize = fontSize;
        instance.preferredCellSize = { width: cell.width, height: cell.height };
      }
      // Keep source columns for correct TUI parsing, but fit their glyphs into
      // the visible width. Change the renderer's font metrics (rather than CSS
      // scaling) so selection, links, mouse coordinates and the caret agree.
      // Report PTY dimensions at the user's preferred font size: reporting the
      // smaller fitted font would grow the PTY again and create a resize loop.
      const preferred = instance.preferredCellSize;
      let proposed = instance.fitAddon.proposeDimensions();
      if (canonical && preferred && rect.width > 4 && rect.height > 0) {
        proposed = {
          cols: Math.max(2, Math.floor((rect.width - 4) / preferred.width)),
          rows: Math.max(1, Math.floor(rect.height / preferred.height)),
        };
        const targetFontSize = Math.min(instance.preferredFontSize,
          Math.max(1, Math.floor(instance.preferredFontSize * (rect.width - 4)
            / (canonical.cols * preferred.width) * 100) / 100));
        if (fontSize !== targetFontSize) instance.terminal.options.fontSize = targetFontSize;
        instance.fittedFontSize = targetFontSize;
      }
      const geometryChanged = !!proposed
        && (canonical ? canonical.cols !== instance.terminal.cols || canonical.rows !== instance.terminal.rows
          : proposed.cols !== instance.terminal.cols || proposed.rows !== instance.terminal.rows);
      if ((sizeChanged || geometryChanged || fontSize !== (instance.fittedFontSize ?? fontSize) || !instance.lastReportedSize) && renderService?.dimensions) {
        try {
          if (canonical) instance.terminal.resize(canonical.cols, canonical.rows);
          else instance.fitAddon.fit();
        } catch { /* xterm may not have a renderer yet */ }
        this.remeasureGlyphSpacing(instance.terminal);
        const screen = instance.terminal.element?.querySelector('.xterm-screen');
        if (!canonical && screen && instance.terminal.cols > 2
            && screen.getBoundingClientRect().right > rect.right + 0.5) {
          instance.terminal.resize(instance.terminal.cols - 1, instance.terminal.rows);
        }
      }
      this.rebindPromptMarker(instance);
      if (rect.width > 0 && rect.height > 0) instance.scroll.sync();
      // A viewing pane can be smaller than the phone that owns the PTY. Keep
      // cursor-addressed output at its source geometry and scroll its viewport
      // to the live editor instead of reflowing into a different terminal grid.
      surface.style.overflow = canonical ? 'auto' : '';
      if (canonical && instance.scroll.isFollowing()) surface.scrollTop = surface.scrollHeight;
      instance.historyLayer.setCols(instance.terminal.cols);
      instance.activityView.syncMetrics();
      this.lastFitSizes.set(id, { w: rect.width, h: rect.height });
      if (this.onResize) {
        const { cols, rows } = canonical && proposed ? proposed : instance.terminal;
        const last = instance.lastReportedSize;
        if (cols > 0 && rows > 0 && (!last || last.cols !== cols || last.rows !== rows)) {
          instance.lastReportedSize = { cols, rows };
          this.onResize(instance.id, cols, rows);
        }
      }
    } catch {}
    if (focus && this.activeId === id
        && !instance.container.querySelector('.terminal-composer')?.contains(document.activeElement)) {
      try { instance.terminal.focus(); } catch { /* ignore an unmounted renderer */ }
    }
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
    instance.themeId = themeId;
    instance.terminal.options.theme = resolveTheme(themeId);
  }

  static registerDynamicTheme(themeId: string, theme: any): void {
    DYNAMIC_THEMES.set(themeId, theme);
    if (theme && typeof theme.background === 'string') {
      THEME_DOTS[themeId] = theme.background;
    }
  }

  static getThemeDotColor(themeId: string): string {
    return THEME_DOTS[themeId] || '#0078d4';
  }
}

function resolveTheme(themeId: string): any {
  if (themeId.startsWith('custom-')) {
    return DYNAMIC_THEMES.get(themeId) || THEMES['vscode-dark'];
  }
  return THEMES[themeId] || THEMES['vscode-dark'];
}
