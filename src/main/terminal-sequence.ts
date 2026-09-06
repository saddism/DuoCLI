/** Preserve an unfinished escape sequence across a snapshot boundary. */
export class TerminalSequence {
  pending = '';
  private state: 'text' | 'escape' | 'csi' | 'string' | 'stringEscape' = 'text';
  private highSurrogate = '';

  feed(data: string): void {
    for (const ch of data) {
      const code = ch.charCodeAt(0);
      this.highSurrogate = ch.length === 1 && code >= 0xd800 && code <= 0xdbff ? ch : '';
      if (ch === '\x18' || ch === '\x1a') { this.pending = ''; this.state = 'text'; continue; }
      if (this.state === 'string' || this.state === 'stringEscape') {
        this.pending += ch;
        if (ch === '\x07' || ch === '\x9c' || (this.state === 'stringEscape' && ch === '\\')) {
          this.pending = ''; this.state = 'text';
        } else this.state = ch === '\x1b' ? 'stringEscape' : 'string';
        continue;
      }
      if (ch === '\x1b') { this.pending = ch; this.state = 'escape'; continue; }
      if (this.state === 'text') {
        if (ch === '\x9b') { this.pending = ch; this.state = 'csi'; }
        else if (['\x90', '\x9d', '\x9e', '\x9f'].includes(ch)) { this.pending = ch; this.state = 'string'; }
        continue;
      }
      this.pending += ch;
      if (this.state === 'escape') {
        if (ch === '[') this.state = 'csi';
        else if (']PX^_'.includes(ch)) this.state = 'string';
        else if (code >= 0x30 && code <= 0x7e) { this.pending = ''; this.state = 'text'; }
      } else if (code >= 0x40 && code <= 0x7e) { this.pending = ''; this.state = 'text'; }
    }
  }

  suffix(): string { return this.pending || this.highSurrogate; }
}
