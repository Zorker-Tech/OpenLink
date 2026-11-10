import assert from "node:assert/strict"
import test from "node:test"

import { AgentMode } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { toAgentNotesPromptInput } from "../../source/adapters/interop/agent/agent-notes-context-adapter.ts"

test("the counterpart project mode is reduced to the Slate notes-context decision", () => {
  const common = {
    enableAgentNotes: true,
    metaAgentNotes: false,
    conversationNotesListing: "conversation.md",
    sharedNotesListing: "shared.md",
  }

  assert.deepEqual(toAgentNotesPromptInput({ ...common, mode: AgentMode.PROJECT }), {
    isProjectConversation: true,
    ...common,
  })
  assert.deepEqual(toAgentNotesPromptInput({ ...common, mode: AgentMode.AGENT }), {
    isProjectConversation: false,
    ...common,
  })
})
