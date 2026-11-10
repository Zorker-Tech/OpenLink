import type { TranscriptEntry } from "./transcript-hub.ts"
import type { SlateTranscriptEntryKind } from "./transcript-entry-id-contracts.ts"
import {
  countTrailingAssistantMessageEntries,
  countTrailingSendMessageEntries,
  countTrailingUserAttachmentEntries,
  countUserTranscriptEntries,
} from "./transcript-entry-id-counts.ts"

export const INITIAL_TRANSCRIPT_TURN_KEY = "b"

export function firstUnoccupiedEntryId(
  existingIds: ReadonlySet<string>,
  format: (index: number) => string,
  startAt: number,
): string {
  let candidateIndex = startAt
  let candidate = format(candidateIndex)
  while (existingIds.has(candidate)) candidate = format(++candidateIndex)
  return candidate
}

export function allocateTranscriptEntryId(
  entries: readonly TranscriptEntry[],
  kind: SlateTranscriptEntryKind,
): string {
  const existingIds = new Set(entries.map((entry) => entry.id))
  const userTurnCount = countUserTranscriptEntries(entries)

  if (kind === "user-message") {
    return firstUnoccupiedEntryId(existingIds, (index) => `t${index}u`, userTurnCount)
  }
  if (kind === "user-attachment") {
    return firstUnoccupiedEntryId(existingIds, (index) => `t${userTurnCount}ua${index}`, countTrailingUserAttachmentEntries(entries))
  }

  const turnKey = userTurnCount === 0 ? INITIAL_TRANSCRIPT_TURN_KEY : String(userTurnCount - 1)
  return kind === "assistant-message"
    ? firstUnoccupiedEntryId(existingIds, (index) => `t${turnKey}a${index}`, countTrailingAssistantMessageEntries(entries))
    : firstUnoccupiedEntryId(existingIds, (index) => `t${turnKey}s${index}`, countTrailingSendMessageEntries(entries))
}
