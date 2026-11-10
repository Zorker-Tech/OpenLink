import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  createSlateConversationSummaryArchiveSerde,
  redactSlateConversationSummaryArchive,
} from "../../source/adapters/interop/agent/conversation-summary-storage-adapter.ts"
import { summaryMessageBlobIdsFromStored } from "../../source/adapters/interop/agent/transcript-summary-archive-adapter.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"

describe("stored transcript summary archives", () => {
  it("reads the same message identifiers from Slate's summary archive schema", () => {
    const serde = createSlateConversationSummaryArchiveSerde(PrivacyMode.NO_STORAGE)
    const bytes = serde.serialize(redactSlateConversationSummaryArchive({
      summarizedMessageBlobIds: [new TextEncoder().encode("message-1"), new TextEncoder().encode("message-2")],
      summary: "condensed history",
      summaryMessageBlobId: new TextEncoder().encode("carrier"),
      unsummarizedWindowTail: 3,
    }, PrivacyMode.NO_STORAGE))

    assert.deepEqual(summaryMessageBlobIdsFromStored(bytes), [new TextEncoder().encode("message-1"), new TextEncoder().encode("message-2")])
  })

  it("leaves a malformed archive unreadable instead of interrupting the transcript", () => {
    assert.equal(summaryMessageBlobIdsFromStored(new Uint8Array([0xff, 0xff])), undefined)
  })
})
