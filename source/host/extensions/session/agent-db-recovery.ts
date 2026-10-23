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
  const store = new DatabaseSync(dbPath);
  try {
    store.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? DB_BUSY_TIMEOUT_MS}`);
    try {
      store.exec("PRAGMA journal_mode = WAL");
      store.exec("PRAGMA synchronous = NORMAL");
    } catch (failure) {
      reportSessionDiagnostic({
        family: "store_db",
        kind: "wal_unavailable",
        agentId: agentDirName,
        errorClass: errorLogTag(failure),
      });
    }
    store.exec(SCHEMA);
    return store;
  } catch (failure) {
    try { store.close(); } catch {}
    throw failure;
  }
}
export function isStoreDbHealthy(store: Pick<DatabaseSync, "prepare">): boolean {
  try {
    const checkRow = store.prepare("PRAGMA quick_check").get();
    return checkRow?.quick_check === "ok";
  } catch {
    return false;
  }
}
export function openConfiguredDb(
  dbPath: string,
  agentDirName: string,
  options: DbRecoveryOptions,
  hasOtherLiveHandles?: boolean,
  openDatabase: typeof initConfiguredDb = initConfiguredDb,
): DatabaseSync {
  const mayRecover = (options.recoverOnCorruption ?? true) && !hasOtherLiveHandles;
  const refuseIfCorrupt = options.rejectIfCorrupt ?? false;
  let store: DatabaseSync | undefined;
  let openFailure: unknown;
  for (let tryIndex = 0; tryIndex < 2 && store === undefined; tryIndex += 1) {
    try {
      store = openDatabase(dbPath, agentDirName, options);
    } catch (failure) {
      openFailure = failure;
      if (!isSqliteIoError(failure) || tryIndex > 0) break;
      reportSessionDiagnostic({
        family: "store_db",
        kind: "open_io_retry",
        agentId: agentDirName,
        errorClass: errorLogTag(failure),
      });
    }
  }
  if (store === undefined) {
    if (mayRecover && isSqliteCorruptError(openFailure)) {
      return recoverCorruptStoreDb(dbPath, agentDirName, options, openFailure);
    }
    throw openFailure;
  }
  const shouldVerify = (mayRecover || refuseIfCorrupt) && (options.verifyIntegrityOnOpen ?? true);
  if (shouldVerify && !isStoreDbHealthy(store)) {
    try { store.close(); } catch {}
    if (mayRecover) {
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
  return store;
}
export function quarantineCorruptDb(dbPath: string, agentDirName: string): string | null {
  const quarantineResult = quarantineCorruptSqliteDb({ dbPath });
  if (quarantineResult.renameErrorCode == null) return quarantineResult.quarantinePath;
  if (quarantineResult.quarantinePath == null) {
    reportSessionDiagnostic({
      family: "store_db",
      kind: "quarantine_rename_failed",
      agentId: agentDirName,
      errorClass: quarantineResult.renameErrorCode,
    });
    return null;
  }
  reportSessionDiagnostic({
    family: "store_db",
    kind: "quarantine_copied",
    agentId: agentDirName,
    errorClass: quarantineResult.renameErrorCode,
  });
  return quarantineResult.quarantinePath;
}
function columnValue(checkRow: unknown, columnName: string): unknown {
  return typeof checkRow === "object" && checkRow != null ? Reflect.get(checkRow, columnName) : undefined;
}
export function salvageStoreDb(sourcePath: string, rebuiltDb: DatabaseSync): SalvageCounts {
  const salvageCounts = { kv: 0, blobs: 0, transcript: 0 };
  const salvagedDb = openSqliteForSalvage({ dbPath: sourcePath });
  if (salvagedDb == null) return salvageCounts;
  try {
    salvageCounts.kv = copySalvageableSqliteRows(
      salvagedDb,
      "SELECT key, value FROM kv",
      rebuiltDb.prepare("INSERT OR IGNORE INTO kv (key, value) VALUES (?, ?)"),
      (checkRow) => [columnValue(checkRow, "key"), columnValue(checkRow, "value")],
    );
    salvageCounts.blobs = copySalvageableSqliteRows(
      salvagedDb,
      "SELECT id, data FROM blobs",
      rebuiltDb.prepare("INSERT OR IGNORE INTO blobs (id, data) VALUES (?, ?)"),
      (checkRow) => [columnValue(checkRow, "id"), columnValue(checkRow, "data")],
    );
    salvageCounts.transcript = copySalvageableSqliteRows(
      salvagedDb,
      "SELECT seq, id, entry FROM transcript_entries",
      rebuiltDb.prepare("INSERT OR IGNORE INTO transcript_entries (seq, id, entry) VALUES (?, ?, ?)"),
      (checkRow) => [columnValue(checkRow, "seq"), columnValue(checkRow, "id"), columnValue(checkRow, "entry")],
    );
  } finally {
    try { salvagedDb.close(); } catch {}
  }
  return salvageCounts;
}
export function recoverCorruptStoreDb(
  dbPath: string,
  agentDirName: string,
  options: DbRecoveryOptions,
  reason: unknown,
): DatabaseSync {
  reportSessionDiagnostic({
    family: "store_db",
    kind: "corrupt_recovering",
    agentId: agentDirName,
    errorClass: errorLogTag(reason),
  });
  const quarantinePath = quarantineCorruptDb(dbPath, agentDirName);
  const rebuiltDb = initConfiguredDb(dbPath, agentDirName, options);
  const salvaged = quarantinePath != null
    ? salvageStoreDb(quarantinePath, rebuiltDb)
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
  return rebuiltDb;
}
