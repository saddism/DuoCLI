import { randomUUID } from 'node:crypto';

// Short-lived, one-use state transfer across LAN/public browser origins.
export class NetworkHandoffStore {
  private readonly entries = new Map<string, { token: string; state: unknown; expiresAt: number }>();

  constructor(private readonly now = Date.now) {}

  put(token: string, state: unknown): string {
    this.prune();
    if (!state || typeof state !== 'object' || Buffer.byteLength(JSON.stringify(state)) > 2 * 1024 * 1024) {
      throw new Error('Invalid network handoff state');
    }
    if (this.entries.size >= 16) throw new Error('Too many pending network handoffs');
    const ticket = randomUUID();
    this.entries.set(ticket, { token, state, expiresAt: this.now() + 120_000 });
    return ticket;
  }

  take(token: string, ticket: string): unknown | null {
    this.prune();
    const entry = this.entries.get(ticket);
    if (!entry || entry.token !== token) return null;
    this.entries.delete(ticket);
    return entry.state;
  }

  private prune(): void {
    for (const [ticket, entry] of this.entries) {
      if (entry.expiresAt <= this.now()) this.entries.delete(ticket);
    }
  }
}
