/**
 * Parsing a file again only when it changed.
 *
 * What is cached is the parse of a set of files, keyed by what the filesystem says about them — inode, modification
 * time and size — so a file that was touched is parsed again and one that was not is not. A file whose fingerprint is
 * too fresh is answered but not cached, since a modification time in the current tick can still hide an edit; a file
 * that is gone drops its entry, and the cache is bounded.
 */
import { statSync, type BigIntStats } from "node:fs";

/** How many parses the cache holds when the caller does not say. */
export const DEFAULT_STAT_PARSE_CACHE_CAPACITY = 2_048;

/** How fresh a file's modification time may be before a cached parse could hide an edit. */
export const RACY_MTIME_TICK_WINDOW_MS = 2_000;

/** What the filesystem says about a set of files: the key their parse is stored under, and how recent they are. */
type FileSignature = {
  key: string;
  newestMtimeMs: number;
};

/** One cached parse, with the signature it was made for. */
type CacheEntry = {
  key: string;
  parsed: unknown;
};

/** The newest modification time in a set could still belong to the tick we are in. */
export function mtimeTickCouldStillHideAnEdit(signature: { newestMtimeMs: number }, now: number): boolean {
  return now - signature.newestMtimeMs < RACY_MTIME_TICK_WINDOW_MS;
}

/** The part of a file's signature that changes when the file does: its inode, its modification time and its size. */
function statPartOf(info: BigIntStats): string {
  return `${info.ino}:${info.mtimeNs}:${info.size}`;
}

/** A modification time, in nanoseconds, as milliseconds. */
function mtimeMsOf(info: BigIntStats): number {
  return Number(info.mtimeNs / 1_000_000n);
}

/** The signature of a set of files, or null when one of them is gone. */
function signatureOf(paths: readonly string[]): FileSignature | null {
  const parts: string[] = [];
  let newestMtimeMs = 0;
  for (const file of paths) {
    const info = statSync(file, { bigint: true, throwIfNoEntry: false });
    if (info == null) return null;
    parts.push(statPartOf(info));
    newestMtimeMs = Math.max(newestMtimeMs, mtimeMsOf(info));
  }
  return { key: parts.join("|"), newestMtimeMs };
}

/** The key a set of files' parse is cached under. */
function pathSetKey(statPaths: readonly string[]): string {
  return statPaths.join("\0");
}

/** Parses a set of files again only when their signature changed, and remembers the parse when it is safe to. */
export class StatKeyedParseCache {
  readonly #parsedByPath = new Map<string, CacheEntry>();

  constructor(readonly capacity = DEFAULT_STAT_PARSE_CACHE_CAPACITY, readonly nowMs: () => number = Date.now) {}

  /** The cached parse of these files, parsed now when there is none that still fits. */
  read<T>(statPaths: readonly string[], parseNow: () => T): T | null {
    const cacheKey = pathSetKey(statPaths);
    let signature: FileSignature | null = null;
    try {
      signature = signatureOf(statPaths);
    } catch {
      return parseNow();
    }
    if (signature === null) {
      this.#parsedByPath.delete(cacheKey);
      return null;
    }
    const cached = this.#parsedByPath.get(cacheKey);
    if (cached !== undefined && cached.key === signature.key) return cached.parsed as T;
    const parsed = parseNow();
    this.#parsedByPath.delete(cacheKey);
    if (mtimeTickCouldStillHideAnEdit(signature, this.nowMs())) return parsed;
    this.#evictOldestWhenFull();
    this.#parsedByPath.set(cacheKey, { key: signature.key, parsed });
    return parsed;
  }

  /** Keeps the cache at its capacity by dropping the entry that was stored first. */
  #evictOldestWhenFull(): void {
    if (this.#parsedByPath.size < this.capacity) return;
    const oldest = this.#parsedByPath.keys().next().value;
    if (oldest !== undefined) this.#parsedByPath.delete(oldest);
  }
}
