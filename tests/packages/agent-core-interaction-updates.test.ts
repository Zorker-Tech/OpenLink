import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Updates } from "../../source/packages/agent-core/interaction-updates.ts";
import { SlateInteractionUpdates, slateTurnEndedUpdate } from "../../source/packages/agent-core/slate-interaction-updates.ts";
import {
  FeedbackRequestCategory,
  InteractionUpdate,
  UserMessage,
} from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts";

const messageOf = (update: InteractionUpdate) => update.message!;
const caseOf = (update: unknown) => (update as { message: { case: string } }).message.case;
const recordOf = (value: unknown) => value as unknown as Record<string, unknown>;

describe("the agent interaction updates", () => {
  it("builds the simple text and token deltas", () => {
    assert.deepEqual(SlateInteractionUpdates.textDelta("hello"), { kind: "text-delta", text: "hello" });
    assert.deepEqual(SlateInteractionUpdates.tokenDelta(12), { kind: "token-delta", tokens: 12 });
    assert.deepEqual(SlateInteractionUpdates.heartbeat(), { kind: "heartbeat" });
    assert.equal(caseOf(Updates.summaryStarted()), "summaryStarted");
    assert.equal((messageOf(Updates.summary("the summary")).value as { summary: string }).summary, "the summary");
    assert.deepEqual(SlateInteractionUpdates.promptSuggestion("try this"), { kind: "prompt-suggestion", suggestion: "try this" });
    assert.deepEqual(SlateInteractionUpdates.activeBranchChange("/work", "main"), {
      kind: "active-branch-change",
      path: "/work",
      branchName: "main",
    });
    assert.equal((messageOf(Updates.shellOutputDelta({} as never)).value as { event: unknown }).event !== undefined, true);
  });

  it("carries tool call updates with their ids and optional tool calls", () => {
    const started = messageOf(Updates.toolCallStarted("call-1", undefined, "model-1"));
    assert.equal(started.case, "toolCallStarted");
    const startedValue = started.value as { callId: string; modelCallId: string; toolCall?: unknown };
    assert.equal(startedValue.callId, "call-1");
    assert.equal(startedValue.modelCallId, "model-1");
    assert.equal(startedValue.toolCall, undefined);
    const withCall = messageOf(Updates.toolCallStarted("call-2", undefined, "model-2")).value as { callId: string };
    assert.equal(withCall.callId, "call-2");
    assert.equal(caseOf(Updates.toolCallCompleted("c", undefined, "m")), "toolCallCompleted");
    assert.equal(caseOf(Updates.toolCallDelta("c", undefined, "m")), "toolCallDelta");
    assert.equal(caseOf(Updates.partialToolCall("c", undefined, "m")), "partialToolCall");
  });

  it("carries thinking, user message and summary completions", () => {
    assert.deepEqual(SlateInteractionUpdates.thinkingDelta("hm"), { kind: "thinking-delta", text: "hm" });
    assert.deepEqual(SlateInteractionUpdates.thinkingDelta("hm", 2), {
      kind: "thinking-delta",
      text: "hm",
      style: "code-oriented",
    });
    assert.equal(SlateInteractionUpdates.thinkingDelta("hm", 0).style, "unspecified");
    assert.equal(SlateInteractionUpdates.thinkingDelta("hm", 1).style, "standard");
    assert.equal(SlateInteractionUpdates.thinkingDelta("hm", 3).style, "alternate");
    assert.deepEqual(SlateInteractionUpdates.thinkingDelta("hm", 87).style, { kind: "unknown", code: 87 });
    assert.deepEqual(SlateInteractionUpdates.thinkingDelta("hm", "custom-style").style, { kind: "custom", value: "custom-style" });
    assert.deepEqual(SlateInteractionUpdates.thinkingCompleted(250), { kind: "thinking-completed", durationMs: 250 });
    const appended = messageOf(Updates.userMessageAppended(new UserMessage())).value as { userMessage?: UserMessage };
    assert.equal(appended.userMessage instanceof UserMessage, true);
    assert.equal(caseOf(Updates.summaryCompleted(undefined)), "summaryCompleted");
  });

  it("keeps turn usage and step lifecycle values in Slate units", () => {
    const ended = slateTurnEndedUpdate({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 5 });
    assert.deepEqual(ended, { kind: "turn-ended", usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 5 } });
    const early = slateTurnEndedUpdate();
    assert.deepEqual(early, { kind: "turn-ended" });
    const noReasoning = slateTurnEndedUpdate({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 });
    assert.equal(noReasoning.usage?.reasoningTokens, 0);
    assert.deepEqual(SlateInteractionUpdates.stepStarted(7), { kind: "step-started", stepId: 7 });
    assert.deepEqual(SlateInteractionUpdates.stepCompleted(7, 1200), {
      kind: "step-completed",
      stepId: 7,
      durationMs: 1200,
    });
  });

  it("builds a feedback request with its copy and lists", () => {
    const category = new FeedbackRequestCategory({ id: "other", label: "Other" });
    const built = messageOf(Updates.feedbackRequest("req-1", "model-x", [category], [], { title: "T", negativeTitle: "N", commentPlaceholder: "C" })).value as unknown as Record<string, unknown>;
    assert.equal(built.requestId, "req-1");
    assert.equal(built.canonicalModelName, "model-x");
    assert.deepEqual([...(built.categories as unknown as FeedbackRequestCategory[])].map((value) => value.id), ["other"]);
    assert.deepEqual([...(built.categoryGroups as unknown[])], []);
    assert.equal(built.title, "T");
    assert.equal(built.negativeTitle, "N");
    assert.equal(built.commentPlaceholder, "C");
    const minimal = messageOf(Updates.feedbackRequest("req-2", undefined, [])).value as unknown as Record<string, unknown>;
    assert.equal(minimal.canonicalModelName, undefined);
    assert.equal(minimal.title, undefined);
  });
});
