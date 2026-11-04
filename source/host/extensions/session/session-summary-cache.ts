import { existsSync } from "node:fs"
import { join } from "node:path"
import { errorLogTag } from "../../../shared/errors/summary.ts"
import { getSlateProfilePath } from "../../agents/agent-profile.ts"
import { getSlateAgentDbWriteGeneration } from "../../storage/store-db.ts"
import { SlateAgentDb } from "./agent-db.ts"
import { loadAgentDbExtras, type DbExtras } from "./session-summaries.ts"
import { statIfExists } from "./session-paths.ts"
import { reportSessionDiagnostic } from "./session-diagnostics.ts"

interface DbStats {
  readonly size: number
  readonly mtimeMs: number
}

interface CacheEntry {
  readonly key: string
  readonly extras: DbExtras
}

export class SessionExtrasCache {
  readonly #entries = new Map<string, CacheEntry>()

  constructor(
    private readonly rootDir: string,
    private readonly isAgentBeingDeleted: (agentId: string) => boolean,
  ) {}

  clear(agentId: string): void {
    this.#entries.delete(agentId)
  }

  retainOnly(agentIds: ReadonlySet<string>): void {
    for (const agentId of this.#entries.keys()) {
      if (!agentIds.has(agentId)) this.#entries.delete(agentId)
    }
  }

  async load(
    agentId: string,
    dbPath: string,
    dbStats: DbStats,
    readExtras?: () => DbExtras | null,
  ): Promise<DbExtras | null> {
    const wal = await statIfExists(`${dbPath}-wal`)
    const generation = getSlateAgentDbWriteGeneration(dbPath)
    const fingerprint = [
      generation,
      dbStats.size,
      dbStats.mtimeMs,
      wal?.size ?? -1,
      wal?.mtimeMs ?? -1,
    ].join(":")
    const cached = this.#entries.get(agentId)
    if (
      cached?.key === fingerprint &&
      existsSync(getSlateProfilePath(join(this.rootDir, agentId)))
    ) {
      return cached.extras
    }
    if (this.isAgentBeingDeleted(agentId)) return null

    const extras = readExtras?.() ?? this.#readFromDisk(dbPath, agentId, dbStats)
    if (extras !== null) this.#entries.set(agentId, { key: fingerprint, extras })
    return extras
  }

  #readFromDisk(dbPath: string, agentId: string, dbStats: DbStats): DbExtras | null {
    let db: SlateAgentDb
    try {
      db = new SlateAgentDb(dbPath, { recoverOnCorruption: false })
    } catch (error) {
      reportSessionDiagnostic({
        family: "store_db",
        kind: "unreadable",
        agentId,
        errorClass: errorLogTag(error),
      })
      return null
    }
    try {
      return loadAgentDbExtras(db, dbPath, agentId, dbStats)
    } finally {
      db.close()
    }
  }
}
