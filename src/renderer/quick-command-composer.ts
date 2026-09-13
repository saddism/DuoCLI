export function createQuickCommandComposer(sessionId: string): { element: HTMLElement; dispose: () => void } {
  const api = (window as any).duocli;
  const element = document.createElement('div');
  element.className = 'terminal-composer';
  element.innerHTML = `<div class="terminal-compose-row"><textarea rows="2" aria-label="终端消息" placeholder="输入消息；Ctrl/⌘ + Enter 发送"></textarea><button type="button" class="compose-send">发送</button></div><div class="desktop-quick-commands" aria-label="快捷命令"></div><div class="quick-command-editor" hidden><input aria-label="新快捷命令" placeholder="输入快捷命令"><button type="button">保存</button></div><div class="compose-status" role="status"></div>`;
  const input = element.querySelector('textarea')!;
  const bar = element.querySelector('.desktop-quick-commands')!;
  const editor = element.querySelector('.quick-command-editor') as HTMLElement;
  const commandInput = editor.querySelector('input')!;
  const status = element.querySelector('.compose-status')!;
  const send = element.querySelector('.compose-send') as HTMLButtonElement;
  let payload = '';
  let disposed = false;
  const showError = (error: any) => { status.textContent = error.message || String(error); };
  const render = (state: { commands: string[] }) => {
    if (disposed || JSON.stringify(state.commands) === payload) return;
    payload = JSON.stringify(state.commands);
    bar.replaceChildren();
    for (const command of state.commands) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = command;
      button.title = `${command}\n点击插入；右键删除`;
      button.onmousedown = event => event.preventDefault();
      button.onclick = () => {
        input.setRangeText(command, input.selectionStart, input.selectionEnd, 'end');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
      };
      button.oncontextmenu = event => {
        event.preventDefault();
        if (confirm(`删除快捷命令「${command}」？`)) void update({ action: 'remove', command });
      };
      bar.appendChild(button);
    }
    const add = document.createElement('button');
    add.textContent = '+ 添加';
    add.onclick = () => { editor.hidden = !editor.hidden; if (!editor.hidden) commandInput.focus(); };
    bar.appendChild(add);
  };
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
  const submit = async () => {
    if (send.disabled || !input.value.trim()) return;
    const text = input.value;
    send.disabled = true;
    status.textContent = '';
    try {
      await api.submitPty(sessionId, crypto.randomUUID(), text);
      if (input.value === text) input.value = '';
    } catch (error) { showError(error); }
    finally { send.disabled = false; }
  };
  send.onclick = () => { void submit(); };
  input.onkeydown = event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault();
      void submit();
    }
  };
  // Keep composer gestures from moving focus back into the terminal pane.
  for (const event of ['mousedown', 'click', 'keydown', 'contextmenu']) element.addEventListener(event, e => e.stopPropagation());
  const timer = setInterval(() => { void refresh(); }, 2000);
  window.addEventListener('focus', refresh);
  void refresh();
  return { element, dispose: () => { disposed = true; clearInterval(timer); window.removeEventListener('focus', refresh); } };
}
