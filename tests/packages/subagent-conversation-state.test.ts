import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { mapSubagentConversationState } from "../../source/packages/agent/subagent-conversation-state.ts"

describe("Slate subagent conversation-state mapping", () => {
  it("uses the configured mapper when one exists", () => {
    const caller = { turns: ["parent"] }
    const mapped = { turns: ["mapped"] }
    assert.equal(
      mapSubagentConversationState(
        { conversationStateMapper: () => mapped },
        caller,
        { turns: [] },
      ),
      mapped,
    )
  })

  it("uses the supplied empty state instead of importing a wire constructor", () => {
    const caller = { turns: ["parent"] }
    const empty = { turns: [] as string[] }
    assert.equal(mapSubagentConversationState({}, caller, empty), empty)
    assert.notEqual(mapSubagentConversationState({}, caller, empty), caller)
  })
})
