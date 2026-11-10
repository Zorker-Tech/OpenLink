import { takeLogShipBatch } from "./log-ship-cadence.ts";
import { BOX_LOG_EVENT, HOST_LOG_EVENT } from "./telemetry-events.ts";
import type { BufferedStructuredLog } from "./structured-log-transport-contracts.ts";
import { MAX_BUFFER_SIZE } from "./structured-log-transport-values.ts";

export class StructuredLogBuffer {
  private queued: BufferedStructuredLog[];
  private sending: BufferedStructuredLog[] = [];

  constructor(restored: readonly BufferedStructuredLog[] = []) {
    this.queued = restored
      .slice(-MAX_BUFFER_SIZE)
      .map((record) => ({ ...record, metadata: { ...record.metadata } }));
  }

  enqueue(record: BufferedStructuredLog): BufferedStructuredLog[] {
    this.queued.push(record);
    return this.evictOverflow();
  }

  takeBatch(): BufferedStructuredLog[] {
    const taken = takeLogShipBatch(this.queued);
    this.queued = taken.remaining;
    this.sending = taken.batch;
    return this.sending;
  }

  restoreSendingBatch(): BufferedStructuredLog[] {
    this.queued = [...this.sending, ...this.queued];
    this.sending = [];
    return this.evictOverflow();
  }

  settleSendingBatch(settlement: "delivered" | "dropped"): void {
    const completed = this.sending;
    this.sending = [];
    settle(completed, settlement);
  }

  discardSendingBatch(): void {
    this.sending = [];
  }

  expireQueued(now: number, maxAgeMs: number): number {
    const expired: BufferedStructuredLog[] = [];
    this.queued = this.queued.filter((record) => {
      if (now - record.timestamp > maxAgeMs) {
        expired.push(record);
        return false;
      }
      return true;
    });
    settle(expired, "dropped");
    return expired.length;
  }

  pendingRows(): BufferedStructuredLog[] {
    return [...this.sending, ...this.queued].map((record) => ({
      ...record,
      metadata: { ...record.metadata },
    }));
  }

  clear(): BufferedStructuredLog[] {
    const rows = [...this.sending, ...this.queued];
    this.sending = [];
    this.queued = [];
    return rows;
  }

  pendingCount(): number {
    return this.sending.length + this.queued.length;
  }

  queuedCount(): number {
    return this.queued.length;
  }

  hasQueuedRows(): boolean {
    return this.queued.length > 0;
  }

  enforceLimit(): BufferedStructuredLog[] {
    return this.evictOverflow();
  }

  private evictOverflow(): BufferedStructuredLog[] {
    let excess = this.queued.length - MAX_BUFFER_SIZE;
    if (excess <= 0) return [];

    const evicted: BufferedStructuredLog[] = [];
    this.queued = this.queued.filter((record) => {
      if (excess > 0 && isLowPriorityLog(record.message)) {
        excess -= 1;
        evicted.push(record);
        return false;
      }
      return true;
    });

    if (excess > 0) evicted.push(...this.queued.splice(0, excess));
    return evicted;
  }
}

function isLowPriorityLog(message: string): boolean {
  return message === HOST_LOG_EVENT || message === BOX_LOG_EVENT;
}

function settle(records: readonly BufferedStructuredLog[], result: "delivered" | "dropped"): void {
  for (const record of records) record.onSettled?.(result);
}
