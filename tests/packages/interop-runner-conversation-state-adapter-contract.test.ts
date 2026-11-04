import assert from "node:assert/strict"
import test from "node:test"

import { ConversationStateStructure } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { cloneInteropRunnerConversationState } from "../../source/adapters/interop/agent/runner-conversation-state-adapter.ts"

test("the runner gets an independent copy of the Agent-owned checkpoint", () => {
  const source = new ConversationStateStructure({ turns: [new Uint8Array([1, 2])] })
  const copy = cloneInteropRunnerConversationState(source)

  assert.ok(copy instanceof ConversationStateStructure)
  assert.notEqual(copy, source)
  copy.turns.push(new Uint8Array([3]))
  assert.equal(source.turns.length, 1)
})

test("a value without the Agent message codec is not accepted as a checkpoint", () => {
  assert.equal(cloneInteropRunnerConversationState({ turns: [] }), undefined)
})
