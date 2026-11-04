import { test } from "node:test"
import assert from "node:assert/strict"

import { createRedactedString } from "../../source/packages/redaction/create.ts"
import { DataClassification } from "../../source/packages/redaction/classification.ts"
import { createContext } from "../../source/packages/context/context.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import {
  FeedbackRequestCategory,
  FeedbackRequestCategoryGroup,
} from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { Updates } from "../../source/packages/agent-core/interaction-updates.ts"
import { RedactedUpdates } from "../../source/packages/agent-core/redacted-interaction-updates.ts"
import * as agentCore from "../../source/packages/agent-core/index.ts"

const mode = PrivacyMode.NO_STORAGE

test("an update is built with the case its client renders", () => {
  const text = Updates.textDelta("hello")
  assert.equal(text.message.case, "textDelta")
  assert.equal((text.message.value as { text?: string }).text, "hello")

  assert.equal(Updates.heartbeat().message.case, "heartbeat")
  assert.equal(Updates.summaryStarted().message.case, "summaryStarted")
  assert.equal(Updates.tokenDelta(42).message.case, "tokenDelta")
  assert.equal(Updates.activeBranchChange("/repo", "main").message.case, "activeBranchChange")

  const step = Updates.stepStarted(7)
  assert.equal((step.message.value as { stepId?: bigint }).stepId, BigInt(7), "a step id is a bigint on the wire")
  const completed = Updates.stepCompleted(7, 1500)
  assert.equal((completed.message.value as { stepDurationMs?: bigint }).stepDurationMs, BigInt(1500))
})

test("turn usage is converted to bigints, and an early end reports nothing", () => {
  const withUsage = Updates.turnEnded({
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 5,
    reasoningTokens: 7,
  })
  const value = withUsage.message.value as { inputTokens?: bigint; reasoningTokens?: bigint }
  assert.equal(value.inputTokens, BigInt(100))
  assert.equal(value.reasoningTokens, BigInt(7))

  const withoutReasoning = Updates.turnEnded({
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
  })
  assert.equal((withoutReasoning.message.value as { reasoningTokens?: bigint }).reasoningTokens, BigInt(0))

  const early = Updates.turnEnded()
  assert.equal(
    (early.message.value as { inputTokens?: bigint }).inputTokens,
    undefined,
    "usage counts are optional fields, so an omitted usage stays absent",
  )
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

test("a redacted update takes its privacy mode from the value it is given", () => {
  const text = createRedactedString("the secret", DataClassification.CODE, "text", mode)
  const update = RedactedUpdates.textDelta(text)
  assert.equal(update._privacyMode, mode)
  assert.equal(update.message.case, "textDelta")
  const textValue = update.message.value as unknown as { text: unknown; isServerNotice?: boolean }
  assert.equal(textValue.text, text, "the redacted value travels as it is")
  assert.equal(textValue.isServerNotice, false)

  const summary = RedactedUpdates.summary(createRedactedString("summary", DataClassification.CODE, "summary", mode))
  assert.equal(summary._privacyMode, mode)

  const path = createRedactedString("/repo", DataClassification.PATH, "path", mode)
  assert.equal(RedactedUpdates.activeBranchChange(path, "main")._privacyMode, mode)
})

test("an update without text takes its privacy mode explicitly", () => {
  assert.equal(RedactedUpdates.heartbeat(mode)._privacyMode, mode)
  assert.equal(RedactedUpdates.tokenDelta(mode, 5)._privacyMode, mode)
  assert.equal(RedactedUpdates.stepStarted(mode, 3)._privacyMode, mode)
  assert.equal((RedactedUpdates.stepStarted(mode, 3).message.value as { stepId?: bigint }).stepId, BigInt(3))
  assert.equal(RedactedUpdates.stepCompleted(mode, 3, 10)._privacyMode, mode)
})

test("redacted turn usage converts the same way, and stays absent when there is none", () => {
  const withUsage = RedactedUpdates.turnEnded(mode, {
    inputTokens: "100",
    outputTokens: 20n,
    cacheReadTokens: 30,
    cacheWriteTokens: 5,
    reasoningTokens: null,
  })
  const value = withUsage.message.value as { inputTokens?: bigint; reasoningTokens?: bigint }
  assert.equal(value.inputTokens, BigInt(100))
  assert.equal(value.reasoningTokens, BigInt(0), "a null reasoning count is zero, not absent")

  const none = RedactedUpdates.turnEnded(mode, undefined)
  assert.equal("inputTokens" in (none.message.value as object), false)
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
