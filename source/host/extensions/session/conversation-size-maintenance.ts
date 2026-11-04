import { basename, dirname } from "node:path";
import { reportSessionDiagnostic } from "./session-diagnostics.ts";
import {
  conversationHardLimitBytes,
  conversationSoftLimitBytes,
  isConversationGcEnabled,
  SOFT_GC_MIN_INTERVAL_MS,
} from "./conversation-size-limits-config.ts";
import {
  blobDbPathFor,
  measureConversationBlobBytes,
  reportConversationGcVerdict,
  runConversationGc,
} from "./conversation-size-garbage-collection.ts";
import type { ConversationGcDatabase, ConversationGcHost, ConversationGcVerdict } from "./conversation-size-limits-contracts.ts";

interface ScheduledGcState {
  active: boolean;
  lastStartedAtMs: number;
}

const scheduledByBlobPath = new Map<string, ScheduledGcState>();

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export class SlateConversationTooLargeError extends Error {
  readonly isConversationTooLarge = true;

  constructor(sizeBytes: number, limitBytes: number) {
    super(`This conversation's stored state is ${Math.round(sizeBytes / (1024 * 1024))} MB, over the ${Math.round(limitBytes / (1024 * 1024))} MB limit, and compaction could not shrink it. Start a new conversation with this agent to continue.`);
    this.name = "SlateConversationTooLargeError";
  }
}

/** Kick off at most one soft collection per blob database and interval. */
export function scheduleConversationSizeMaintenance(
  host: ConversationGcHost,
  dbPath: string,
  db: ConversationGcDatabase,
): void {
  if (!isConversationGcEnabled()) return;
  const blobDbPath = blobDbPathFor(dbPath);
  const state = scheduledByBlobPath.get(blobDbPath) ?? { active: false, lastStartedAtMs: 0 };
  scheduledByBlobPath.set(blobDbPath, state);
  if (state.active || Date.now() - state.lastStartedAtMs < SOFT_GC_MIN_INTERVAL_MS) return;
  state.active = true;

  void (async () => {
    try {
      const sizeBytes = await measureConversationBlobBytes(blobDbPath);
      if (sizeBytes < conversationSoftLimitBytes()) return;
      state.lastStartedAtMs = Date.now();
      const verdict = await runConversationGc(host, dbPath, db);
      reportConversationGcVerdict("soft_schedule", dbPath, verdict);
    } catch (error) {
      reportConversationGcVerdict("soft_schedule", dbPath, { outcome: "failed" });
      reportSessionDiagnostic({
        family: "maintenance",
        kind: "conversation_gc_failed",
        agentId: basename(dirname(dbPath)),
        errorClass: errorKind(error),
      });
    } finally {
      state.active = false;
    }
  })();
}

/** Hold a turn only when a completed GC still leaves the conversation at or above its hard cap. */
export async function ensureConversationCapacityForTurn(
  host: ConversationGcHost,
  dbPath: string,
  db: ConversationGcDatabase,
): Promise<void> {
  if (!isConversationGcEnabled()) return;
  const blobDbPath = blobDbPathFor(dbPath);
  const sizeBeforeGc = await measureConversationBlobBytes(blobDbPath);
  const hardLimit = conversationHardLimitBytes();
  if (sizeBeforeGc < hardLimit) {
    if (sizeBeforeGc >= conversationSoftLimitBytes()) scheduleConversationSizeMaintenance(host, dbPath, db);
    return;
  }

  let verdict: ConversationGcVerdict;
  try {
    verdict = await runConversationGc(host, dbPath, db);
  } catch (error) {
    reportConversationGcVerdict("turn_gate", dbPath, { outcome: "failed" });
    reportSessionDiagnostic({
      family: "maintenance",
      kind: "conversation_gc_failed",
      agentId: basename(dirname(dbPath)),
      errorClass: errorKind(error),
    });
    return;
  }
  if (verdict?.outcome !== "collected") {
    reportConversationGcVerdict("turn_gate", dbPath, verdict);
    return;
  }

  const sizeAfterGc = await measureConversationBlobBytes(blobDbPath);
  const stillOverCap = sizeAfterGc >= hardLimit;
  reportConversationGcVerdict("turn_gate", dbPath, verdict, stillOverCap);
  if (stillOverCap) throw new SlateConversationTooLargeError(sizeAfterGc, hardLimit);
}
