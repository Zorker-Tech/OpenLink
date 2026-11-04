import type { DatabaseSync, StatementSync } from "node:sqlite";
import { collectReachableBlobHexIds } from "../../../adapters/interop/agent/conversation-blob-reachability-adapter.ts";
import type {
  ConversationBlobGarbageCollectionOptions,
  ConversationBlobGarbageCollectionResult,
  ConversationBlobIndexRow,
} from "./conversation-blob-store-contracts.ts";

const VACUUM_MIN_DELETED_BYTES = 64 * 1024 * 1024;
const VACUUM_MIN_DELETED_SHARE = 1 / 8;

function readBlob(getBlob: StatementSync, id: string): Uint8Array | undefined {
  const value = (getBlob.get(id) as { data?: unknown } | undefined)?.data;
  return value instanceof Uint8Array ? value : undefined;
}

function isPendingRecentWrite(id: string, history: ReadonlyMap<string, number>, cutoff: number): boolean {
  const lastWriteAt = history.get(id);
  return lastWriteAt != null && lastWriteAt > cutoff;
}

export function collectConversationBlobs(args: {
  readonly isClosed: boolean;
  readonly db: DatabaseSync;
  readonly getBlob: StatementSync;
  readonly scanBlobIndex: StatementSync;
  readonly recentWriteAtMsById: ReadonlyMap<string, number>;
} & ConversationBlobGarbageCollectionOptions): ConversationBlobGarbageCollectionResult {
  if (args.isClosed) return { outcome: "skipped", reason: "no-root" };
  const root = readBlob(args.getBlob, args.retainedRootIdHex);
  if (root === undefined) return { outcome: "skipped", reason: "no-root" };

  let reachable;
  try {
    reachable = collectReachableBlobHexIds({
      rootBytes: root,
      getBlobByHexId: (id) => readBlob(args.getBlob, id),
    });
  } catch {
    return { outcome: "skipped", reason: "root-undecodable" };
  }
  if (reachable.unresolvedProtoRefs > 0) {
    return { outcome: "skipped", reason: "unresolved-refs", unresolvedProtoRefs: reachable.unresolvedProtoRefs };
  }

  const cutoff = Date.now() - args.pendingWriteRetentionMs;
  const removableIds: string[] = [];
  let liveRows = 0;
  let retainedPendingRows = 0;
  let deletedBytes = 0;
  let liveBytes = 0;
  for (const rawRow of args.scanBlobIndex.iterate()) {
    const row = rawRow as ConversationBlobIndexRow;
    if (typeof row.id !== "string" || typeof row.len !== "number") continue;
    if (row.id === args.retainedRootIdHex || reachable.reachableHexIds.has(row.id)) {
      liveRows += 1;
      liveBytes += row.len;
      continue;
    }
    if (isPendingRecentWrite(row.id, args.recentWriteAtMsById, cutoff)) {
      retainedPendingRows += 1;
      liveRows += 1;
      liveBytes += row.len;
      continue;
    }
    removableIds.push(row.id);
    deletedBytes += row.len;
  }

  removeIndexedBlobs(args.db, removableIds);
  const shouldVacuum = deletedBytes >= VACUUM_MIN_DELETED_BYTES
    || (deletedBytes > 0 && deletedBytes >= (deletedBytes + liveBytes) * VACUUM_MIN_DELETED_SHARE);
  if (shouldVacuum) args.db.exec("VACUUM");
  args.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  return {
    outcome: "collected",
    deletedRows: removableIds.length,
    deletedBytes,
    liveRows,
    liveBytes,
    retainedPendingRows,
    vacuumed: shouldVacuum,
  };
}

function removeIndexedBlobs(db: DatabaseSync, ids: readonly string[]): void {
  if (ids.length === 0) return;
  const removeBlob = db.prepare("DELETE FROM blobs WHERE id = ?");
  let transactionOpen = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    for (const id of ids) removeBlob.run(id);
    db.exec("COMMIT");
  } catch (error) {
    if (transactionOpen) db.exec("ROLLBACK");
    throw error;
  }
}
