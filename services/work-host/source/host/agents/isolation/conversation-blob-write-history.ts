export const MAX_TRACKED_RECENT_WRITES = 16_384;

/** Move one recently written identifier to the tail of the bounded insertion-order ledger. */
export function recordRecentBlobWrite(recentWriteMsByHexId: Map<string, number>, blobId: string, atMs: number): void {
  recentWriteMsByHexId.delete(blobId);
  recentWriteMsByHexId.set(blobId, atMs);
  while (recentWriteMsByHexId.size > MAX_TRACKED_RECENT_WRITES) {
    const oldest = recentWriteMsByHexId.keys().next().value;
    if (oldest == null) break;
    recentWriteMsByHexId.delete(oldest);
  }
}
