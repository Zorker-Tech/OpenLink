/**
 * Taking a consistent copy of a store database.
 *
 * The copy is made by the database itself rather than by reading the file, so a snapshot is a database and not half a
 * write; one that cannot be made says what the database answered rather than being reported as a plain failure.
 */
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { brandedErrno } from "../../../shared/errors/bounded-values.ts";
import { findSystemErrno } from "../../../shared/system-errno.ts";
import { DB_BUSY_TIMEOUT_MS, SQLITE_DB_SIDECAR_SUFFIXES } from "../../storage/store-db.ts";
import {
  isSqliteBusyError,
  isSqliteCantOpenError,
  isSqliteCorruptError,
  isSqliteIoError,
} from "../../storage/sqlite-busy.ts";

export const LOCKED_DB_COPY_ATTEMPTS = 3;

export type SqliteSnapshotOperation =
  | "prepare_staged"
  | "read_source_main"
  | "write_staged_main"
  | "copy_source_sidecars"
  | "verify_source_stability"
  | "open_staged"
  | "checkpoint_staged"
  | "set_staged_journal_mode"
  | "quick_check_staged"
  | "close_staged"
  | "cleanup_staged"
  | "vacuum_into";

export type SqliteSnapshotPathStage =
  | "source_main"
  | "staged_main"
  | "staged_sidecars"
  | "source_and_staged_sidecars"
  | "source_or_staged_main";

export interface SqliteSnapshotFailure {
  readonly operation: SqliteSnapshotOperation;
  readonly pathStage: SqliteSnapshotPathStage;
  readonly cause: string;
  readonly errorClass: string;
  readonly errno?: string;
  readonly sqliteCode?: number;
}

export function sqliteVacuumInto(
  srcPath: string,
  destPath: string,
  busyTimeoutMs = DB_BUSY_TIMEOUT_MS,
): void {
  const database = new DatabaseSync(srcPath, { readOnly: true });
  try {
    database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    database.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
  } finally {
    database.close();
  }
}

function readErrcode(failure: unknown): number | undefined {
  if (typeof failure !== "object" || failure == null || !("errcode" in failure)) return undefined;
  const rawCandidate = failure.errcode;
  return typeof rawCandidate === "number" && Number.isSafeInteger(rawCandidate) && rawCandidate >= 0
    ? rawCandidate
    : undefined;
}

export function classifySqliteSnapshotFailure(
  failure: unknown,
  operation: SqliteSnapshotOperation,
  pathStage: SqliteSnapshotPathStage,
): SqliteSnapshotFailure {
  const sqliteCode = readErrcode(failure);
  const errnoName = sqliteCode === undefined ? findSystemErrno(failure) : undefined;
  const errno = brandedErrno(errnoName);
  const primaryCode = sqliteCode === undefined ? undefined : sqliteCode & 0xff;
  const capacityFailure = errnoName === "ENOSPC"
    || errnoName === "EDQUOT"
    || primaryCode === 13;
  let finalPathStage = pathStage;
  if (operation === "vacuum_into" && capacityFailure) finalPathStage = "staged_main";
  else if (operation === "copy_source_sidecars" && capacityFailure) finalPathStage = "staged_sidecars";
  else if (operation === "vacuum_into" && (isSqliteBusyError(failure) || isSqliteCorruptError(failure))) {
    finalPathStage = "source_main";
  }

  let errorClass = "unknown";
  if (failure instanceof TypeError) errorClass = "TypeError";
  else if (failure instanceof RangeError) errorClass = "RangeError";
  else if (failure instanceof Error) errorClass = "Error";

  let cause = "unknown";
  if (isSqliteBusyError(failure)) cause = "busy";
  else if (isSqliteIoError(failure)) cause = "io";
  else if (isSqliteCorruptError(failure)) cause = "corrupt";
  else if (isSqliteCantOpenError(failure)) cause = "cant_open";
  else if (sqliteCode !== undefined) cause = "sqlite";
  else if (errno !== undefined) cause = "system";
  else if (failure instanceof Error) cause = "error";

  return {
    operation,
    pathStage: finalPathStage,
    cause,
    errorClass,
    ...(errno === undefined ? {} : { errno }),
    ...(sqliteCode === undefined ? {} : { sqliteCode }),
  };
}

function isQuickCheckOk(checkRow: unknown): boolean {
  return typeof checkRow === "object" && checkRow != null && "quick_check" in checkRow && checkRow.quick_check === "ok";
}

export function copyLockedSqliteDb(request: {
  srcPath: string;
  destPath: string;
  readFile?(path: string): Buffer;
  onFailure?(failure: SqliteSnapshotFailure): void;
}): boolean {
  const { srcPath, destPath } = request;
  const readFile = request.readFile ?? readFileSync;
  let previousFailure: SqliteSnapshotFailure = {
    operation: "prepare_staged",
    pathStage: "staged_main",
    cause: "unknown",
    errorClass: "unknown",
  };

  for (let tryNumber = 1; tryNumber <= LOCKED_DB_COPY_ATTEMPTS; tryNumber += 1) {
    let isVerified = false;
    let tryFailure: SqliteSnapshotFailure | undefined;
    let database: DatabaseSync | undefined;
    let operation: SqliteSnapshotOperation = "prepare_staged";
    let pathStage: SqliteSnapshotPathStage = "staged_main";
    try {
      rmSync(destPath, { force: true });
      pathStage = "staged_sidecars";
      for (const suffix of SQLITE_DB_SIDECAR_SUFFIXES) rmSync(`${destPath}${suffix}`, { force: true });
      operation = "read_source_main";
      pathStage = "source_main";
      const sourceBytes = readFile(srcPath);
      operation = "write_staged_main";
      pathStage = "staged_main";
      writeFileSync(destPath, sourceBytes);
      operation = "copy_source_sidecars";
      pathStage = "source_and_staged_sidecars";
      for (const suffix of SQLITE_DB_SIDECAR_SUFFIXES) {
        const sidecarPath = `${srcPath}${suffix}`;
        if (existsSync(sidecarPath)) copyFileSync(sidecarPath, `${destPath}${suffix}`);
      }
      operation = "verify_source_stability";
      pathStage = "source_main";
      if (!readFile(srcPath).equals(sourceBytes)) {
        tryFailure = {
          operation,
          pathStage,
          cause: "source_changed",
          errorClass: "none",
        };
      } else {
        operation = "open_staged";
        pathStage = "staged_main";
        database = new DatabaseSync(destPath);
        operation = "checkpoint_staged";
        database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        operation = "set_staged_journal_mode";
        database.exec("PRAGMA journal_mode=DELETE");
        operation = "quick_check_staged";
        isVerified = isQuickCheckOk(database.prepare("PRAGMA quick_check").get());
        if (!isVerified) {
          tryFailure = {
            operation,
            pathStage,
            cause: "quick_check_failed",
            errorClass: "none",
          };
        }
      }
    } catch (failure) {
      tryFailure = classifySqliteSnapshotFailure(failure, operation, pathStage);
      isVerified = false;
    } finally {
      try {
        database?.close();
      } catch (failure) {
        isVerified = false;
        tryFailure ??= classifySqliteSnapshotFailure(failure, "close_staged", "staged_main");
      }
      for (const suffix of SQLITE_DB_SIDECAR_SUFFIXES) {
        try {
          rmSync(`${destPath}${suffix}`, { force: true });
        } catch (failure) {
          isVerified = false;
          tryFailure ??= classifySqliteSnapshotFailure(failure, "cleanup_staged", "staged_sidecars");
        }
      }
      if (!isVerified) {
        try {
          rmSync(destPath, { force: true });
        } catch (failure) {
          tryFailure ??= classifySqliteSnapshotFailure(failure, "cleanup_staged", "staged_main");
        }
      }
    }
    if (isVerified && tryFailure === undefined) return true;
    if (tryFailure !== undefined) previousFailure = tryFailure;
  }
  request.onFailure?.(previousFailure);
  return false;
}
