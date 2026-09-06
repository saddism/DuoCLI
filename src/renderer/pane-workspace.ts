import {
  closePane,
  arrangeTiled,
  createEmptyLayout,
  dropStaleSessionPanes,
  findPane,
  listPanes,
  setPaneContent,
  splitPane,
  swapPaneContents,
  type PaneContent,
  type PaneDirection,
  type PaneLeaf,
  type LayoutNode,
  type WorkspaceLayout,
} from './pane-layout';
import { loadWorkspaceLayout, saveWorkspaceLayout } from './pane-layout-store';

export interface PaneWorkspaceCallbacks {
  onContentMount: (paneId: string, content: PaneContent, body: HTMLElement) => void;
  onContentUnmount?: (paneId: string, content: PaneContent) => void;
  onFocus?: (paneId: string, content: PaneContent) => void;
  onRequestClose?: (paneId: string, content: PaneContent) => void;
  onLayoutChange?: (layout: WorkspaceLayout) => void;
  getAgentTagColors?: (agentLabel: string) => [string, string];
}

export function paneContentKey(content: PaneContent): string {
  // Labels are presentation-only. Keeping them out of the identity prevents
  // a title update from tearing down a live terminal view.
  switch (content.kind) {
    case 'terminal': return `terminal:${content.sessionId}`;
    case 'file': return `file:${content.path}`;
    case 'android': return `android:${content.deviceId || ''}`;
    default: return 'empty';
  }
}

/** Desktop-only layout shell. Content implementations stay in app.ts so the
 * terminal, file and Android capabilities can be reused. */
export class PaneWorkspace {
  private readonly root: HTMLElement;
  private readonly callbacks: PaneWorkspaceCallbacks;
  private layout: WorkspaceLayout;
  private workspaceKey = '';
  private liveTerminals: Set<string> | null = null;
  private leafElements = new Map<string, HTMLElement>();
  private splitElements = new Map<string, HTMLElement>();
  private contentKeys = new Map<string, string>();
  private mountedContents = new Map<string, PaneContent>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(root: HTMLElement, cwd: string, callbacks: PaneWorkspaceCallbacks) {
    this.root = root;
    this.callbacks = callbacks;
    this.root.classList.add('pane-workspace-root');
    this.layout = createEmptyLayout();
    if (cwd.trim()) this.setWorkspace(cwd);
    else this.render();
  }

  setWorkspace(cwd: string): void {
    const nextKey = cwd.trim();
    if (nextKey === this.workspaceKey) return;
    if (this.workspaceKey) this.flushSave();
    this.unmountAll();
    this.workspaceKey = nextKey;
    this.layout = nextKey ? loadWorkspaceLayout(nextKey) : createEmptyLayout();
    this.layout = this.sanitizedLayout(this.layout);
    this.render();
  }

  setLiveSessions(terminals: Iterable<string>): void {
    this.liveTerminals = new Set(terminals);
    const next = this.sanitizedLayout(this.layout);
    if (next === this.layout) return;
    this.layout = next;
    this.render();
  }

  remountAll(): void {
    this.contentKeys.clear();
    this.render();
  }

  private sanitizedLayout(layout: WorkspaceLayout): WorkspaceLayout {
    return dropStaleSessionPanes(layout, {
      terminal: this.liveTerminals ?? undefined,
    });
  }

  getWorkspaceKey(): string {
    return this.workspaceKey;
  }

  getLayout(): WorkspaceLayout {
    return this.layout;
  }

  getFocusedPaneId(): string {
    return this.layout.focusedPaneId;
  }

  getFocusedContent(): PaneContent | null {
    return findPane(this.layout.root, this.layout.focusedPaneId)?.content || null;
  }

  getPaneIdForContent(kind: PaneContent['kind'], id: string): string | null {
    const pane = listPanes(this.layout.root).find((item) => {
      const content = item.content;
      if (content.kind !== kind) return false;
      switch (content.kind) {
        case 'terminal':
          return content.sessionId === id;
        case 'file':
          return content.path === id;
        case 'android':
          return !id || !content.deviceId || content.deviceId === id;
        default:
          return false;
      }
    });
    return pane?.id || null;
  }

  focusPane(paneId: string): void {
    const pane = findPane(this.layout.root, paneId);
    if (!pane) return;
    this.layout = { ...this.layout, focusedPaneId: paneId };
    this.renderFocusOnly();
    this.callbacks.onFocus?.(paneId, pane.content);
    this.scheduleSave();
  }

  focusContent(kind: PaneContent['kind'], id: string): boolean {
    const paneId = this.getPaneIdForContent(kind, id);
    if (!paneId) return false;
    this.focusPane(paneId);
    return true;
  }

  /** Place content in the focused empty pane, otherwise split the focused pane. */
  openContent(content: PaneContent): string | null {
    if (content.kind !== 'empty') {
      const existingId = this.getPaneIdForContent(
        content.kind,
        content.kind === 'terminal'
          ? content.sessionId
          : content.kind === 'file'
            ? content.path
            : content.kind === 'android'
              ? content.deviceId || ''
              : '',
      );
      if (existingId) {
        const existingPane = findPane(this.layout.root, existingId);
        if (existingPane && existingPane.content.kind !== 'empty') {
          const current = existingPane.content;
          const labelChanged = content.label != null && current.label !== content.label;
          const agentChanged = content.kind === 'terminal'
            && current.kind === 'terminal'
            && content.agentLabel !== undefined
            && current.agentLabel !== content.agentLabel;
          if (labelChanged || agentChanged) {
            this.layout = setPaneContent(this.layout, existingId, {
              ...current,
              ...(labelChanged ? { label: content.label } : {}),
              ...(agentChanged ? { agentLabel: content.agentLabel } : {}),
            } as PaneContent);
            this.render();
          }
        }
        this.focusPane(existingId);
        return existingId;
      }
    }

    const focused = findPane(this.layout.root, this.layout.focusedPaneId);
    if (!focused) return null;
    if (focused.content.kind === 'empty') {
      this.layout = setPaneContent(this.layout, focused.id, content);
      this.render();
      this.notifyFocus();
      return focused.id;
    }

    // 先把已有内容整理成一个可容纳新 Pane 的平铺布局，再从最末一格
    // 添加内容。这样三格纵向布局添加第四格时，不会生成超过深度限制的
    // 嵌套树，而是稳定得到 2x2。
    const tiled = arrangeTiled(this.layout);
    const panes = listPanes(tiled.root);
    const insertion = panes[panes.length - 1];
    if (!insertion) return null;
    const next = splitPane(tiled, insertion.id, 'horizontal', content);
    if (!next) return null;
    // 从会话列表/文件树打开新内容时采用智能平铺，避免把新 Pane
    // 继续嵌套在当前 Pane 内，导致第四个窗口落到不可见的角落。
    this.layout = arrangeTiled(next);
    this.render();
    this.notifyFocus();
    return next.focusedPaneId;
  }

  splitFocused(direction: PaneDirection, content: PaneContent = { kind: 'empty' }): string | null {
    let base = this.layout;
    let targetId = base.focusedPaneId;
    let next = splitPane(base, targetId, direction, content);
    if (!next && listPanes(base.root).length < 4) {
      // 深度达到上限时先整理成平铺布局，再从一个浅层 Pane 拆分；
      // 这样“3 个纵向 Pane 再右拆分”仍然能创建第 4 个窗口。
      base = arrangeTiled(base);
      targetId = listPanes(base.root).at(-1)?.id || base.focusedPaneId;
      next = splitPane(base, targetId, direction, content);
    }
    if (!next) return null;
    this.layout = next;
    this.render();
    this.notifyFocus();
    return next.focusedPaneId;
  }

  arrangeTiled(): void {
    const next = arrangeTiled(this.layout);
    if (next.root === this.layout.root) return;
    this.layout = next;
    this.render();
    this.notifyFocus();
  }

  closePane(paneId = this.layout.focusedPaneId): PaneLeaf | null {
    const result = closePane(this.layout, paneId);
    if (!result.removed) return null;
    this.layout = result.layout;
    this.render();
    this.notifyFocus();
    return result.removed;
  }

  swapPanes(firstId: string, secondId: string): void {
    const next = swapPaneContents(this.layout, firstId, secondId);
    if (next === this.layout) return;
    this.layout = next;
    this.render();
    this.notifyFocus();
  }

  replaceContent(paneId: string, content: PaneContent): void {
    const next = setPaneContent(this.layout, paneId, content);
    if (next === this.layout) return;
    this.layout = next;
    this.render();
    if (this.layout.focusedPaneId === paneId) this.notifyFocus();
  }

  /** Update a label without remounting the underlying content view. */
  updateContentLabel(kind: PaneContent['kind'], id: string, label: string): void {
    if (kind === 'terminal') {
      this.updateTerminalPaneMeta(id, { label });
      return;
    }
    const paneId = this.getPaneIdForContent(kind, id);
    if (!paneId) return;
    const pane = findPane(this.layout.root, paneId);
    if (!pane || pane.content.kind === 'empty') return;
    this.layout = setPaneContent(this.layout, paneId, { ...pane.content, label } as PaneContent);
    this.renderPaneTitleDom(paneId);
  }

  /** Sync terminal pane header text (session title + agent badge). */
  updateTerminalPaneMeta(
    sessionId: string,
    meta: { label?: string; agentLabel?: string },
  ): void {
    const paneId = this.getPaneIdForContent('terminal', sessionId);
    if (!paneId) return;
    const pane = findPane(this.layout.root, paneId);
    if (!pane || pane.content.kind !== 'terminal') return;
    const next = { ...pane.content, ...meta };
    if (next.label === pane.content.label && next.agentLabel === pane.content.agentLabel) return;
    this.layout = setPaneContent(this.layout, paneId, next);
    this.renderPaneTitleDom(paneId);
  }

  removeContent(kind: PaneContent['kind'], id: string): void {
    const paneId = this.getPaneIdForContent(kind, id);
    // 会话被关闭时，这个 Pane 已没有可保留的内容。直接关闭叶子节点，
    // 让 closePane 折叠只剩一个子项的 split；否则关闭多个会话后会留下空白格。
    if (paneId) this.closePane(paneId);
  }

  private contentKey(content: PaneContent): string {
    return paneContentKey(content);
  }

  private render(): void {
    const liveLeaves = new Set<string>();
    const liveSplits = new Set<string>();
    const renderNode = (node: LayoutNode, parent: HTMLElement): void => {
      if (node.type === 'pane') {
        liveLeaves.add(node.id);
        let leaf = this.leafElements.get(node.id);
        if (!leaf) {
          leaf = document.createElement('section');
          leaf.className = 'pane-leaf';
          leaf.dataset.paneId = node.id;
          const header = document.createElement('div');
          header.className = 'pane-header';
          header.draggable = true;
          const title = document.createElement('span');
          title.className = 'pane-title';
          const actions = document.createElement('div');
          actions.className = 'pane-actions';
          const splitRight = this.makeButton('右拆分', '⇥', () => {
            this.focusPane(node.id);
            this.splitFocused('horizontal');
          });
          const splitDown = this.makeButton('下拆分', '⇵', () => {
            this.focusPane(node.id);
            this.splitFocused('vertical');
          });
          const close = this.makeButton('关闭 Pane', '×', () => {
            const current = findPane(this.layout.root, node.id);
            if (!current) return;
            if (this.callbacks.onRequestClose) {
              this.callbacks.onRequestClose(current.id, current.content);
            } else {
              this.closePane(current.id);
            }
          });
          actions.append(splitRight, splitDown, close);
          header.append(title, actions);
          const body = document.createElement('div');
          body.className = 'pane-body';
          leaf.append(header, body);
          header.addEventListener('click', () => this.focusPane(node.id));
          body.addEventListener('pointerdown', () => this.focusPane(node.id));
          header.addEventListener('dragstart', (event) => {
            event.dataTransfer?.setData('text/plain', node.id);
            if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
          });
          header.addEventListener('dragover', (event) => {
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
          });
          header.addEventListener('drop', (event) => {
            event.preventDefault();
            const sourceId = event.dataTransfer?.getData('text/plain');
            if (sourceId && sourceId !== node.id) this.swapPanes(sourceId, node.id);
          });
          this.leafElements.set(node.id, leaf);
        }
        this.renderPaneTitleDom(node.id, node.content);
        leaf.classList.toggle('pane-leaf-focused', this.layout.focusedPaneId === node.id);
        parent.appendChild(leaf);
        const body = leaf.querySelector<HTMLElement>('.pane-body')!;
        body.dataset.workspaceKey = this.workspaceKey;
        return;
      }

      liveSplits.add(node.id);
      let split = this.splitElements.get(node.id);
      if (!split) {
        split = document.createElement('div');
        split.className = `pane-split pane-split-${node.direction}`;
        split.dataset.splitId = node.id;
        const first = document.createElement('div');
        first.className = 'pane-split-child pane-split-first';
        const divider = document.createElement('div');
        divider.className = 'pane-divider';
        divider.title = '拖动调整 Pane 比例';
        const second = document.createElement('div');
        second.className = 'pane-split-child pane-split-second';
        split.append(first, divider, second);
        this.installDivider(divider, node.id, node.direction);
      }
      this.splitElements.set(node.id, split);
      split.className = `pane-split pane-split-${node.direction}`;
      // Use the direct children only. A split can contain nested splits, so a
      // broad querySelector would otherwise pick a grandchild's second slot
      // while the old tree is being collapsed during a close operation.
      const first = split.children[0] as HTMLElement;
      const second = split.children[2] as HTMLElement;
      split.style.setProperty('--pane-first', `${node.ratio * 100}%`);
      parent.appendChild(split);
      renderNode(node.first, first);
      renderNode(node.second, second);
    };

    // A single empty root is the model's reusable insertion point, rather than
    // a visible split. Keep it out of the DOM until content is opened.
    if (!(this.layout.root.type === 'pane' && this.layout.root.content.kind === 'empty')) {
      renderNode(this.layout.root, this.root);
    }

    // Unmount every changed leaf before mounting any replacement. This is
    // required when two panes swap contents: mounting pane B first moves its
    // DOM into pane A, so pane B must be detached before either mount runs.
    const pendingMounts: Array<{ id: string; content: PaneContent; body: HTMLElement; key: string }> = [];
    for (const [id, leaf] of this.leafElements) {
      if (!liveLeaves.has(id)) {
        const oldKey = this.contentKeys.get(id);
        const old = oldKey ? this.mountedContents.get(id) : null;
        if (old) this.callbacks.onContentUnmount?.(id, old);
        this.contentKeys.delete(id);
        this.mountedContents.delete(id);
        leaf.remove();
        this.leafElements.delete(id);
        continue;
      }

      const pane = findPane(this.layout.root, id);
      const body = leaf.querySelector<HTMLElement>('.pane-body');
      if (!pane || !body) continue;
      const key = this.contentKey(pane.content);
      if (this.contentKeys.get(id) !== key) pendingMounts.push({ id, content: pane.content, body, key });
    }

    for (const pending of pendingMounts) {
      const old = this.mountedContents.get(pending.id);
      if (old) this.callbacks.onContentUnmount?.(pending.id, old);
    }

    for (const pending of pendingMounts) {
      this.contentKeys.set(pending.id, pending.key);
      this.mountedContents.set(pending.id, pending.content);
      this.callbacks.onContentMount(pending.id, pending.content, pending.body);
    }

    for (const [id, split] of this.splitElements) {
      if (!liveSplits.has(id)) {
        split.remove();
        this.splitElements.delete(id);
      }
    }
    this.renderFocusOnly();
    this.callbacks.onLayoutChange?.(this.layout);
    this.scheduleSave();
  }

  private renderFocusOnly(): void {
    for (const [id, leaf] of this.leafElements) {
      leaf.classList.toggle('pane-leaf-focused', id === this.layout.focusedPaneId);
    }
  }

  private renderPaneTitleDom(paneId: string, content?: PaneContent): void {
    const leaf = this.leafElements.get(paneId);
    if (!leaf) return;
    const title = leaf.querySelector<HTMLElement>('.pane-title');
    if (!title) return;
    const paneContent = content || findPane(this.layout.root, paneId)?.content;
    if (!paneContent) return;
    title.replaceChildren();
    if (paneContent.kind === 'terminal') {
      const agent = paneContent.agentLabel?.trim();
      if (agent) {
        const tag = document.createElement('span');
        tag.className = 'pane-agent-tag';
        tag.textContent = agent;
        tag.title = agent;
        const [tagColor, tagBg] = this.callbacks.getAgentTagColors?.(agent) || ['', ''];
        if (tagColor) {
          tag.style.setProperty('--cli-tag-color', tagColor);
          tag.style.setProperty('--cli-tag-bg', tagBg);
        }
        title.appendChild(tag);
      }
      const label = document.createElement('span');
      label.className = 'pane-session-label';
      const text = paneContent.label || '终端';
      label.textContent = text;
      label.title = text;
      title.appendChild(label);
      return;
    }
    title.textContent = this.titleFor(paneContent);
  }

  private titleFor(content: PaneContent): string {
    if (content.kind === 'terminal') return content.label || '终端';
    if (content.kind === 'file') return content.label || content.path.split(/[\\/]/).pop() || '文件';
    if (content.kind === 'android') return content.label || (content.deviceId ? `Android · ${content.deviceId}` : 'Android');
    return '空 Pane';
  }

  private makeButton(title: string, text: string, handler: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = 'pane-action';
    button.type = 'button';
    button.title = title;
    const iconByText: Record<string, string> = {
      '⇥': '<svg class="ui-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h10a3 3 0 0 1 3 3v8"></path><polyline points="13 13 17 17 21 13"></polyline></svg>',
      '⇵': '<svg class="ui-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4v16"></path><polyline points="3 8 7 4 11 8"></polyline><polyline points="3 16 7 20 11 16"></polyline><path d="M17 4v16"></path></svg>',
      '×': '<svg class="ui-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
    };
    button.innerHTML = iconByText[text] || text;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      handler();
    });
    return button;
  }

  private installDivider(divider: HTMLElement, splitId: string, direction: PaneDirection): void {
    divider.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      divider.setPointerCapture?.(event.pointerId);
      const split = divider.parentElement;
      const move = (moveEvent: PointerEvent) => {
        const rect = split?.getBoundingClientRect() || this.root.getBoundingClientRect();
        const ratio = direction === 'horizontal'
          ? (moveEvent.clientX - rect.left) / Math.max(1, rect.width)
          : (moveEvent.clientY - rect.top) / Math.max(1, rect.height);
        const node = this.layout.root;
        const current = this.findSplit(node, splitId);
        if (!current) return;
        this.layout = {
          ...this.layout,
          root: this.replaceSplitRatio(node, splitId, ratio),
        };
        const clamped = this.findSplit(this.layout.root, splitId)?.ratio ?? current.ratio;
        split?.style.setProperty('--pane-first', `${clamped * 100}%`);
      };
      const end = () => {
        divider.removeEventListener('pointermove', move);
        divider.removeEventListener('pointerup', end);
        divider.removeEventListener('pointercancel', end);
        divider.releasePointerCapture?.(event.pointerId);
        this.flushSave();
      };
      divider.addEventListener('pointermove', move);
      divider.addEventListener('pointerup', end, { once: true });
      divider.addEventListener('pointercancel', end, { once: true });
    });
  }

  private findSplit(node: LayoutNode, id: string): Extract<LayoutNode, { type: 'split' }> | null {
    if (node.type === 'pane') return null;
    if (node.id === id) return node;
    return this.findSplit(node.first, id) || this.findSplit(node.second, id);
  }

  private replaceSplitRatio(node: LayoutNode, id: string, ratio: number): LayoutNode {
    if (node.type === 'pane') return node;
    if (node.id === id) {
      return { ...node, ratio: Math.min(0.8, Math.max(0.2, ratio)) };
    }
    return {
      ...node,
      first: this.replaceSplitRatio(node.first, id, ratio),
      second: this.replaceSplitRatio(node.second, id, ratio),
    };
  }

  private unmountAll(): void {
    for (const [id, content] of this.mountedContents) {
      this.callbacks.onContentUnmount?.(id, content);
    }
    this.contentKeys.clear();
    this.mountedContents.clear();
    this.leafElements.clear();
    this.splitElements.clear();
    this.root.innerHTML = '';
  }

  private notifyFocus(): void {
    const pane = findPane(this.layout.root, this.layout.focusedPaneId);
    if (pane) this.callbacks.onFocus?.(pane.id, pane.content);
  }

  private scheduleSave(): void {
    if (!this.workspaceKey) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      saveWorkspaceLayout(this.workspaceKey, this.layout);
    }, 250);
  }

  private flushSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (this.workspaceKey) saveWorkspaceLayout(this.workspaceKey, this.layout);
  }
}
