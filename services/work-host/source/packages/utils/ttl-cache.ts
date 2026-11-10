/**
 * A cache whose entries expire on their own.
 *
 * Used for answers that are expensive and short-lived — a probe result, a capability check — where
 * the caller wants "recent enough" rather than "correct until invalidated". The clock is injectable
 * so expiry can be tested without waiting, and a non-positive TTL is refused at construction rather
 * than silently caching nothing.
 */

export class TTLCache<K, V> {
  private readonly cacheEntries = new Map<K, { value: V; expiresAtMs: number }>()
  private readonly readTtl: () => number
  private readonly clockNow: () => number

  constructor(options: { ttlMs: number | (() => number); now?: () => number }) {
    this.readTtl = typeof options.ttlMs === "function" ? options.ttlMs : TTLCache.fixed(options.ttlMs)
    this.clockNow = options.now ?? Date.now
  }

  private static fixed(ttlMs: number): () => number {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error(`TTL cache requires a positive ttlMs, got ${ttlMs}`)
    return () => ttlMs
  }

  private currentEntry(key: K): { value: V; expiresAtMs: number } | undefined {
    const entry = this.cacheEntries.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAtMs <= this.clockNow()) {
      this.cacheEntries.delete(key)
      return undefined
    }
    return entry
  }

  get(key: K): V | undefined {
    return this.currentEntry(key)?.value
  }

  has(key: K): boolean {
    return this.currentEntry(key) !== undefined
  }

  set(key: K, value: V): void {
    const expiresAtMs = this.clockNow() + this.readTtl()
    this.cacheEntries.set(key, { value, expiresAtMs })
  }

  delete(key: K): boolean {
    return this.cacheEntries.delete(key)
  }

  clear(): void {
    this.cacheEntries.clear()
  }
}
