import { rmSync } from "node:fs";
import { SQLITE_DB_SIDECAR_SUFFIXES } from "./store-db.ts";

const retrySleeper = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export function removeSqliteSidecars(dbPath: string): void {
  for (const suffix of SQLITE_DB_SIDECAR_SUFFIXES) {
    try {
      rmSync(`${dbPath}${suffix}`, { force: true, recursive: true });
    } catch {
      // Sidecars are best-effort; the database file is the source of truth.
    }
  }
}

export function removePathWithRetries(options: {
  path: string;
  attempts?: number;
  retryDelayMs?: number;
  recursive?: boolean;
}): void {
  const attemptLimit = Math.max(1, options.attempts ?? 1);
  let lastFailure: unknown;
  for (let attempt = 0; attempt < attemptLimit; attempt += 1) {
    try {
      rmSync(options.path, { force: true, recursive: options.recursive === true });
      lastFailure = undefined;
      break;
    } catch (error) {
      lastFailure = error;
      if (attempt + 1 < attemptLimit) Atomics.wait(retrySleeper, 0, 0, options.retryDelayMs ?? 50);
    }
  }
  if (lastFailure != null) throw lastFailure;
}

export function removeSqliteDb(options: {
  dbPath: string;
  attempts?: number;
  retryDelayMs?: number;
}): void {
  const retry = {
    ...(options.attempts === undefined ? {} : { attempts: options.attempts }),
    ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
  };
  removePathWithRetries({ path: options.dbPath, ...retry });
  for (const suffix of SQLITE_DB_SIDECAR_SUFFIXES) {
    removePathWithRetries({
      path: `${options.dbPath}${suffix}`,
      ...retry,
      recursive: true,
    });
  }
}
