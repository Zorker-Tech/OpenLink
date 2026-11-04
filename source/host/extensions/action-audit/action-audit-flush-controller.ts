import { MAX_AUDIT_BATCH_SIZE, type AuditEvent } from "./action-audit-contracts.ts";
import { flushFailureBackoffMs } from "./action-audit-policy.ts";

interface ActionAuditOutbox {
  load(): Promise<void>;
  persist(): Promise<void>;
  nextBatch(batchSize: number): AuditEvent[];
  acknowledge(batch: readonly AuditEvent[]): void;
  hasPending(): boolean;
}

/** Drain persisted events with single-flight protection and retry backoff. */
export function createActionAuditFlushController(args: {
  readonly outbox: ActionAuditOutbox;
  readonly now: () => number;
  readonly isForwardingEnabled: () => boolean | Promise<boolean>;
  readonly sendBatch: (events: readonly AuditEvent[]) => Promise<void>;
}) {
  let inFlight: Promise<void> | undefined;
  let retryAfterMs = 0;

  async function run(): Promise<void> {
    if (args.now() < retryAfterMs) return;
    try {
      await args.outbox.load();
      if (!args.outbox.hasPending() || !await args.isForwardingEnabled()) {
        await args.outbox.persist();
        return;
      }

      while (args.outbox.hasPending()) {
        const batch = args.outbox.nextBatch(MAX_AUDIT_BATCH_SIZE);
        await args.sendBatch(batch);
        args.outbox.acknowledge(batch);
      }
      await args.outbox.persist();
    } catch (error) {
      const retryBaseMs = args.now();
      retryAfterMs = retryBaseMs + flushFailureBackoffMs(error, args.now());
      await args.outbox.persist();
    }
  }

  function flushOnce(): Promise<void> {
    if (inFlight != null) return inFlight;
    const current = run().finally(() => {
      if (inFlight === current) inFlight = undefined;
    });
    inFlight = current;
    return current;
  }

  async function waitForCurrent(): Promise<void> {
    await inFlight;
  }

  return { flushOnce, waitForCurrent };
}
