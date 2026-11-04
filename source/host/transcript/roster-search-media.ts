import type { TranscriptManagerLike } from "./transcript-hub.ts"

export async function searchExistingAgentMedia(
  manager: TranscriptManagerLike,
  query: string,
  limit: number,
): Promise<any[]> {
  if (!manager.contentSearch.isSearchReady) return []
  const matches = await manager.contentSearch.searchMedia({ query, limit })
  if (matches == null) return []
  return matches.filter((match: any) => manager.sessionStore.agentExists(match.agentId))
}
