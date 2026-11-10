/**
 * The direct Responses-style provider call: SSE parsing, usage accumulation, the tool round-trip and every failure the
 * provider or the protocol can produce.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { streamCodexDirectResponses, type CodexDirectOptions } from "../../source/host/extensions/inference/codex-direct-responses.ts";

const sseResponse = (events: unknown[], options: Record<string, unknown> = {}) => {
  const text = events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join("") + (options.incomplete === true ? "data: {\"type\"" : "data: [DONE]\n\n");
  const parts = options.splitAt === undefined ? [text] : [text.slice(0, options.splitAt as number), text.slice(options.splitAt as number)];
  return new Response(new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(new TextEncoder().encode(part as string)); controller.close(); } }), { status: 200 });
};

const base = (overrides: Partial<CodexDirectOptions> = {}): Partial<CodexDirectOptions> => ({ endpoint: "https://provider.test/responses", model: "gpt-5", instructions: "be brief", input: [{ role: "user", content: "hi" }], ...overrides });

async function run(options: Partial<CodexDirectOptions>, responses: Array<() => Response>) {
  const requests: Array<{ url: string; init: Record<string, unknown> }> = [];
  let index = 0;
  const fetchImpl = async (url: string, init: Record<string, unknown>) => {
    requests.push({ url, init });
    const response = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return response();
  };
  const events: unknown[] = [];
  let thrown: Error | undefined;
  try {
    for await (const event of streamCodexDirectResponses({ ...(base() as CodexDirectOptions), ...options, fetch: fetchImpl as never })) events.push(event);
  } catch (error) { thrown = error as Error; }
  return { requests, events, thrown };
}

test("text deltas are streamed and the completed usage is reported", async () => {
  const outcome = await run({}, [() => sseResponse([
    { type: "response.output_text.delta", delta: "hello " },
    { type: "response.output_text.delta", delta: "world" },
    { type: "response.completed", response: { id: "resp-1", usage: { input_tokens: 10, output_tokens: 4, input_tokens_details: { cached_tokens: 2 } } } },
  ])]);
  assert.deepEqual(outcome.events, [
    { type: "text-delta", delta: "hello " },
    { type: "text-delta", delta: "world" },
    { type: "done", text: "hello world", responseId: "resp-1", usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 0 } },
  ]);
  assert.equal(outcome.thrown, undefined);
  assert.equal(outcome.requests[0]?.url, "https://provider.test/responses");
  assert.equal(outcome.requests[0]?.init.method, "POST");
  assert.equal((outcome.requests[0]?.init.headers as Record<string, string>)["content-type"], "application/json");
  assert.equal((outcome.requests[0]?.init.headers as Record<string, string>).accept, "text/event-stream");
  assert.equal((outcome.requests[0]?.init.headers as Record<string, string>)["user-agent"], "slate-router/1");
  assert.deepEqual((JSON.parse(String(outcome.requests[0]?.init.body)) as { include: string[] }).include, ["reasoning.encrypted_content"]);
});

test("an event split across chunks is still parsed", async () => {
  const outcome = await run({}, [() => sseResponse([{ type: "response.output_text.delta", delta: "split" }, { type: "response.completed", response: { id: "r", usage: {} } }], { splitAt: 25 })]);
  assert.deepEqual(outcome.events, [{ type: "text-delta", delta: "split" }, { type: "done", text: "split", responseId: "r", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }]);
});

test("declared tools and the reasoning effort reach the request", async () => {
  const outcome = await run({ tools: [{ name: "read_file", description: "reads", parameters: { type: "object" }, source: {} }], reasoningEffort: "high" }, [() => sseResponse([{ type: "response.completed", response: { id: "r", output: [], usage: {} } }])]);
  const body = JSON.parse(String(outcome.requests[0]?.init.body)) as Record<string, unknown>;
  assert.deepEqual(body.tools, [{ type: "function", name: "read_file", description: "reads", parameters: { type: "object" }, strict: false }]);
  assert.equal(body.tool_choice, "auto");
  assert.equal(body.parallel_tool_calls, true);
  assert.deepEqual(body.reasoning, { effort: "high", summary: "auto" });
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
});

test("a tool round-trip runs the executor and sends its result back", async () => {
  const outcome = await run({
    tools: [{ name: "read_file", parameters: {}, source: {} }],
    executeTool: async (_tool, args, id) => ({ args, id }),
  }, [
    () => sseResponse([{ type: "response.completed", response: { id: "resp-1", usage: { input_tokens: 5, output_tokens: 1 }, output: [{ type: "function_call", name: "read_file", call_id: "call-1", arguments: "{\"path\":\"/a\"}" }] } }]),
    () => sseResponse([{ type: "response.output_text.delta", delta: "done" }, { type: "response.completed", response: { id: "resp-2", usage: { input_tokens: 7, output_tokens: 2 } } }]),
  ]);
  assert.equal(outcome.requests.length, 2);
  const second = JSON.parse(String(outcome.requests[1]?.init.body)) as { input: unknown[] };
  assert.deepEqual(second.input, [
    { role: "user", content: "hi" },
    { type: "function_call", name: "read_file", call_id: "call-1", arguments: "{\"path\":\"/a\"}" },
    { type: "function_call_output", call_id: "call-1", output: "{\"args\":{\"path\":\"/a\"},\"id\":\"call-1\"}" },
  ]);
  assert.deepEqual(outcome.events, [{ type: "text-delta", delta: "done" }, { type: "done", text: "done", responseId: "resp-2", usage: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 } }]);
});

test("an unknown tool and invalid arguments are answered with error payloads", async () => {
  const unknown = await run({ tools: [{ name: "known", parameters: {}, source: {} }], executeTool: async () => "ok" }, [
    () => sseResponse([{ type: "response.completed", response: { id: "r", output: [{ type: "function_call", name: "missing", call_id: "c", arguments: "{}" }] } }]),
    () => sseResponse([{ type: "response.completed", response: { id: "r2", usage: {} } }]),
  ]);
  const unknownInput = JSON.parse(String(unknown.requests[1]?.init.body)).input as Array<Record<string, unknown>>;
  assert.equal(unknownInput[2]?.output, "{\"isError\":true,\"error\":\"Unknown Slate tool: missing\"}");
  const invalid = await run({ tools: [{ name: "t", parameters: {}, source: {} }], executeTool: async () => "ok" }, [
    () => sseResponse([{ type: "response.completed", response: { id: "r", output: [{ type: "function_call", name: "t", call_id: "c", arguments: "not json" }] } }]),
    () => sseResponse([{ type: "response.completed", response: { id: "r2", usage: {} } }]),
  ]);
  const invalidInput = JSON.parse(String(invalid.requests[1]?.init.body)).input as Array<Record<string, unknown>>;
  assert.equal(invalidInput[2]?.output, "{\"isError\":true,\"error\":\"Tool arguments were not valid JSON.\"}");
});

test("an executor failure is answered with the error message", async () => {
  const outcome = await run({ tools: [{ name: "t", parameters: {}, source: {} }], executeTool: async () => { throw new Error("exec failed"); } }, [
    () => sseResponse([{ type: "response.completed", response: { id: "r", output: [{ type: "function_call", name: "t", call_id: "c", arguments: "{}" }] } }]),
    () => sseResponse([{ type: "response.completed", response: { id: "r2", usage: {} } }]),
  ]);
  const input = JSON.parse(String(outcome.requests[1]?.init.body)).input as Array<Record<string, unknown>>;
  assert.equal(input[2]?.output, "{\"isError\":true,\"error\":\"exec failed\"}");
});

test("a tool request without an executor is refused", async () => {
  const outcome = await run({}, [() => sseResponse([{ type: "response.completed", response: { id: "r", output: [{ type: "function_call", name: "t", call_id: "c", arguments: "{}" }] } }])]);
  assert.equal(outcome.thrown?.message, "Codex requested a tool but Slate did not provide an executor.");
});

test("provider failures are reported as errors", async () => {
  const failed = await run({}, [() => sseResponse([{ type: "response.failed", response: { error: { code: "bad" } } }])]);
  assert.match(failed.thrown?.message ?? "", /Codex direct response failed: \{"code":"bad"\}/);
  const errorEvent = await run({}, [() => sseResponse([{ type: "error", error: { message: "nope" } }])]);
  assert.match(errorEvent.thrown?.message ?? "", /Codex direct response failed: \{"message":"nope"\}/);
  const notOk = await run({}, [() => new Response("  bad request  ", { status: 422 })]);
  assert.equal(notOk.thrown?.message, "Codex direct request failed (422: bad request).");
});

test("a malformed, incomplete or bodiless stream is refused", async () => {
  const malformed = await run({}, [() => new Response("data: {oops\n\n", { status: 200 })]);
  assert.equal(malformed.thrown?.message, "Codex direct response contained malformed SSE JSON.");
  const incomplete = await run({}, [() => sseResponse([], { incomplete: true })]);
  assert.match(incomplete.thrown?.message ?? "", /incomplete SSE event/);
  const bodiless = await run({}, [() => new Response(null, { status: 200 })]);
  assert.equal(bodiless.thrown?.message, "Codex direct response did not include a stream.");
  const missing = await run({}, [() => sseResponse([{ type: "response.output_text.delta", delta: "x" }])]);
  assert.equal(missing.thrown?.message, "Codex direct response ended without response.completed.");
});

test("the step limit stops a model that keeps calling tools", async () => {
  const outcome = await run({ maxSteps: 2, tools: [{ name: "t", parameters: {}, source: {} }], executeTool: async () => "ok" }, [
    () => sseResponse([{ type: "response.completed", response: { id: "r", output: [{ type: "function_call", name: "t", call_id: "c", arguments: "{}" }] } }]),
    () => sseResponse([{ type: "response.completed", response: { id: "r2", output: [{ type: "function_call", name: "t", call_id: "c2", arguments: "{}" }] } }]),
  ]);
  assert.equal(outcome.requests.length, 2);
  assert.equal(outcome.thrown?.message, "Codex exceeded Slate's 2-step tool limit.");
});

test("streamed output items stand in when the completion carries none", async () => {
  const outcome = await run({}, [() => sseResponse([
    { type: "response.output_item.done", item: { type: "message", content: [] } },
    { type: "response.completed", response: { id: "r", usage: {}, output: [] } },
  ])]);
  assert.deepEqual(outcome.events, [{ type: "done", text: "", responseId: "r", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }]);
});

test("a tool result that cannot be serialized becomes an error payload", async () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const outcome = await run({ tools: [{ name: "t", parameters: {}, source: {} }], executeTool: async () => circular }, [
    () => sseResponse([{ type: "response.completed", response: { id: "r", output: [{ type: "function_call", name: "t", call_id: "c", arguments: "{}" }] } }]),
    () => sseResponse([{ type: "response.completed", response: { id: "r2", usage: {} } }]),
  ]);
  const input = JSON.parse(String(outcome.requests[1]?.init.body)).input as Array<Record<string, unknown>>;
  assert.match(String(input[2]?.output), /^\{"isError":true,"error":/);
});
