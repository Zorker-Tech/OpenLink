import type { TranscriptEntry } from "./transcript-hub.ts"

export function findPendingBoxRequestEntry(
  entries: readonly TranscriptEntry[],
  requestId: string,
): TranscriptEntry | undefined {
  return entries.find((entry) =>
    entry.kind === "send-message"
      && entry.boxRequestId === requestId
      && entry.boxResolution == null
  )
}

export function withBoxRequestResolution(entry: TranscriptEntry, resolution: string): TranscriptEntry {
  return entry.kind === "send-message" && entry.boxResolution == null
    ? { ...entry, boxResolution: resolution }
    : entry
}
