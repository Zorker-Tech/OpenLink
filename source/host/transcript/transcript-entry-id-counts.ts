import type { TranscriptEntry } from "./transcript-hub.ts"

export function countUserTranscriptEntries(entries: readonly TranscriptEntry[]): number {
  return entries.reduce((total, entry) => total + (entry.kind === "message" && entry.role === "user" ? 1 : 0), 0)
}

export function countTrailingEntryFamily(
  entries: readonly TranscriptEntry[],
  include: (entry: TranscriptEntry) => boolean,
): number {
  let total = 0
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry == null) continue
    if (entry.kind === "message" && entry.role === "user") break
    if (include(entry)) total += 1
  }
  return total
}

export const countTrailingUserAttachmentEntries = (entries: readonly TranscriptEntry[]): number =>
  countTrailingEntryFamily(entries, (entry) => entry.kind === "user-attachment")

export const countTrailingAssistantMessageEntries = (entries: readonly TranscriptEntry[]): number =>
  countTrailingEntryFamily(entries, (entry) => entry.kind === "message" && entry.role === "assistant")

export const countTrailingSendMessageEntries = (entries: readonly TranscriptEntry[]): number =>
  countTrailingEntryFamily(entries, (entry) => entry.kind === "send-message")
