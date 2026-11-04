import type { TranscriptEntry } from "./transcript-hub.ts"

export type SlateTranscriptEntryKind = "user-message" | "user-attachment" | "assistant-message" | "send-message"

export interface TranscriptEntrySequence {
  readonly entries: readonly TranscriptEntry[]
  readonly kind: SlateTranscriptEntryKind
}
