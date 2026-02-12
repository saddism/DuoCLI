import { Terminal, IBufferLine, ILinkProvider, ILink } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';

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

// 文件路径正则
// 1. 带目录的路径: /abs/path, rel/path, @alias/path, ./rel/path
const PATH_RE = /(?:@\/?|\.\/|\/)?(?:[\w.\-\u4e00-\u9fff]+\/)+[\w.\-\u4e00-\u9fff]*(?:\.[\w]+)?/g;
// 2. 单文件名（无目录，有源码扩展名）
const SINGLE_FILE_RE = /(?<![\/\w.\-])[\w.\-\u4e00-\u9fff]+\.(?:vue|ts|tsx|js|jsx|json|css|scss|less|html|md|yaml|yml|xml|svg|py|go|rs|java|kt|swift|c|cpp|h|hpp|sh|toml|conf|txt|env|config|nvue|wxml|wxss)(?![\w.\-])/g;

// 常见源码扩展名
const SOURCE_EXTS = new Set([
  'vue', 'ts', 'tsx', 'js', 'jsx', 'json', 'css', 'scss', 'less', 'html',
  'md', 'yaml', 'yml', 'xml', 'svg', 'py', 'go', 'rs', 'java', 'kt',
  'swift', 'c', 'cpp', 'h', 'hpp', 'sh', 'bash', 'zsh', 'toml', 'conf',
  'txt', 'env', 'lock', 'config', 'nvue', 'wxml', 'wxss',
]);

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
    const line = this.terminal.buffer.active.getLine(y - 1);
    if (!line) { callback(undefined); return; }

    // 读取行文本，跳过宽字符（中文等）后面的空 cell
    // 同时记录 textIndex → cellIndex 映射，用于计算链接坐标
    let text = '';
    const textToCellStart: number[] = []; // textToCellStart[textIdx] = cellIdx
    for (let i = 0; i < line.length; i++) {
      const cell = line.getCell(i);
      const chars = cell?.getChars() || '';
      const width = cell?.getWidth() || 1;
      if (chars.length > 0) {
        for (let c = 0; c < chars.length; c++) {
          textToCellStart.push(i);
        }
        text += chars;
      } else if (width === 0) {
        // 宽字符的第二个 cell，跳过
      } else {
        textToCellStart.push(i);
        text += ' ';
      }
    }

    const cwd = this.getCwd();
    const matched: Array<{ filePath: string; display: string; index: number }> = [];

    // 1. 匹配带目录的路径
    let match: RegExpExecArray | null;
    PATH_RE.lastIndex = 0;
    while ((match = PATH_RE.exec(text)) !== null) {
      let fp = match[0];
      if (fp.length < 4) continue;
      const before = text.substring(Math.max(0, match.index - 10), match.index);
      if (/:\/{0,2}$/.test(before) || /:\d+$/.test(before)) continue;
      if (fp.includes('node_modules')) continue;
      const ext = fp.split('.').pop()?.toLowerCase() || '';
      const isDir = fp.endsWith('/');
      if (!isDir && !SOURCE_EXTS.has(ext)) continue;
      matched.push({ filePath: fp, display: fp, index: match.index });
    }

    // 2. 匹配单文件名
    SINGLE_FILE_RE.lastIndex = 0;
    while ((match = SINGLE_FILE_RE.exec(text)) !== null) {
      const fp = match[0];
      const overlaps = matched.some(r => match!.index >= r.index && match!.index < r.index + r.display.length);
      if (overlaps) continue;
      matched.push({ filePath: fp, display: fp, index: match.index });
    }

    // 解析路径并生成链接
    const links: ILink[] = [];
    for (const m of matched) {
      let resolved = m.filePath;
      if (resolved.startsWith('/')) {
        // 绝对路径
      } else if (resolved.startsWith('@/') || resolved.startsWith('@')) {
        resolved = cwd + '/' + resolved.replace(/^@\/?/, '');
      } else if (resolved.startsWith('./')) {
        resolved = cwd + '/' + resolved.replace(/^\.\//, '');
      } else {
        resolved = cwd + '/' + resolved;
      }
      if (resolved.endsWith('/')) resolved = resolved.slice(0, -1);

      // 用 textToCellStart 映射把 text index 转换为 cell index
      const cellStart = (textToCellStart[m.index] ?? m.index) + 1;
      const endTextIdx = m.index + m.display.length - 1;
      const cellEnd = (textToCellStart[endTextIdx] ?? endTextIdx) + 1;
      links.push({
        range: { start: { x: cellStart, y }, end: { x: cellEnd, y } },
        text: m.display,
        activate: () => { this.onClickCallback(resolved); },
      });
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

interface TermInstance {
  id: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  container: HTMLDivElement;
  themeId: string;
}

export class TerminalManager {
  private instances: Map<string, TermInstance> = new Map();
  private activeId: string | null = null;
  private terminalArea: HTMLElement;
  private resizeObserver: ResizeObserver;
  private onResize: ((id: string, cols: number, rows: number) => void) | null = null;

  constructor(terminalArea: HTMLElement, onResize?: (id: string, cols: number, rows: number) => void) {
    this.terminalArea = terminalArea;
    this.onResize = onResize || null;
    this.resizeObserver = new ResizeObserver(() => {
      this.fitActive();
    });
    this.resizeObserver.observe(terminalArea);

    // 窗口重新获得焦点时，重新 fit 并同步 pty 尺寸
    // 解决手机端远程控制后桌面端终端尺寸不同步的问题
    window.addEventListener('focus', () => {
      this.fitActive();
    });
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
      scrollOnOutput: true,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    const container = document.createElement('div');
    container.className = 'terminal-container';
    container.id = `tc-${id}`;
    this.terminalArea.appendChild(container);

    terminal.open(container);
    terminal.loadAddon(new WebLinksAddon());
    terminal.onData((data) => onData(data));

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

    // 拦截粘贴事件，检测剪贴板图片
    container.addEventListener('paste', async (e: ClipboardEvent) => {
      if (!e.clipboardData) return;
      const hasImage = Array.from(e.clipboardData.items).some(
        (item) => item.type.startsWith('image/')
      );
      if (!hasImage) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        const filePath = await (window as any).duocli.clipboardSaveImage();
        if (filePath) {
          onData(filePath);
        }
      } catch { /* 静默失败 */ }
    }, true);

    // 浮动"滚到底部"按钮
    const scrollBtn = document.createElement('button');
    scrollBtn.className = 'scroll-bottom-btn';
    scrollBtn.textContent = '⬇';
    scrollBtn.title = '滚到底部';
    scrollBtn.style.display = 'none';
    container.appendChild(scrollBtn);

    scrollBtn.addEventListener('click', () => {
      terminal.scrollToBottom();
      scrollBtn.style.display = 'none';
    });

    // 监听滚动：不在底部时显示按钮
    const checkScroll = () => {
      const buf = terminal.buffer.active;
      const atBottom = buf.viewportY >= buf.baseY;
      scrollBtn.style.display = atBottom ? 'none' : 'block';
    };
    terminal.onScroll(() => checkScroll());
    terminal.onWriteParsed(() => checkScroll());

    this.instances.set(id, { id, terminal, fitAddon, container, themeId });
    this.switchTo(id);
  }

  switchTo(id: string): void {
    // 隐藏所有
    this.instances.forEach((inst) => {
      inst.container.classList.remove('active');
    });
    // 显示目标
    const target = this.instances.get(id);
    if (!target) return;
    target.container.classList.add('active');
    this.activeId = id;
    // 延迟fit确保DOM更新
    setTimeout(() => {
      target.fitAddon.fit();
      if (this.onResize) {
        const { cols, rows } = target.terminal;
        this.onResize(target.id, cols, rows);
      }
      target.terminal.focus();
    }, 50);
  }

  // 隐藏终端（归档用，不销毁）
  hide(id: string): void {
    const inst = this.instances.get(id);
    if (!inst) return;
    inst.container.classList.remove('active');
    if (this.activeId === id) {
      // 切换到其他可见终端
      const remaining = Array.from(this.instances.keys()).filter(k => k !== id);
      if (remaining.length > 0) {
        this.switchTo(remaining[remaining.length - 1]);
      } else {
        this.activeId = null;
      }
    }
  }

  write(id: string, data: string): void {
    const inst = this.instances.get(id);
    if (!inst) return;
    // 写入前判断是否在底部附近（容差 3 行），是则写入后自动滚到底
    const buf = inst.terminal.buffer.active;
    const nearBottom = buf.baseY - buf.viewportY <= 3;
    inst.terminal.write(data, () => {
      if (nearBottom) inst.terminal.scrollToBottom();
    });
  }

  destroy(id: string): string | null {
    const inst = this.instances.get(id);
    if (!inst) return this.activeId;
    inst.terminal.dispose();
    inst.container.remove();
    this.instances.delete(id);

    // 切换到其他终端
    if (this.activeId === id) {
      const remaining = Array.from(this.instances.keys());
      if (remaining.length > 0) {
        this.switchTo(remaining[remaining.length - 1]);
        return this.activeId;
      }
      this.activeId = null;
    }
    return this.activeId;
  }

  fitActive(): void {
    if (!this.activeId) return;
    const inst = this.instances.get(this.activeId);
    if (inst) {
      inst.fitAddon.fit();
      if (this.onResize) {
        const { cols, rows } = inst.terminal;
        this.onResize(inst.id, cols, rows);
      }
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

  static getThemeDotColor(themeId: string): string {
    return THEME_DOTS[themeId] || '#0078d4';
  }
}