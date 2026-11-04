/** Decodes the counterpart's summary archive into the message blob identifiers Slate hydrates. */

import { ConversationSummaryArchive } from "../proto/generated/agent/v1/agent_pb.ts"

export function summaryMessageBlobIdsFromInterop(blob: Uint8Array): readonly Uint8Array[] | undefined {
  try {
    return ConversationSummaryArchive.fromBinary(blob).summarizedMessages
  } catch {
    return undefined
  }
}
