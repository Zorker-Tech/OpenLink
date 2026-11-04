import {
  AGENT_CONTENT_SEARCH_MAX_MATCHES_PER_AGENT,
  AGENT_CONTENT_SEARCH_MAX_RESULTS,
  findAgentContentMatches,
} from "./agent-content-search.ts"
import type { SlateSearchIndexService } from "./search-index-service.ts"

type SearchIndexApi = Pick<SlateSearchIndexService, "isSearchReady" | "searchMessages" | "searchMedia">

export function createContentSearchExtensionApi(index: SearchIndexApi, isEnabled: () => boolean) {
  return {
    isEnabled,
    get isSearchReady() { return index.isSearchReady },
    maxMatchesPerAgent: AGENT_CONTENT_SEARCH_MAX_MATCHES_PER_AGENT,
    maxResults: AGENT_CONTENT_SEARCH_MAX_RESULTS,
    searchMessages: ({ query, limit }: { query: string; limit: number }) => index.searchMessages(query, limit),
    searchMedia: ({ query, limit }: { query: string; limit: number }) => index.searchMedia(query, limit),
    findTranscriptMatches: findAgentContentMatches,
  }
}
