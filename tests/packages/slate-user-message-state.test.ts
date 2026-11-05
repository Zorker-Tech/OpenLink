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
import { RedactedString } from "../../source/packages/redaction/redacted-values.ts"
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
  CustomModeSource,
  AgentMode,
  CustomModeExitIntent,
  CustomModeIntent,
  ExecutePlanInfo,
  ProjectDetails,
  ProjectSubagentDetails,
  SimulatedMsgReason,
  SubscriptionEventDisplay,
  SubscriptionSource,
  SubmittedCustomMode,
  SubmittedExitedCustomMode,
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
    fsdFindingAction: "apply",
    url: "https://example.test/task",
    subscriptionSource: SubscriptionSource.GITHUB,
    subscriptionEventDisplay: new SubscriptionEventDisplay({
      displayLabel: "Pull request",
      resourceUrl: "https://example.test/pr/1",
      subscriptionId: "subscription-1",
    }),
  })
  const customModeIntent = new CustomModeIntent({
    intent: {
      case: "enter",
      value: new SubmittedCustomMode({
        id: "mode-1",
        label: "Review",
        source: CustomModeSource.PLUGIN_SKILL,
        sourcePath: "/plugins/review.md",
        sourceHash: "hash-1",
        managedSkillId: "managed-1",
        pluginId: "plugin-1",
        pluginSnapshotToken: "snapshot-token",
      }),
    },
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
  assert.deepEqual(slate.planExecution, { id: "plan-1", title: "Plan" })
  assert.deepEqual(slate.triggeringActor, { authId: "user-1", userId: 7 })
  assert.deepEqual(slate.simulation, {
    title: "Task",
    taskId: "task-1",
    findingAction: "apply",
    url: "https://example.test/task",
    subscriptionSource: "github",
    subscriptionEvent: {
      label: "Pull request",
      resourceUrl: "https://example.test/pr/1",
      subscriptionId: "subscription-1",
    },
  })
  assert.deepEqual(slate.modeIntent, {
    kind: "enter",
    mode: {
      id: "mode-1",
      label: "Review",
      source: "plugin-skill",
      sourcePath: "/plugins/review.md",
      sourceHash: "hash-1",
      managedSkillId: "managed-1",
      pluginId: "plugin-1",
      pluginSnapshotToken: "snapshot-token",
    },
  })
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

test("unknown subscription and custom-mode enum values survive the Slate boundary and storage", () => {
  const simulation = new UserMessage_SimulatedMessageMetadata({
    subscriptionSource: 91 as SubscriptionSource,
  })
  const exitIntent = new CustomModeIntent({
    intent: { case: "exit", value: new CustomModeExitIntent({ nextMode: 92 as AgentMode }) },
  })
  const exitSlate = fromInteropUserMessage(new UserMessage({
    text: "exit",
    messageId: "exit-message",
    conversationStateBlobId: new Uint8Array([1]),
    simulatedMessageMetadata: simulation,
    customModeIntent: exitIntent,
  }))
  assert.equal(exitSlate.simulation?.subscriptionSource, "unknown-91")
  assert.deepEqual(exitSlate.modeIntent, { kind: "exit", nextMode: { kind: "unrecognized", code: 92 } })

  const enterIntent = new CustomModeIntent({
    intent: {
      case: "enter",
      value: new SubmittedCustomMode({ id: "mode-1", label: "Mode", source: 93 as CustomModeSource }),
    },
  })
  const enterSlate = fromInteropUserMessage(new UserMessage({
    text: "enter",
    messageId: "enter-message",
    conversationStateBlobId: new Uint8Array([2]),
    customModeIntent: enterIntent,
  }))
  assert.equal(enterSlate.modeIntent?.kind, "enter")
  if (enterSlate.modeIntent?.kind !== "enter") assert.fail("expected custom-mode entry")
  assert.equal(enterSlate.modeIntent.mode.source, "unknown-93")

  const serde = createSlateUserMessageSerde(PrivacyMode.UNSPECIFIED)
  for (const [slate, original] of [[exitSlate, new UserMessage({
    text: "exit", messageId: "exit-message", conversationStateBlobId: new Uint8Array([1]),
    simulatedMessageMetadata: simulation, customModeIntent: exitIntent,
  })], [enterSlate, new UserMessage({
    text: "enter", messageId: "enter-message", conversationStateBlobId: new Uint8Array([2]),
    customModeIntent: enterIntent,
  })]] as const) {
    const restored = serde.deserialize(serde.serialize(slate))
    assert.ok(UserMessage.equals(toInteropUserMessage(restored), original))
  }
})

test("simulation and custom-mode redacted fields keep their classifications in Slate storage", () => {
  const serde = createSlateUserMessageSerde(PrivacyMode.NO_STORAGE)
  const message: SlateUserMessage = {
    text: "metadata",
    messageId: "metadata-message",
    mode: SlateMode.AGENT,
    conversationStateBlobId: new Uint8Array([1]),
    hookContexts: [],
    simulation: {
      title: createRedactedString("Title", DataClassification.CODE, "title", PrivacyMode.NO_STORAGE),
      url: createRedactedString("https://example.test", DataClassification.CODE, "url", PrivacyMode.NO_STORAGE),
      subscriptionEvent: {
        label: createRedactedString("Label", DataClassification.CODE, "display_label", PrivacyMode.NO_STORAGE),
        resourceUrl: createRedactedString("https://example.test/event", DataClassification.CODE, "resource_url", PrivacyMode.NO_STORAGE),
      },
    },
    modeIntent: {
      kind: "enter",
      mode: {
        id: createRedactedString("mode-id", DataClassification.PATH, "id", PrivacyMode.NO_STORAGE),
        label: "Mode",
        source: "plugin-skill",
        sourcePath: createRedactedString("/mode/path", DataClassification.PATH, "source_path", PrivacyMode.NO_STORAGE),
        pluginSnapshotToken: createRedactedString("snapshot", DataClassification.CREDENTIALS, "plugin_snapshot_token", PrivacyMode.NO_STORAGE),
      },
    },
  }

  const restored = serde.deserialize(serde.serialize(message))
  const assertRedacted = (value: unknown, expectedText: string, fieldName: string, classification: DataClassification) => {
    if (!(value instanceof RedactedString)) assert.fail(`expected redacted ${fieldName}`)
    assert.equal(value.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), expectedText)
    assert.equal(value.__classification, classification)
    assert.equal(value.__fieldName, fieldName)
  }
  assertRedacted(restored.simulation?.title, "Title", "title", DataClassification.CODE)
  assertRedacted(restored.simulation?.url, "https://example.test", "url", DataClassification.CODE)
  assertRedacted(restored.simulation?.subscriptionEvent?.label, "Label", "display_label", DataClassification.CODE)
  assertRedacted(restored.simulation?.subscriptionEvent?.resourceUrl, "https://example.test/event", "resource_url", DataClassification.CODE)
  if (restored.modeIntent?.kind !== "enter") assert.fail("expected restored custom-mode entry")
  assertRedacted(restored.modeIntent.mode.id, "mode-id", "id", DataClassification.PATH)
  assertRedacted(restored.modeIntent.mode.sourcePath, "/mode/path", "source_path", DataClassification.PATH)
  assertRedacted(restored.modeIntent.mode.pluginSnapshotToken, "snapshot", "plugin_snapshot_token", DataClassification.CREDENTIALS)
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
  const planExecution = { id: "plan-1", title: "Plan" }
  const message: SlateUserMessage = {
    text: "hello",
    messageId: "message-1",
    mode: SlateMode.AGENT,
    conversationStateBlobId: new Uint8Array([1]),
    textBlobId: new Uint8Array([2]),
    hookContexts: [{ event: "event", text: "notice" }],
    planExecution,
    projectDetails: { name: "Project", subagent: { storeDir: "/store" } },
  }

  const copy = cloneSlateUserMessage(message)
  message.conversationStateBlobId[0] = 9
  message.textBlobId![0] = 8
  planExecution.title = "Changed"
  message.projectDetails!.name = "Changed"

  assert.deepEqual(copy.conversationStateBlobId, new Uint8Array([1]))
  assert.deepEqual(copy.textBlobId, new Uint8Array([2]))
  assert.deepEqual(copy.planExecution, { id: "plan-1", title: "Plan" })
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
    version: number
    message: Record<string, unknown>
  }
  assert.equal(stored.format, "slate.agent-user-message")
  assert.equal(stored.version, 3)
  const storedPlan = stored.message.planExecution as { id?: unknown; title?: unknown }
  assert.deepEqual(storedPlan, {
    id: { kind: "string", value: "plan-1" },
    title: { kind: "string", value: "Plan" },
  })
  assert.deepEqual(stored.message.actor, { authId: "actor" })
  assert.deepEqual(stored.message.simulation, {
    title: { kind: "string", value: "Task" },
    taskId: "task-1",
  })
  assert.deepEqual(stored.message.modeIntent, { kind: "exit", nextMode: "unspecified" })
  assert.deepEqual(serde.deserialize(bytes).planExecution, { id: "plan-1", title: "Plan" })
  assert.equal(stored.message.id, "message-1")
  assert.equal(stored.message.mode, SlateMode.PLAN)
  assert.equal(Object.hasOwn(stored.message, "message_id"), false)

  const restored = toInteropUserMessage(serde.deserialize(bytes))
  assert.ok(UserMessage.equals(restored, original))
})

test("version-one and version-two message metadata migrate to typed Slate version three", () => {
  const serde = createSlateUserMessageSerde(PrivacyMode.UNSPECIFIED)
  const slate: SlateUserMessage = {
    text: "execute this plan",
    messageId: "plan-message",
    mode: SlateMode.PLAN,
    conversationStateBlobId: new Uint8Array([1]),
    hookContexts: [],
    planExecution: { id: "plan-1", title: "Plan" },
    triggeringActor: { authId: "actor-1", userId: 7 },
    simulation: {
      title: "Task",
      taskId: "task-1",
      findingAction: "apply",
      url: "https://example.test/task",
      subscriptionSource: "github",
      subscriptionEvent: { label: "Pull request", resourceUrl: "https://example.test/pr/1", subscriptionId: "sub-1" },
    },
    modeIntent: {
      kind: "enter",
      mode: {
        id: "mode-1",
        label: "Review",
        source: "plugin-skill",
        sourcePath: "/plugins/review.md",
        sourceHash: "hash-1",
        managedSkillId: "managed-1",
        pluginId: "plugin-1",
        pluginSnapshotToken: "snapshot-token",
      },
    },
  }
  const currentBytes = serde.serialize(slate)
  const currentEnvelope = JSON.parse(new TextDecoder().decode(currentBytes).slice("SLATE-AGENT-USER\n".length)) as {
    version: number
    message: Record<string, unknown>
  }
  const stringValue = (value: string) => ({ kind: "string", value })
  const numberValue = (value: number) => ({ kind: "number", value })
  const objectValue = (entries: readonly (readonly [string, unknown])[]) => ({ kind: "object", entries })
  const legacyActor = objectValue([["authId", stringValue("actor-1")], ["userId", numberValue(7)], ["_privacyMode", numberValue(0)]])
  const legacySimulation = objectValue([
    ["title", stringValue("Task")],
    ["taskId", stringValue("task-1")],
    ["fsdFindingAction", stringValue("apply")],
    ["url", stringValue("https://example.test/task")],
    ["subscriptionSource", numberValue(2)],
    ["subscriptionEventDisplay", objectValue([
      ["displayLabel", stringValue("Pull request")],
      ["resourceUrl", stringValue("https://example.test/pr/1")],
      ["subscriptionId", stringValue("sub-1")],
    ])],
  ])
  const legacyModeIntent = objectValue([[
    "intent",
    objectValue([
      ["case", stringValue("enter")],
      ["value", objectValue([
        ["id", stringValue("mode-1")],
        ["label", stringValue("Review")],
        ["source", numberValue(2)],
        ["sourcePath", stringValue("/plugins/review.md")],
        ["sourceHash", stringValue("hash-1")],
        ["managedSkillId", stringValue("managed-1")],
        ["pluginId", stringValue("plugin-1")],
        ["pluginSnapshotToken", stringValue("snapshot-token")],
      ])],
    ]),
  ]])

  for (const version of [1, 2] as const) {
    const envelope = JSON.parse(JSON.stringify(currentEnvelope)) as {
      version: number
      message: Record<string, unknown>
    }
    envelope.version = version
    envelope.message.actor = legacyActor
    envelope.message.simulation = legacySimulation
    envelope.message.modeIntent = legacyModeIntent
    envelope.message.planExecution = version === 1
      ? objectValue([
          ["planId", stringValue("plan-1")],
          ["planTitle", stringValue("Plan")],
          ["_privacyMode", numberValue(0)],
        ])
      : { id: stringValue("plan-1"), title: stringValue("Plan") }
    const oldBytes = new TextEncoder().encode(`SLATE-AGENT-USER\n${JSON.stringify(envelope)}`)

    const imported = serde.deserialize(oldBytes)
    assert.deepEqual(imported.planExecution, { id: "plan-1", title: "Plan" })
    assert.deepEqual(imported.triggeringActor, { authId: "actor-1", userId: 7 })
    assert.deepEqual(imported.simulation, slate.simulation)
    assert.deepEqual(imported.modeIntent, slate.modeIntent)
    assert.ok(UserMessage.equals(toInteropUserMessage(imported), toInteropUserMessage(slate)))

    const migratedBytes = serde.serialize(imported)
    const migrated = JSON.parse(new TextDecoder().decode(migratedBytes).slice("SLATE-AGENT-USER\n".length)) as {
      version: number
      message: Record<string, unknown>
    }
    assert.equal(migrated.version, 3)
    assert.equal((migrated.message.actor as { authId?: string }).authId, "actor-1")
    assert.deepEqual(migrated.message.modeIntent, {
      kind: "enter",
      mode: {
        id: stringValue("mode-1"),
        label: "Review",
        source: "plugin-skill",
        sourcePath: stringValue("/plugins/review.md"),
        sourceHash: "hash-1",
        managedSkillId: "managed-1",
        pluginId: "plugin-1",
        pluginSnapshotToken: stringValue("snapshot-token"),
      },
    })
  }
})

test("plan execution title redaction survives the versioned Slate storage envelope", () => {
  const serde = createSlateUserMessageSerde(PrivacyMode.NO_STORAGE)
  const message: SlateUserMessage = {
    text: "execute this plan",
    messageId: "plan-message",
    mode: SlateMode.PLAN,
    conversationStateBlobId: new Uint8Array([1]),
    hookContexts: [],
    planExecution: {
      id: "plan-1",
      title: createRedactedString("Private plan", DataClassification.CODE, "plan_title", PrivacyMode.NO_STORAGE),
    },
  }
  const restored = serde.deserialize(serde.serialize(message))
  const title = restored.planExecution?.title
  if (title === undefined || typeof title === "string") assert.fail("expected the plan title to remain redacted")
  assert.equal(title.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "Private plan")
  assert.equal(title.__classification, DataClassification.CODE)
  assert.equal(title.__fieldName, "plan_title")
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

test("unknown fields inside legacy user-message metadata survive Slate conversion", () => {
  const info = new ExecutePlanInfo({ planId: "plan-1", planTitle: "Plan" })
  ExecutePlanInfo.runtime.bin.onUnknownField(info, 101, 0, new Uint8Array([7]))
  const actor = new TriggeringUserInfo({ authId: "actor-1", userId: 7 })
  TriggeringUserInfo.runtime.bin.onUnknownField(actor, 102, 0, new Uint8Array([8]))
  const subscriptionDisplay = new SubscriptionEventDisplay({ displayLabel: "PR" })
  SubscriptionEventDisplay.runtime.bin.onUnknownField(subscriptionDisplay, 103, 0, new Uint8Array([9]))
  const simulation = new UserMessage_SimulatedMessageMetadata({
    title: "Task",
    subscriptionEventDisplay: subscriptionDisplay,
  })
  UserMessage_SimulatedMessageMetadata.runtime.bin.onUnknownField(simulation, 104, 0, new Uint8Array([10]))
  const submittedMode = new SubmittedCustomMode({ id: "mode-1", label: "Mode", source: CustomModeSource.PLUGIN_SKILL })
  SubmittedCustomMode.runtime.bin.onUnknownField(submittedMode, 105, 0, new Uint8Array([11]))
  const intent = new CustomModeIntent({ intent: { case: "enter", value: submittedMode } })
  CustomModeIntent.runtime.bin.onUnknownField(intent, 106, 0, new Uint8Array([12]))
  const legacy = new UserMessage({
    text: "Start this plan",
    messageId: "kickoff",
    triggeringUserInfo: actor,
    executePlanInfo: info,
    simulatedMessageMetadata: simulation,
    customModeIntent: intent,
  })

  const slate = fromInteropUserMessage(legacy)
  assert.deepEqual(slate.planExecution, { id: "plan-1", title: "Plan" })
  assert.equal(slate.compatibility?.legacyUnknownFields?.length, 6)

  const restored = toInteropUserMessage(slate)
  assert.deepEqual(restored.executePlanInfo?.getType().runtime.bin.listUnknownFields(restored.executePlanInfo).map(field => [...field.data]), [[7]])
  assert.deepEqual(restored.triggeringUserInfo?.getType().runtime.bin.listUnknownFields(restored.triggeringUserInfo).map(field => [...field.data]), [[8]])
  assert.deepEqual(restored.simulatedMessageMetadata?.getType().runtime.bin.listUnknownFields(restored.simulatedMessageMetadata).map(field => [...field.data]), [[10]])
  assert.deepEqual(restored.simulatedMessageMetadata?.subscriptionEventDisplay?.getType().runtime.bin.listUnknownFields(restored.simulatedMessageMetadata.subscriptionEventDisplay).map(field => [...field.data]), [[9]])
  assert.deepEqual(restored.customModeIntent?.getType().runtime.bin.listUnknownFields(restored.customModeIntent).map(field => [...field.data]), [[12]])
  if (restored.customModeIntent?.intent.case !== "enter") assert.fail("expected custom-mode entry")
  assert.deepEqual(restored.customModeIntent.intent.value.getType().runtime.bin.listUnknownFields(restored.customModeIntent.intent.value).map(field => [...field.data]), [[11]])
})
