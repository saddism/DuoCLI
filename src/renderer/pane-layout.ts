/**
 * Pure layout model for the desktop workspace.
 *
 * The model deliberately contains references to content, not DOM nodes. This
 * keeps split/close/move/persist operations deterministic and makes it safe to
 * rebuild the view after a renderer restart.
 */

export type PaneDirection = 'horizontal' | 'vertical';

export type PaneContent =
  | { kind: 'terminal'; sessionId: string; label?: string; agentLabel?: string }
  | { kind: 'file'; path: string; label?: string }
  | { kind: 'android'; deviceId?: string; label?: string }
  | { kind: 'empty' };

export interface PaneLeaf {
  type: 'pane';
  id: string;
  content: PaneContent;
}

export interface PaneSplit {
  type: 'split';
  id: string;
  direction: PaneDirection;
  ratio: number;
  first: LayoutNode;
  second: LayoutNode;
}

export type LayoutNode = PaneLeaf | PaneSplit;

export interface WorkspaceLayout {
  version: 1;
  root: LayoutNode;
  focusedPaneId: string;
}

export const LAYOUT_VERSION = 1 as const;
export const MAX_PANES = 4;
export const MAX_LAYOUT_DEPTH = 3;
export const MIN_SPLIT_RATIO = 0.2;
export const MAX_SPLIT_RATIO = 0.8;

let nextId = 1;

export function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${nextId++}`;
}

export function createEmptyLayout(): WorkspaceLayout {
  const root = createPane({ kind: 'empty' });
  return { version: LAYOUT_VERSION, root, focusedPaneId: root.id };
}

export function createPane(content: PaneContent, id = createId('pane')): PaneLeaf {
  return { type: 'pane', id, content };
}

export function countPanes(node: LayoutNode): number {
  return node.type === 'pane' ? 1 : countPanes(node.first) + countPanes(node.second);
}

export function layoutDepth(node: LayoutNode): number {
  return node.type === 'pane' ? 1 : 1 + Math.max(layoutDepth(node.first), layoutDepth(node.second));
}

export function findPane(node: LayoutNode, paneId: string): PaneLeaf | null {
  if (node.type === 'pane') return node.id === paneId ? node : null;
  return findPane(node.first, paneId) || findPane(node.second, paneId);
}

export function findNode(node: LayoutNode, nodeId: string): LayoutNode | null {
  if (node.id === nodeId) return node;
  if (node.type === 'pane') return null;
  return findNode(node.first, nodeId) || findNode(node.second, nodeId);
}

export function listPanes(node: LayoutNode): PaneLeaf[] {
  return node.type === 'pane' ? [node] : [...listPanes(node.first), ...listPanes(node.second)];
}

function replaceNode(node: LayoutNode, targetId: string, replacement: LayoutNode): LayoutNode {
  if (node.id === targetId) return replacement;
  if (node.type === 'pane') return node;
  return {
    ...node,
    first: replaceNode(node.first, targetId, replacement),
    second: replaceNode(node.second, targetId, replacement),
  };
}

export function setPaneContent(layout: WorkspaceLayout, paneId: string, content: PaneContent): WorkspaceLayout {
  const pane = findPane(layout.root, paneId);
  if (!pane) return layout;
  return {
    ...layout,
    root: replaceNode(layout.root, paneId, { ...pane, content }),
  };
}

export function splitPane(
  layout: WorkspaceLayout,
  paneId: string,
  direction: PaneDirection,
  content: PaneContent,
  splitId = createId('split'),
  newPaneId = createId('pane'),
): WorkspaceLayout | null {
  const pane = findPane(layout.root, paneId);
  if (!pane || countPanes(layout.root) >= MAX_PANES) return null;
  const replacement: PaneSplit = {
    type: 'split',
    id: splitId,
    direction,
    ratio: 0.5,
    first: pane,
    second: createPane(content, newPaneId),
  };
  const nextLayout: WorkspaceLayout = {
    ...layout,
    root: replaceNode(layout.root, paneId, replacement),
    focusedPaneId: newPaneId,
  };
  if (layoutDepth(nextLayout.root) > MAX_LAYOUT_DEPTH) return null;
  return nextLayout;
}

/**
 * Rebuild the current panes into a compact, predictable grid while keeping
 * pane ids, content and focus stable. Four panes become a 2x2 grid; three
 * panes become two on the first row and one full-width pane below.
 */
export function arrangeTiled(layout: WorkspaceLayout): WorkspaceLayout {
  const panes = listPanes(layout.root);
  if (panes.length <= 1) return layout;

  const columns = Math.ceil(Math.sqrt(panes.length));
  const rows: PaneLeaf[][] = [];
  for (let i = 0; i < panes.length; i += columns) {
    rows.push(panes.slice(i, i + columns));
  }

  const buildAxis = (items: LayoutNode[], direction: PaneDirection): LayoutNode => {
    if (items.length === 1) return items[0];
    const firstCount = Math.ceil(items.length / 2);
    const first = buildAxis(items.slice(0, firstCount), direction);
    const second = buildAxis(items.slice(firstCount), direction);
    return {
      type: 'split',
      id: createId('split'),
      direction,
      ratio: Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, firstCount / items.length)),
      first,
      second,
    };
  };

  const rowNodes = rows.map((row) => buildAxis(row, 'horizontal'));
  const root = buildAxis(rowNodes, 'vertical');
  return { ...layout, root };
}

export function resizeSplit(layout: WorkspaceLayout, splitId: string, ratio: number): WorkspaceLayout {
  const node = findNode(layout.root, splitId);
  if (!node || node.type !== 'split') return layout;
  const clamped = Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
  return {
    ...layout,
    root: replaceNode(layout.root, splitId, { ...node, ratio: clamped }),
  };
}

function removeNode(node: LayoutNode, targetId: string): { node: LayoutNode | null; removed: PaneLeaf | null } {
  if (node.type === 'pane') {
    return node.id === targetId ? { node: null, removed: node } : { node, removed: null };
  }

  if (node.first.id === targetId) {
    return { node: node.second, removed: node.first.type === 'pane' ? node.first : null };
  }
  if (node.second.id === targetId) {
    return { node: node.first, removed: node.second.type === 'pane' ? node.second : null };
  }

  const first = removeNode(node.first, targetId);
  if (first.removed) {
    return { node: { ...node, first: first.node || node.second }, removed: first.removed };
  }
  const second = removeNode(node.second, targetId);
  if (second.removed) {
    return { node: { ...node, second: second.node || node.first }, removed: second.removed };
  }
  return { node, removed: null };
}

export function closePane(layout: WorkspaceLayout, paneId: string): { layout: WorkspaceLayout; removed: PaneLeaf | null } {
  const panes = listPanes(layout.root);
  if (panes.length <= 1) {
    const only = panes[0];
    if (!only || only.id !== paneId) return { layout, removed: null };
    const empty = createPane({ kind: 'empty' }, only.id);
    return {
      layout: { ...layout, root: empty, focusedPaneId: empty.id },
      removed: only,
    };
  }

  const result = removeNode(layout.root, paneId);
  if (!result.removed || !result.node) return { layout, removed: null };
  const nextFocused = result.removed.id === layout.focusedPaneId
    ? listPanes(result.node)[0]?.id || layout.focusedPaneId
    : layout.focusedPaneId;
  return {
    layout: { ...layout, root: result.node, focusedPaneId: nextFocused },
    removed: result.removed,
  };
}

function swapContents(node: LayoutNode, firstId: string, secondId: string, first: PaneContent, second: PaneContent): LayoutNode {
  if (node.type === 'pane') {
    if (node.id === firstId) return { ...node, content: second };
    if (node.id === secondId) return { ...node, content: first };
    return node;
  }
  return {
    ...node,
    first: swapContents(node.first, firstId, secondId, first, second),
    second: swapContents(node.second, firstId, secondId, first, second),
  };
}

export function swapPaneContents(layout: WorkspaceLayout, firstId: string, secondId: string): WorkspaceLayout {
  if (firstId === secondId) return layout;
  const first = findPane(layout.root, firstId);
  const second = findPane(layout.root, secondId);
  if (!first || !second) return layout;
  return { ...layout, root: swapContents(layout.root, firstId, secondId, first.content, second.content) };
}

export function dropStaleSessionPanes(
  layout: WorkspaceLayout,
  live: { terminal?: Set<string> },
): WorkspaceLayout {
  const staleIds = listPanes(layout.root)
    .filter((pane) => {
      const content = pane.content;
      if (content.kind === 'terminal' && live.terminal) return !live.terminal.has(content.sessionId);
      return false;
    })
    .map((pane) => pane.id);
  if (!staleIds.length) return layout;
  let next = layout;
  for (const id of staleIds) {
    if (!findPane(next.root, id)) continue;
    next = closePane(next, id).layout;
  }
  return next;
}

export function validateLayout(value: unknown): WorkspaceLayout | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<WorkspaceLayout>;
  if (candidate.version !== LAYOUT_VERSION || !candidate.root || typeof candidate.focusedPaneId !== 'string') return null;

  const ids = new Set<string>();
  const validateNode = (node: unknown, depth: number): node is LayoutNode => {
    if (!node || typeof node !== 'object' || depth > MAX_LAYOUT_DEPTH) return false;
    const n = node as Partial<LayoutNode>;
    if (typeof n.id !== 'string' || !n.id) return false;
    if (ids.has(n.id)) return false;
    ids.add(n.id);
    if (n.type === 'pane') {
      if (!n.content || typeof n.content !== 'object') return false;
      const content = n.content as Partial<PaneContent>;
      if (!['terminal', 'file', 'android', 'empty'].includes(String(content.kind))) return false;
      if (content.kind === 'terminal') return typeof content.sessionId === 'string' && content.sessionId.length > 0;
      if (content.kind === 'file') return typeof content.path === 'string' && content.path.length > 0;
      if (content.kind === 'android' && content.deviceId !== undefined && typeof content.deviceId !== 'string') return false;
      return true;
    }
    if (n.type !== 'split' || !['horizontal', 'vertical'].includes(String(n.direction))) return false;
    if (typeof n.ratio !== 'number' || !Number.isFinite(n.ratio)
      || n.ratio < MIN_SPLIT_RATIO || n.ratio > MAX_SPLIT_RATIO) return false;
    return validateNode(n.first, depth + 1) && validateNode(n.second, depth + 1);
  };

  if (!validateNode(candidate.root, 1)) return null;
  const root = candidate.root as LayoutNode;
  if (countPanes(root) > MAX_PANES || layoutDepth(root) > MAX_LAYOUT_DEPTH || !findPane(root, candidate.focusedPaneId)) return null;
  return { version: LAYOUT_VERSION, root, focusedPaneId: candidate.focusedPaneId };
}
