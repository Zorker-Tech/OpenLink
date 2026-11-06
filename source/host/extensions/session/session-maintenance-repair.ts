/** One-time hidden-entry repair and legacy conversation-blob retirement. */
import { basename, dirname, join } from "node:path";
import { conversationStructureFullyResolves, selectHiddenArtifactEntryIds } from "./conversation-recovery.ts";
import { CONVERSATION_BLOBS_FILENAME } from "./session-paths.ts";
import {
  HIDDEN_ENTRY_REPAIR_VERSION,
  LEGACY_BLOB_RETIREMENT_VERSION,
  isLegacyStoreBlobRetirementEnabled,
  type MaintenanceDb,
  type MaintenanceHost,
  type MaintenanceStore,
} from "./session-maintenance-contracts.ts";
import { blobIdHex, generationAt, openHandles, reportMaintenanceFailure } from "./session-maintenance-common.ts";

export async function repairHiddenTranscriptEntriesOnce(
  host: MaintenanceHost,
  dbPath: string,
  database: MaintenanceDb,
  store: MaintenanceStore,
): Promise<number> {
  if (database.getHiddenEntryRepairVersion() >= HIDDEN_ENTRY_REPAIR_VERSION) return 0;

  try {
    const transcript = database.getTranscriptEntries();
    const hasRecoveredUserMessage = transcript.some(entry =>
      entry.kind === "message"
      && entry.role === "user"
      && typeof entry.id === "string"
      && entry.id.startsWith("recovered-"));
    if (!hasRecoveredUserMessage) {
      database.setHiddenEntryRepairVersion(HIDDEN_ENTRY_REPAIR_VERSION);
      return 0;
    }

    const structure = store.getConversationStateStructure();
    const state = await store.getFullConversation(host.ctx);
    if (state.turns.length === 0 || state.turns.length < structure.turnBlobIds.length) return 0;
    if (!await conversationStructureFullyResolves(host.ctx, structure, store.getBlobStore())) return 0;

    const outline = host.deriveOutline?.(state) ?? state.turns.flatMap(turn => turn.items);
    const hiddenIds = selectHiddenArtifactEntryIds(transcript, outline);
    for (const id of hiddenIds) if (!database.deleteTranscriptEntry(id)) return 0;
    database.setHiddenEntryRepairVersion(HIDDEN_ENTRY_REPAIR_VERSION);
    return hiddenIds.length;
  } catch (error) {
    reportMaintenanceFailure(host, "hidden_repair_failed", dbPath, error);
    return 0;
  }
}

export async function retireLegacyStoreBlobsOnce(
  host: MaintenanceHost,
  dbPath: string,
  database: MaintenanceDb,
  store: MaintenanceStore,
): Promise<boolean> {
  if (!isLegacyStoreBlobRetirementEnabled() || database.getLegacyBlobRetirementVersion() >= LEGACY_BLOB_RETIREMENT_VERSION) return false;

  try {
    if (!database.hasLegacyConversationBlobs()) return database.retireLegacyConversationBlobs(LEGACY_BLOB_RETIREMENT_VERSION);
    const root = database.get("latestRootBlobId");
    if (!(root instanceof Uint8Array) || root.length === 0) return false;
    if (store.getConversationStateStructure().turnBlobIds.length === 0 || openHandles(host, dbPath) > 1) return false;

    const startingGeneration = generationAt(host, dbPath);
    const result = await host.requireWorkerPool().verifyLegacyBlobRetirement({
      agentId: basename(dirname(dbPath)),
      blobDbPath: join(dirname(dbPath), CONVERSATION_BLOBS_FILENAME),
      legacyBlobDbPath: dbPath,
      retainedRootIdHex: blobIdHex(root),
    });
    if (!result.isRetirable || generationAt(host, dbPath) !== startingGeneration) return false;
    if (blobIdHex(database.get("latestRootBlobId") as Uint8Array) !== blobIdHex(root) || openHandles(host, dbPath) > 1) return false;
    return database.retireLegacyConversationBlobs(LEGACY_BLOB_RETIREMENT_VERSION);
  } catch (error) {
    reportMaintenanceFailure(host, "blob_retirement_failed", dbPath, error);
    return false;
  }
}
