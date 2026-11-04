import assert from "node:assert/strict"
import test from "node:test"

import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { ConversationAction, ConversationStateStructure, ResumeAction, UserMessage, UserMessageAction } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import {
  cloneInteropConversationState,
  projectInteropTurnRun,
} from "../../source/adapters/interop/agent/turn-agent-run-projection-adapter.ts"

test("the host takes an independent snapshot before projecting it to the Agent", () => {
  const source = new ConversationStateStructure({ turns: [new Uint8Array([1, 2])] })
  const copy = cloneInteropConversationState(source)

  assert.notEqual(copy, source)
  copy.turns.push(new Uint8Array([3]))
  assert.equal(source.turns.length, 1)
})

test("fresh runs keep their action while retries use the accepted checkpoint and empty resume action", () => {
  const baseState = new ConversationStateStructure({ turns: [new Uint8Array([1])] })
  const checkpoint = new ConversationStateStructure({ turns: [new Uint8Array([1]), new Uint8Array([2])] })
  const originalAction = new ConversationAction({
    action: {
      case: "userMessageAction",
      value: new UserMessageAction({ userMessage: new UserMessage({ text: "hello" }), prependUserMessages: [] }),
    },
  })
  const resumeAction = new ConversationAction({ action: { case: "resumeAction", value: new ResumeAction() } })

  const fresh = projectInteropTurnRun({ baseState, action: originalAction, resumeAction, privacyMode: PrivacyMode.UNSPECIFIED })
  const resumed = projectInteropTurnRun({ baseState, action: originalAction, resumeFrom: checkpoint, resumeAction, privacyMode: PrivacyMode.UNSPECIFIED })

  assert.equal(fresh.isResume, false)
  assert.equal(fresh.action.action.case, "userMessageAction")
  assert.equal(fresh.state.turns.length, 1)
  assert.equal((fresh.state as { _privacyMode?: unknown })._privacyMode, PrivacyMode.UNSPECIFIED)
  assert.equal(resumed.isResume, true)
  assert.equal(resumed.action.action.case, "resumeAction")
  assert.equal(resumed.state.turns.length, 2)
})
