import type { RedactedString } from "../redaction/redacted-values.ts"

/** Plain conversation summary value owned by Slate. */
export interface SlateConversationSummary {
  readonly content: string
}

/** Durable summary text after the active privacy policy has been applied. */
export interface SlateStoredConversationSummary extends Omit<SlateConversationSummary, "content"> {
  readonly content: string | RedactedString
}

/** Summary archive model consumed by transcript recovery and compaction policy. */
export interface SlateConversationSummaryArchive {
  readonly summarizedMessageBlobIds: readonly Uint8Array[]
  readonly summary: string | RedactedString
  readonly summaryMessageBlobId: Uint8Array
  readonly unsummarizedWindowTail: number
}

/** Durable archive after the summary text has been redacted for storage. */
export interface SlateStoredConversationSummaryArchive extends Omit<SlateConversationSummaryArchive, "summary"> {
  readonly summary: string | RedactedString
}

export function cloneSlateConversationSummary(
  summary: SlateConversationSummary,
): SlateConversationSummary {
  return { content: summary.content }
}

export function cloneSlateConversationSummaryArchive(
  archive: SlateConversationSummaryArchive,
): SlateConversationSummaryArchive {
  return {
    summarizedMessageBlobIds: archive.summarizedMessageBlobIds.map(id => new Uint8Array(id)),
    summary: archive.summary,
    summaryMessageBlobId: new Uint8Array(archive.summaryMessageBlobId),
    unsummarizedWindowTail: archive.unsummarizedWindowTail,
  }
}
