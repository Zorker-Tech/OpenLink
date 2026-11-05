import type { SlateCheckpointUnknownField } from "./conversation-checkpoint-state.ts"
import type { RedactedString } from "../redaction/redacted-values.ts"

export interface SlateConversationSummaryCompatibility {
  /** Unknown fields from a historical summary blob, kept only for migration round-trips. */
  readonly legacyUnknownFields?: readonly SlateCheckpointUnknownField[]
}

/** Plain conversation summary value owned by Slate. */
export interface SlateConversationSummary {
  readonly content: string
  readonly compatibility?: SlateConversationSummaryCompatibility
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
  readonly compatibility?: SlateConversationSummaryCompatibility
}

/** Durable archive after the summary text has been redacted for storage. */
export interface SlateStoredConversationSummaryArchive extends Omit<SlateConversationSummaryArchive, "summary"> {
  readonly summary: string | RedactedString
}

export function cloneSlateConversationSummary(
  summary: SlateConversationSummary,
): SlateConversationSummary {
  const unknownFields = summary.compatibility?.legacyUnknownFields
  return {
    content: summary.content,
    ...(unknownFields === undefined
      ? {}
      : {
          compatibility: {
            legacyUnknownFields: unknownFields.map(field => ({
              ...field,
              path: field.path.map(step => ({ ...step })),
            })),
          },
        }),
  }
}

export function cloneSlateConversationSummaryArchive(
  archive: SlateConversationSummaryArchive,
): SlateConversationSummaryArchive {
  const unknownFields = archive.compatibility?.legacyUnknownFields
  return {
    summarizedMessageBlobIds: archive.summarizedMessageBlobIds.map(id => new Uint8Array(id)),
    summary: archive.summary,
    summaryMessageBlobId: new Uint8Array(archive.summaryMessageBlobId),
    unsummarizedWindowTail: archive.unsummarizedWindowTail,
    ...(archive.compatibility === undefined
      ? {}
      : {
          compatibility: {
            ...(unknownFields === undefined
              ? {}
              : { legacyUnknownFields: unknownFields.map(field => ({
                  ...field,
                  path: field.path.map(step => ({ ...step })),
                })) }),
          },
        }),
  }
}
