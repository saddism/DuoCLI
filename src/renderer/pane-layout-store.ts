import { countPanes, createEmptyLayout, validateLayout, type WorkspaceLayout } from './pane-layout';

const STORAGE_KEY = 'duocli_workspace_layouts_v1';

/** Single shared split layout across all projects. */
export const GLOBAL_WORKSPACE_KEY = '__global__';

function normalizeWorkspaceKey(cwd: string): string {
  let value = cwd.trim().replace(/\\/g, '/');
  if (value.startsWith('/private/')) value = value.slice('/private'.length);
  if (value.length > 1) value = value.replace(/\/+$/, '');
  // Windows paths are case-insensitive; preserve case elsewhere so two
  // distinct POSIX workspaces cannot overwrite one another.
  if (/^[A-Za-z]:\//.test(value)) value = value.toLowerCase();
  return value || '__default__';
}

type LayoutMap = Record<string, WorkspaceLayout>;

function readAll(): LayoutMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== 'object') return {};
    const result: LayoutMap = {};
    for (const [key, item] of Object.entries(value)) {
      const layout = validateLayout(item);
      if (layout) result[key] = layout;
    }
    return result;
  } catch {
    return {};
  }
}

function writeAll(value: LayoutMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // A full or disabled localStorage should not make the workspace unusable.
  }
}

function isEmptyLayout(layout: WorkspaceLayout): boolean {
  return layout.root.type === 'pane' && layout.root.content.kind === 'empty';
}

/**
 * Prefer an existing global layout. If missing, migrate the densest
 * non-empty per-project layout so users keep their current splits once.
 */
export function loadGlobalWorkspaceLayout(): WorkspaceLayout {
  const all = readAll();
  const existing = all[GLOBAL_WORKSPACE_KEY];
  if (existing && !isEmptyLayout(existing)) return existing;

  let best: WorkspaceLayout | null = null;
  let bestCount = 0;
  for (const [key, layout] of Object.entries(all)) {
    if (key === GLOBAL_WORKSPACE_KEY) continue;
    if (isEmptyLayout(layout)) continue;
    const count = countPanes(layout.root);
    if (count > bestCount) {
      best = layout;
      bestCount = count;
    }
  }
  if (best) {
    all[GLOBAL_WORKSPACE_KEY] = best;
    writeAll(all);
    return best;
  }
  return createEmptyLayout();
}

export function loadWorkspaceLayout(cwd: string): WorkspaceLayout {
  const key = normalizeWorkspaceKey(cwd);
  if (key === GLOBAL_WORKSPACE_KEY || key === '__default__') {
    return loadGlobalWorkspaceLayout();
  }
  return readAll()[key] || createEmptyLayout();
}

export function saveWorkspaceLayout(cwd: string, layout: WorkspaceLayout): void {
  const all = readAll();
  all[normalizeWorkspaceKey(cwd)] = layout;
  writeAll(all);
}

export function clearWorkspaceLayout(cwd: string): void {
  const all = readAll();
  delete all[normalizeWorkspaceKey(cwd)];
  writeAll(all);
}

export { normalizeWorkspaceKey };
