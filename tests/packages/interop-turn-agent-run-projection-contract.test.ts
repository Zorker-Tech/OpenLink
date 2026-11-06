import assert from "node:assert/strict"
import test from "node:test"

import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { PrivacyCapability } from "../../source/packages/redaction/classification.ts"
import { RedactedBytes, RedactedString } from "../../source/packages/redaction/redacted-values.ts"
import { SlateAgentActionKind, type SlateUserMessageActionPayload } from "../../source/packages/agent/agent-action-state.ts"
import { ConversationAction, ConversationStateStructure, ResumeAction, UserMessage, UserMessageAction } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { slateTurnActionFromPrompt } from "../../source/adapters/interop/agent/prompt-action-adapter.ts"
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
  assert.equal(fresh.action.kind, "user-message")
  assert.equal(fresh.state.turns.length, 1)
  assert.equal((fresh.state as { _privacyMode?: unknown })._privacyMode, PrivacyMode.UNSPECIFIED)
  assert.equal(resumed.isResume, true)
  assert.equal(resumed.action.kind, "resume")
  assert.equal(resumed.state.turns.length, 2)
})

test("Slate prompt actions keep their owned payload and apply run privacy at the runner boundary", () => {
  const baseState = new ConversationStateStructure({ turns: [new Uint8Array([1])] })
  const nativeAction = slateTurnActionFromPrompt({
    text: "private prompt",
    messageId: "message-1",
    selectedImages: [{ data: new Uint8Array([4, 5]), path: "/workspace/image.png", mimeType: "image/png" }],
    selectedVideos: [],
    prependUserMessages: [{ text: "earlier message", messageId: "earlier-1" }],
    automationStatusReminder: null,
    automationStatusCompactionEpoch: 0,
  }).action

  const projection = projectInteropTurnRun({
    baseState,
    action: nativeAction,
    resumeAction: new ConversationAction({ action: { case: "resumeAction", value: new ResumeAction() } }),
    privacyMode: PrivacyMode.NO_STORAGE,
  })
  const payload = projection.action.payload as SlateUserMessageActionPayload
  assert.equal(projection.action.kind, SlateAgentActionKind.USER_MESSAGE)
  assert.equal(projection.action.context.privacyMode, PrivacyMode.NO_STORAGE)
  assert.equal(payload.schema, "slate.agent-action.user-message")
  assert.equal(payload.message?.text instanceof RedactedString, true)
  if (payload.message?.text instanceof RedactedString) {
    assert.equal(payload.message.text.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "private prompt")
  }
  assert.equal(payload.earlierMessages[0]?.text instanceof RedactedString, true)
  const selectedImage = payload.message?.selectedContext?.media.images[0]
  assert.equal(selectedImage?.path instanceof RedactedString, true)
  assert.equal(selectedImage?.content?.kind, "inline")
  if (selectedImage?.content?.kind === "inline") {
    assert.equal(selectedImage.content.bytes instanceof RedactedBytes, true)
    if (selectedImage.content.bytes instanceof RedactedBytes) {
      assert.deepEqual(selectedImage.content.bytes.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), new Uint8Array([4, 5]))
    }
  }
})
