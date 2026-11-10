/** Reads Slate or historical summary archives and projects the message blob ids used for transcript hydration. */

import { deserializeSlateConversationSummaryArchiveInterop } from "./conversation-summary-storage-adapter.ts"

export function summaryMessageBlobIdsFromStored(blob: Uint8Array): readonly Uint8Array[] | undefined {
  try {
    return deserializeSlateConversationSummaryArchiveInterop(blob).summarizedMessages
  } catch {
    return undefined
  }
}
