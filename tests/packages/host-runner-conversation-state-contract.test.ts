import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SLATE_SUMMARIZATION_MAX_PROMPT_CHARS,
  awaitBlockUntilMs,
  buildUnansweredQuestionsNote,
  classifyCompletedAwaitOutcome,
  createSlateResolvedModelTracker,
  createSlateSummarizationHandler,
  lastReportedContextWindow,
  sanitizeExtendedUsage,
  sanitizeFullStream,
  sanitizePromptExecutorUsage,
  sanitizePromptSessionUsage,
  sanitizeStreamResult,
  sanitizeUsage,
  selectUnconfirmedUserMessages,
  shouldUseSlateSelfSummary,
  toSafeTokenCount,
  type RecentUserMessage,
} from "../../source/host/runner/conversation-state.ts";
import { SLATE_HIDDEN_PROMPT_MARKER } from "../../source/host/runner/slate-prompt-markers.ts";
import { SummarizationHandler } from "../../source/packages/agent-summarization/summarization-handler.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

async function* partsOf(...parts: unknown[]) {
  for (const part of parts) yield part;
}

describe("the user messages a turn has not confirmed", () => {
  const messages: RecentUserMessage[] = [
    { id: "one", text: "first" },
    { id: "empty", text: "  \n " },
    { id: "two", text: "second" },
    { id: "current", text: "now" },
    { id: "future", text: "later" },
  ];

  it("selects earlier nonblank messages before the current turn message", () => {
    assert.deepEqual(selectUnconfirmedUserMessages({
      recentUserMessages: messages, currentMessageId: "current", hasConfirmedTurns: false,
    }), [messages[0], messages[2]]);
  });

  it("starts after the last-turn watermark and refuses an unknown or later watermark", () => {
    assert.deepEqual(selectUnconfirmedUserMessages({
      recentUserMessages: messages, currentMessageId: "current", lastTurnUserMessageId: "one", hasConfirmedTurns: true,
    }), [messages[2]]);
    assert.deepEqual(selectUnconfirmedUserMessages({
      recentUserMessages: messages, currentMessageId: "current", lastTurnUserMessageId: "missing", hasConfirmedTurns: false,
    }), []);
    assert.deepEqual(selectUnconfirmedUserMessages({
      recentUserMessages: messages, currentMessageId: "two", lastTurnUserMessageId: "current", hasConfirmedTurns: true,
    }), []);
  });

  it("returns no messages without a current id, a preceding message, or an unconfirmed window", () => {
    assert.deepEqual(selectUnconfirmedUserMessages({ recentUserMessages: messages, hasConfirmedTurns: false }), []);
    assert.deepEqual(selectUnconfirmedUserMessages({ recentUserMessages: messages, currentMessageId: "one", hasConfirmedTurns: false }), []);
    assert.deepEqual(selectUnconfirmedUserMessages({ recentUserMessages: messages, currentMessageId: "current", hasConfirmedTurns: true }), []);
  });
});

describe("the note about earlier questions", () => {
  it("omits empty prompts and keeps the hidden marker when it writes a note", () => {
    assert.equal(buildUnansweredQuestionsNote({ skipped: [" ", ""], dismissed: [] }), "");
    assert.equal(buildUnansweredQuestionsNote({ skipped: ["What size?"], dismissed: [] }),
      `${SLATE_HIDDEN_PROMPT_MARKER}Earlier you prompted the user and they moved on without responding ("What size?") — treat it as skipped. Don't wait for or assume a response; continue with what you already know, and only ask again if you still genuinely need it.`);
  });

  it("trims prompts, keeps list order, and separates skipped from dismissed questions", () => {
    const note = buildUnansweredQuestionsNote({
      skipped: [" first ", "", "second"],
      dismissed: ["choice"],
    });
    assert.ok(note.startsWith(SLATE_HIDDEN_PROMPT_MARKER));
    assert.ok(note.includes("- \"first\"\n- \"second\""));
    assert.ok(note.includes("\n\nThe user dismissed your question (\"choice\")"));
    assert.equal(note.indexOf("first") < note.indexOf("choice"), true);
  });
});

describe("bounded usage values and await outcomes", () => {
  it("keeps only positive finite numeric token counts and floors fractions", () => {
    assert.equal(toSafeTokenCount(8.9), 8);
    assert.equal(toSafeTokenCount(0), 0);
    assert.equal(toSafeTokenCount(-1), 0);
    assert.equal(toSafeTokenCount(Number.NaN), 0);
    assert.equal(toSafeTokenCount(Number.POSITIVE_INFINITY), 0);
    assert.equal(toSafeTokenCount("42"), 0);
    assert.equal(toSafeTokenCount(42n), 0);
  });

  it("reads the await deadline as a number, with nullish input meaning no wait", () => {
    assert.equal(awaitBlockUntilMs({}), 0);
    assert.equal(awaitBlockUntilMs({ args: { blockUntilMs: null } }), 0);
    assert.equal(awaitBlockUntilMs({ args: { blockUntilMs: "1250" } }), 1250);
    assert.equal(Number.isNaN(awaitBlockUntilMs({ args: { blockUntilMs: "bad" } })), true);
  });

  it("classifies completed, still-running, and malformed await results", () => {
    const successful = (awaitResult: unknown) => ({ result: { result: { case: "success", value: { awaitResult } } } });
    assert.equal(classifyCompletedAwaitOutcome(successful({ case: "complete", value: { taskId: "" } })), "slept_full");
    assert.equal(classifyCompletedAwaitOutcome(successful({ case: "complete", value: { taskId: " task-1 " } })), "completed_early");
    assert.equal(classifyCompletedAwaitOutcome(successful({ case: "stillRunning", value: { regexMatch: [] } })), "slept_full");
    assert.equal(classifyCompletedAwaitOutcome(successful({ case: "stillRunning", value: { regexMatch: ["match"] } })), "completed_early");
    assert.equal(classifyCompletedAwaitOutcome({ result: { result: { case: "error" } } }), "completed_early");
  });

  it("sanitizes usage while preserving unrelated fields and deriving a missing total", () => {
    assert.deepEqual(sanitizeUsage({ promptTokens: 3.9, completionTokens: 4, totalTokens: 0, cache: "kept" }), {
      promptTokens: 3, completionTokens: 4, totalTokens: 7, cache: "kept",
    });
    assert.deepEqual(sanitizeUsage({ promptTokens: -2, completionTokens: Number.NaN, totalTokens: 10 }), {
      promptTokens: 0, completionTokens: 0, totalTokens: 10,
    });
  });

  it("updates a model's context window only for a positive bounded maximum", () => {
    const model = `contract-${Math.random()}`;
    assert.deepEqual(sanitizeExtendedUsage({ inputTokens: 1.8, outputTokens: "3", maxTokens: 100.9 }, model), {
      inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, maxTokens: 100,
    });
    assert.equal(lastReportedContextWindow(model), 100);
    assert.equal(sanitizeExtendedUsage({ maxTokens: 0 }, model).maxTokens, 0);
    assert.equal(lastReportedContextWindow(model), 100, "a missing maximum does not erase the last report");
  });
});

describe("sanitizing a prompt executor's results", () => {
  it("removes error parts, preserves the first error, and throws it after draining", async () => {
    const first = { type: "text", text: "before" };
    const failure = new TypeError("provider failed");
    const stream = sanitizeFullStream(partsOf(first, { type: "error", error: failure }, { type: "text", text: "after" }));
    const observed: unknown[] = [];
    await assert.rejects(async () => { for await (const part of stream) observed.push(part); }, failure);
    assert.deepEqual(observed, [first]);
  });

  it("sanitizes finish usage and settles the associated promises", async () => {
    const resolvedIds: string[] = [];
    const result = sanitizeStreamResult({
      fullStream: partsOf({ type: "finish", usage: { promptTokens: 2.8, completionTokens: 4, totalTokens: 0 } }),
      response: Promise.resolve({ modelId: "  resolved-model  " }),
      usage: Promise.resolve({ promptTokens: 5, completionTokens: 1, totalTokens: 6 }),
      extendedUsage: Promise.resolve({ inputTokens: 6.8, outputTokens: 2, maxTokens: 2048 }),
    }, "requested-model", (modelId) => resolvedIds.push(modelId));

    const streamParts: unknown[] = [];
    for await (const part of result.fullStream) streamParts.push(part);
    assert.deepEqual(streamParts, [{ type: "finish", usage: { promptTokens: 2, completionTokens: 4, totalTokens: 6 } }]);
    assert.deepEqual(await result.usage, { promptTokens: 5, completionTokens: 1, totalTokens: 6 });
    assert.deepEqual(await result.extendedUsage, { inputTokens: 6, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, maxTokens: 2048 });
    assert.deepEqual(await result.response, { modelId: "  resolved-model  " });
    assert.deepEqual(resolvedIds, ["resolved-model"]);
  });

  it("accepts only the newest resolved model for a requested model id", () => {
    const tracker = createSlateResolvedModelTracker();
    assert.equal(tracker.get("model-a"), undefined);
    const stale = tracker.beginRequest("model-a");
    const newest = tracker.beginRequest("model-a");
    const other = tracker.beginRequest("model-b");
    assert.equal(newest("provider-new"), true);
    assert.equal(stale("provider-old"), false);
    assert.equal(other("provider-b"), true);
    assert.equal(newest("provider-again"), false);
    assert.equal(tracker.get("model-a"), "provider-new");
    assert.equal(tracker.get("model-b"), "provider-b");
  });

  it("tracks resolved model ids through the executor proxy while forwarding other members", async () => {
    const resolved: string[] = [];
    const original = { streamCalls: 0, marker: "kept", stream() {
      this.streamCalls += 1;
      return {
        fullStream: partsOf({ type: "finish", usage: {} }),
        response: Promise.resolve({ modelId: "provider-resolved" }),
        usage: Promise.resolve({}),
        extendedUsage: Promise.resolve({}),
      };
    } };
    const tracked = sanitizePromptExecutorUsage(original, "requested", {
      tracker: createSlateResolvedModelTracker(), onResolvedModelId: (modelId) => resolved.push(modelId),
    });
    assert.equal(tracked.marker, "kept");
    const call = tracked.stream();
    await call.response;
    assert.equal(original.streamCalls, 1);
    assert.deepEqual(resolved, ["provider-resolved"]);
  });

  it("exposes a tracked and untracked executor over the summarization session", async () => {
    const session = {
      getModelId: () => "summary-model",
      getExecutor: () => ({ stream: () => ({
        fullStream: partsOf(),
        response: Promise.resolve({ modelId: "resolved-summary" }),
        usage: Promise.resolve({}),
        extendedUsage: Promise.resolve({}),
      }) }),
    };
    const resolved: string[] = [];
    const view = sanitizePromptSessionUsage(session, createSlateResolvedModelTracker(), (modelId) => resolved.push(modelId));
    assert.equal(view.getModelId(), "summary-model");
    assert.equal(view.getResolvedModelId(), undefined);
    const trackedCall = view.getExecutor({}).stream();
    await trackedCall.response;
    assert.equal(view.getResolvedModelId(), "resolved-summary");
    const untrackedCall = view.getExecutorWithoutResolvedModelTracking({}).stream();
    await untrackedCall.response;
    assert.deepEqual(resolved, ["resolved-summary"]);
  });
});

describe("the Slate summary model choice", () => {
  it("recognizes Slate aliases and supported provider variants without matching neighboring names", () => {
    for (const model of [
      "slate-4.5", "slate-4.5#long", "slate-4.5-fast-high", "cursor-slate-4.5", "cursor-slate-4.5-fast",
      "vega", "vega-pro", "accounts/slate/models/vega-plus", "slate/vega", "v9", "v9-fast", "XAIEXTERNAL--tenant--v9",
    ]) assert.equal(shouldUseSlateSelfSummary(model), true, model);
    for (const model of ["slate-4.4", "cursor-slate-4.4", "other-vega", "v90", "XAIEXTERNAL--tenant--v8"]) {
      assert.equal(shouldUseSlateSelfSummary(model), false, model);
    }
  });

  it("builds a summarization handler with the platform limits and image option", () => {
    const emptyCall = {
      fullStream: partsOf(),
      extendedUsage: Promise.resolve({}),
      usage: Promise.resolve({}),
      providerMetadata: Promise.resolve({}),
      invocationId: Promise.resolve("call-id"),
      response: Promise.resolve({ messages: [] }),
    };
    const session = { getExecutor: () => ({ stream: () => emptyCall }), getModelId: () => "slate-summary" };
    const handler = createSlateSummarizationHandler(session, { preserveLatestImage: true });
    assert.equal(handler instanceof SummarizationHandler, true);
    assert.equal(handler.promptSession, session);
    assert.equal(handler.isFallbackToMainModel, false);
    assert.equal(handler.enableReduceInputsRetry, true);
    assert.equal(SLATE_SUMMARIZATION_MAX_PROMPT_CHARS, 2_800_000);
    assert.equal(handler.maxPromptChars, SLATE_SUMMARIZATION_MAX_PROMPT_CHARS);
    assert.equal(handler.maxOutputTokens, 32_000);
    assert.equal(handler.preserveLatestImage, true);
    assert.equal(createSlateSummarizationHandler(session).preserveLatestImage, false);
  });
});
