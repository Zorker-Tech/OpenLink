import assert from "node:assert/strict"
import { test } from "node:test"

import { createContext } from "../../source/packages/context/context.ts"
import { conversationIdKey } from "../../source/packages/agent/utils/request-scope.ts"
import { smartModeClassifierExecutorResource } from "../../source/packages/agent-exec/smart-mode-classifier-operation.ts"
import {
  SmartModeClassifierConversationMessage,
  SmartModeClassifierDecision,
  SmartModeClassifierResult,
} from "../../source/adapters/interop/proto/generated/agent/v1/smart_mode_classifier_exec_pb.ts"
import type { SmartModeRiskTarget } from "../../source/adapters/interop/proto/generated/agent/v1/smart_mode_classifier_exec_pb.ts"
import { encodeAutoReviewRiskTarget, projectAutoReviewClassifierResult } from "../../source/adapters/interop/agent/auto-review-classifier-adapter.ts"
import { decideAutoReviewClassifierResult } from "../../source/host/runner/auto-review-classifier-contracts.ts"
import { runSlateAutoReviewClassifier } from "../../source/host/runner/slate-auto-review-classifier-run.ts"

test("classifier decisions cross the wire boundary as Slate outcomes", () => {
  assert.deepEqual(projectAutoReviewClassifierResult({
    result: { case: "success", value: { decision: SmartModeClassifierDecision.ALLOW } },
  } as never), { kind: "allow" })

  const blocked = projectAutoReviewClassifierResult({
    result: {
      case: "success",
      value: {
        decision: SmartModeClassifierDecision.BLOCK,
        blockReason: "  risky change  ",
        proposedAllowRule: "  git push  ",
      },
    },
  } as never)
  assert.deepEqual(blocked, {
    kind: "block",
    blockReason: "  risky change  ",
    proposedAllowRule: "  git push  ",
  })
  assert.deepEqual(decideAutoReviewClassifierResult(blocked, "manual review", "Blocked by Auto-review"), {
    kind: "block",
    reason: "risky change",
    proposedRule: "git push",
  })
})

test("missing, unknown and empty classifier answers fail closed with a Slate reason", () => {
  const unavailable = projectAutoReviewClassifierResult({ result: { case: "error", value: { error: "offline" } } } as never)
  const unknown = projectAutoReviewClassifierResult({
    result: { case: "success", value: { decision: SmartModeClassifierDecision.UNSPECIFIED } },
  } as never)
  const emptyBlock = projectAutoReviewClassifierResult({
    result: {
      case: "success",
      value: { decision: SmartModeClassifierDecision.BLOCK, blockReason: "  ", proposedAllowRule: "  " },
    },
  } as never)

  assert.equal(decideAutoReviewClassifierResult(unavailable, "retry manually", "Blocked by Auto-review").kind, "reject")
  assert.deepEqual(decideAutoReviewClassifierResult(unknown, "retry manually", "Blocked by Auto-review"), {
    kind: "reject",
    reason: "retry manually",
  })
  assert.deepEqual(decideAutoReviewClassifierResult(emptyBlock, "retry manually", "Blocked by Auto-review"), {
    kind: "block",
    reason: "Blocked by Auto-review",
  })
})

test("the runner sends classifier wire values through the executor adapter", async () => {
  const calls: Array<{ toolCallId: string; parentConversationId: string; target: SmartModeRiskTarget; conversationContext: SmartModeClassifierConversationMessage[] }> = []
  const target = { action: "shell", arguments: { command: "git push" } }
  const response = new SmartModeClassifierResult({
    result: {
      case: "success",
      value: {
        decision: SmartModeClassifierDecision.BLOCK,
        blockReason: " protected branch ",
        proposedAllowRule: " git push origin " ,
      },
    },
  })
  const executor = {
    async execute(_context: unknown, args: {
      readonly toolCallId: string
      readonly parentConversationId: string
      readonly target: SmartModeRiskTarget
      readonly conversationContext: SmartModeClassifierConversationMessage[]
    }) {
      calls.push(args)
      return response
    },
  }

  const decision = await runSlateAutoReviewClassifier({
    ctx: createContext().with(conversationIdKey, "conversation-1"),
    resourceAccessor: {
      get(resource: unknown) {
        assert.equal(resource, smartModeClassifierExecutorResource)
        return executor
      },
    } as never,
    toolCallId: "call-1",
    mode: "enforce",
    buildTarget: () => target,
    loadConversationContext: async () => [new SmartModeClassifierConversationMessage({ role: "user", content: "push changes" })],
    workspacePaths: ["/repo"],
    errorReason: "review unavailable",
  })

  assert.deepEqual(decision, { kind: "block", reason: "protected branch", proposedRule: "git push origin" })
  assert.equal(calls[0]?.toolCallId, "call-1")
  assert.equal(calls[0]?.parentConversationId, "conversation-1")
  assert.equal(calls[0]?.target.action, "shell")
  assert.deepEqual(calls[0]?.target.arguments?.toJson(), { command: "git push" })
  assert.equal(calls[0]?.conversationContext[0]?.content, "push changes")
})

test("Slate-owned risk records are encoded at the classifier boundary", () => {
  const encoded = encodeAutoReviewRiskTarget({
    action: "browser",
    arguments: { surface: "browser", action_kind: "browser_click", url: "https://example.test" },
  })

  assert.equal(encoded.action, "browser")
  assert.deepEqual(encoded.arguments?.toJson(), {
    surface: "browser",
    action_kind: "browser_click",
    url: "https://example.test",
  })
})

test("the runner returns service failures and rethrows explicit aborts", async () => {
  const run = (failure: Error) => runSlateAutoReviewClassifier({
    ctx: createContext(),
    resourceAccessor: { get: () => ({ execute: async () => { throw failure } }) } as never,
    toolCallId: "call-1",
    mode: "shadow",
    buildTarget: () => ({ action: "shell", arguments: {} }),
    loadConversationContext: async () => [],
    errorReason: "review unavailable",
  })

  assert.deepEqual(await run(new Error("offline")), { kind: "reject", reason: "review unavailable" })
  const abort = Object.assign(new Error("stopped"), { name: "AbortError" })
  await assert.rejects(run(abort), error => error === abort)
})
