import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { MAX_PENDING_AUDIT_EVENTS } from "./action-audit-contracts.ts";
import type { AuditEvent } from "./action-audit-contracts.ts";

function appendLoadedRows(older: readonly unknown[], queued: readonly AuditEvent[]): AuditEvent[] {
  const prior = older.slice(0, MAX_PENDING_AUDIT_EVENTS) as AuditEvent[];
  const keepRoom = Math.max(0, MAX_PENDING_AUDIT_EVENTS - prior.length);
  return [...prior, ...queued.slice(-keepRoom)];
}

/** Owns the capped memory queue and its best-effort atomic outbox file. */
export function createActionAuditOutbox(path: string) {
  let queued: AuditEvent[] = [];
  let didLoad = false;

  async function readSavedRows(): Promise<unknown> {
    try {
      return JSON.parse(await fs.readFile(path, "utf8"));
    } catch {
      return null;
    }
  }

  async function load(): Promise<void> {
    if (didLoad) return;
    didLoad = true;
    const saved = await readSavedRows();
    if (Array.isArray(saved)) queued = appendLoadedRows(saved, queued);
  }

  async function persist(): Promise<void> {
    try {
      if (queued.length === 0) {
        await fs.rm(path, { force: true });
        return;
      }
      await fs.mkdir(dirname(path), { recursive: true });
      const temporaryPath = `${path}.${process.pid}.tmp`;
      await fs.writeFile(temporaryPath, JSON.stringify(queued), "utf8");
      await fs.rename(temporaryPath, path);
    } catch {
      // Local retention is best-effort; a storage error must not interrupt the host action that was audited.
    }
  }

  function add(event: AuditEvent): void {
    queued.push(event);
    if (queued.length > MAX_PENDING_AUDIT_EVENTS) queued = queued.slice(-MAX_PENDING_AUDIT_EVENTS);
  }

  function nextBatch(batchSize: number): AuditEvent[] {
    return queued.slice(0, batchSize);
  }

  function acknowledge(batch: readonly AuditEvent[]): void {
    const deliveredIds = new Set(batch.map((event) => event.eventId));
    queued = queued.filter((event) => !deliveredIds.has(event.eventId));
  }

  return {
    load,
    persist,
    add,
    nextBatch,
    acknowledge,
    hasPending: () => queued.length > 0,
    pendingCount: () => queued.length,
  };
}
