import assert from "node:assert/strict"
import { test } from "node:test"

import {
  ActiveBranchChange,
  ContextInjectionState,
  ContextInjectionQueued,
  ContextInjectionStateUpdate,
  FeedbackRequestCategory,
  FeedbackRequestCategoryGroup,
  FeedbackRequestUpdate,
  HeartbeatUpdate,
  InteractionUpdate,
  PartialToolCallUpdate,
  PostRequestPromptUpdate,
  PromptSuggestionUpdate,
  ResponseComparisonUpdate,
  ResponseComparisonStarted,
  RoutedModelUpdate,
  ShellOutputDeltaUpdate,
  StepCompletedUpdate,
  StepStartedUpdate,
  SummaryCompletedUpdate,
  SummaryStartedUpdate,
  SummaryUpdate,
  TextDeltaUpdate,
  ThinkingCompletedUpdate,
  ThinkingDeltaUpdate,
  TokenDeltaUpdate,
  ToolCallCompletedUpdate,
  ToolCallDeltaUpdate,
  ToolCallDelta,
  ToolCallStartedUpdate,
  TaskToolCall,
  TaskToolCallDelta,
  TurnEndedUpdate,
  UserMessageAppendedUpdate,
  UserMessage,
  ToolCall,
} from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { ShellStreamStdout } from "../../source/adapters/interop/proto/generated/agent/v1/shell_exec_pb.ts"
import {
  slateTaskProgressUpdateFromInterop,
  slateTaskProgressUpdateToInterop,
  createTaskProgressListenerInterop,
} from "../../source/adapters/interop/agent/task-progress-protocol-adapter.ts"
import { createTaskToolCallDeltaInterop } from "../../source/adapters/interop/agent/task-tool-protocol-adapter.ts"
import { toRedactedInteractionListener } from "../../source/adapters/interop/agent/redacted-interaction-listener-adapter.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import type { SlateTaskProgressUpdateView } from "../../source/packages/agent/tools/task-progress-state.ts"

function interaction(caseName: string, value: unknown): InteractionUpdate {
  return new InteractionUpdate({ message: { case: caseName, value } } as never)
}

const cases: readonly [string, InteractionUpdate][] = [
  ["assistant-text", interaction("textDelta", new TextDeltaUpdate({ text: "child progress", isServerNotice: true }))],
  ["tool-call-started", interaction("toolCallStarted", new ToolCallStartedUpdate({
    callId: "call-1",
    modelCallId: "model-1",
    toolCall: new ToolCall({ tool: { case: "taskToolCall", value: new TaskToolCall() } }),
  }))],
  ["tool-call-completed", interaction("toolCallCompleted", new ToolCallCompletedUpdate({ callId: "call-1", modelCallId: "model-1" }))],
  ["reasoning-text", interaction("thinkingDelta", new ThinkingDeltaUpdate({ text: "reasoning", thinkingStyle: 2 }))],
  ["reasoning-completed", interaction("thinkingCompleted", new ThinkingCompletedUpdate({ thinkingDurationMs: 12 }))],
  ["user-message-appended", interaction("userMessageAppended", new UserMessageAppendedUpdate({
    userMessage: new UserMessage({ text: "child message", messageId: "message-1" }),
  }))],
  ["tool-arguments-progress", interaction("partialToolCall", new PartialToolCallUpdate({
    callId: "call-1",
    argsTextDelta: "{",
    modelCallId: "model-1",
  }))],
  ["token-count", interaction("tokenDelta", new TokenDeltaUpdate({ tokens: 3 }))],
  ["summary-progress", interaction("summary", new SummaryUpdate({ summary: "summary" }))],
  ["summary-started", interaction("summaryStarted", new SummaryStartedUpdate())],
  ["summary-completed", interaction("summaryCompleted", new SummaryCompletedUpdate({ hookMessage: "done" }))],
  ["shell-output-progress", interaction("shellOutputDelta", new ShellOutputDeltaUpdate({
    event: { case: "stdout", value: new ShellStreamStdout({ data: "output" }) },
  }))],
  ["heartbeat", interaction("heartbeat", new HeartbeatUpdate())],
  ["turn-ended", interaction("turnEnded", new TurnEndedUpdate({ inputTokens: 3n, reasoningTokens: 2n }))],
  ["tool-call-progress", interaction("toolCallDelta", new ToolCallDeltaUpdate({
    callId: "call-1",
    modelCallId: "model-1",
    toolCallDelta: new ToolCallDelta({
      delta: {
        case: "taskToolCallDelta",
        value: new TaskToolCallDelta({
          interactionUpdate: interaction("textDelta", new TextDeltaUpdate({ text: "nested" })),
        }),
      },
    }),
  }))],
  ["step-started", interaction("stepStarted", new StepStartedUpdate({ stepId: 7n }))],
  ["step-completed", interaction("stepCompleted", new StepCompletedUpdate({ stepId: 7n, stepDurationMs: 19n }))],
  ["prompt-suggestion", interaction("promptSuggestion", new PromptSuggestionUpdate({ suggestion: "next" }))],
  ["post-request-prompt", interaction("postRequestPrompt", new PostRequestPromptUpdate({
    title: "title",
    message: "message",
    buttonLabel: "open",
    buttonUrl: "https://example.test",
  }))],
  ["branch-changed", interaction("activeBranchChange", new ActiveBranchChange({ path: "/repo", branchName: "feature" }))],
  ["feedback-request", interaction("feedbackRequest", new FeedbackRequestUpdate({
    requestId: "feedback-1",
    canonicalModelName: "model",
    categories: [new FeedbackRequestCategory({ id: "quality", label: "Quality" })],
    categoryGroups: [new FeedbackRequestCategoryGroup({
      id: "group",
      prompt: "Choose one",
      categories: [new FeedbackRequestCategory({ id: "speed", label: "Speed" })],
    })],
    showFormImmediately: true,
    title: "Feedback",
    negativeTitle: "Needs work",
    commentPlaceholder: "Comment",
  }))],
  ["model-comparison", interaction("responseComparison", new ResponseComparisonUpdate({
    comparisonId: "comparison-1",
    event: { case: "started", value: new ResponseComparisonStarted() },
  }))],
  ["context-injection-state", interaction("contextInjectionState", new ContextInjectionStateUpdate({
    injectionId: "injection-1",
    state: new ContextInjectionState({ state: { case: "queued", value: new ContextInjectionQueued() } }),
  }))],
  ["routed-model", interaction("routedModel", new RoutedModelUpdate({ displayName: "Model" }))],
]

test("all 24 interaction event cases map to Slate task progress semantics and round-trip unchanged", () => {
  assert.equal(cases.length, 24)
  for (const [expectedKind, wireUpdate] of cases) {
    const slateUpdate = slateTaskProgressUpdateFromInterop(wireUpdate)
    assert.equal(slateUpdate.kind, expectedKind)
    if (slateUpdate.kind === "tool-call-started") {
      assert.equal(slateUpdate.toolCall?.kind, "tool-call")
      if (slateUpdate.toolCall?.kind === "tool-call") assert.equal(slateUpdate.toolCall.tool.kind, "task")
    }
    if (slateUpdate.kind === "user-message-appended") {
      assert.equal(slateUpdate.message?.messageId, "message-1")
    }
    assert.deepEqual(slateTaskProgressUpdateToInterop(slateUpdate).toBinary(), wireUpdate.toBinary())

    const { compatibility: _compatibility, ...ownedUpdate } = slateUpdate
    assert.deepEqual(slateTaskProgressUpdateToInterop(ownedUpdate).toJson(), wireUpdate.toJson())
  }
})

test("new Slate progress events do not require a legacy payload", () => {
  const update = slateTaskProgressUpdateToInterop({
    schemaVersion: 1,
    kind: "assistant-text",
    text: "first-party update",
    serverNotice: false,
  })
  assert.equal(update.message.case, "textDelta")
  assert.equal(update.message.value.text, "first-party update")
})

test("future interaction fields remain opaque and survive task progress wrapping", () => {
  const update = InteractionUpdate.fromBinary(new Uint8Array([0xd8, 0x2d, 0x01]))

  const slateUpdate = slateTaskProgressUpdateFromInterop(update)
  assert.equal(slateUpdate.kind, "unrecognized")

  const delta = createTaskToolCallDeltaInterop(slateUpdate)
  if (delta.delta.case !== "taskToolCallDelta" || delta.delta.value.interactionUpdate === undefined) {
    assert.fail("expected the future event payload to be carried")
  }
  assert.deepEqual(
    InteractionUpdate.runtime.bin.listUnknownFields(delta.delta.value.interactionUpdate),
    InteractionUpdate.runtime.bin.listUnknownFields(update),
  )
})

test("the listener adapter exposes a Slate update to task policy", async () => {
  const received: unknown[] = []
  const listener = createTaskProgressListenerInterop({
    async sendUpdate(_context: string, update: unknown) { received.push(update) },
    async query(_context: string, query: { readonly id: number; readonly kind: string; readonly payload?: unknown }) {
      return { id: query.id, kind: query.kind, payload: query.payload }
    },
  })
  await listener.sendUpdate("run", cases[0]![1])
  assert.equal((received[0] as { kind?: unknown }).kind, "assistant-text")
})

test("the parent listener receives privacy-projected Slate progress without compatibility bytes", async () => {
  const received: Array<{ readonly toolCallId: string; readonly update: SlateTaskProgressUpdateView }> = []
  const listener = toRedactedInteractionListener({
    async sendUpdate() {},
    async query(_context: string, query: { readonly id: number; readonly kind: string; readonly payload?: unknown }) {
      return { id: query.id, kind: query.kind, payload: query.payload }
    },
    async sendTaskProgressUpdate(_context: string, toolCallId: string, update: SlateTaskProgressUpdateView) {
      received.push({ toolCallId, update })
    },
  }, PrivacyMode.NO_TRAINING)

  const update = slateTaskProgressUpdateFromInterop(
    interaction("textDelta", new TextDeltaUpdate({ text: "private child code" })),
  )
  await listener.sendTaskProgressUpdate?.("run", "task-call-1", update)

  assert.equal(received.length, 1)
  assert.equal(received[0]?.toolCallId, "task-call-1")
  assert.equal(received[0]?.update.kind, "assistant-text")
  assert.equal(received[0]?.update.text, "[redacted:text]")
  assert.equal("compatibility" in (received[0]?.update ?? {}), false)

  const appendedMessage = slateTaskProgressUpdateFromInterop(interaction(
    "userMessageAppended",
    new UserMessageAppendedUpdate({ userMessage: new UserMessage({ text: "private child message", messageId: "message-2" }) }),
  ))
  await listener.sendTaskProgressUpdate?.("run", "task-call-1", appendedMessage)
  assert.equal(received.length, 2)
  const messageUpdate = received[1]?.update
  assert.equal(messageUpdate?.kind, "user-message-appended")
  if (messageUpdate?.kind === "user-message-appended") {
    const message = messageUpdate.message as { readonly text?: unknown; readonly messageId?: unknown } | undefined
    assert.equal(message?.text, "[redacted:text]")
    assert.equal(message?.messageId, "message-2")
  }
  assert.equal("compatibility" in (messageUpdate ?? {}), false)
})

test("task progress rejects empty, mismatched and non-interaction messages", () => {
  assert.throws(() => slateTaskProgressUpdateFromInterop(new InteractionUpdate()), /no recognized event/)
  assert.throws(() => slateTaskProgressUpdateFromInterop({ message: { case: "textDelta", value: { text: "wrong" } } }), /invalid/)
  assert.throws(() => slateTaskProgressUpdateFromInterop(new ToolCall()), /invalid/)

  const update = slateTaskProgressUpdateFromInterop(cases[0]![1])
  assert.throws(() => slateTaskProgressUpdateToInterop({ ...update, text: "tampered" }), /do not match/)
})
