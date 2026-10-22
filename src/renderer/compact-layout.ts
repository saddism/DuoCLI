export const COMPACT_LAYOUT_ENTER_WIDTH = 1280;
export const COMPACT_LAYOUT_EXIT_WIDTH = 1360;
export const SIDEBAR_COMPACT_WIDTH = 210;

export type CompactLayoutPhase = 'compact' | 'roomy' | 'hold';

export function compactLayoutPhase(
  windowWidth: number,
  currentlyCompact: boolean,
): CompactLayoutPhase {
  if (windowWidth <= COMPACT_LAYOUT_ENTER_WIDTH) return 'compact';
  if (windowWidth >= COMPACT_LAYOUT_EXIT_WIDTH) return 'roomy';
  return currentlyCompact ? 'compact' : 'hold';
}

export function shouldFileTreeCollapse(input: {
  phase: CompactLayoutPhase;
  userCollapsed: boolean;
  userPinnedOpen: boolean;
  collapsed: boolean;
}): boolean {
  if (input.userCollapsed) return true;
  if (input.userPinnedOpen) return false;
  if (input.phase === 'compact') return true;
  if (input.phase === 'roomy') return false;
  return input.collapsed;
}

export function nextSidebarWidth(input: {
  phase: CompactLayoutPhase;
  userCollapsed: boolean;
  userPinnedWidth: boolean;
  currentWidth: number;
  preferredWidth: number;
}): number | null {
  if (input.userCollapsed) return null;
  if (input.phase === 'compact') {
    if (input.userPinnedWidth) return input.currentWidth;
    return Math.min(input.currentWidth, SIDEBAR_COMPACT_WIDTH);
  }
  if (input.phase === 'roomy') return Math.max(input.preferredWidth, SIDEBAR_COMPACT_WIDTH);
  return input.currentWidth;
}
