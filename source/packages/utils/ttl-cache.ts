/**
 * A cache whose entries expire on their own.
 *
 * Used for answers that are expensive and short-lived — a probe result, a capability check — where
 * the caller wants "recent enough" rather than "correct until invalidated". The clock is injectable
 * so expiry can be tested without waiting, and a non-positive TTL is refused at construction rather
 * than silently caching nothing.
 */

export class TTLCache<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAtMs: number }>()
  private readonly ttlMs: () => number
  private readonly now: () => number

  constructor(options: { ttlMs: number | (() => number); now?: () => number }) {
    this.ttlMs = typeof options.ttlMs === "function" ? options.ttlMs : TTLCache.fixed(options.ttlMs)
    this.now = options.now ?? Date.now
  }

  private static fixed(ttlMs: number): () => number {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error(`TTL cache requires a positive ttlMs, got ${ttlMs}`)
    return () => ttlMs
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAtMs <= this.now()) {
      this.entries.delete(key)
      return undefined
    }
    return entry.value
  }

  has(key: K): boolean {
    const entry = this.entries.get(key)
    if (entry === undefined) return false
    if (entry.expiresAtMs <= this.now()) {
      this.entries.delete(key)
      return false
    }
    return true
  }

  set(key: K, value: V): void {
    this.entries.set(key, { value, expiresAtMs: this.now() + this.ttlMs() })
  }

  delete(key: K): boolean {
    return this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }
}
