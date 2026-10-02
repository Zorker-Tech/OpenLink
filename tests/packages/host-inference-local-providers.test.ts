/**
 * The local providers a turn can run through: the arguments the Claude Code CLI is run with, the frames its stream is
 * read as, what a turn that did not finish is answered with, and the OpenAI-compatible chat model — what it asks the
 * endpoint for and how it streams what comes back.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { LanguageModelV1CallOptions, LanguageModelV1Prompt, LanguageModelV1StreamPart } from "ai";

import {
  claudeCodeCliArgs,
  createOpenRouterChatModel,
  runClaudeCodeCli,
  streamClaudeCodeFrames,
} from "../../source/host/extensions/inference/local-providers.ts";

/** A CLI of the test's own: a script that prints the frames it was told to, and exits how it was told to. */
function fakeCli(frames: string[], options: { exitCode?: number; stderr?: string } = {}): string {
  const directory = mkdtempSync(join(tmpdir(), "slate-fake-cli-"));
  const path = join(directory, "claude-like");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      ...frames.map((frame) => `printf '%s\\n' '${frame.replace(/'/g, "'\\''")}'`),
      ...(options.stderr == null ? [] : [`printf '%s' '${options.stderr.replace(/'/g, "'\\''")}' >&2`]),
      `exit ${options.exitCode ?? 0}`,
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(path, 0o755);
  return path;
}

const resultFrame = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "result", subtype: "success", errors: [], result: "the answer", session_id: "session-1", total_cost_usd: 0.01, usage: { input_tokens: 3, output_tokens: 4 }, ...overrides });

function callOptions(prompt: LanguageModelV1Prompt, extra: Record<string, unknown> = {}): LanguageModelV1CallOptions {
  return { prompt, inputFormat: "messages", mode: { type: "regular" }, ...extra } as LanguageModelV1CallOptions;
}

const userPrompt: LanguageModelV1Prompt = [
  { role: "system", content: "be brief" },
  { role: "user", content: [{ type: "text", text: "say hi" }] },
];

/** An endpoint of the test's own: it answers with the SSE blocks it was told to, and records what it was asked. */
function fakeEndpoint(blocks: string[] = [], options: { status?: number } = {}) {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) as Record<string, unknown>, headers: (init.headers ?? {}) as Record<string, string> });
    if ((options.status ?? 200) !== 200) return new Response("nope", { status: options.status ?? 200 });
    if (blocks.length === 0) return new Response(JSON.stringify({ choices: [{ message: { content: "the answer", tool_calls: [{ id: "call-1", function: { name: "run", arguments: "{}" } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 3, completion_tokens: 4 } }), { status: 200 });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const block of blocks) controller.enqueue(new TextEncoder().encode(block));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("running the Claude Code CLI", () => {
  it("runs it with the turn it was told to take", () => {
    const base = claudeCodeCliArgs({ executable: "/bin/claude", prompt: "say hi", cwd: tmpdir() });
    assert.deepEqual(base, ["--print", "--output-format", "stream-json", "--verbose", "--permission-mode", "default", "--max-turns=1", "--no-session-persistence", "say hi"]);
    const full = claudeCodeCliArgs({
      executable: "/bin/claude",
      prompt: "say hi",
      cwd: tmpdir(),
      model: "claude-sonnet",
      maxTurns: 8,
      persistSession: true,
      tools: ["mcp__slate_plugins__*"],
      mcpServerName: "slate_plugins",
      mcpServerUrl: "https://box.example/mcp",
    });
    assert.deepEqual(full, [
      "--print", "--output-format", "stream-json", "--verbose", "--permission-mode", "default", "--max-turns=8",
      "--model", "claude-sonnet",
      "--allowedTools", "mcp__slate_plugins__*",
      "--mcp-config", JSON.stringify({ mcpServers: { slate_plugins: { type: "http", url: "https://box.example/mcp" } } }),
      "--strict-mcp-config",
      "say hi",
    ]);
  });

  it("reads every frame it printed as it comes, and answers a finished turn with its result", async () => {
    const executable = fakeCli([JSON.stringify({ type: "system", subtype: "init" }), "not a frame at all", resultFrame()]);
    const frames: string[] = [];
    for await (const frame of streamClaudeCodeFrames({ executable, prompt: "say hi", cwd: tmpdir() })) frames.push(frame.type);
    assert.deepEqual(frames, ["system", "result"]);
    const result = await runClaudeCodeCli({ executable, prompt: "say hi", cwd: tmpdir() });
    assert.deepEqual([result.subtype, result.result, result.session_id, result.usage.output_tokens], ["success", "the answer", "session-1", 4]);
  });

  it("is an error when the CLI failed, and when a turn did not finish", async () => {
    const broken = fakeCli([JSON.stringify({ type: "system" })], { exitCode: 3, stderr: "no such model" });
    await assert.rejects(() => runClaudeCodeCli({ executable: broken, prompt: "say hi", cwd: tmpdir() }), /exited with code 3: no such model/);
    const silent = fakeCli([JSON.stringify({ type: "system" })]);
    await assert.rejects(() => runClaudeCodeCli({ executable: silent, prompt: "say hi", cwd: tmpdir() }), /ended without a result/);
    const refused = fakeCli([resultFrame({ subtype: "error_max_turns", errors: ["too many turns"] })]);
    await assert.rejects(() => runClaudeCodeCli({ executable: refused, prompt: "say hi", cwd: tmpdir() }), /too many turns/);
  });
});

describe("the OpenAI-compatible chat model", () => {
  it("asks the endpoint in the AI SDK's terms, and answers in them", async () => {
    const endpoint = fakeEndpoint();
    const model = createOpenRouterChatModel({ apiKey: "key-1", modelId: "openai/gpt-5.2", fetchImpl: endpoint.fetchImpl, headers: { "X-Title": "Slate" } });
    assert.deepEqual([model.provider, model.modelId, model.specificationVersion, model.defaultObjectGenerationMode], ["openrouter", "openai/gpt-5.2", "v1", "tool"]);
    const generated = await model.doGenerate(callOptions(userPrompt, {
      maxTokens: 100,
      mode: { type: "regular", tools: [{ type: "function", name: "run", description: "runs", parameters: { type: "object" } }], toolChoice: { type: "tool", toolName: "run" } },
    }));
    assert.deepEqual([generated.text, generated.finishReason, generated.usage], ["the answer", "tool-calls", { promptTokens: 3, completionTokens: 4 }]);
    assert.deepEqual(generated.toolCalls?.map((entry) => [entry.toolCallId, entry.toolName, entry.args]), [["call-1", "run", "{}"]]);
    const sent = endpoint.calls[0];
    assert.deepEqual([sent?.url, sent?.headers.authorization, sent?.headers["X-Title"]], ["https://openrouter.ai/api/v1/chat/completions", "Bearer key-1", "Slate"]);
    // A message that is one string is sent as that string; one that is parts is sent as parts.
    assert.deepEqual(sent?.body.messages, [{ role: "system", content: "be brief" }, { role: "user", content: [{ type: "text", text: "say hi" }] }]);
    assert.deepEqual([sent?.body.model, sent?.body.stream, sent?.body.max_tokens, sent?.body.tool_choice], ["openai/gpt-5.2", false, 100, { type: "function", function: { name: "run" } }]);
  });

  it("streams what the endpoint streams: the words, the calls, and what the turn cost", async () => {
    const blocks = [
      'data: {"choices":[{"delta":{"content":"the "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-9","function":{"name":"run","arguments":"{\\"a\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":4}}\n\n',
      "data: [DONE]\n\n",
    ];
    const endpoint = fakeEndpoint(blocks);
    const model = createOpenRouterChatModel({ apiKey: "key-1", modelId: "openai/gpt-5.2", fetchImpl: endpoint.fetchImpl });
    const parts: LanguageModelV1StreamPart[] = [];
    const { stream } = await model.doStream(callOptions(userPrompt));
    for await (const part of stream as unknown as AsyncIterable<LanguageModelV1StreamPart>) parts.push(part);
    assert.deepEqual(parts.map((part) => part.type), ["text-delta", "text-delta", "tool-call", "finish"]);
    assert.deepEqual(parts.filter((part) => part.type === "text-delta").map((part) => (part as { textDelta: string }).textDelta), ["the ", "answer"]);
    assert.deepEqual(parts[2], { type: "tool-call", toolCallType: "function", toolCallId: "call-9", toolName: "run", args: '{"a":1}' });
    assert.deepEqual(parts[3], { type: "finish", finishReason: "tool-calls", usage: { promptTokens: 3, completionTokens: 4 } });
    assert.equal(endpoint.calls[0]?.body.stream, true);
  });

  it("refuses an endpoint that refused", async () => {
    const endpoint = fakeEndpoint([], { status: 429 });
    const model = createOpenRouterChatModel({ apiKey: "key-1", modelId: "openai/gpt-5.2", fetchImpl: endpoint.fetchImpl });
    await assert.rejects(async () => {
      await model.doGenerate(callOptions(userPrompt));
    }, /OpenRouter answered 429/);
    await assert.rejects(async () => {
      await model.doStream(callOptions(userPrompt));
    }, /OpenRouter answered 429/);
  });
});
