import { copyFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { removeSqliteDb, removeSqliteSidecars } from "./sqlite-recovery-files.ts";
import { SQLITE_DB_SIDECAR_SUFFIXES } from "./store-db.ts";

export interface SqliteQuarantineOptions {
  readonly dbPath: string;
  readonly quarantinePath?: string;
  readonly preserveSourceOnCopyFailure?: boolean;
  readonly removeAttempts?: number;
  readonly removeRetryDelayMs?: number;
}

export interface SqliteQuarantineResult {
  readonly quarantinePath: string | null;
  readonly copied: boolean;
  readonly renameErrorCode: string | null;
}

function defaultQuarantinePath(dbPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${dbPath}.corrupt-${stamp}`;
}

function copyAvailableSidecars(dbPath: string, quarantinePath: string): void {
  for (const suffix of SQLITE_DB_SIDECAR_SUFFIXES) {
    const source = `${dbPath}${suffix}`;
    if (!existsSync(source)) continue;
    try {
      copyFileSync(source, `${quarantinePath}${suffix}`);
    } catch {
      // The main database copy remains useful even when a sidecar could not be copied.
    }
  }
}

function copyDatabase(dbPath: string, quarantinePath: string): boolean {
  try {
    copyFileSync(dbPath, quarantinePath);
    copyAvailableSidecars(dbPath, quarantinePath);
    return true;
  } catch {
    return false;
  }
}

function clearOldQuarantine(quarantinePath: string): void {
  try {
    rmSync(quarantinePath, { force: true });
  } catch {
    // A stale quarantine can be absent or held by the previous recovery attempt.
  }
  removeSqliteSidecars(quarantinePath);
}

function renameAvailableSidecars(dbPath: string, quarantinePath: string): void {
  for (const suffix of SQLITE_DB_SIDECAR_SUFFIXES) {
    const source = `${dbPath}${suffix}`;
    try {
      if (existsSync(source)) renameSync(source, `${quarantinePath}${suffix}`);
    } catch {
      rmSync(source, { force: true });
    }
  }
}

export function quarantineCorruptSqliteDb(options: SqliteQuarantineOptions): SqliteQuarantineResult {
  const quarantinePath = options.quarantinePath ?? defaultQuarantinePath(options.dbPath);
  clearOldQuarantine(quarantinePath);

  try {
    renameSync(options.dbPath, quarantinePath);
  } catch (error) {
    const renameErrorCode = String((error as { code?: unknown }).code ?? "error");
    const copied = copyDatabase(options.dbPath, quarantinePath);
    if (!copied && options.preserveSourceOnCopyFailure === true) {
      return { quarantinePath: options.dbPath, copied: false, renameErrorCode };
    }
    removeSqliteDb({
      dbPath: options.dbPath,
      ...(options.removeAttempts === undefined ? {} : { attempts: options.removeAttempts }),
      ...(options.removeRetryDelayMs === undefined ? {} : { retryDelayMs: options.removeRetryDelayMs }),
    });
    return { quarantinePath: copied ? quarantinePath : null, copied, renameErrorCode };
  }

  renameAvailableSidecars(options.dbPath, quarantinePath);
  return { quarantinePath, copied: false, renameErrorCode: null };
}
