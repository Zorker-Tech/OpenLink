import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { CONVERSATION_BLOB_ADOPTION_COMPLETE, readConversationBlobMigrationState } from "./conversation-blob-db.ts";

/** Import rows from an older store only while the new store says adoption has not completed. */
export function adoptLegacyConversationBlobs(db: DatabaseSync, legacyPath: string, log: (message: string) => void): void {
  const migrationState = readConversationBlobMigrationState(db);
  if (!(["unstarted", "recovery-rebuilt"] as const).includes(migrationState as "unstarted" | "recovery-rebuilt") || !existsSync(legacyPath)) return;

  try {
    db.prepare("ATTACH DATABASE ? AS legacy").run(legacyPath);
    try {
      db.exec("INSERT OR IGNORE INTO blobs (id, data) SELECT id, data FROM legacy.blobs");
    } finally {
      db.exec("DETACH DATABASE legacy");
    }
  } catch (error) {
    log(`[agent-store-worker] legacy blob adoption failed: ${String(error)}`);
    return;
  }

  db.exec(`PRAGMA user_version = ${CONVERSATION_BLOB_ADOPTION_COMPLETE}`);
}
