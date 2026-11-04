import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { ConversationSummaryArchive } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { summaryMessageBlobIdsFromInterop } from "../../source/adapters/interop/agent/transcript-summary-archive-adapter.ts"

describe("the transcript-summary archive interop adapter", () => {
  it("projects the archived message blob identifiers", () => {
    const archive = new ConversationSummaryArchive({ summarizedMessages: [new TextEncoder().encode("message-1"), new TextEncoder().encode("message-2")] })
    assert.deepEqual(summaryMessageBlobIdsFromInterop(archive.toBinary()), [new TextEncoder().encode("message-1"), new TextEncoder().encode("message-2")])
  })

  it("leaves a malformed archive unreadable instead of interrupting the transcript", () => {
    assert.equal(summaryMessageBlobIdsFromInterop(new Uint8Array([0xff, 0xff])), undefined)
  })
})
