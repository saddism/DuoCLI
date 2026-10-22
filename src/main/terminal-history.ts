export const TERMINAL_CAPABILITY_VERSION = 2;
export const HISTORY_PAGE_ROWS = 80;
export const HISTORY_MAX_ROWS = 5000;
export const HISTORY_MAX_BYTES = 2 * 1024 * 1024;
export const HISTORY_PAGE_MAX_BYTES = 64 * 1024;
export const HISTORY_LINE_FRAGMENT_CHARS = 4000;

export const STYLE_BOLD = 1;
export const STYLE_UNDERLINE = 2;
export const STYLE_DIM = 4;
export const STYLE_INVERSE = 8;
export const STYLE_ITALIC = 16;

/** xterm `getFgColorMode()` returns CM_* bitmasks, not 0–3. */
export const XTERM_CM_P16 = 0x1000000;
export const XTERM_CM_P256 = 0x2000000;
export const XTERM_CM_RGB = 0x3000000;
export const XTERM_CM_MASK = 0x3000000;

export function normalizeColorMode(mode: unknown): 0 | 1 | 2 | 3 {
  const value = Number(mode);
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value <= 3) return value as 0 | 1 | 2 | 3;
  return (((value >>> 0) & XTERM_CM_MASK) >>> 24) as 0 | 1 | 2 | 3;
}

export interface HistoryStyleRun {
  start: number;
  end: number;
  fg?: number;
  bg?: number;
  fgMode?: number;
  bgMode?: number;
  flags?: number;
}

export interface HistoryLine {
  lineId: number;
  epoch: number;
  text: string;
  wraps: number[];
  styles: HistoryStyleRun[];
  order: number;
}

export interface HistoryLineFragment extends HistoryLine {
  part: number;
  partCount: number;
}

export interface HistoryLogicalLine {
  text: string;
  wraps: number[];
  styles: HistoryStyleRun[];
}

export interface HistoryPage {
  items: HistoryLineFragment[];
  nextCursor: string | null;
  hasMore: boolean;
  earliestAvailable: boolean;
  truncated: boolean;
  stale: boolean;
  requestId: string;
  epoch: number;
}

export interface HistoryBufferLine {
  isWrapped?: boolean;
  translateToString?(trimRight?: boolean): string;
  length?: number;
  getCell?(x: number, cell?: unknown): HistoryBufferCell | undefined;
}

export interface HistoryBufferCell {
  getChars?(): string;
  getWidth?(): number;
  getFgColor?(): number;
  getBgColor?(): number;
  getFgColorMode?(): number;
  getBgColorMode?(): number;
  isBold?(): number | boolean;
  isUnderline?(): number | boolean;
  isDim?(): number | boolean;
  isInverse?(): number | boolean;
  isItalic?(): number | boolean;
}

export interface HistoryBuffer {
  length: number;
  baseY: number;
  getLine(y: number): HistoryBufferLine | undefined;
}

export function encodeHistoryCursor(epoch: number, lineId: number, part = 0): string {
  return part > 0 ? `${epoch}:${lineId}:${part}` : `${epoch}:${lineId}`;
}

export function decodeHistoryCursor(cursor: unknown): { epoch: number; lineId: number; part: number } | null {
  if (typeof cursor !== 'string' || !cursor) return null;
  const match = /^(\d+):(\d+)(?::(\d+))?$/.exec(cursor);
  if (!match) return null;
  return { epoch: Number(match[1]), lineId: Number(match[2]), part: Number(match[3] || 0) };
}

export function sameLogicalTexts(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

/** Longest suffix of `previous` that matches a prefix of `current`. */
export function overlapLogicalCount(previous: string[], current: string[]): number {
  const max = Math.min(previous.length, current.length);
  for (let len = max; len > 0; len--) {
    let matched = true;
    for (let i = 0; i < len; i++) {
      if (previous[previous.length - len + i] !== current[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return len;
  }
  return 0;
}

function cellFlag(value: number | boolean | undefined): boolean {
  return value === true || value === 1;
}

export function readPhysicalStyles(line: HistoryBufferLine | undefined): { text: string; styles: HistoryStyleRun[] } {
  if (!line) return { text: '', styles: [] };
  if (typeof line.getCell !== 'function') {
    const text = (line.translateToString?.(true) || '').replace(/\s+$/g, '');
    return { text, styles: [] };
  }
  let text = '';
  const styles: HistoryStyleRun[] = [];
  let run: HistoryStyleRun | null = null;
  const width = Math.max(0, line.length || 0);
  for (let x = 0; x < width; x++) {
    const cell = line.getCell(x);
    const chars = cell?.getChars?.() || '';
    const cellWidth = cell?.getWidth?.() ?? 1;
    if (!chars && cellWidth === 0) continue;
    const piece = chars || (cellWidth > 0 ? ' ' : '');
    if (!piece) continue;
    const styleKey = {
      fg: cell?.getFgColor?.(),
      bg: cell?.getBgColor?.(),
      fgMode: normalizeColorMode(cell?.getFgColorMode?.()),
      bgMode: normalizeColorMode(cell?.getBgColorMode?.()),
      flags: (cellFlag(cell?.isBold?.()) ? STYLE_BOLD : 0)
        | (cellFlag(cell?.isUnderline?.()) ? STYLE_UNDERLINE : 0)
        | (cellFlag(cell?.isDim?.()) ? STYLE_DIM : 0)
        | (cellFlag(cell?.isInverse?.()) ? STYLE_INVERSE : 0)
        | (cellFlag(cell?.isItalic?.()) ? STYLE_ITALIC : 0),
    };
    const start = text.length;
    text += piece;
    const end = text.length;
    if (
      run
      && run.fg === styleKey.fg
      && run.bg === styleKey.bg
      && run.fgMode === styleKey.fgMode
      && run.bgMode === styleKey.bgMode
      && run.flags === styleKey.flags
    ) {
      run.end = end;
    } else {
      run = { start, end, ...styleKey };
      styles.push(run);
    }
  }
  while (text.endsWith(' ')) {
    text = text.slice(0, -1);
    const last = styles[styles.length - 1];
    if (last && last.end > text.length) last.end = text.length;
    if (last && last.start >= last.end) styles.pop();
  }
  return { text, styles };
}

export function readLogicalScrollback(buffer: HistoryBuffer): HistoryLogicalLine[] {
  const end = Math.max(0, Math.min(buffer.length, buffer.baseY));
  const result: HistoryLogicalLine[] = [];
  let y = 0;
  while (y < end) {
    const first = buffer.getLine(y);
    if (!first) {
      y++;
      continue;
    }
    let text = '';
    const wraps: number[] = [];
    const styles: HistoryStyleRun[] = [];
    let row = y;
    while (row < end) {
      const physical = readPhysicalStyles(buffer.getLine(row));
      if (row > y) wraps.push(text.length);
      for (const run of physical.styles) {
        styles.push({ ...run, start: run.start + text.length, end: run.end + text.length });
      }
      text += physical.text;
      row++;
      if (row >= end || !buffer.getLine(row)?.isWrapped) break;
    }
    result.push({ text, wraps, styles });
    y = row;
  }
  return result;
}

function shiftStyles(styles: HistoryStyleRun[], start: number, end: number): HistoryStyleRun[] {
  const shifted: HistoryStyleRun[] = [];
  for (const run of styles) {
    const from = Math.max(run.start, start) - start;
    const to = Math.min(run.end, end) - start;
    if (to <= from) continue;
    shifted.push({ ...run, start: from, end: to });
  }
  return shifted;
}

export function fragmentHistoryLine(line: HistoryLine, maxChars = HISTORY_LINE_FRAGMENT_CHARS): HistoryLineFragment[] {
  const limit = Math.max(1, maxChars);
  if (line.text.length <= limit) {
    return [{ ...line, part: 0, partCount: 1 }];
  }
  const partCount = Math.ceil(line.text.length / limit);
  const parts: HistoryLineFragment[] = [];
  for (let part = 0; part < partCount; part++) {
    const start = part * limit;
    const end = Math.min(line.text.length, start + limit);
    parts.push({
      ...line,
      text: line.text.slice(start, end),
      wraps: line.wraps.filter(offset => offset >= start && offset < end).map(offset => offset - start),
      styles: shiftStyles(line.styles, start, end),
      part,
      partCount,
    });
  }
  return parts;
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export class TerminalHistoryArchive {
  readonly epoch: number;
  private lines: HistoryLine[] = [];
  private nextLineId = 1;
  private nextOrder = 1;
  private fingerprint: string[] = [];
  private bytes = 0;
  truncated = false;
  private readonly maxRows: number;
  private readonly maxBytes: number;

  constructor(epoch = 1, limits?: { maxRows?: number; maxBytes?: number }) {
    this.epoch = epoch;
    this.maxRows = limits?.maxRows ?? HISTORY_MAX_ROWS;
    this.maxBytes = limits?.maxBytes ?? HISTORY_MAX_BYTES;
  }

  get lastLineId(): number {
    return this.lines.length ? this.lines[this.lines.length - 1].lineId : 0;
  }

  get count(): number {
    return this.lines.length;
  }

  get hasMore(): boolean {
    return this.lines.length > 0;
  }

  get historyCursor(): string | null {
    return this.lines.length ? encodeHistoryCursor(this.epoch, this.lastLineId + 1) : null;
  }

  getLines(): HistoryLine[] {
    return this.lines.slice();
  }

  syncFromLogical(current: HistoryLogicalLine[]): HistoryLine[] {
    const texts = current.map(line => line.text);
    if (sameLogicalTexts(texts, this.fingerprint)) {
      this.updateWraps(current);
      return [];
    }
    const overlap = overlapLogicalCount(this.fingerprint, texts);
    const added = current.slice(overlap);
    const created: HistoryLine[] = [];
    for (const line of added) created.push(this.pushLine(line));
    this.fingerprint = texts;
    this.trim();
    return created;
  }

  syncFromBuffer(buffer: HistoryBuffer): HistoryLine[] {
    return this.syncFromLogical(readLogicalScrollback(buffer));
  }

  /** Extend the logical line anchored by a live xterm marker, then append new
   * lines. The anchor's identity survives ring trims, including identical rows. */
  syncTailFromBuffer(buffer: HistoryBuffer, startRow: number): HistoryLine[] {
    if (!this.lines.length || startRow < 0 || startRow >= buffer.baseY) {
      return this.syncFromBuffer(buffer);
    }
    const current = readLogicalScrollback({
      length: buffer.length - startRow,
      baseY: buffer.baseY - startRow,
      getLine: (row) => buffer.getLine(startRow + row),
    });
    if (!current.length) return [];
    const tail = this.lines[this.lines.length - 1];
    const first = current[0];
    this.bytes += utf8Bytes(first.text) - utf8Bytes(tail.text);
    tail.text = first.text;
    tail.wraps = first.wraps.slice();
    tail.styles = first.styles.map(run => ({ ...run }));
    if (this.fingerprint.length) this.fingerprint[this.fingerprint.length - 1] = first.text;
    else this.fingerprint.push(first.text);
    const created = current.slice(1).map(line => this.pushLine(line));
    this.fingerprint.push(...current.slice(1).map(line => line.text));
    // Retain enough text for a rare full reconciliation after resize or reset,
    // without retaining unbounded history alongside the archive's byte budget.
    this.fingerprint = this.fingerprint.slice(-(HISTORY_MAX_ROWS + 1));
    this.trim();
    return created;
  }

  pageBefore(input: {
    beforeCursor?: string | null;
    limitRows?: number;
    requestId?: string;
    epoch?: number;
  } = {}): HistoryPage {
    const requestId = typeof input.requestId === 'string' ? input.requestId : '';
    const decoded = input.beforeCursor ? decodeHistoryCursor(input.beforeCursor) : {
      epoch: this.epoch,
      lineId: this.lastLineId + 1,
      part: 0,
    };
    const requestedEpoch = Number.isInteger(input.epoch) ? input.epoch : decoded?.epoch;
    if (!decoded || requestedEpoch !== this.epoch || decoded.epoch !== this.epoch) {
      return {
        items: [],
        nextCursor: this.historyCursor,
        hasMore: this.hasMore,
        earliestAvailable: !this.truncated && this.lines.length === 0,
        truncated: this.truncated,
        stale: true,
        requestId,
        epoch: this.epoch,
      };
    }

    const limitRows = Math.max(1, Math.min(200, Math.floor(input.limitRows ?? HISTORY_PAGE_ROWS)));
    const eligible = this.lines.filter(line => (
      line.lineId < decoded.lineId
      || (line.lineId === decoded.lineId && decoded.part > 0)
    ));
    const collected: HistoryLineFragment[] = [];
    let rows = 0;
    let bytes = 0;
    outer: for (let i = eligible.length - 1; i >= 0; i--) {
      const fragments = fragmentHistoryLine(eligible[i]);
      const startPart = eligible[i].lineId === decoded.lineId ? Math.max(0, decoded.part) : fragments.length;
      for (let f = Math.min(fragments.length, startPart) - 1; f >= 0; f--) {
        const fragment = fragments[f];
        const rowCost = Math.max(1, fragment.wraps.length + 1);
        const byteCost = utf8Bytes(fragment.text) + 48;
        if (collected.length && (rows + rowCost > limitRows || bytes + byteCost > HISTORY_PAGE_MAX_BYTES)) {
          break outer;
        }
        collected.push(fragment);
        rows += rowCost;
        bytes += byteCost;
      }
    }
    collected.reverse();
    const oldest = collected[0];
    const nextCursor = oldest
      ? encodeHistoryCursor(this.epoch, oldest.lineId, oldest.part)
      : null;
    const hasMore = Boolean(oldest && this.lines.some(line => (
      line.lineId < oldest.lineId || (line.lineId === oldest.lineId && oldest.part > 0)
    )));
    return {
      items: collected,
      nextCursor,
      hasMore,
      earliestAvailable: !hasMore && !this.truncated,
      truncated: this.truncated && !hasMore,
      stale: false,
      requestId,
      epoch: this.epoch,
    };
  }

  private pushLine(line: HistoryLogicalLine): HistoryLine {
    const entry: HistoryLine = {
      lineId: this.nextLineId++,
      epoch: this.epoch,
      text: line.text,
      wraps: line.wraps.slice(),
      styles: line.styles.map(run => ({ ...run })),
      order: this.nextOrder++,
    };
    this.lines.push(entry);
    this.bytes += utf8Bytes(entry.text) + 48;
    return entry;
  }

  private updateWraps(current: HistoryLogicalLine[]): void {
    const start = this.lines.length - current.length;
    if (start < 0) return;
    for (let i = 0; i < current.length; i++) {
      const line = this.lines[start + i];
      if (!line || line.text !== current[i].text) continue;
      line.wraps = current[i].wraps.slice();
      line.styles = current[i].styles.map(run => ({ ...run }));
    }
  }

  private trim(): void {
    while (this.lines.length > this.maxRows || this.bytes > this.maxBytes) {
      const removed = this.lines.shift();
      if (!removed) break;
      this.bytes = Math.max(0, this.bytes - utf8Bytes(removed.text) - 48);
      this.truncated = true;
    }
  }
}
