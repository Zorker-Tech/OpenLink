import { ackObligationsPath, readAckObligations, writeAckObligations } from "./ack-obligation-file.ts";
import type { AckObligation } from "./ack-obligation-records.ts";
import { coerceObligation, finiteNumber, parseAckObligationsFile } from "./ack-obligation-records.ts";

export { coerceObligation, finiteNumber, parseAckObligationsFile } from "./ack-obligation-records.ts";
export type { AckObligation } from "./ack-obligation-records.ts";

export class SlateAckObligationStore {
  readonly filePath: string;
  private cache: AckObligation[] | null = null;

  constructor(rootDir: string) {
    this.filePath = ackObligationsPath(rootDir);
  }

  get(agentId: string): AckObligation | undefined {
    return this.readPending().find((obligation) => obligation.agentId === agentId);
  }

  list(): AckObligation[] {
    return this.readPending();
  }

  recordSend(agentId: string, send: { atMs: number }): { obligation: AckObligation; created: boolean } {
    const existing = this.get(agentId);
    const next = existing == null
      ? {
          agentId,
          createdAtMs: send.atMs,
          lastSendAtMs: send.atMs,
          coalescedCount: 1,
          redriveAttempts: 0,
        }
      : {
          ...existing,
          lastSendAtMs: send.atMs,
          coalescedCount: existing.coalescedCount + 1,
        };
    this.upsert(next);
    return { obligation: next, created: existing == null };
  }

  recordInterrupt(agentId: string, atMs: number): void {
    const current = this.get(agentId);
    if (current != null) this.upsert({ ...current, lastInterruptAtMs: atMs });
  }

  recordRedriveAttempt(agentId: string): AckObligation | undefined {
    const current = this.get(agentId);
    if (current == null) return undefined;
    const next = { ...current, redriveAttempts: current.redriveAttempts + 1 };
    this.upsert(next);
    return next;
  }

  clear(agentId: string): void {
    try {
      const current = this.readPending();
      const remaining = current.filter((obligation) => obligation.agentId !== agentId);
      if (remaining.length !== current.length) this.write(remaining);
    } catch {
      // A failed durable write leaves the in-memory obligation intact.
    }
  }

  upsert(obligation: AckObligation): void {
    try {
      const pending = this.readPending().filter((entry) => entry.agentId !== obligation.agentId);
      this.write([...pending, obligation]);
    } catch {
      // Persistence is best-effort; the caller still receives the state it attempted to write.
    }
  }

  readPending(): AckObligation[] {
    if (this.cache != null) return this.cache;
    this.cache = readAckObligations(this.filePath);
    return this.cache;
  }

  write(pending: readonly AckObligation[]): void {
    writeAckObligations(this.filePath, pending);
    this.cache = [...pending];
  }
}
