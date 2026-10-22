/** WCAG-ish contrast helpers for terminal theme swatches. */

function parseHexColor(input: string): { r: number; g: number; b: number } | null {
  const raw = String(input || '').trim();
  const short = /^#([0-9a-f]{3})$/i.exec(raw);
  if (short) {
    const [r, g, b] = short[1].split('').map((ch) => parseInt(ch + ch, 16));
    return { r, g, b };
  }
  const full = /^#([0-9a-f]{6})$/i.exec(raw);
  if (!full) return null;
  return {
    r: parseInt(full[1].slice(0, 2), 16),
    g: parseInt(full[1].slice(2, 4), 16),
    b: parseInt(full[1].slice(4, 6), 16),
  };
}

function srgbChannelToLinear(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance 0..1 (WCAG). */
export function relativeLuminance(color: string): number {
  const rgb = parseHexColor(color);
  if (!rgb) return 0;
  const r = srgbChannelToLinear(rgb.r);
  const g = srgbChannelToLinear(rgb.g);
  const b = srgbChannelToLinear(rgb.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const light = Math.max(l1, l2);
  const dark = Math.min(l1, l2);
  return (light + 0.05) / (dark + 0.05);
}

/** Prefer the given fg when contrast is enough; otherwise pick black/white. */
export function pickContrastingForeground(background: string, preferred?: string): string {
  const dark = '#0a0a0a';
  const light = '#f5f5f5';
  if (preferred && contrastRatio(background, preferred) >= 3.5) return preferred;
  return contrastRatio(background, light) >= contrastRatio(background, dark) ? light : dark;
}

/** Build an xterm theme whose fg/cursor/selection stay readable on light or dark bg. */
export function buildContrastingTerminalTheme(background: string, preferredForeground?: string): Record<string, string> {
  const foreground = pickContrastingForeground(background, preferredForeground);
  const bgIsLight = relativeLuminance(background) >= 0.45;
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: bgIsLight ? 'rgba(0, 0, 0, 0.28)' : 'rgba(255, 255, 255, 0.3)',
    black: '#1a1a1a',
    red: '#ff6b6b',
    green: '#51cf66',
    yellow: '#ffd43b',
    blue: '#339af0',
    magenta: '#cc5de8',
    cyan: '#20c997',
    white: '#f8f9fa',
    brightBlack: '#495057',
    brightRed: '#fa5252',
    brightGreen: '#69db7c',
    brightYellow: '#ffe066',
    brightBlue: '#54a9ff',
    brightMagenta: '#bb81e6',
    brightCyan: '#48c9b0',
    brightWhite: '#ffffff',
  };
}
