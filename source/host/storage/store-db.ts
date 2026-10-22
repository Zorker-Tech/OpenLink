/**
 * The store's database and the bookkeeping kept beside it.
 *
 * A store's database is opened with a busy timeout, and this module remembers two things about each: how many live
 * handles it has, so a writer can tell whether it is about to move a database out from under someone, and a write
 * generation that is bumped whenever the file is written, so a reader can tell whether what it cached is stale. It
 * also knows the sidecar files a database leaves beside itself, and how to fold a write-ahead log into the file.
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** How long a checkpoint waits for a writer before giving up. */
export const DB_BUSY_TIMEOUT_MS = 5_000;

/** The files a SQLite database leaves beside itself. */
export const SQLITE_DB_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

/** The write generation of each database, and how many handles are live on each, both keyed by resolved path. */
const generationByPath = new Map<string, number>();
const handleCountByPath = new Map<string, number>();

/** The write generation of a database: how many times its file has been written, as this process knows it. */
export function getSlateAgentDbWriteGeneration(databasePath: string): number {
  return generationByPath.get(resolve(databasePath)) ?? 0;
}

/** Records one write of a database's file. */
export function bumpDbWriteGeneration(databasePath: string): void {
  const resolved = resolve(databasePath);
  generationByPath.set(resolved, (generationByPath.get(resolved) ?? 0) + 1);
}

/** Forgets a database's write generation, for a file this process will no longer write. */
export function deleteSlateAgentDbWriteGeneration(databasePath: string): void {
  generationByPath.delete(resolve(databasePath));
}

/** How many live handles a database has. */
export function liveDbHandleCount(resolvedDbPath: string): number {
  return handleCountByPath.get(resolvedDbPath) ?? 0;
}

/** Records one more live handle on a database. */
export function registerLiveDbHandle(databasePath: string): void {
  const resolved = resolve(databasePath);
  handleCountByPath.set(resolved, liveDbHandleCount(resolved) + 1);
}

/** Records one fewer live handle on a database, forgetting the count when none are left. */
export function releaseLiveDbHandle(databasePath: string): void {
  const resolved = resolve(databasePath);
  const left = liveDbHandleCount(resolved) - 1;
  if (left <= 0) handleCountByPath.delete(resolved);
  else handleCountByPath.set(resolved, left);
}

/** Whether a database has a live handle. */
export function hasLiveSlateAgentDbHandle(databasePath: string): boolean {
  return liveDbHandleCount(resolve(databasePath)) > 0;
}

/** Whether a wal_checkpoint row says every frame has been folded into the database file. */
export function walFramesFullyFolded(row: unknown): boolean | undefined {
  if (typeof row !== "object" || row == null) return undefined;
  const { log, checkpointed } = row as Record<string, unknown>;
  if (typeof log !== "number" || typeof checkpointed !== "number" || log < 0 || checkpointed < 0) return undefined;
  return checkpointed >= log;
}

/** The row the database answers the checkpoint with, or nothing when it cannot be opened. */
function checkpointRow(dbPath: string, busyTimeoutMs: number): { answered: boolean; row: unknown } {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath);
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    return { answered: true, row: db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() };
  } catch {
    return { answered: false, row: undefined };
  } finally {
    db?.close();
  }
}

/** Whether the wal sidecar is empty, or was never there. */
function walSidecarIsEmpty(dbPath: string): boolean {
  try {
    return statSync(`${dbPath}-wal`).size === 0;
  } catch (error) {
    return (error as { code?: unknown }).code === "ENOENT";
  }
}

/** Folds a database's write-ahead log into the database file, answering whether it is fully folded. */
export function checkpointSlateAgentDb(dbPath: string, busyTimeoutMs = DB_BUSY_TIMEOUT_MS): boolean {
  if (!existsSync(dbPath)) return true;
  const checkpoint = checkpointRow(dbPath, busyTimeoutMs);
  if (!checkpoint.answered) return false;
  const folded = walFramesFullyFolded(checkpoint.row);
  if (folded != null) return folded;
  return walSidecarIsEmpty(dbPath);
}
