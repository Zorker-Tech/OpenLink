import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { getSlateAgentsRootDir, resolveSlateAgentDir } from "../../storage/agent-paths.ts";
import { createActionAuditFlushController } from "./action-audit-flush-controller.ts";
import { createActionAuditLocalWriteLane } from "./action-audit-local-write-lane.ts";
import { createActionAuditOutbox } from "./action-audit-outbox.ts";
import { localAuditJsonlLine } from "./action-audit-local-jsonl.ts";
import { isBackendForwardable } from "./action-audit-policy.ts";
import {
  type ActionAuditDependencies,
  type AuditEvent,
  type AuditRecord,
} from "./action-audit-contracts.ts";

/** Create the local event recorder and its independently gated backend drain. */
export function createSlateActionAuditor(deps: ActionAuditDependencies) {
  const now = deps.now ?? Date.now;
  const outboxPath = deps.outboxPath ?? join(getSlateAgentsRootDir(), "audit-outbox.json");
  const resolveAuditPath = deps.auditPath ?? ((agentId: string) => join(resolveSlateAgentDir(agentId), "audit.jsonl"));
  const appendLocalLine = deps.appendLocalLine ?? (async (path: string, line: string) => {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.appendFile(path, line, "utf8");
  });
  const outbox = createActionAuditOutbox(outboxPath);
  const localWrites = createActionAuditLocalWriteLane({
    auditPath: resolveAuditPath,
    append: appendLocalLine,
    ...(deps.report === undefined ? {} : { report: deps.report }),
  });
  const flusher = createActionAuditFlushController({
    outbox,
    now,
    isForwardingEnabled: deps.isBackendForwardingEnabled,
    sendBatch: deps.sendBatch,
  });
  let acceptingRecords = true;

  let firstPoll = true;
  const polling = deps.flushPolicy.start(async () => {
    if (firstPoll) {
      firstPoll = false;
      return;
    }
    await flusher.flushOnce();
  });

  const auditor = {
    record(record: AuditRecord): void {
      try {
        const eventId = deps.randomId?.() ?? crypto.randomUUID();
        try {
          const line = localAuditJsonlLine(record, eventId);
          localWrites.enqueue(record.agentId, line);
        } catch {
          // A local projection problem cannot change the host action being recorded.
        }

        if (acceptingRecords && isBackendForwardable(record)) {
          const event: AuditEvent = {
            eventId,
            occurredAtMs: record.occurredAtMs,
            agentId: record.agentId,
            turnId: record.turnId ?? "",
            boxId: record.boxId ?? "",
            action: record.action,
          };
          outbox.add(event);
        }
      } catch {
        // Audit failures are isolated from the operation the host is performing for a user.
      }
    },
  };

  let disposePromise: Promise<void> | undefined;
  const dispose = (): Promise<void> => disposePromise ??= (async () => {
    acceptingRecords = false;
    polling.dispose();
    await flusher.waitForCurrent();
    await flusher.flushOnce();
    await outbox.persist();
    await localWrites.close();
  })();

  return { auditor, dispose, flush: flusher.flushOnce };
}

export {
  ACTION_AUDIT_FLUSH_INTERVAL_MS,
  AUDIT_FLUSH_FAILURE_BACKOFF_MS,
  MAX_AUDIT_BATCH_SIZE,
  MAX_PENDING_AUDIT_EVENTS,
} from "./action-audit-contracts.ts";
export { flushFailureBackoffMs, isBackendForwardable } from "./action-audit-policy.ts";
export { localAuditJsonlLine } from "./action-audit-local-jsonl.ts";
export type { AuditAction, AuditEvent, AuditRecord } from "./action-audit-contracts.ts";
