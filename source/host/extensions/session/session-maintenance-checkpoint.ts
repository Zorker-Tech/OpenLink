/** One-time removal of obsolete checkpoint roots and lookup of recoverable roots. */
import { dirname, join, basename } from "node:path";
import { ConversationRecoveryScanError } from "./session-recovery.ts";
import { CONVERSATION_BLOBS_FILENAME } from "./session-paths.ts";
import { STALE_ROOT_CLEANUP_VERSION, isStaleRootGcEnabled, type MaintenanceDb, type MaintenanceHost, type MaintenanceStore } from "./session-maintenance-contracts.ts";
import { blobIdHex, generationAt, openHandles, reportMaintenanceFailure } from "./session-maintenance-common.ts";

export async function clearStaleCheckpointRootsOnce(
  host: MaintenanceHost,
  dbPath: string,
  database: MaintenanceDb,
  store: MaintenanceStore,
): Promise<boolean> {
  if (!isStaleRootGcEnabled() || database.getStaleRootCleanupVersion() >= STALE_ROOT_CLEANUP_VERSION) return false;

  try {
    const rootId = database.get("latestRootBlobId");
    if (!(rootId instanceof Uint8Array) || rootId.length === 0) return false;
    if (store.getConversationStateStructure().turns.length === 0 || openHandles(host, dbPath) > 1) return false;

    const initialGeneration = generationAt(host, dbPath);
    await host.requireWorkerPool().clearStaleCheckpointRoots(
      basename(dirname(dbPath)),
      join(dirname(dbPath), CONVERSATION_BLOBS_FILENAME),
      blobIdHex(rootId),
      dbPath,
    );
    if (generationAt(host, dbPath) !== initialGeneration) return false;
    const currentRoot = database.get("latestRootBlobId");
    if (!(currentRoot instanceof Uint8Array) || blobIdHex(currentRoot) !== blobIdHex(rootId)) return false;
    if (openHandles(host, dbPath) > 1) return false;
    return database.setStaleRootCleanupVersion(STALE_ROOT_CLEANUP_VERSION);
  } catch (error) {
    reportMaintenanceFailure(host, "checkpoint_cleanup_failed", dbPath, error);
    return false;
  }
}

export async function findLatestDurableRootBlobId(
  host: MaintenanceHost,
  args: { dbPath: string; blobsPath: string },
): Promise<Uint8Array | null> {
  try {
    return await host.requireWorkerPool().findLatestRootBlobId({
      agentId: basename(dirname(args.dbPath)),
      blobDbPath: args.blobsPath,
      legacyBlobDbPath: args.dbPath,
    });
  } catch (error) {
    throw new ConversationRecoveryScanError(error instanceof Error ? error.name : String(error));
  }
}
