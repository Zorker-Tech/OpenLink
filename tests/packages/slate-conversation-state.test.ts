import { test } from "node:test"
import assert from "node:assert/strict"

import {
  fromInteropConversationState,
  toInteropConversationState,
} from "../../source/adapters/interop/agent/agent-state-message-serdes-adapter.ts"
import { toRedactedConversationStateStructure } from "../../source/adapters/interop/redacted-protos/generated/agent/v1/agent_redacted.ts"
import {
  AgentMode,
  ConversationStateStructure,
} from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { SlateMode } from "../../source/packages/agent/mode-processing.ts"

test("conversation state projects its persisted mode and fields into Slate", () => {
  const source = new ConversationStateStructure({
    turns: [new Uint8Array([1]), new Uint8Array([2])],
    rootPromptMessagesJson: [new Uint8Array([3])],
    mode: AgentMode.PLAN,
    activeBranchName: "feature",
    conversationStartedTimestampMs: BigInt(10),
  })
  const redacted = toRedactedConversationStateStructure(source, PrivacyMode.NO_STORAGE)
  const slate = fromInteropConversationState(redacted)

  assert.equal(slate.mode, SlateMode.PLAN)
  assert.equal(slate.privacyMode, PrivacyMode.NO_STORAGE)
  assert.deepEqual(slate.turns, source.turns)
  assert.deepEqual(slate.rootPromptMessagesJson, source.rootPromptMessagesJson)
  assert.equal(slate.activeBranchName, "feature")
  assert.equal(slate.conversationStartedTimestampMs, BigInt(10))

  const roundTripped = toInteropConversationState(slate)
  assert.equal(roundTripped.mode, AgentMode.PLAN)
  assert.equal(roundTripped._privacyMode, PrivacyMode.NO_STORAGE)
})

test("an unknown conversation mode uses Slate's fallback without losing its source code", () => {
  const redacted = toRedactedConversationStateStructure(
    new ConversationStateStructure({ mode: 987654 as AgentMode }),
    PrivacyMode.NO_STORAGE,
  )
  const slate = fromInteropConversationState(redacted)
  const roundTripped = toInteropConversationState(slate)

  assert.equal(slate.mode, SlateMode.UNSPECIFIED)
  assert.equal(slate.unknownModeCode, 987654)
  assert.equal(roundTripped.mode, 987654)
})
