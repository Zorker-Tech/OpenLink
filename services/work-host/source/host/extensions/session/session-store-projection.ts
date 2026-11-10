import type { OpenAgentSession, SessionMemoryProvider } from "./agent-session.ts"
import { recoverAgentWithMissingDb } from "./session-mutations.ts"
import { listAgents, summarizeAgentById } from "./session-roster.ts"
import { buildSummary, loadAgentDbExtras, type DbExtras } from "./session-summaries.ts"
import { statIfExists } from "./session-paths.ts"
import { SlateAgentDb } from "./agent-db.ts"
import type { SessionExtrasCache } from "./session-summary-cache.ts"

interface ProjectionDependencies {
  readonly rootDir: string
  readonly memory: () => SessionMemoryProvider
  readonly isAgentBeingDeleted: (agentId: string) => boolean
  readonly cache: SessionExtrasCache
  readonly reseedMinimalStoreDb: (dbPath: string) => void
}

export class SessionStoreProjection {
  constructor(private readonly dependencies: ProjectionDependencies) {}

  async summarizeOpen(session: OpenAgentSession): Promise<Record<string, unknown> | null> {
    const dbStats = await statIfExists(session.dbPath)
    if (this.dependencies.isAgentBeingDeleted(session.id)) return null
    return this.#build(session, dbStats, session.id, {
      extras: loadAgentDbExtras(session.db, session.dbPath, session.id, dbStats),
    })
  }

  async summarize(
    session: OpenAgentSession,
    activeAgentId?: string,
  ): Promise<Record<string, unknown> | null> {
    const dbStats = await statIfExists(session.dbPath)
    if (this.dependencies.isAgentBeingDeleted(session.id)) return null
    const extras = dbStats === undefined
      ? loadAgentDbExtras(session.db, session.dbPath, session.id, dbStats)
      : await this.#loadExtras(session.id, session.dbPath, dbStats)
    if (this.dependencies.isAgentBeingDeleted(session.id)) return null
    return this.#build(session, dbStats, activeAgentId, { extras })
  }

  async summarizeAgent(agentId: string, activeAgentId?: string) {
    return summarizeAgentById(this.rosterHost(), agentId, activeAgentId)
  }

  async list(activeAgentId?: string) {
    return listAgents(this.rosterHost(), activeAgentId)
  }

  rosterHost() {
    return {
      rootDir: this.dependencies.rootDir,
      isAgentBeingDeleted: this.dependencies.isAgentBeingDeleted,
      memory: this.dependencies.memory(),
      loadCachedExtras: (args: {
        dirName: string
        dbPath: string
        dbStats: { size: number; mtimeMs: number }
        readExtras?: () => DbExtras | null
      }) => this.#loadExtras(args.dirName, args.dbPath, args.dbStats, args.readExtras),
      recoverAgentWithMissingDb: (args: {
        dbPath: string
        dirName: string
        activeAgentId?: string
      }) => recoverAgentWithMissingDb(
        {
          memory: this.dependencies.memory(),
          isAgentBeingDeleted: this.dependencies.isAgentBeingDeleted,
          reseedMinimalStoreDbIfMissing: this.dependencies.reseedMinimalStoreDb,
        },
        args,
      ),
      pruneExtrasCache: (ids: Set<string>) => this.dependencies.cache.retainOnly(ids),
    }
  }

  #loadExtras(
    agentId: string,
    dbPath: string,
    dbStats: { size: number; mtimeMs: number },
    readExtras?: () => DbExtras | null,
  ) {
    return this.dependencies.cache.load(agentId, dbPath, dbStats, readExtras)
  }

  #build(
    session: OpenAgentSession,
    dbStats: Awaited<ReturnType<typeof statIfExists>>,
    activeAgentId: string | undefined,
    values: {
      readonly extras: DbExtras | null
    },
  ) {
    return buildSummary({
      extras: values.extras,
      dbPath: session.dbPath,
      dirName: session.id,
      ...(dbStats === undefined ? {} : { dbStats }),
      ...(activeAgentId === undefined ? {} : { activeAgentId }),
      includeBlank: true,
      agentHasMemory: candidate => this.dependencies.memory().agentHasContent(candidate),
    })
  }
}
