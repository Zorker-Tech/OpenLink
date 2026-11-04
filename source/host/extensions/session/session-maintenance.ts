/** Stable maintenance API for transcript, checkpoint and legacy-store repairs. */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { decodeInteropAgentConversationCheckpoint } from "../../../adapters/interop/agent/agent-conversation-protobuf-adapter.ts";
import { getSlateProfilePath, readSlateProfileFile } from "../../agents/agent-profile.ts";
import { CONVERSATION_BLOBS_FILENAME } from "./session-paths.ts";
import { ConversationRecoveryScanError } from "./session-recovery.ts";
import type { MaintenanceDb, MaintenanceHost, MaintenanceStore } from "./session-maintenance-contracts.ts";
import { backfillTranscript } from "./session-maintenance-transcript.ts";
import { findLatestDurableRootBlobId } from "./session-maintenance-checkpoint.ts";
import { blobIdHex, generationAt, reportMaintenanceFailure } from "./session-maintenance-common.ts";

export * from "./session-maintenance-contracts.ts";
export * from "./session-maintenance-checkpoint.ts";
export * from "./session-maintenance-repair.ts";
export * from "./session-maintenance-transcript.ts";
export type { OutlineItem } from "./conversation-recovery.ts";

export async function recoverConversationIfRootMissing(
  host: MaintenanceHost,
  dbPath: string,
  database: MaintenanceDb,
  store: MaintenanceStore,
): Promise<boolean> {
  const existingRoot = database.get("latestRootBlobId");
  if (!(existingRoot instanceof Uint8Array) || existingRoot.length > 0) return false;
  const blobDatabasePath = join(dirname(dbPath), CONVERSATION_BLOBS_FILENAME);
  const scanGeneration = generationAt(host, dbPath);

  try {
    if (!existsSync(blobDatabasePath) && !database.hasLegacyConversationBlobs()) return false;
    const rootId = await findLatestDurableRootBlobId(host, { dbPath, blobsPath: blobDatabasePath });
    if (rootId === null) return false;
    const blob = await store.getBlobStore().getBlob(host.ctx, rootId);
    if (blob === null) return false;

    const structure = decodeInteropAgentConversationCheckpoint(blob);
    const state = await host.resolveConversationState(structure, store.getBlobStore());
    if (state === null || generationAt(host, dbPath) !== scanGeneration) return false;
    if (!database.compareAndSetLatestRootBlobId({ expectedRoot: existingRoot, nextRoot: rootId })) {
      await store.resetFromDb(host.ctx);
      return false;
    }

    await store.resetFromDb(host.ctx);
    const currentRoot = database.get("latestRootBlobId") as Uint8Array;
    if (blobIdHex(currentRoot) !== blobIdHex(rootId)) return false;

    const profile = readSlateProfileFile(getSlateProfilePath(dirname(dbPath)))?.name.trim();
    if (profile != null && profile.length > 0 && database.get("name") !== profile) database.set("name", profile);
    backfillTranscript(host, database, state);
    return true;
  } catch (error) {
    const failureKind = error instanceof ConversationRecoveryScanError ? "recovery_scan_failed" : "recovery_failed";
    reportMaintenanceFailure(host, failureKind, dbPath, error);
    if (error instanceof ConversationRecoveryScanError) throw error;
    return false;
  }
}
