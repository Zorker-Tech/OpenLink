export interface MutationDb {
  getSlateProfile(): { description: string; avatarPath: string | null }
  setSlateProfile(value: { description: string; avatarPath: string | null }): boolean
  get(key: string): unknown
  getTranscriptEntries(): Record<string, unknown>[]
  getUnreadState(): {
    lastActivityAt: number
    lastViewedAt: number
    isManuallyUnread: boolean
    unreadCount: number
  }
}

export interface SessionMutationMemory {
  agentHasContent(dir: string): boolean
}

export interface SessionRecoveryHost {
  readonly memory: SessionMutationMemory
  isAgentBeingDeleted(id: string): boolean
  hasLiveDbHandle?(path: string): boolean
  reseedMinimalStoreDbIfMissing(path: string): void
}

export interface MissingDbRecoveryInput {
  readonly dbPath: string
  readonly dirName: string
  readonly activeAgentId?: string
}
