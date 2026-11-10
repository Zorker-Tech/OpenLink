import { updateEntry } from "./transcript-store.ts"
import type { TranscriptEntry } from "./transcript-hub.ts"
import { findPendingBoxRequestEntry, withBoxRequestResolution } from "./box-request-entry-projection.ts"
import type { ActiveBoxRequest, BoxRequestEntryHost, BoxRequestSession } from "./box-request-entries-contracts.ts"

export type { ActiveBoxRequest, BoxRequestEntryHost, BoxRequestSession } from "./box-request-entries-contracts.ts"
export { findPendingBoxRequestEntry, withBoxRequestResolution } from "./box-request-entry-projection.ts"

/** Keeps the currently visible box request tied to the transcript entry that owns its answer. */
export class BoxRequestEntries {
  activeBoxRequest: ActiveBoxRequest | null = null

  constructor(readonly tm: BoxRequestEntryHost) {}

  trackBoxRequestEntry(entry: TranscriptEntry): void {
    if (entry.boxRequestId == null || entry.boxResolution != null) return
    const activeSession = this.tm.sessions?.activeSession
    if (activeSession == null) return

    const previous = this.activeBoxRequest
    if (previous != null && previous.agentId === activeSession.id) {
      void this.tm.resolveBoxRequestEntry(activeSession.id, previous.requestId, "dismissed")
    }

    this.activeBoxRequest = {
      agentId: activeSession.id,
      entryId: entry.id,
      requestId: entry.boxRequestId as string,
    }
  }

  async resolveBoxRequestEntry(agentId: string, requestId: string, resolution: string): Promise<void> {
    if (this.activeBoxRequest?.requestId === requestId) this.activeBoxRequest = null

    const sessionIndex = this.tm.sessions
    if (sessionIndex?.isAgentGone(agentId)) return

    const liveSession = sessionIndex?.activeSession?.id === agentId
      ? sessionIndex.activeSession
      : sessionIndex?.liveSessions.get(agentId)
    let session: BoxRequestSession
    try {
      session = liveSession ?? await this.tm.sessionStore.openSession(agentId)
    } catch {
      return
    }

    try {
      const target = findPendingBoxRequestEntry(session.db.getTranscriptEntries(), requestId)
      if (target === undefined) return

      const applyResolution = (entry: TranscriptEntry): TranscriptEntry => withBoxRequestResolution(entry, resolution)
      session.db.updateTranscriptEntry(target.id, applyResolution)
      if (sessionIndex?.activeSession?.id === agentId && sessionIndex.inMemoryTranscriptAgentId === agentId) {
        const updated = updateEntry(target.id, applyResolution)
        if (updated !== null) this.tm.roster.emit({ type: "updated", entry: updated })
      }
    } finally {
      if (liveSession == null) {
        await session.agentStore.dispose()
        session.db.close()
      }
    }
  }
}
