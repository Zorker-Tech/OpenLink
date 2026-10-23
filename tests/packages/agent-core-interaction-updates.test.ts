import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Updates } from "../../source/packages/agent-core/interaction-updates.ts";
import {
  FeedbackRequestCategory,
  ThinkingDeltaUpdate,
  UserMessage,
} from "../../source/packages/proto/generated/agent/v1/agent_pb.ts";

const messageOf = (update: ReturnType<typeof Updates.textDelta>) => update.message!;
const caseOf = (update: unknown) => (update as { message: { case: string } }).message.case;
const recordOf = (value: unknown) => value as unknown as Record<string, unknown>;

describe("the agent interaction updates", () => {
  it("builds the simple text and token deltas", () => {
    assert.equal(caseOf(Updates.textDelta("hello")), "textDelta");
    const text = messageOf(Updates.textDelta("hello"));
    assert.equal(text.case, "textDelta");
    assert.equal((text.value as { text: string }).text, "hello");
    assert.equal(caseOf(Updates.tokenDelta(12)), "tokenDelta");
    assert.equal((messageOf(Updates.tokenDelta(12)).value as { tokens: number }).tokens, 12);
    assert.equal(caseOf(Updates.heartbeat()), "heartbeat");
    assert.equal(caseOf(Updates.summaryStarted()), "summaryStarted");
    assert.equal((messageOf(Updates.summary("the summary")).value as { summary: string }).summary, "the summary");
    assert.equal((messageOf(Updates.promptSuggestion("try this")).value as { suggestion: string }).suggestion, "try this");
    assert.equal((messageOf(Updates.activeBranchChange("/work", "main")).value as { path: string; branchName: string }).branchName, "main");
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
    const thinking = messageOf(Updates.thinkingDelta("hm", undefined));
    assert.equal(thinking.case, "thinkingDelta");
    assert.equal((thinking.value as ThinkingDeltaUpdate).text, "hm");
    const styled = messageOf(Updates.thinkingDelta("hm", 1 as never)).value as ThinkingDeltaUpdate;
    assert.equal(styled.thinkingStyle, 1);
    assert.equal((messageOf(Updates.thinkingCompleted(250)).value as { thinkingDurationMs: number }).thinkingDurationMs, 250);
    const appended = messageOf(Updates.userMessageAppended(new UserMessage())).value as { userMessage?: UserMessage };
    assert.equal(appended.userMessage instanceof UserMessage, true);
    assert.equal(caseOf(Updates.summaryCompleted(undefined)), "summaryCompleted");
  });

  it("converts turn usage and step numbers to bigints", () => {
    const ended = messageOf(Updates.turnEnded({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 5 })).value as unknown as Record<string, unknown>;
    assert.deepEqual([ended.inputTokens, ended.outputTokens, ended.cacheReadTokens, ended.cacheWriteTokens, ended.reasoningTokens], [1n, 2n, 3n, 4n, 5n]);
    const early = messageOf(Updates.turnEnded()).value as unknown as Record<string, unknown>;
    assert.equal(early.inputTokens, undefined);
    const noReasoning = messageOf(Updates.turnEnded({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 })).value as { reasoningTokens: bigint };
    assert.equal(noReasoning.reasoningTokens, 0n);
    const started = messageOf(Updates.stepStarted(7)).value as { stepId: bigint };
    assert.equal(started.stepId, 7n);
    const completed = messageOf(Updates.stepCompleted(7, 1200)).value as { stepId: bigint; stepDurationMs: bigint };
    assert.equal(completed.stepId, 7n);
    assert.equal(completed.stepDurationMs, 1200n);
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
