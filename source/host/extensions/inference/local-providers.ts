/**
 * The local providers a turn can be run through without the other side's SDKs.
 *
 * Two shapes are needed. The Claude Code CLI is a program this platform resolves and runs itself, so its stream-json
 * frames are read as they arrive and the last one — the result — is what a turn is answered from. OpenRouter is an
 * OpenAI-compatible chat endpoint, so it is spoken to with the platform's own fetch and wrapped in the AI SDK's own
 * model shape, which lets `streamText` drive it like any other model.
 */

import { spawn } from "node:child_process";

import type {
  LanguageModelV1,
  LanguageModelV1CallOptions,
  LanguageModelV1Prompt,
  LanguageModelV1StreamPart,
} from "ai";

/** Why a turn ended, in the AI SDK's own terms. */
type FinishReason = "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other" | "unknown";

/** What the CLI was told to run: a prompt, where to run it, and what it may reach for. */
export interface ClaudeCodeCliOptions {
  readonly executable: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly tools?: readonly string[];
  readonly mcpServerName?: string;
  readonly mcpServerUrl?: string;
  readonly maxTurns?: number;
  readonly model?: string;
  readonly persistSession?: boolean;
}

export interface ClaudeCodeUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
}

export interface ClaudeCodeResultFrame {
  readonly type: "result";
  readonly subtype: string;
  readonly errors: readonly string[];
  readonly result: string;
  readonly session_id: string;
  readonly total_cost_usd: number;
  readonly usage: ClaudeCodeUsage;
}

export type ClaudeCodeFrame = ClaudeCodeResultFrame | { readonly type: string };

/** The arguments the CLI is run with: its stream as JSON, and the turn it was told to take. */
export function claudeCodeCliArgs(options: ClaudeCodeCliOptions): string[] {
  const args = ["--print", "--output-format", "stream-json", "--verbose", "--permission-mode", "default", `--max-turns=${options.maxTurns ?? 1}`];
  if (options.model != null && options.model.length > 0) args.push("--model", options.model);
  if (options.persistSession !== true) args.push("--no-session-persistence");
  const tools = options.tools ?? [];
  if (tools.length > 0) args.push("--allowedTools", tools.join(" "));
  if (options.mcpServerUrl != null && options.mcpServerUrl.length > 0)
    args.push("--mcp-config", JSON.stringify({ mcpServers: { [options.mcpServerName ?? "tools"]: { type: "http", url: options.mcpServerUrl } } }), "--strict-mcp-config");
  args.push(options.prompt);
  return args;
}

/** Runs the CLI and yields every frame it printed, one JSON object per line. */
export async function* streamClaudeCodeFrames(options: ClaudeCodeCliOptions): AsyncGenerator<ClaudeCodeFrame> {
  const child = spawn(options.executable, claudeCodeCliArgs(options), { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
  const queued: ClaudeCodeFrame[] = [];
  let ended = false;
  let failure: Error | undefined;
  let wake: (() => void) | undefined;
  let stderrText = "";
  const notify = () => {
    const resume = wake;
    wake = undefined;
    resume?.();
  };
  let pending = "";
  const push = (line: string) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    try {
      queued.push(JSON.parse(trimmed) as ClaudeCodeFrame);
    } catch {
      // A line that is not a frame is the CLI talking to a human, and is left to stderr.
    }
    notify();
  };
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) push(line);
    if (lines.length > 0) notify();
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrText += chunk;
  });
  child.on("error", (error) => {
    failure = error;
    ended = true;
    notify();
  });
  child.on("close", (code) => {
    if (pending.length > 0) push(pending);
    if (code !== 0 && failure == null) failure = new Error(`Claude Code exited with code ${code}${stderrText.trim().length === 0 ? "" : `: ${stderrText.trim()}`}`);
    ended = true;
    notify();
  });
  try {
    while (true) {
      while (queued.length > 0) yield queued.shift() as ClaudeCodeFrame;
      if (ended) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    while (queued.length > 0) yield queued.shift() as ClaudeCodeFrame;
  } finally {
    child.kill();
  }
  if (failure != null) throw failure;
}

/** Runs the CLI to the end and answers with its result frame, refusing anything but a finished turn. */
export async function runClaudeCodeCli(options: ClaudeCodeCliOptions): Promise<ClaudeCodeResultFrame> {
  let result: ClaudeCodeResultFrame | undefined;
  for await (const frame of streamClaudeCodeFrames(options)) if (frame.type === "result") result = frame as ClaudeCodeResultFrame;
  if (result == null) throw new Error("Claude Code ended without a result.");
  if (result.subtype !== "success") throw new Error(result.errors.join("\n") || `Claude Code failed (${result.subtype}).`);
  return result;
}

/** What an OpenAI-compatible endpoint is called with. */
export interface OpenRouterModelOptions {
  readonly apiKey: string;
  readonly modelId: string;
  readonly baseURL?: string;
  readonly fetchImpl?: typeof fetch;
  readonly headers?: Readonly<Record<string, string>>;
}

interface OpenAiToolCallDelta {
  readonly index: number;
  readonly id?: string;
  readonly function?: { readonly name?: string; readonly arguments?: string };
}

function textOfPrompt(prompt: LanguageModelV1Prompt): unknown[] {
  return prompt.map((message) => {
    const content = typeof message.content === "string" ? message.content : message.content.map((part) => {
      if (part.type === "text") return { type: "text", text: part.text };
      if (part.type === "tool-result") return { type: "text", text: JSON.stringify(part.result) };
      return { type: "text", text: "" };
    });
    return { role: message.role, content };
  });
}

function modeTools(call: LanguageModelV1CallOptions): ReadonlyArray<{ name: string; description?: string; parameters: unknown }> {
  return call.mode.type === "regular" ? (call.mode.tools ?? []) as ReadonlyArray<{ name: string; description?: string; parameters: unknown }> : [];
}

function finishReasonOf(reason: unknown): FinishReason {
  return reason === "length" || reason === "content_filter" || reason === "tool_calls" || reason === "stop" ? (reason === "content_filter" ? "content-filter" : reason === "tool_calls" ? "tool-calls" : reason) : "other";
}

/**
 * A chat model over an OpenAI-compatible endpoint, in the shape the AI SDK drives: what was said, which tools ran, and
 * what the turn cost, streamed as the endpoint sends it.
 */
export function createOpenRouterChatModel(options: OpenRouterModelOptions): LanguageModelV1 {
  const baseURL = (options.baseURL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const send = options.fetchImpl ?? fetch;
  const bodyFor = (call: LanguageModelV1CallOptions, stream: boolean) => ({
    model: options.modelId,
    messages: textOfPrompt(call.prompt),
    stream,
    ...(call.maxTokens == null ? {} : { max_tokens: call.maxTokens }),
    ...(call.temperature == null ? {} : { temperature: call.temperature }),
    ...(modeTools(call).length === 0 ? {} : { tools: modeTools(call).map((entry) => ({ type: "function", function: { name: entry.name, description: entry.description, parameters: entry.parameters } })) }),
    ...(call.mode.type !== "regular" || call.mode.toolChoice == null || call.mode.toolChoice.type !== "tool" ? {} : { tool_choice: { type: "function", function: { name: call.mode.toolChoice.toolName } } }),
  });
  const post = async (call: LanguageModelV1CallOptions, stream: boolean): Promise<Response> =>
    await send(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}`, ...(options.headers ?? {}) },
      body: JSON.stringify(bodyFor(call, stream)),
    });

  return {
    specificationVersion: "v1",
    provider: "openrouter",
    modelId: options.modelId,
    defaultObjectGenerationMode: "tool",
    async doGenerate(call) {
      const response = await post(call, false);
      if (!response.ok) throw new Error(`OpenRouter answered ${response.status}.`);
      const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      const choice = payload.choices?.[0];
      const text = choice?.message?.content ?? null;
      return {
        ...(text == null ? {} : { text }),
        toolCalls: (choice?.message?.tool_calls ?? []).map((entry) => ({ toolCallType: "function" as const, toolCallId: entry.id ?? "", toolName: entry.function?.name ?? "", args: entry.function?.arguments ?? "" })),
        finishReason: finishReasonOf(choice?.finish_reason),
        usage: { promptTokens: payload.usage?.prompt_tokens ?? 0, completionTokens: payload.usage?.completion_tokens ?? 0 },
        warnings: [],
        rawCall: { rawPrompt: call.prompt, rawSettings: {} },
      };
    },
    async doStream(call) {
      const response = await post(call, true);
      if (!response.ok) throw new Error(`OpenRouter answered ${response.status}.`);
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      const calls = new Map<number, { id: string; name: string; args: string }>();
      let usage = { promptTokens: 0, completionTokens: 0 };
      let finishReason: FinishReason = "other";
      let buffered = "";
      const stream = new ReadableStream<LanguageModelV1StreamPart>({
        async start(controller) {
          const handle = (chunk: string): void => {
            for (const block of chunk.split("\n\n")) {
              const line = block.split("\n").find((entry) => entry.startsWith("data:"));
              if (line == null) continue;
              const data = line.slice("data:".length).trim();
              if (data.length === 0 || data === "[DONE]") continue;
              let frame: Record<string, unknown>;
              try {
                frame = JSON.parse(data) as Record<string, unknown>;
              } catch {
                continue;
              }
              const delta = (frame.choices as Array<{ delta?: { content?: string | null; tool_calls?: OpenAiToolCallDelta[] }; finish_reason?: string }> | undefined)?.[0];
              if (delta?.delta?.content != null && delta.delta.content.length > 0) controller.enqueue({ type: "text-delta", textDelta: delta.delta.content });
              for (const entry of delta?.delta?.tool_calls ?? []) {
                const current = calls.get(entry.index) ?? { id: `call-${entry.index}`, name: "", args: "" };
                if (entry.id != null && entry.id.length > 0) current.id = entry.id;
                if (entry.function?.name != null) current.name += entry.function.name;
                if (entry.function?.arguments != null) current.args += entry.function.arguments;
                calls.set(entry.index, current);
              }
              if (delta?.finish_reason != null) finishReason = finishReasonOf(delta.finish_reason);
              const frameUsage = frame.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
              if (frameUsage != null) usage = { promptTokens: frameUsage.prompt_tokens ?? usage.promptTokens, completionTokens: frameUsage.completion_tokens ?? usage.completionTokens };
            }
          };
          try {
            while (true) {
              const { done, value } = await reader?.read() ?? { done: true, value: undefined };
              if (done) break;
              buffered += decoder.decode(value as Uint8Array, { stream: true });
              const boundary = buffered.lastIndexOf("\n\n");
              if (boundary < 0) continue;
              const complete = buffered.slice(0, boundary + 2);
              buffered = buffered.slice(boundary + 2);
              handle(complete);
            }
            if (buffered.length > 0) handle(buffered);
            for (const [index, call] of [...calls.entries()].sort((left, right) => left[0] - right[0]))
              controller.enqueue({ type: "tool-call", toolCallType: "function", toolCallId: call.id || `call-${index}`, toolName: call.name, args: call.args });
            controller.enqueue({ type: "finish", finishReason, usage });
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        },
      });
      return { stream, rawCall: { rawPrompt: call.prompt, rawSettings: {} } };
    },
  };
}
