import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { UserMessage } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { toInteropHookContextMessages } from "../../source/adapters/interop/agent/hook-context-adapter.ts"
import { hookContextsFromUserMessageInterop } from "../../source/adapters/interop/agent/user-message-action-protocol-adapter.ts"

describe("user-message hook context projection", () => {
  it("hands Slate entries to the state machine", () => {
    const message = new UserMessage({
      hookAdditionalContexts: toInteropHookContextMessages([
        { event: "preToolUse", text: "first" },
        { event: "agentStoreConflict", text: "second" },
      ]),
    })

    assert.deepEqual(hookContextsFromUserMessageInterop(message), [
      { event: "preToolUse", text: "first" },
      { event: "agentStoreConflict", text: "second" },
    ])
  })

  it("treats a message written without the field as carrying no hook context", () => {
    const message = { hookAdditionalContexts: undefined } as unknown as UserMessage
    assert.deepEqual(hookContextsFromUserMessageInterop(message), [])
  })
})
