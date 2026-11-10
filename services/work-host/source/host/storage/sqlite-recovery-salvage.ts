import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { removeSqliteSidecars } from "./sqlite-recovery-files.ts";

export interface SqliteSalvageSource {
  prepare(sql: string): { iterate(): Iterator<unknown> };
}

export interface SqliteSalvageInsert {
  run(...params: unknown[]): unknown;
}

function openCheckedDatabase(dbPath: string, busyTimeoutMs?: number): DatabaseSync {
  const database = new DatabaseSync(dbPath);
  try {
    if (busyTimeoutMs != null) database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    database.prepare("PRAGMA schema_version").get();
    return database;
  } catch (error) {
    try {
      database.close();
    } catch {
      // Keep the schema check error as the useful recovery signal.
    }
    throw error;
  }
}

export function openSqliteForSalvage(options: { dbPath: string; busyTimeoutMs?: number }): DatabaseSync | undefined {
  if (!existsSync(options.dbPath)) return undefined;
  try {
    return openCheckedDatabase(options.dbPath, options.busyTimeoutMs);
  } catch {
    removeSqliteSidecars(options.dbPath);
  }
  try {
    return openCheckedDatabase(options.dbPath, options.busyTimeoutMs);
  } catch {
    try {
      return new DatabaseSync(options.dbPath);
    } catch {
      return undefined;
    }
  }
}

export function copySalvageableSqliteRows(
  source: SqliteSalvageSource,
  selectSql: string,
  insert: SqliteSalvageInsert,
  toParams: (row: unknown) => unknown[],
): number {
  let rows: Iterator<unknown>;
  try {
    rows = source.prepare(selectSql).iterate();
  } catch {
    return 0;
  }

  let copiedRows = 0;
  try {
    while (true) {
      let next: IteratorResult<unknown>;
      try {
        next = rows.next();
      } catch {
        break;
      }
      if (next.done) break;
      try {
        insert.run(...toParams(next.value));
        copiedRows += 1;
      } catch {
        // One damaged row does not prevent salvage of later readable rows.
      }
    }
  } finally {
    try {
      rows.return?.();
    } catch {
      // Iterator cleanup must not mask salvage results.
    }
  }
  return copiedRows;
}
