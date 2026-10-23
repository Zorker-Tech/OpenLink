import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TracingMiddleware,
  createTracingMiddleware,
  tracingMiddleware,
} from "../../source/packages/chat-inference/middleware/tracing-middleware.ts";
import { metricsKey, type MetricsBackend } from "../../source/packages/metrics/index.ts";
import { createContext } from "../../source/packages/context/context.ts";

interface Recorded {
  type: string;
  name: string;
  value: number;
  labels?: Record<string, string> | undefined;
}

function recording(): { backend: MetricsBackend; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const backend: MetricsBackend = {
    record(_context, handle, value, labels) { calls.push({ type: "record", name: handle.name, value, labels }); },
    increment(_context, handle, value, labels) { calls.push({ type: "increment", name: handle.name, value, labels }); },
    gauge(_context, handle, value, labels) { calls.push({ type: "gauge", name: handle.name, value, labels }); },
    histogram(_context, handle, value, labels) { calls.push({ type: "histogram", name: handle.name, value, labels }); },
  };
  return { backend, calls };
}
const contextWith = (backend: MetricsBackend) => createContext().with(metricsKey, backend);
const of = (calls: Recorded[], name: string) => calls.filter((call) => call.name === name);
const label = (call: Recorded) => call.labels?.message_type ?? call.labels?.outcome;

function innerStream(events: unknown[], response: Promise<unknown>) {
  return {
    fullStream: (async function* () { for (const event of events) yield event; })(),
    response,
    usage: Promise.resolve({ promptTokens: 1 }),
    providerMetadata: Promise.resolve(undefined),
    extendedUsage: Promise.resolve({}),
    invocationId: Promise.resolve("inv-1"),
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test("the input distribution counts messages and characters by role", async () => {
  const { backend, calls } = recording();
  const messages = [
    { role: "user", content: "hello" },
    { role: "assistant", content: [{ type: "text", text: "abc" }, { type: "image" }, { type: "text", text: "de" }] },
    { role: "tool", content: [{ type: "tool-result", result: "ok" }, { type: "tool-result", result: { a: 1 } }] },
    { role: "system", content: "ignored" },
  ];
  const inner = { getMessages: () => messages, stream: () => innerStream([], Promise.resolve({})) };
  const middleware = new TracingMiddleware(inner as never);
  middleware.stream(contextWith(backend), "inv-1");
  const counts = of(calls, "chat_inference.input_messages").map((call) => [label(call), call.value]);
  assert.deepEqual(counts, [["user", 1], ["assistant", 1], ["tool", 1]]);
  const chars = of(calls, "chat_inference.input_characters").map((call) => [label(call), call.value]);
  assert.deepEqual(chars, [["user", 5], ["assistant", 5], ["tool", 2 + JSON.stringify({ a: 1 }).length]]);
});

test("a string tool result and a string user message are counted", async () => {
  const { backend, calls } = recording();
  const messages = [
    { role: "user", content: [{ type: "text", text: "one" }, { type: "image" }] },
    { role: "tool", content: "plain" },
  ];
  const middleware = new TracingMiddleware({ getMessages: () => messages, stream: () => innerStream([], Promise.resolve({})) } as never);
  middleware.stream(contextWith(backend));
  assert.deepEqual(of(calls, "chat_inference.input_characters").map((call) => [label(call), call.value]), [["user", 3], ["assistant", 0], ["tool", 5]]);
});

test("the chain duration is measured and events pass through unchanged", async () => {
  const { backend, calls } = recording();
  const events = [{ type: "text-delta", textDelta: "a" }, { type: "text-delta", textDelta: "b" }];
  const inner = { getMessages: () => [], stream: () => innerStream(events, Promise.resolve({})) };
  const result = new TracingMiddleware(inner as never).stream(contextWith(backend), "inv-1");
  const seen = [];
  for await (const event of result.fullStream) seen.push(event);
  assert.deepEqual(seen, events);
  assert.equal(of(calls, "agent.ttft.middlewareChainMs").length, 1);
  assert.equal(of(calls, "chat_inference.ttft_ms").length, 1);
  assert.deepEqual(of(calls, "chat_inference.ttft_ms").map((call) => call.labels?.outcome), ["success"]);
  assert.equal(await result.invocationId, "inv-1");
  assert.deepEqual(await result.usage, { promptTokens: 1 });
  assert.deepEqual(await result.extendedUsage, {});
});

test("the first token is timed once even with many parts", async () => {
  const { backend, calls } = recording();
  const events = [{ type: "text-delta" }, { type: "text-delta" }, { type: "tool-call" }];
  const inner = { getMessages: () => [], stream: () => innerStream(events, Promise.resolve({})) };
  const result = new TracingMiddleware(inner as never).stream(contextWith(backend));
  for await (const _event of result.fullStream) { /* consume */ }
  assert.equal(of(calls, "chat_inference.ttft_ms").length, 1);
  const toolCalls = of(calls, "chat_inference.ttf_toolcall_ms");
  assert.deepEqual(toolCalls.map((call) => call.labels?.outcome), ["success"]);
});

test("the first tool call is timed for deltas as well", async () => {
  const { backend, calls } = recording();
  const events = [{ type: "tool-call-delta" }, { type: "text-delta" }, { type: "tool-call" }];
  const inner = { getMessages: () => [], stream: () => innerStream(events, Promise.resolve({})) };
  const result = new TracingMiddleware(inner as never).stream(contextWith(backend));
  for await (const _event of result.fullStream) { /* consume */ }
  assert.equal(of(calls, "chat_inference.ttf_toolcall_ms").length, 1);
});

test("a stream failure before a token is counted as a failure and rethrown", async () => {
  const { backend, calls } = recording();
  const failure = new Error("stream broke");
  const inner = {
    getMessages: () => [],
    stream: () => ({
      fullStream: (async function* () { yield { type: "text-delta" }; throw failure; })(),
      response: Promise.resolve({}),
    }),
  };
  const result = new TracingMiddleware(inner as never).stream(contextWith(backend));
  let threw: unknown = null;
  try { for await (const _event of result.fullStream) { /* consume */ } } catch (error) { threw = error; }
  assert.equal(threw, failure);
  assert.equal(of(calls, "chat_inference.ttft_ms").length, 1);
});

test("the response outcome is counted and the response is passed through", async () => {
  const { backend, calls } = recording();
  const successResponse = { id: "ok" };
  let result = new TracingMiddleware({ getMessages: () => [], stream: () => innerStream([], Promise.resolve(successResponse)) } as never).stream(contextWith(backend));
  assert.equal(await result.response, successResponse);
  const failedResponse = { id: "bad", error: new Error("no") };
  result = new TracingMiddleware({ getMessages: () => [], stream: () => innerStream([], Promise.resolve(failedResponse)) } as never).stream(contextWith(backend));
  assert.equal(await result.response, failedResponse);
  const e2e = of(calls, "chat_inference.e2e_latency_ms").map((call) => call.labels?.outcome);
  const outcomes = of(calls, "chat_inference.request_outcome").map((call) => call.labels?.outcome);
  assert.deepEqual(e2e, ["success", "success"]);
  assert.deepEqual(outcomes, ["success", "failure"]);
});

test("a rejected response is counted as a failure and rethrown", async () => {
  const { backend, calls } = recording();
  const failure = new Error("response rejected");
  const result = new TracingMiddleware({ getMessages: () => [], stream: () => innerStream([], Promise.reject(failure)) } as never).stream(contextWith(backend));
  await assert.rejects(() => result.response, (error: unknown) => error === failure);
  assert.deepEqual(of(calls, "chat_inference.e2e_latency_ms").map((call) => call.labels?.outcome), ["failure"]);
  assert.deepEqual(of(calls, "chat_inference.request_outcome").map((call) => call.labels?.outcome), ["failure"]);
});

test("the middleware factory builds tracing middleware", () => {
  const inner = { getMessages: () => [], stream: () => innerStream([], Promise.resolve({})) };
  const middleware = createTracingMiddleware()(inner as never);
  assert.equal(middleware instanceof TracingMiddleware, true);
  assert.equal(typeof tracingMiddleware, "function");
});

test("the metric names are the contract", async () => {
  const { backend, calls } = recording();
  const inner = { getMessages: () => [{ role: "user", content: "x" }], stream: () => innerStream([{ type: "text-delta" }, { type: "tool-call-delta" }], Promise.resolve({})) };
  const result = new TracingMiddleware(inner as never).stream(contextWith(backend));
  for await (const _event of result.fullStream) { /* consume */ }
  await result.response;
  const names = new Set(calls.map((call) => call.name));
  for (const name of ["chat_inference.input_messages", "chat_inference.input_characters", "agent.ttft.middlewareChainMs", "chat_inference.ttft_ms", "chat_inference.ttf_toolcall_ms", "chat_inference.e2e_latency_ms", "chat_inference.request_outcome"]) {
    assert.equal(names.has(name), true, name);
  }
});
test("a stream that fails before any token records a failed first token", async () => {
  const { backend, calls } = recording();
  const failure = new Error("no first token");
  const inner = {
    getMessages: () => [],
    stream: () => ({
      fullStream: (async function* () { throw failure; })(),
      response: Promise.resolve({}),
    }),
  };
  const result = new TracingMiddleware(inner as never).stream(contextWith(backend));
  let threw: unknown = null;
  try { for await (const _event of result.fullStream) { /* consume */ } } catch (error) { threw = error; }
  assert.equal(threw, failure);
  const ttft = of(calls, "chat_inference.ttft_ms");
  assert.deepEqual(ttft.map((call) => call.labels?.outcome), ["failure"]);
});
