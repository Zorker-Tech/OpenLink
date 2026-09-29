/**
 * Recovering an agent's database.
 *
 * A database that cannot be opened is copied aside and rebuilt from what could be read, and what was recovered is
 * published so the rest of the host sees the repair rather than reading a half-open store.
 */
import { DatabaseSync } from "node:sqlite";
import { errorLogTag } from "../../../shared/errors/summary.ts";
import { publishTranscriptMutation } from "../../transcript/transcript-mutation-events.ts";
import { isSqliteCorruptError, isSqliteIoError } from "../../storage/sqlite-busy.ts";
import {
  copySalvageableSqliteRows,
  openSqliteForSalvage,
  quarantineCorruptSqliteDb,
} from "../../storage/sqlite-recovery.ts";
import { DB_BUSY_TIMEOUT_MS } from "../../storage/store-db.ts";
import { SCHEMA } from "./agent-db-schema.ts";
import { reportSessionDiagnostic } from "./session-diagnostics.ts";

export interface DbRecoveryOptions {
  recoverOnCorruption?: boolean;
  rejectIfCorrupt?: boolean;
  verifyIntegrityOnOpen?: boolean;
  busyTimeoutMs?: number;
  onCorruptionRecovered?(event: { outcome: "recovered" | "reset"; quarantinePath: string | null; salvaged: SalvageCounts }): void;
}
export interface SalvageCounts { kv: number; blobs: number; transcript: number }
export class SlateAgentDbIntegrityError extends Error {}

export function initConfiguredDb(dbPath: string, agentDirName: string, options: DbRecoveryOptions): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? DB_BUSY_TIMEOUT_MS}`);
    try {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
    } catch (error) {
      reportSessionDiagnostic({
        family: "store_db",
        kind: "wal_unavailable",
        agentId: agentDirName,
        errorClass: errorLogTag(error),
      });
    }
    db.exec(SCHEMA);
    return db;
  } catch (error) {
    try { db.close(); } catch {}
    throw error;
  }
}
export function isStoreDbHealthy(db: Pick<DatabaseSync, "prepare">): boolean {
  try {
    const row = db.prepare("PRAGMA quick_check").get();
    return row?.quick_check === "ok";
  } catch {
    return false;
  }
}
export function openConfiguredDb(
  dbPath: string,
  agentDirName: string,
  options: DbRecoveryOptions,
  hasOtherLiveHandles?: boolean,
  initDb: typeof initConfiguredDb = initConfiguredDb,
): DatabaseSync {
  const recover = (options.recoverOnCorruption ?? true) && !hasOtherLiveHandles;
  const rejectIfCorrupt = options.rejectIfCorrupt ?? false;
  let db: DatabaseSync | undefined;
  let openError: unknown;
  for (let attempt = 0; attempt < 2 && db === undefined; attempt += 1) {
    try {
      db = initDb(dbPath, agentDirName, options);
    } catch (error) {
      openError = error;
      if (!isSqliteIoError(error) || attempt > 0) break;
      reportSessionDiagnostic({
        family: "store_db",
        kind: "open_io_retry",
        agentId: agentDirName,
        errorClass: errorLogTag(error),
      });
    }
  }
  if (db === undefined) {
    if (recover && isSqliteCorruptError(openError)) {
      return recoverCorruptStoreDb(dbPath, agentDirName, options, openError);
    }
    throw openError;
  }
  const verify = (recover || rejectIfCorrupt) && (options.verifyIntegrityOnOpen ?? true);
  if (verify && !isStoreDbHealthy(db)) {
    try { db.close(); } catch {}
    if (recover) {
      reportSessionDiagnostic({ family: "store_db", kind: "quick_check_failed", agentId: agentDirName });
      return recoverCorruptStoreDb(
        dbPath,
        agentDirName,
        options,
        new Error("PRAGMA quick_check failed"),
      );
    }
    throw new SlateAgentDbIntegrityError(`store.db failed integrity check for ${agentDirName}`);
  }
  return db;
}
export function quarantineCorruptDb(dbPath: string, agentDirName: string): string | null {
  const result = quarantineCorruptSqliteDb({ dbPath });
  if (result.renameErrorCode == null) return result.quarantinePath;
  if (result.quarantinePath == null) {
    reportSessionDiagnostic({
      family: "store_db",
      kind: "quarantine_rename_failed",
      agentId: agentDirName,
      errorClass: result.renameErrorCode,
    });
    return null;
  }
  reportSessionDiagnostic({
    family: "store_db",
    kind: "quarantine_copied",
    agentId: agentDirName,
    errorClass: result.renameErrorCode,
  });
  return result.quarantinePath;
}
function rowValue(row: unknown, key: string): unknown {
  return typeof row === "object" && row != null ? Reflect.get(row, key) : undefined;
}
export function salvageStoreDb(sourcePath: string, freshDb: DatabaseSync): SalvageCounts {
  const counts = { kv: 0, blobs: 0, transcript: 0 };
  const source = openSqliteForSalvage({ dbPath: sourcePath });
  if (source == null) return counts;
  try {
    counts.kv = copySalvageableSqliteRows(
      source,
      "SELECT key, value FROM kv",
      freshDb.prepare("INSERT OR IGNORE INTO kv (key, value) VALUES (?, ?)"),
      (row) => [rowValue(row, "key"), rowValue(row, "value")],
    );
    counts.blobs = copySalvageableSqliteRows(
      source,
      "SELECT id, data FROM blobs",
      freshDb.prepare("INSERT OR IGNORE INTO blobs (id, data) VALUES (?, ?)"),
      (row) => [rowValue(row, "id"), rowValue(row, "data")],
    );
    counts.transcript = copySalvageableSqliteRows(
      source,
      "SELECT seq, id, entry FROM transcript_entries",
      freshDb.prepare("INSERT OR IGNORE INTO transcript_entries (seq, id, entry) VALUES (?, ?, ?)"),
      (row) => [rowValue(row, "seq"), rowValue(row, "id"), rowValue(row, "entry")],
    );
  } finally {
    try { source.close(); } catch {}
  }
  return counts;
}
export function recoverCorruptStoreDb(
  dbPath: string,
  agentDirName: string,
  options: DbRecoveryOptions,
  cause: unknown,
): DatabaseSync {
  reportSessionDiagnostic({
    family: "store_db",
    kind: "corrupt_recovering",
    agentId: agentDirName,
    errorClass: errorLogTag(cause),
  });
  const quarantinePath = quarantineCorruptDb(dbPath, agentDirName);
  const freshDb = initConfiguredDb(dbPath, agentDirName, options);
  const salvaged = quarantinePath != null
    ? salvageStoreDb(quarantinePath, freshDb)
    : { kv: 0, blobs: 0, transcript: 0 };
  const outcome = salvaged.kv + salvaged.blobs + salvaged.transcript > 0 ? "recovered" : "reset";
  reportSessionDiagnostic({
    family: "store_db",
    kind: "recovery_outcome",
    agentId: agentDirName,
    outcome,
    quarantine: quarantinePath != null ? "preserved" : "none",
    salvagedKv: salvaged.kv,
    salvagedBlobs: salvaged.blobs,
    salvagedTranscript: salvaged.transcript,
  });
  try { options.onCorruptionRecovered?.({ outcome, quarantinePath, salvaged }); } catch {}
  publishTranscriptMutation({ kind: "agent-needs-reindex", agentId: agentDirName });
  return freshDb;
}
