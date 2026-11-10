import { getTranscript } from "./transcript-store.ts"
import type { TranscriptManagerLike } from "./transcript-hub.ts"
import { rankTranscriptSearchResults, type TranscriptSearchResult } from "./roster-search-contracts.ts"

export async function searchIndexedTranscriptResults(
  manager: TranscriptManagerLike,
  normalizedQuery: string,
  limit: number,
): Promise<TranscriptSearchResult[] | null> {
  const indexed = await manager.contentSearch.searchMessages({
    query: normalizedQuery,
    limit: limit + manager.contentSearch.maxMatchesPerAgent,
  })
  if (indexed == null) return null

  const activeAgentId = manager.sessions.inMemoryTranscriptAgentId
  const results: TranscriptSearchResult[] = indexed.filter(
    (match: TranscriptSearchResult) =>
      match.agentId !== activeAgentId && manager.sessionStore.agentExists(match.agentId),
  )

  if (activeAgentId != null) {
    const liveEntries = getTranscript()
    const newestLiveMs = liveEntries.reduce(
      (latest, entry) => Math.max(latest, entry.timestampMs ?? 0),
      0,
    ) || Date.now()
    for (const match of manager.contentSearch.findTranscriptMatches(liveEntries, normalizedQuery)) {
      results.push({
        agentId: activeAgentId,
        entryId: match.entryId,
        role: match.role,
        timestampMs: match.timestampMs > 0 ? match.timestampMs : newestLiveMs,
        snippet: match.snippet,
      })
    }
  }

  return rankTranscriptSearchResults(results, limit)
}
