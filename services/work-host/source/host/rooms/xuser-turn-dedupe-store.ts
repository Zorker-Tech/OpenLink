import { join } from "node:path"

import { SLATE_XUSER_TURN_DEDUPE_FILE_NAME } from "../durable-file-policy.ts"
import { parseDedupeFile, persistDedupeFile, readDedupeFile } from "./xuser-turn-dedupe-file.ts"
import { createInMemoryXuserTurnDedupe } from "./xuser-turn-dedupe-memory.ts"
import { XUSER_TURN_DEDUPE_TTL_MS, type XuserTurnDedupe } from "./xuser-turn-dedupe-contracts.ts"

export { createInMemoryXuserTurnDedupe, parseDedupeFile, XUSER_TURN_DEDUPE_TTL_MS }
export type { XuserTurnDedupe } from "./xuser-turn-dedupe-contracts.ts"

export class SlateXuserTurnDedupeStore implements XuserTurnDedupe {
  readonly filePath: string
  private snapshot: Map<string, number> | null = null

  constructor(
    rootDir: string,
    readonly ttlMs = XUSER_TURN_DEDUPE_TTL_MS,
    readonly nowMs: () => number = Date.now,
  ) {
    this.filePath = join(rootDir, SLATE_XUSER_TURN_DEDUPE_FILE_NAME)
  }

  markSeenIfNew(nonce: string): boolean {
    if (nonce.length === 0) return false

    const known = this.readSnapshot()
    const now = this.nowMs()
    const removedExpired = this.pruneExpired(known, now)
    if (known.has(nonce)) {
      if (removedExpired) this.persist(known)
      return false
    }

    known.set(nonce, now + this.ttlMs)
    this.persist(known)
    return true
  }

  pruneExpired(known: Map<string, number>, now: number): boolean {
    let changed = false
    for (const [nonce, expiresAtMs] of known) {
      if (expiresAtMs > now) continue
      known.delete(nonce)
      changed = true
    }
    return changed
  }

  private readSnapshot(): Map<string, number> {
    if (this.snapshot !== null) return this.snapshot
    this.snapshot = readDedupeFile(this.filePath)
    return this.snapshot
  }

  private persist(known: Map<string, number>): void {
    this.snapshot = known
    persistDedupeFile(this.filePath, known)
  }
}
