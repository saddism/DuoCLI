import { createEmptyLayout, validateLayout, type WorkspaceLayout } from './pane-layout';

const STORAGE_KEY = 'duocli_workspace_layouts_v1';

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

export function loadWorkspaceLayout(cwd: string): WorkspaceLayout {
  return readAll()[normalizeWorkspaceKey(cwd)] || createEmptyLayout();
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
