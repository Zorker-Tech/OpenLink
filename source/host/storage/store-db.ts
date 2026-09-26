/**
 * The database the store keeps its state in.
 *
 * A store's database is opened with a busy timeout, and the module remembers two things about each: how many handles
 * are live, so a writer can tell whether it is about to move a database out from under someone, and a write
 * generation that is bumped whenever the file is written, so a reader can tell whether what it cached is stale. The
 * sidecar files a database leaves beside itself are named here too.
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
export const DB_BUSY_TIMEOUT_MS = 5_000;
export const SQLITE_DB_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;
const dbWriteGenerations = new Map<string, number>(), liveDbHandlesByPath = new Map<string, number>();
export function getSlateAgentDbWriteGeneration(dbPath: string): number { return dbWriteGenerations.get(resolve(dbPath)) ?? 0; }
export function bumpDbWriteGeneration(dbPath: string): void { const path = resolve(dbPath); dbWriteGenerations.set(path, (dbWriteGenerations.get(path) ?? 0) + 1); }
export function deleteSlateAgentDbWriteGeneration(dbPath: string): void { dbWriteGenerations.delete(resolve(dbPath)); }
export function liveDbHandleCount(resolvedDbPath: string): number { return liveDbHandlesByPath.get(resolvedDbPath) ?? 0; }
export function registerLiveDbHandle(dbPath: string): void { const path = resolve(dbPath); liveDbHandlesByPath.set(path, liveDbHandleCount(path) + 1); }
export function releaseLiveDbHandle(dbPath: string): void { const path = resolve(dbPath), next = liveDbHandleCount(path) - 1; if (next <= 0) liveDbHandlesByPath.delete(path); else liveDbHandlesByPath.set(path, next); }
export function hasLiveSlateAgentDbHandle(dbPath: string): boolean { return liveDbHandleCount(resolve(dbPath)) > 0; }
export function walFramesFullyFolded(row: unknown): boolean | undefined { if (typeof row !== "object" || row == null) return undefined; const { log, checkpointed } = row as Record<string, unknown>; if (typeof log !== "number" || typeof checkpointed !== "number" || log < 0 || checkpointed < 0) return undefined; return checkpointed >= log; }
export function checkpointSlateAgentDb(dbPath: string, busyTimeoutMs = DB_BUSY_TIMEOUT_MS): boolean { if (!existsSync(dbPath)) return true; let db: DatabaseSync | undefined, result: unknown; try { db = new DatabaseSync(dbPath); db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`); result = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get(); } catch { return false; } finally { db?.close(); } const folded = walFramesFullyFolded(result); if (folded != null) return folded; try { return statSync(`${dbPath}-wal`).size === 0; } catch (error) { return (error as { code?: unknown }).code === "ENOENT"; } }
