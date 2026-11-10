import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { CONVERSATION_BLOBS_FILENAME } from "./session-paths.ts";
import { GC_PENDING_WRITE_RETENTION_MS } from "./conversation-size-limits-config.ts";
import type {
  ConversationGcDatabase,
  ConversationGcHost,
  ConversationGcReport,
  ConversationGcVerdict,
} from "./conversation-size-limits-contracts.ts";

let gcReportSink: ((report: ConversationGcReport) => void) | null = null;

export function pinConversationGcReporter(reporter: ((report: ConversationGcReport) => void) | null): void {
  gcReportSink = reporter;
}

export function blobDbPathFor(dbPath: string): string {
  return join(dirname(dbPath), CONVERSATION_BLOBS_FILENAME);
}

/** Count the main blob file and the bytes its WAL still holds. */
export async function measureConversationBlobBytes(blobDbPath: string): Promise<number> {
  const files = [blobDbPath, `${blobDbPath}-wal`];
  let totalBytes = 0;
  for (const file of files) totalBytes += await stat(file).then(({ size }) => size, () => 0);
  return totalBytes;
}

function blobIdHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** Record one collector outcome for the session it belongs to. */
export function reportConversationGcVerdict(
  trigger: string,
  dbPath: string,
  verdict: ConversationGcVerdict,
  stillOverCap = false,
): void {
  const agentId = basename(dirname(dbPath));
  if (verdict === null) {
    gcReportSink?.({ trigger, agentId, outcome: "skipped", skipReason: "no-root" });
    return;
  }
  if (verdict.outcome === "failed") {
    gcReportSink?.({ trigger, agentId, outcome: "failed" });
    return;
  }
  if (verdict.outcome === "skipped") {
    gcReportSink?.({
      trigger,
      agentId,
      outcome: "skipped",
      skipReason: verdict.reason,
      ...(verdict.unresolvedProtoRefs === undefined ? {} : { unresolvedProtoRefs: verdict.unresolvedProtoRefs }),
    });
    return;
  }
  gcReportSink?.({
    trigger,
    agentId,
    outcome: "collected",
    deletedRows: verdict.deletedRows,
    deletedBytes: verdict.deletedBytes,
    liveRows: verdict.liveRows,
    liveBytes: verdict.liveBytes,
    vacuumed: verdict.vacuumed,
    stillOverCap,
  });
}

/** Ask the worker pool to collect data that is no longer reachable from the latest root. */
export async function runConversationGc(
  host: ConversationGcHost,
  dbPath: string,
  db: ConversationGcDatabase,
): Promise<ConversationGcVerdict> {
  const retainedRoot = db.get("latestRootBlobId");
  if (retainedRoot.length === 0) return null;
  return await host.requireWorkerPool().collectConversationGarbage({
    agentId: basename(dirname(dbPath)),
    blobDbPath: blobDbPathFor(dbPath),
    retainedRootIdHex: blobIdHex(retainedRoot),
    pendingWriteRetentionMs: GC_PENDING_WRITE_RETENTION_MS,
    legacyBlobDbPath: dbPath,
  });
}
