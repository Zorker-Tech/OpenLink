export interface TranscriptSearchResult {
  agentId: string
  entryId: string
  role: string
  timestampMs: number
  snippet: string
}

export function rankTranscriptSearchResults(
  results: TranscriptSearchResult[],
  limit: number,
): TranscriptSearchResult[] {
  return results.sort((left, right) => right.timestampMs - left.timestampMs).slice(0, limit)
}
