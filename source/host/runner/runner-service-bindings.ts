/** Services attached to a runner after the host has built the per-session graph. */
export interface RunnerServiceBindings {
  readonly agentState?: {
    readonly store: unknown
    readonly profileProvider: unknown
  }
  readonly memory?: {
    readonly primary?: unknown
    readonly user?: unknown
    readonly project?: unknown
    readonly snapshots?: unknown
    readonly profileSnapshots?: unknown
    readonly episodeProgress?: unknown
  }
  readonly automation?: {
    readonly automations?: unknown
    readonly workflows?: unknown
    readonly channels?: unknown
  }
  readonly toolAccess?: {
    readonly mcp?: unknown
    readonly management?: unknown
  }
  readonly attachments?: {
    readonly ingestor?: unknown
    readonly imagePersister?: unknown
    readonly mediaPersister?: unknown
  }
}
