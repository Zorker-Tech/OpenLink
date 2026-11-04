import type { TranscriptManagerLike } from "./transcript-hub.ts"
import { searchIndexedTranscriptResults } from "./roster-search-indexed.ts"
import { searchAgentsByTranscriptScan } from "./roster-search-linear.ts"
import { searchExistingAgentMedia } from "./roster-search-media.ts"
import type { TranscriptSearchResult } from "./roster-search-contracts.ts"

export type { TranscriptSearchResult } from "./roster-search-contracts.ts"

export class RosterSearch {
  constructor(readonly tm: TranscriptManagerLike) {}

  async searchAgents(
    query: string,
    limit = this.tm.contentSearch.maxResults,
  ): Promise<TranscriptSearchResult[]> {
    const normalizedQuery = query.trim().toLowerCase()
    if (normalizedQuery.length === 0) return []

    if (this.tm.contentSearch.isSearchReady) {
      const indexed = await searchIndexedTranscriptResults(this.tm, normalizedQuery, limit)
      if (indexed !== null) return indexed
    }
    return this.searchAgentsByLinearScan(normalizedQuery, limit)
  }

  searchAgentsByLinearScan(normalizedQuery: string, limit: number): Promise<TranscriptSearchResult[]> {
    return searchAgentsByTranscriptScan(this.tm, normalizedQuery, limit)
  }

  searchMedia(
    query: string,
    limit = this.tm.contentSearch.maxResults,
  ): Promise<any[]> {
    return searchExistingAgentMedia(this.tm, query.trim(), limit)
  }
}
