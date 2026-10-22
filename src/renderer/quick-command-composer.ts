const DESKTOP_SHORTCUT_KEYS: Array<{ id?: string; label: string; key: string; title?: string }> = [
  { id: 'ctrl-o-key', label: '^O', key: '\x0f', title: 'Ctrl + O' },
];

const LONG_PRESS_MS = 420;
const MOVE_CANCEL_PX = 8;

export function formatQuickCommandLabel(command: string): string {
  const text = String(command || '');
  if (text.length <= 8) return text;
  return `${text.slice(0, Math.ceil(text.length / 2))}…`;
}

type PointerSession = {
  button: HTMLButtonElement;
  command: string;
  startX: number;
  startY: number;
  pointerId: number;
  timer: number | null;
  sorting: boolean;
};

export function createQuickCommandComposer(
  options?: { onSendKey?: (data: string) => void },
): { element: HTMLElement; dispose: () => void } {
  const api = (window as any).duocli;
  const element = document.createElement('div');
  element.className = 'terminal-composer';
  element.innerHTML = `<div class="desktop-quick-commands" aria-label="快捷命令"></div><div class="quick-command-editor" hidden><input aria-label="新快捷命令" placeholder="输入快捷命令"><button type="button">保存</button></div><div class="desktop-shortcut-bar" aria-label="快捷键"></div><div class="compose-status" role="status"></div>`;
  const shortcutBar = element.querySelector('.desktop-shortcut-bar')!;
  const bar = element.querySelector('.desktop-quick-commands') as HTMLElement;
  const editor = element.querySelector('.quick-command-editor') as HTMLElement;
  const commandInput = editor.querySelector('input')!;
  const status = element.querySelector('.compose-status')!;
  let payload = '';
  let disposed = false;
  let pointer: PointerSession | null = null;

  const showError = (error: any) => { status.textContent = error.message || String(error); };

  const collectCommands = () => [...bar.querySelectorAll<HTMLElement>('[data-command]')]
    .map(node => node.dataset.command || '')
    .filter(Boolean);

  const addButton = () => bar.querySelector<HTMLButtonElement>('.qcmd-add');

  const getDragAfterElement = (x: number) => {
    const items = [...bar.querySelectorAll<HTMLElement>('[data-command]:not(.dragging)')];
    return items.reduce<{ offset: number; element: HTMLElement | null }>((closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = x - box.left - box.width / 2;
      if (offset < 0 && offset > closest.offset) return { offset, element: child };
      return closest;
    }, { offset: Number.NEGATIVE_INFINITY, element: null }).element;
  };

  const persistOrder = async () => {
    const commands = collectCommands();
    let current: string[] = [];
    try { current = JSON.parse(payload || '[]'); } catch { current = []; }
    if (commands.length === current.length && commands.every((command, index) => command === current[index])) return;
    try {
      render(await api.updateQuickCommands({ action: 'reorder', commands }));
    } catch (error) {
      showError(error);
      void refresh();
    }
  };

  const closeConfirm = () => document.querySelector('.quick-command-confirm-overlay')?.remove();

  const showSendConfirm = (command: string) => {
    closeConfirm();
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay quick-command-confirm-overlay';
    overlay.tabIndex = -1;
    overlay.innerHTML = `
      <div class="confirm-dialog quick-command-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="quick-command-confirm-title">
        <h3 id="quick-command-confirm-title">发送快捷命令</h3>
        <p>是否将以下内容发送到当前工作区？</p>
        <pre class="quick-command-confirm-text"></pre>
        <div class="confirm-buttons">
          <button type="button" class="btn-cancel" data-confirm="delete">删除</button>
          <button type="button" class="btn-cancel" data-confirm="no">取消</button>
          <button type="button" class="btn-confirm-send" data-confirm="yes">发送</button>
        </div>
      </div>`;
    overlay.querySelector('.quick-command-confirm-text')!.textContent = command;
    const finish = (action: string) => {
      overlay.remove();
      if (action === 'yes') options?.onSendKey?.(command);
      if (action === 'delete') void update({ action: 'remove', command });
    };
    overlay.addEventListener('click', event => {
      const button = eventElement(event)?.closest?.('[data-confirm]');
      if (button) {
        event.preventDefault();
        finish(button.getAttribute('data-confirm') || 'no');
        return;
      }
      if (event.target === overlay) finish('no');
    });
    overlay.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); finish('no'); }
      if (event.key === 'Enter') { event.preventDefault(); finish('yes'); }
    });
    document.body.appendChild(overlay);
    overlay.focus();
  };

  const clearPointer = (session: PointerSession | null, persist: boolean) => {
    if (!session) return;
    if (session.timer != null) window.clearTimeout(session.timer);
    session.button.classList.remove('dragging');
    session.button.style.touchAction = '';
    bar.classList.remove('is-sorting');
    if (session.sorting && persist) void persistOrder();
    if (pointer === session) pointer = null;
  };

  const render = (state: { commands: string[] }) => {
    if (disposed || JSON.stringify(state.commands) === payload) return;
    payload = JSON.stringify(state.commands);
    clearPointer(pointer, false);
    bar.replaceChildren();

    state.commands.forEach((command, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.command = command;
      button.dataset.index = String(index);
      button.textContent = formatQuickCommandLabel(command);
      button.title = command;
      button.oncontextmenu = event => {
        event.preventDefault();
        if (confirm(`删除快捷命令「${command}」？`)) void update({ action: 'remove', command });
      };
      bar.appendChild(button);
    });

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'qcmd-add';
    add.textContent = '+ 添加';
    add.onclick = () => { editor.hidden = !editor.hidden; if (!editor.hidden) commandInput.focus(); };
    bar.appendChild(add);
  };

  const eventElement = (event: Event) => {
    const target = event.target;
    if (target instanceof Element) return target;
    return target instanceof Node ? target.parentElement : null;
  };

  bar.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const button = eventElement(event)?.closest?.('[data-command]') as HTMLButtonElement | null;
    if (!button || !bar.contains(button)) return;
    if (event.pointerType === 'mouse') event.preventDefault();
    clearPointer(pointer, false);
    const session: PointerSession = {
      button,
      command: button.dataset.command || '',
      startX: event.clientX,
      startY: event.clientY,
      pointerId: event.pointerId,
      sorting: false,
      timer: window.setTimeout(() => {
        if (pointer !== session) return;
        session.sorting = true;
        session.button.classList.add('dragging');
        session.button.style.touchAction = 'none';
        bar.classList.add('is-sorting');
        try { session.button.setPointerCapture(event.pointerId); } catch { /* ignore */ }
      }, LONG_PRESS_MS),
    };
    pointer = session;
  });

  bar.addEventListener('pointermove', event => {
    if (!pointer || pointer.pointerId !== event.pointerId) return;
    const dx = event.clientX - pointer.startX;
    const dy = event.clientY - pointer.startY;
    if (!pointer.sorting) {
      if (Math.hypot(dx, dy) > MOVE_CANCEL_PX && pointer.timer != null) {
        window.clearTimeout(pointer.timer);
        pointer.timer = null;
      }
      return;
    }
    event.preventDefault();
    const after = getDragAfterElement(event.clientX);
    const add = addButton();
    if (after) bar.insertBefore(pointer.button, after);
    else if (add) bar.insertBefore(pointer.button, add);
    else bar.appendChild(pointer.button);
  });

  bar.addEventListener('pointerup', event => {
    if (!pointer || pointer.pointerId !== event.pointerId) return;
    const session = pointer;
    const moved = Math.hypot(event.clientX - session.startX, event.clientY - session.startY) > MOVE_CANCEL_PX;
    const wasSorting = session.sorting;
    clearPointer(session, wasSorting);
    if (!wasSorting && !moved && session.command) showSendConfirm(session.command);
  });

  bar.addEventListener('pointercancel', event => {
    if (!pointer || pointer.pointerId !== event.pointerId) return;
    clearPointer(pointer, pointer.sorting);
  });

  async function refresh() {
    if (!api?.getQuickCommands) return;
    try { render(await api.getQuickCommands()); } catch (error) { showError(error); }
  }
  async function update(operation: object) {
    try {
      render(await api.updateQuickCommands(operation));
      status.textContent = '';
    } catch (error) { showError(error); }
  }
  const save = async () => {
    const command = commandInput.value.trim();
    if (!command) return;
    try {
      render(await api.updateQuickCommands({ action: 'add', command }));
      commandInput.value = '';
      editor.hidden = true;
      status.textContent = '';
    } catch (error) { showError(error); }
  };
  editor.querySelector('button')!.onclick = () => { void save(); };
  commandInput.onkeydown = event => {
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); void save(); }
  };
  for (const item of DESKTOP_SHORTCUT_KEYS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.shortcut = item.id;
    button.textContent = item.label;
    button.title = item.title || item.label;
    button.setAttribute('aria-label', item.title || item.label);
    button.onmousedown = event => event.preventDefault();
    button.onclick = () => { options?.onSendKey?.(item.key); };
    shortcutBar.appendChild(button);
  }

  // Keep composer gestures from moving focus back into the terminal pane.
  for (const event of ['mousedown', 'click', 'keydown', 'contextmenu']) element.addEventListener(event, e => e.stopPropagation());
  const timer = setInterval(() => { void refresh(); }, 2000);
  window.addEventListener('focus', refresh);
  void refresh();
  return {
    element,
    dispose: () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      closeConfirm();
      clearPointer(pointer, false);
    },
  };
}
