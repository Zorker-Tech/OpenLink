import { test } from "node:test"
import assert from "node:assert/strict"

import {
  cloneSlateUserMessage,
  SlateSimulatedMessageReason,
  type SlateUserMessage,
} from "../../source/packages/agent/user-message-state.ts"
import { SlateMode } from "../../source/packages/agent/mode-processing.ts"
import { PrivacyCapability, DataClassification } from "../../source/packages/redaction/classification.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { createRedactedString } from "../../source/packages/redaction/create.ts"
import {
  createSlateUserMessageSerde,
  deserializeSlateUserMessageInterop,
} from "../../source/adapters/interop/agent/agent-state-message-serdes-adapter.ts"
import {
  fromInteropSimulatedMessageReason,
  fromInteropUserMessage,
  toInteropSimulatedMessageReason,
  toInteropUserMessage,
} from "../../source/adapters/interop/agent/user-message-action-protocol-adapter.ts"
import {
  AgentMode,
  CustomModeExitIntent,
  CustomModeIntent,
  ExecutePlanInfo,
  ProjectDetails,
  ProjectSubagentDetails,
  SimulatedMsgReason,
  TriggeringUserInfo,
  UserMessage,
  UserMessage_SimulatedMessageMetadata,
} from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { SelectedContext } from "../../source/adapters/interop/proto/generated/agent/v1/selected_context_pb.ts"
import { HookAdditionalContext } from "../../source/adapters/interop/proto/generated/agent/v1/hook_additional_context_pb.ts"

test("the user-message boundary preserves every top-level persisted field", () => {
  const selectedContext = new SelectedContext()
  const triggeringUserInfo = new TriggeringUserInfo({ authId: "user-1", userId: 7 })
  const executePlanInfo = new ExecutePlanInfo({ planId: "plan-1", planTitle: "Plan" })
  const simulatedMessageMetadata = new UserMessage_SimulatedMessageMetadata({
    title: "Task",
    taskId: "task-1",
  })
  const customModeIntent = new CustomModeIntent({
    intent: { case: "exit", value: new CustomModeExitIntent() },
  })
  const projectDetails = new ProjectDetails({
    name: "Project",
    subagent: new ProjectSubagentDetails({ storeDir: "/stores/subagent" }),
  })
  const message = new UserMessage({
    text: "hello",
    messageId: "message-1",
    selectedContext,
    mode: AgentMode.PLAN,
    isSimulatedMsg: true,
    bestOfNGroupId: "group-1",
    tryUseBestOfNPromotion: false,
    richText: "<p>hello</p>",
    simulatedMsgReason: SimulatedMsgReason.SUBSCRIPTION,
    conversationStateBlobId: new Uint8Array([1]),
    subagentSystemReminder: "reminder",
    triggeringUserInfo,
    executePlanInfo,
    simulatedMessageMetadata,
    promptReferenceId: "reference-1",
    threadId: "thread-1",
    textBlobId: new Uint8Array([2]),
    richTextBlobId: new Uint8Array([3]),
    hookAdditionalContexts: [new HookAdditionalContext({
      hookEventName: "agentStoreConflict",
      content: "notice",
    })],
    customModeIntent,
    projectDetails,
  })

  const slate = fromInteropUserMessage(message)
  const roundTripped = toInteropUserMessage(slate)

  assert.equal(slate.mode, SlateMode.PLAN)
  assert.equal(slate.simulatedMsgReason, SlateSimulatedMessageReason.SUBSCRIPTION)
  assert.deepEqual(slate.hookContexts, [{ event: "agentStoreConflict", text: "notice" }])
  assert.ok(UserMessage.equals(roundTripped, message))
  assert.notEqual(slate.conversationStateBlobId, message.conversationStateBlobId)
  assert.notEqual(slate.textBlobId, message.textBlobId)
  assert.notEqual(roundTripped.conversationStateBlobId, slate.conversationStateBlobId)
})

test("a future simulated-message reason survives the product boundary", () => {
  const slate = fromInteropSimulatedMessageReason(21 as SimulatedMsgReason)
  assert.equal(slate, "unknown-21")
  assert.equal(toInteropSimulatedMessageReason(slate), 21)
  assert.equal(fromInteropSimulatedMessageReason(undefined), undefined)
  assert.equal(
    fromInteropSimulatedMessageReason(SimulatedMsgReason.PR_TAB_BUGBOT_FIX),
    SlateSimulatedMessageReason.PR_TAB_AUTOMATED_REVIEW_FIX,
  )
  assert.equal(
    fromInteropSimulatedMessageReason(SimulatedMsgReason.RUN_BUGBOT_REVIEW),
    SlateSimulatedMessageReason.RUN_AUTOMATED_REVIEW,
  )
})

test("an unknown persisted mode uses Slate's fallback without losing the stored code", () => {
  const message = new UserMessage({
    text: "hello",
    messageId: "message-1",
    mode: 987654 as AgentMode,
  })

  const slate = fromInteropUserMessage(message)
  const roundTripped = toInteropUserMessage(slate)

  assert.equal(slate.mode, SlateMode.UNSPECIFIED)
  assert.equal(slate.compatibility?.legacyModeCode, 987654)
  assert.equal(roundTripped.mode, 987654)
})

test("copying a Slate user message does not retain caller-owned byte or context arrays", () => {
  const message: SlateUserMessage = {
    text: "hello",
    messageId: "message-1",
    mode: SlateMode.AGENT,
    conversationStateBlobId: new Uint8Array([1]),
    textBlobId: new Uint8Array([2]),
    hookContexts: [{ event: "event", text: "notice" }],
    projectDetails: { name: "Project", subagent: { storeDir: "/store" } },
  }

  const copy = cloneSlateUserMessage(message)
  message.conversationStateBlobId[0] = 9
  message.textBlobId![0] = 8
  message.projectDetails!.name = "Changed"

  assert.deepEqual(copy.conversationStateBlobId, new Uint8Array([1]))
  assert.deepEqual(copy.textBlobId, new Uint8Array([2]))
  assert.equal(copy.projectDetails?.name, "Project")
  assert.notEqual(copy.hookContexts, message.hookContexts)
})

test("project conversation details keep the label and both child kinds", () => {
  const sideChat = { storeDir: "/stores/side-chat" }
  const message = fromInteropUserMessage(new UserMessage({
    text: "hello",
    messageId: "message-1",
    projectDetails: new ProjectDetails({ name: "Project", sideChat: sideChat as never }),
  }))

  assert.deepEqual(message.projectDetails, {
    name: "Project",
    sideChat,
  })
})

test("user messages persist in Slate's versioned field schema and rehydrate every supported field", () => {
  const original = new UserMessage({
    text: "hello",
    messageId: "message-1",
    selectedContext: new SelectedContext(),
    mode: AgentMode.PLAN,
    isSimulatedMsg: false,
    bestOfNGroupId: "promotion-1",
    tryUseBestOfNPromotion: true,
    richText: "<p>hello</p>",
    simulatedMsgReason: SimulatedMsgReason.PLAN_EXECUTION,
    conversationStateBlobId: new Uint8Array([1, 2]),
    subagentSystemReminder: "reminder",
    triggeringUserInfo: new TriggeringUserInfo({ authId: "actor" }),
    executePlanInfo: new ExecutePlanInfo({ planId: "plan-1", planTitle: "Plan" }),
    simulatedMessageMetadata: new UserMessage_SimulatedMessageMetadata({ title: "Task", taskId: "task-1" }),
    promptReferenceId: "prompt-1",
    threadId: "thread-1",
    textBlobId: new Uint8Array([3]),
    richTextBlobId: new Uint8Array([4]),
    hookAdditionalContexts: [new HookAdditionalContext({ hookEventName: "postToolUse", content: "notice" })],
    customModeIntent: new CustomModeIntent({ intent: { case: "exit", value: new CustomModeExitIntent() } }),
    projectDetails: new ProjectDetails({
      name: "Project",
      subagent: new ProjectSubagentDetails({ storeDir: "/store" }),
    }),
  })
  const slate = fromInteropUserMessage(original)
  const serde = createSlateUserMessageSerde(PrivacyMode.UNSPECIFIED)
  const bytes = serde.serialize(slate)
  const json = new TextDecoder().decode(bytes)
  assert.ok(json.startsWith("SLATE-AGENT-USER\n"))
  assert.deepEqual(serde.getBlobType?.(), { kind: "json", typeName: "slate.agent-user-message" })
  const stored = JSON.parse(json.slice("SLATE-AGENT-USER\n".length)) as {
    format: string
    message: Record<string, unknown>
  }
  assert.equal(stored.format, "slate.agent-user-message")
  assert.equal(stored.message.id, "message-1")
  assert.equal(stored.message.mode, SlateMode.PLAN)
  assert.equal(Object.hasOwn(stored.message, "message_id"), false)

  const restored = toInteropUserMessage(serde.deserialize(bytes))
  assert.ok(UserMessage.equals(restored, original))
})

test("user-message privacy metadata and unknown legacy fields survive the migration write", () => {
  const selectedContext = new SelectedContext()
  SelectedContext.runtime.bin.onUnknownField(selectedContext, 101, 0, new Uint8Array([7]))
  const legacy = new UserMessage({ text: "legacy", messageId: "message-legacy", selectedContext })
  UserMessage.runtime.bin.onUnknownField(legacy, 100, 0, new Uint8Array([9]))
  const legacyBytes = legacy.toBinary()
  const serde = createSlateUserMessageSerde(PrivacyMode.NO_STORAGE)
  const imported = serde.deserialize(legacyBytes)
  assert.equal(imported.compatibility?.legacyUnknownFields?.length, 2)

  const redacted = {
    ...imported,
    text: createRedactedString("private prompt", DataClassification.CODE, "text", PrivacyMode.NO_STORAGE),
  }
  const rewritten = serde.serialize(redacted)
  const decoded = serde.deserialize(rewritten)
  if (typeof decoded.text === "string") assert.fail("expected redacted user-message text")
  assert.equal(decoded.text.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "private prompt")
  assert.equal(decoded.text.__classification, DataClassification.CODE)
  assert.equal(decoded.text.__fieldName, "text")

  const restored = deserializeSlateUserMessageInterop(rewritten)
  assert.equal(restored.getType().runtime.bin.listUnknownFields(restored).length, 1)
  assert.equal(restored.selectedContext?.getType().runtime.bin.listUnknownFields(restored.selectedContext).length, 1)
})
