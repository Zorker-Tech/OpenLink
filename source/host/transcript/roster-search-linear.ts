import { getTranscript } from "./transcript-store.ts"
import type { TranscriptManagerLike } from "./transcript-hub.ts"
import { rankTranscriptSearchResults, type TranscriptSearchResult } from "./roster-search-contracts.ts"

export async function searchAgentsByTranscriptScan(
  manager: TranscriptManagerLike,
  normalizedQuery: string,
  limit: number,
): Promise<TranscriptSearchResult[]> {
  const activeAgentId = manager.getActiveAgentId()
  const agents = await manager.sessionStore.listAgents(activeAgentId ?? undefined)
  const results: TranscriptSearchResult[] = []

  for (const agent of agents) {
    const entries = activeAgentId != null && agent.id === activeAgentId
      ? getTranscript()
      : manager.sessionStore.readAgentTranscriptEntries(agent.id)
    for (const match of manager.contentSearch.findTranscriptMatches(entries, normalizedQuery)) {
      results.push({
        agentId: agent.id,
        entryId: match.entryId,
        role: match.role,
        timestampMs: match.timestampMs > 0 ? match.timestampMs : agent.updatedAt,
        snippet: match.snippet,
      })
    }
  }

  return rankTranscriptSearchResults(results, limit)
}
