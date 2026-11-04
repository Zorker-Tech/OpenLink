/** Whether a conversation's old blob database can be let go of.

 * The old file may only be retired once the conversation has been adopted, is healthy, knows where its retained root
 * is, and the old file can actually be read — so what is retired is counted rather than assumed. */
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { readConversationBlobMigrationState } from "./conversation-blob-db.ts";

export type LegacyBlobRetirementVerdict =
  | { isRetirable: false; reason: string; legacyRows: 0; legacyBytes: 0 }
  | { isRetirable: true; legacyRows: number; legacyBytes: number };

interface RetirementCheckOptions {
  readonly db: DatabaseSync;
  readonly legacyBlobDbPath: string;
  readonly retainedRootIdHex: string;
}

function defer(reason: string): LegacyBlobRetirementVerdict {
  return { isRetirable: false, reason, legacyRows: 0, legacyBytes: 0 };
}

function destinationIsHealthy(db: DatabaseSync): boolean {
  try {
    const result = db.prepare("PRAGMA quick_check").get() as { quick_check?: unknown } | undefined;
    return result?.quick_check === "ok";
  } catch {
    return false;
  }
}

function migrationHoldReason(db: DatabaseSync): string | undefined {
  const state = readConversationBlobMigrationState(db);
  if (state === "adoption-complete") return undefined;
  if (state === "unstarted") return "adoption-incomplete";
  if (state === "recovery-rebuilt") return "recovery-rebuilt";
  return "migration-state-unknown";
}

function retainedRootIsPresent(db: DatabaseSync, rootId: string): boolean {
  return db.prepare("SELECT 1 AS present FROM blobs WHERE id = ?").get(rootId) != null;
}

function countLegacyContents(db: DatabaseSync, legacyPath: string): LegacyBlobRetirementVerdict {
  let attached = false;
  try {
    db.prepare("ATTACH DATABASE ? AS legacy").run(legacyPath);
    attached = true;
    const counts = db.prepare(
      "SELECT count(*) AS rows, coalesce(sum(length(data)), 0) AS bytes FROM legacy.blobs",
    ).get() as { rows?: unknown; bytes?: unknown } | undefined;
    return {
      isRetirable: true,
      legacyRows: Number(counts?.rows ?? 0),
      legacyBytes: Number(counts?.bytes ?? 0),
    };
  } catch {
    return defer("legacy-unreadable");
  } finally {
    if (attached) {
      try {
        db.exec("DETACH DATABASE legacy");
      } catch {
        // The destination remains open for its caller even if detaching failed.
      }
    }
  }
}

export function verifyLegacyBlobRetirement(
  options: RetirementCheckOptions,
): LegacyBlobRetirementVerdict {
  if (!existsSync(options.legacyBlobDbPath)) return defer("legacy-unreadable");
  if (!destinationIsHealthy(options.db)) return defer("destination-unhealthy");

  const holdReason = migrationHoldReason(options.db);
  if (holdReason !== undefined) return defer(holdReason);
  if (!retainedRootIsPresent(options.db, options.retainedRootIdHex)) return defer("root-missing");

  return countLegacyContents(options.db, options.legacyBlobDbPath);
}
