import { test } from "node:test"
import assert from "node:assert/strict"

import { createRedactedString } from "../../source/packages/redaction/create.ts"
import { DataClassification, PrivacyCapability } from "../../source/packages/redaction/classification.ts"
import { RedactedString } from "../../source/packages/redaction/redacted-values.ts"
import { createContext } from "../../source/packages/context/context.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { SlateMode } from "../../source/packages/agent/mode-processing.ts"
import type { SlateUserMessage } from "../../source/packages/agent/user-message-state.ts"
import {
  InteractionUpdate,
  TaskToolCallDelta,
  TextDeltaUpdate,
  ToolCall,
  ToolCallDelta,
} from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { EditToolCallDelta } from "../../source/adapters/interop/proto/generated/agent/v1/edit_tool_pb.ts"
import { ReplaceEnvToolCallDelta } from "../../source/adapters/interop/proto/generated/agent/v1/replace_env_tool_pb.ts"
import { ShellArgs } from "../../source/adapters/interop/proto/generated/agent/v1/shell_exec_pb.ts"
import { ShellToolCallDelta, ShellToolCallStdoutDelta } from "../../source/adapters/interop/proto/generated/agent/v1/shell_tool_pb.ts"
import {
  interopToolCallDeltaFromSlateValue,
  redactSlateInteractionToolCallValue,
  redactSlateToolCallDeltaValue,
  slateInteractionToolCallValueFromInterop,
  slateToolCallDeltaValueFromInterop,
  unredactSlateInteractionToolCallValue,
  unredactSlateToolCallDeltaValue,
} from "../../source/adapters/interop/agent/interaction-tool-call-adapter.ts"
import {
  FeedbackRequestCategory,
  FeedbackRequestCategoryGroup,
} from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { Updates } from "../../source/packages/agent-core/interaction-updates.ts"
import { RedactedUpdates } from "../../source/packages/agent-core/redacted-interaction-updates.ts"
import {
  isSlateInteractionUpdate,
  isSlateRedactedInteractionUpdate,
  redactSlateInteractionUpdate,
  SlateInteractionUpdates,
  SlateRedactedInteractionUpdates,
  slateRedactedTurnEndedUpdate,
  slateTurnEndedUpdate,
  unredactSlateInteractionUpdate,
} from "../../source/packages/agent-core/slate-interaction-updates.ts"
import {
  redactSlateUserMessage,
  unredactSlateUserMessage,
} from "../../source/adapters/interop/agent/user-message-action-protocol-adapter.ts"
import * as agentCore from "../../source/packages/agent-core/index.ts"

const mode = PrivacyMode.NO_STORAGE

test("Slate interaction constructors build the local stream values", () => {
  const text = SlateInteractionUpdates.textDelta("hello")
  assert.deepEqual(text, { kind: "text-delta", text: "hello" })

  assert.deepEqual(SlateInteractionUpdates.heartbeat(), { kind: "heartbeat" })
  assert.equal(Updates.summaryStarted().message.case, "summaryStarted")
  assert.deepEqual(SlateInteractionUpdates.tokenDelta(42), { kind: "token-delta", tokens: 42 })
  assert.deepEqual(SlateInteractionUpdates.activeBranchChange("/repo", "main"), {
    kind: "active-branch-change",
    path: "/repo",
    branchName: "main",
  })

  assert.deepEqual(SlateInteractionUpdates.stepStarted(7), { kind: "step-started", stepId: 7 })
  assert.deepEqual(SlateInteractionUpdates.stepCompleted(7, 1500), { kind: "step-completed", stepId: 7, durationMs: 1500 })
  assert.deepEqual(SlateInteractionUpdates.promptSuggestion("try this"), { kind: "prompt-suggestion", suggestion: "try this" })
  assert.deepEqual(SlateInteractionUpdates.summary("summary text"), { kind: "summary", text: "summary text" })
  assert.deepEqual(SlateInteractionUpdates.summaryStarted(), { kind: "summary-started" })
  assert.deepEqual(SlateInteractionUpdates.summaryCompleted("hook message"), { kind: "summary-completed", hookMessage: "hook message" })
})

test("turn usage is converted to bigints, and an early end reports nothing", () => {
  const withUsage = slateTurnEndedUpdate({
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 5,
    reasoningTokens: 7,
  })
  assert.deepEqual(withUsage.usage, {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 5,
    reasoningTokens: 7,
  })

  const withoutReasoning = slateTurnEndedUpdate({
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
  })
  assert.equal(withoutReasoning.usage?.reasoningTokens, 0)

  const early = slateTurnEndedUpdate()
  assert.equal("usage" in early, false, "usage counts are omitted when the turn reported none")
})

test("a feedback request carries its categories and only the copy it was given", () => {
  const update = Updates.feedbackRequest("req-1", "some-model", [new FeedbackRequestCategory({ id: "good", label: "Good" })])
  const value = update.message.value as { categories: unknown[]; categoryGroups: unknown[]; title?: unknown }
  assert.equal(value.categories.length, 1)
  assert.equal(value.categoryGroups.length, 0)
  assert.equal(value.title, undefined, "copy is optional, so an omitted title stays absent")

  const withCopy = Updates.feedbackRequest(
    "req-2",
    undefined,
    [new FeedbackRequestCategory({ id: "good", label: "Good" })],
    [new FeedbackRequestCategoryGroup({
      id: "group",
      prompt: "How was it?",
      categories: [new FeedbackRequestCategory({ id: "x", label: "X" })],
    })],
    { title: "Rate this", commentPlaceholder: "Notes" },
  )
  const withCopyValue = withCopy.message.value as {
    canonicalModelName?: unknown
    categoryGroups: unknown[]
    title?: unknown
    commentPlaceholder?: unknown
    negativeTitle?: unknown
  }
  assert.equal(withCopyValue.canonicalModelName, undefined)
  assert.equal(withCopyValue.categoryGroups.length, 1)
  assert.equal(withCopyValue.title, "Rate this")
  assert.equal(withCopyValue.commentPlaceholder, "Notes")
  assert.equal(withCopyValue.negativeTitle, undefined)
})

test("a Slate redacted update carries the privacy-aware value without a generated envelope", () => {
  const update = SlateRedactedInteractionUpdates.textDelta("the secret", mode)
  assert.equal(update.privacyMode, mode)
  assert.equal(update.kind, "text-delta")
  assert.equal(update.text.__classification, DataClassification.CODE)
  assert.equal(update.text.__privacyMode, mode)
  assert.equal(update.text.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "the secret")

  const reasoning = SlateRedactedInteractionUpdates.thinkingDelta("private reasoning", mode, { kind: "custom", value: "custom-style" })
  assert.equal(isSlateRedactedInteractionUpdate(reasoning), true)
  assert.equal(reasoning.text.__classification, DataClassification.CODE)
  assert.deepEqual(reasoning.style, { kind: "custom", value: "custom-style" })
  assert.equal(isSlateRedactedInteractionUpdate({ ...reasoning, privacyMode: "not-a-policy" }), false)

  const summary = RedactedUpdates.summary(createRedactedString("summary", DataClassification.CODE, "summary", mode))
  assert.equal(summary._privacyMode, mode)

  const branch = SlateRedactedInteractionUpdates.activeBranchChange("/repo", "main", mode)
  assert.equal(branch.privacyMode, mode)
  assert.equal(branch.path.__classification, DataClassification.PATH)
  assert.equal(branch.path.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "/repo")
})

test("an update without text takes its privacy mode explicitly", () => {
  assert.equal(SlateRedactedInteractionUpdates.heartbeat(mode).privacyMode, mode)
  assert.equal(SlateRedactedInteractionUpdates.tokenDelta(5, mode).privacyMode, mode)
  assert.equal(SlateRedactedInteractionUpdates.thinkingCompleted(12, mode).privacyMode, mode)
  assert.deepEqual(SlateRedactedInteractionUpdates.stepStarted(3, mode), { kind: "step-started", privacyMode: mode, stepId: 3 })
  assert.deepEqual(SlateRedactedInteractionUpdates.stepCompleted(3, 10, mode), {
    kind: "step-completed",
    privacyMode: mode,
    stepId: 3,
    durationMs: 10,
  })
  assert.equal(SlateRedactedInteractionUpdates.promptSuggestion("try this", mode).privacyMode, mode)
})

test("step, suggestion and branch events round-trip through Slate privacy projection", () => {
  const updates = [
    SlateInteractionUpdates.stepStarted(2),
    SlateInteractionUpdates.stepCompleted(2, 15),
    SlateInteractionUpdates.promptSuggestion("try a narrower search"),
    SlateInteractionUpdates.activeBranchChange("/repo", "feature/branch"),
  ]

  for (const update of updates) {
    assert.equal(isSlateInteractionUpdate(update), true)
    const redacted = redactSlateInteractionUpdate(update, mode)
    assert.equal(isSlateRedactedInteractionUpdate(redacted), true)
    assert.equal(redacted.privacyMode, mode)
    assert.deepEqual(unredactSlateInteractionUpdate(redacted), update)
  }

  const redactedSuggestion = SlateRedactedInteractionUpdates.promptSuggestion("suggestion", mode)
  const redactedBranch = SlateRedactedInteractionUpdates.activeBranchChange("/repo", "main", mode)
  assert.equal(redactedSuggestion.suggestion.__classification, DataClassification.CODE)
  assert.equal(redactedBranch.path.__classification, DataClassification.PATH)
})

test("summary lifecycle and summary text round-trip through Slate privacy projection", () => {
  const updates = [
    SlateInteractionUpdates.summary("summary text"),
    SlateInteractionUpdates.summaryStarted(),
    SlateInteractionUpdates.summaryCompleted("hook message"),
    SlateInteractionUpdates.summaryCompleted(),
  ]

  for (const update of updates) {
    assert.equal(isSlateInteractionUpdate(update), true)
    const redacted = redactSlateInteractionUpdate(update, mode)
    assert.equal(isSlateRedactedInteractionUpdate(redacted), true)
    assert.equal(redacted.privacyMode, mode)
    assert.deepEqual(unredactSlateInteractionUpdate(redacted), update)
  }

  const summary = SlateRedactedInteractionUpdates.summary("summary text", mode)
  assert.equal(summary.text.__classification, DataClassification.CODE)
  assert.equal(summary.text.__privacyMode, mode)
  const existingSummary = createRedactedString("summary text", DataClassification.CODE, "summary", mode)
  assert.equal(SlateRedactedInteractionUpdates.summaryValue(existingSummary).text, existingSummary)
})

test("user-message append events round-trip through Slate privacy projection", () => {
  const message = {
    text: "private prompt",
    messageId: "message-appended",
    mode: SlateMode.AGENT,
    conversationStateBlobId: new Uint8Array([1, 2, 3]),
    hookContexts: [{ event: "context", text: "hook text" }],
  } satisfies SlateUserMessage
  const update = SlateInteractionUpdates.userMessageAppended(message)
  assert.equal(isSlateInteractionUpdate(update), true)
  assert.notEqual(update.message, message, "the builder owns its copy")

  const redacted = redactSlateInteractionUpdate(
    update,
    mode,
    undefined,
    undefined,
    redactSlateUserMessage,
  )
  assert.ok(isSlateRedactedInteractionUpdate(redacted))
  assert.equal(redacted.privacyMode, mode)
  assert.ok(redacted.kind === "user-message-appended")
  assert.equal(redacted.message.text instanceof RedactedString, true)
  assert.equal(redacted.message.hookContexts[0]?.text instanceof RedactedString, true)
  assert.equal(
    (redacted.message.text as RedactedString).unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
    "private prompt",
  )
  assert.deepEqual(
    unredactSlateInteractionUpdate(redacted, undefined, undefined, unredactSlateUserMessage),
    update,
  )

  assert.throws(
    () => redactSlateInteractionUpdate(update, mode),
    /user-message redaction adapter/,
  )
})

test("feedback requests round-trip through Slate privacy projection", () => {
  const update = SlateInteractionUpdates.feedbackRequest(
    "request-1",
    "model-x",
    [{ id: "good", label: "Good" }],
    [{ id: "group", prompt: "How was it?", categories: [{ id: "x", label: "X" }] }],
    { title: "Title", negativeTitle: "Not this", commentPlaceholder: "Say more" },
    true,
  )
  assert.equal(isSlateInteractionUpdate(update), true)
  assert.deepEqual(update.categories, [{ id: "good", label: "Good" }])
  assert.equal(update.showFormImmediately, true)

  const redacted = redactSlateInteractionUpdate(update, mode)
  assert.ok(isSlateRedactedInteractionUpdate(redacted))
  assert.equal(redacted.privacyMode, mode)
  assert.deepEqual(unredactSlateInteractionUpdate(redacted), update)

  const minimal = SlateInteractionUpdates.feedbackRequest("request-2", undefined, [])
  assert.equal("canonicalModelName" in minimal, false)
  assert.equal("copy" in minimal, false)
  assert.equal("showFormImmediately" in minimal, false)
})

test("Slate tool-call events round-trip through the interop privacy boundary", () => {
  const toolCall = slateInteractionToolCallValueFromInterop(new ToolCall({
    tool: { case: "shellToolCall", value: { args: new ShellArgs({ command: "echo private" }) } as never },
  }), "call-privacy")
  const update = SlateInteractionUpdates.toolCallStarted("call-privacy", toolCall, "model-privacy")
  const redacted = redactSlateInteractionUpdate(update, mode, redactSlateInteractionToolCallValue)
  assert.equal(isSlateRedactedInteractionUpdate(redacted), true)
  assert.equal(redacted.kind, "tool-call-update")
  assert.equal(redacted.toolCall?.tool.kind, "shell")
  const redactedCommand = redacted.toolCall?.tool.kind === "shell" ? redacted.toolCall.tool.args?.command : undefined
  assert.equal(typeof redactedCommand, "object")
  assert.equal((redactedCommand as { readonly __privacyMode?: string }).__privacyMode, mode)
  assert.deepEqual(unredactSlateInteractionUpdate(redacted, unredactSlateInteractionToolCallValue), update)
})

test("Slate tool-call deltas preserve operation data through the privacy boundary", () => {
  const deltas = [
    new ToolCallDelta({
      delta: { case: "editToolCallDelta", value: new EditToolCallDelta({ streamContentDelta: "patch text" }) },
    }),
    new ToolCallDelta({
      delta: {
        case: "shellToolCallDelta",
        value: new ShellToolCallDelta({ delta: { case: "stdout", value: new ShellToolCallStdoutDelta({ content: "shell output" }) } }),
      },
    }),
    new ToolCallDelta({
      delta: {
        case: "taskToolCallDelta",
        value: new TaskToolCallDelta({
          interactionUpdate: new InteractionUpdate({
            message: { case: "textDelta", value: new TextDeltaUpdate({ text: "task output" }) },
          }),
        }),
      },
    }),
    new ToolCallDelta({
      delta: { case: "replaceEnvToolCallDelta", value: new ReplaceEnvToolCallDelta({ associatedPodKey: "environment-1" }) },
    }),
    new ToolCallDelta(),
  ]

  const updates = deltas.map((delta, index) => {
    const slateDelta = slateToolCallDeltaValueFromInterop(delta)
    assert.ok(slateDelta)
    const update = SlateInteractionUpdates.toolCallDelta(`call-${index}`, slateDelta, `model-${index}`)
    assert.equal(isSlateInteractionUpdate(update), true)
    const redacted = redactSlateInteractionUpdate(update, mode, undefined, redactSlateToolCallDeltaValue)
    assert.equal(isSlateRedactedInteractionUpdate(redacted), true)
    const restored = unredactSlateInteractionUpdate(redacted, undefined, unredactSlateToolCallDeltaValue)
    assert.equal(restored.kind, "tool-call-delta")
    if (restored.kind !== "tool-call-delta" || restored.delta === undefined) assert.fail("expected the streamed delta value")
    assert.equal(restored.callId, `call-${index}`)
    assert.equal(restored.modelCallId, `model-${index}`)
    assert.deepEqual(interopToolCallDeltaFromSlateValue(restored.delta).toBinary(), delta.toBinary())
    return restored
  })

  assert.deepEqual(updates.map(update => update.delta?.kind), [
    "edit-content",
    "shell-output",
    "legacy",
    "environment-assignment",
    "legacy",
  ])

  const unknown = ToolCallDelta.fromBinary(new Uint8Array([0x2a, 0x01, 0x78]))
  const unknownSlateValue = slateToolCallDeltaValueFromInterop(unknown)
  assert.deepEqual(interopToolCallDeltaFromSlateValue(unknownSlateValue!).toBinary(), unknown.toBinary())

  const absent = SlateInteractionUpdates.toolCallDelta("call-none", undefined, "model-none")
  assert.equal(isSlateInteractionUpdate(absent), true)
  assert.deepEqual(unredactSlateInteractionUpdate(redactSlateInteractionUpdate(absent, mode)), absent)
})

test("redacted turn usage converts the same way, and stays absent when there is none", () => {
  const withUsage = slateRedactedTurnEndedUpdate(mode, {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 5,
  })
  const value = withUsage.usage
  assert.equal(value?.inputTokens, 100)
  assert.equal(value?.reasoningTokens, 0, "an omitted reasoning count becomes zero when usage exists")

  const none = slateRedactedTurnEndedUpdate(mode, undefined)
  assert.equal("usage" in none, false)
})

test("a context injection state is reported in the shape of its kind", () => {
  const queued = RedactedUpdates.contextInjectionState(mode, "inj-1", { kind: "queued" })
  const queuedState = (queued.message.value as unknown as { state: { state: { case: string } } }).state
  assert.equal(queuedState.state.case, "queued")

  const delivered = RedactedUpdates.contextInjectionState(mode, "inj-2", {
    kind: "delivered",
    step: "step-1",
    deliveryBatchId: "batch-1",
    deliveredAtMs: 1_700_000_000_000,
  })
  const deliveredState = (delivered.message.value as unknown as {
    state: { state: { case: string; value: { deliveredAtMs?: bigint } } }
  }).state
  assert.equal(deliveredState.state.case, "delivered")
  assert.equal(deliveredState.state.value.deliveredAtMs, BigInt(1_700_000_000_000))

  const rejected = RedactedUpdates.contextInjectionState(mode, "inj-3", { kind: "rejected", reason: "too late" })
  const rejectedState = (rejected.message.value as unknown as {
    state: { state: { case: string; value: { reason?: unknown } } }
  }).state
  assert.equal(rejectedState.state.case, "rejected")
  assert.equal(rejectedState.state.value.reason, "too late")

  assert.equal(
    (RedactedUpdates.contextInjectionState(mode, "inj-4", { kind: "queued_for_next_turn" }).message.value as unknown as {
      state: { state: { case: string } }
    }).state.state.case,
    "queuedForNextTurn",
  )
})

test("redacted feedback categories carry the mode with each entry", () => {
  const update = RedactedUpdates.feedbackRequest(
    "req-1",
    "some-model",
    mode,
    [new FeedbackRequestCategory({ id: "good", label: "Good" })],
    [new FeedbackRequestCategoryGroup({
      id: "group",
      prompt: "How was it?",
      categories: [new FeedbackRequestCategory({ id: "x", label: "X" })],
    })],
  )
  const value = update.message.value as unknown as {
    categories: { _privacyMode?: PrivacyMode; id?: unknown }[]
    categoryGroups: { _privacyMode?: PrivacyMode; categories: { _privacyMode?: PrivacyMode }[] }[]
    showFormImmediately?: boolean
  }
  assert.equal(value.categories[0]?._privacyMode, mode)
  assert.equal(value.categoryGroups[0]?._privacyMode, mode)
  assert.equal(value.categoryGroups[0]?.categories[0]?._privacyMode, mode)
  assert.equal(value.showFormImmediately, false)
})

test("a conversation with no queue behind it reports nothing queued", async () => {
  const receiver = new agentCore.NoopConversationActionReceiver()
  const context = createContext()
  assert.equal(await receiver.peek(context), undefined)
  assert.equal(await receiver.pop(context), undefined)
})

test("the action inbox keeps its message shape owned by the caller", async () => {
  type Action = { readonly kind: "resume"; readonly requestId: string }
  const action: Action = { kind: "resume", requestId: "request-1" }
  const inbox: agentCore.AgentActionInbox<Action> = {
    async peek() { return { action } },
    async pop() { return undefined },
  }
  assert.deepEqual(await inbox.peek(createContext()), { action })
  assert.equal(await inbox.pop(createContext()), undefined)
})

test("the module's surface is reachable from one place", () => {
  for (const name of [
    "Updates",
    "RedactedUpdates",
    "Responses",
    "NoopInteractionListener",
    "buildGoalPursuitGuidelines",
    "goalElapsedMs",
    "queryWebSearch",
    "NoopConversationActionReceiver",
  ]) {
    assert.equal(name in agentCore, true, `${name} is exported`)
  }
  assert.equal("toRedactedInteractionListener" in agentCore, false, "the generated-message bridge stays in interop")
})
