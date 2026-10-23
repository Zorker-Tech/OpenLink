import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MockPromptBuilder,
  MockPromptExecutor,
  createMockPromptExecutor,
  type MockPromptExecutorOptions,
} from "../../source/packages/chat-inference/mock-prompt-executor.ts";

const collect = async (executor: MockPromptExecutor, invocationId?: string) => {
  const events: Array<Record<string, unknown>> = [];
  const result = executor.stream(undefined, invocationId, undefined, undefined);
  for await (const event of result.fullStream) events.push(event as Record<string, unknown>);
  return { events, result };
};

test("the defaults answer with a phrase and default usage", async () => {
  const executor = createMockPromptExecutor(() => ({}));
  assert.equal(executor instanceof MockPromptExecutor, true);
  assert.equal(executor instanceof MockPromptBuilder, false);
  const options = executor.options();
  assert.equal(options.response, "This is a mock response.");
  assert.deepEqual(options.toolCalls, []);
  assert.equal(options.streamDelay, 0);
  assert.equal(options.chunkSize, 1);
  assert.deepEqual(options.usage, { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, maxTokens: 1000 });
  assert.equal(options.simulateError, undefined);
});

test("an answer is streamed in chunks and finished with its usage", async () => {
  const executor = createMockPromptExecutor(() => ({ response: "abcdef", chunkSize: 2 }));
  const { events, result } = await collect(executor, "invocation-1");
  assert.deepEqual(events.filter((event) => event.type === "text-delta").map((event) => event.textDelta), ["ab", "cd", "ef"]);
  const finish = events.at(-1) as Record<string, any>;
  assert.equal(finish.type, "finish");
  assert.equal(finish.finishReason, "stop");
  assert.deepEqual(finish.usage, { promptTokens: 10, completionTokens: 20, totalTokens: 30 });
  assert.equal(finish.response.id, "mock-response-id");
  assert.equal(finish.response.modelId, "mock-model");
  assert.equal(finish.response.timestamp instanceof Date, true);
  assert.equal(result.invocationId instanceof Promise, true);
  assert.equal(await result.invocationId, "invocation-1");
  assert.deepEqual(await result.usage, { promptTokens: 10, completionTokens: 20, totalTokens: 30 });
  assert.deepEqual(await result.extendedUsage, { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, maxTokens: 1000 });
  assert.equal(await result.providerMetadata, undefined);
});

test("an invocation without an id gets one", async () => {
  const executor = createMockPromptExecutor(() => ({}));
  const { result } = await collect(executor);
  const id = await result.invocationId;
  assert.equal(typeof id, "string");
  assert.match(id, /^[0-9a-f-]{36}$/);
});

test("the response is assembled from text and tool calls", async () => {
  const calls = [{ toolCallId: "tool-1", toolName: "read", args: { path: "/tmp/x" } }];
  const executor = createMockPromptExecutor(() => ({ response: "the answer", toolCalls: calls, usage: { inputTokens: 3, outputTokens: 4 } }));
  const { result } = await collect(executor);
  const answer = await result.response;
  assert.equal(answer.id, "mock-response-id");
  assert.equal(answer.modelId, "mock-model");
  const message = answer.messages[0];
  assert.equal(message.role, "assistant");
  assert.deepEqual(message.content, [
    { type: "text", text: "the answer" },
    { type: "tool-call", toolCallId: "tool-1", toolName: "read", args: { path: "/tmp/x" } },
  ]);
  assert.deepEqual(await result.usage, { promptTokens: 3, completionTokens: 4, totalTokens: 7 });
});

test("an answer with no text and no tool calls has empty content", async () => {
  const executor = createMockPromptExecutor(() => ({ response: "" }));
  const { events, result } = await collect(executor);
  assert.equal(events.some((event) => event.type === "text-delta"), false);
  const answer = await result.response;
  assert.equal(answer.messages[0].content, "");
});

test("tool calls are announced, streamed as arguments and delivered", async () => {
  const calls = [
    { toolCallId: "tool-1", toolName: "read", args: { path: "/tmp/x" } },
    { toolCallId: "tool-2", toolName: "write", args: { path: "/tmp/y", text: "hi" } },
  ];
  const executor = createMockPromptExecutor(() => ({ response: "", toolCalls: calls, chunkSize: 3 }));
  const { events } = await collect(executor);
  assert.deepEqual(events.filter((event) => event.type === "tool-call-streaming-start").map((event) => [event.toolCallId, event.toolName]), [["tool-1", "read"], ["tool-2", "write"]]);
  const deltas = events.filter((event) => event.type === "tool-call-delta");
  assert.equal(deltas.every((event) => typeof event.argsTextDelta === "string" && event.argsTextDelta.length <= 3), true);
  const argumentText = deltas.filter((event) => event.toolCallId === "tool-2").map((event) => event.argsTextDelta).join("");
  assert.deepEqual(JSON.parse(argumentText), { path: "/tmp/y", text: "hi" });
  const delivered = events.filter((event) => event.type === "tool-call");
  assert.deepEqual(delivered.map((event) => [event.toolCallId, event.args]), [["tool-1", { path: "/tmp/x" }], ["tool-2", { path: "/tmp/y", text: "hi" }]]);
});

test("a simulated error is yielded and thrown, and the response carries it", async () => {
  const failure = new Error("simulated");
  const executor = createMockPromptExecutor(() => ({ response: "abcdef", chunkSize: 2, simulateError: failure }));
  const events: Array<Record<string, unknown>> = [];
  const result = executor.stream(undefined);
  const stream = result.fullStream;
  let threw: unknown = null;
  try {
    for await (const event of stream) events.push(event as Record<string, unknown>);
  } catch (error) {
    threw = error;
  }
  assert.equal(threw, failure);
  assert.equal(events.at(-1)?.type, "error");
  assert.equal(events.at(-1)?.error, failure);
  const answer = await result.response;
  assert.equal(answer.error, failure);
  assert.deepEqual(answer.messages[0].content, [{ type: "text", text: "ab" }]);
});

test("a stream delay pauses between pieces", async () => {
  const executor = createMockPromptExecutor(() => ({ response: "ab", chunkSize: 1, streamDelay: 5 }));
  const startedAt = Date.now();
  const { events } = await collect(executor);
  assert.deepEqual(events.filter((event) => event.type === "text-delta").map((event) => event.textDelta), ["a", "b"]);
  assert.equal(Date.now() - startedAt >= 10, true);
});

test("the options are read for every stream, not once", async () => {
  let response = "one";
  const executor = createMockPromptExecutor(() => ({ response }));
  const first = await collect(executor);
  assert.deepEqual(first.events.filter((event) => event.type === "text-delta").map((event) => event.textDelta), ["o", "n", "e"]);
  response = "two";
  const second = await collect(executor);
  assert.equal((second.events.filter((event) => event.type === "text-delta").map((event) => event.textDelta).join("")), "two");
});

test("a builder without initial messages starts empty and can be constructed directly", () => {
  const builder = new MockPromptBuilder();
  assert.equal(typeof builder, "object");
  const executor = new MockPromptExecutor(() => ({ response: "direct" }));
  assert.equal(executor.options().response, "direct");
});
test("the detailed usage carries the cache counters it was given", async () => {
  const executor = createMockPromptExecutor(() => ({ usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 6, maxTokens: 7 } }));
  const { result } = await collect(executor);
  assert.deepEqual(await result.extendedUsage, { inputTokens: 1, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 6, maxTokens: 7 });
  assert.deepEqual(await result.usage, { promptTokens: 1, completionTokens: 2, totalTokens: 3 });
});
