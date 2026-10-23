/**
 * Reading the usage a provider reports for a turn.
 *
 * What comes back from the provider is read defensively — a field that is missing or not a number is treated as no
 * usage rather than as zero — so a report never claims a turn cost more or less than it did.
 */
type Loose = Record<string, any>;

export type CodexDirectUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
};

export type CodexDirectTool = {
  readonly name: string;
  readonly description?: string;
  readonly parameters: unknown;
  readonly source: Loose;
};

export type CodexDirectEvent =
  | { readonly type: "text-delta"; readonly delta: string }
  | { readonly type: "done"; readonly text: string; readonly responseId: string; readonly usage: CodexDirectUsage };

export type CodexDirectOptions = {
  readonly fetch: typeof fetch;
  readonly endpoint: string;
  readonly model: string;
  readonly reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  readonly instructions: string;
  readonly input: readonly Loose[];
  readonly tools?: readonly CodexDirectTool[];
  readonly executeTool?: (tool: CodexDirectTool, parsedArguments: unknown, toolCallId: string) => Promise<unknown>;
  readonly maxSteps?: number;
};

function objectOf(value: unknown): Loose | null {
  return typeof value === "object" && value != null && !Array.isArray(value) ? value as Loose : null;
}

function jsonTextOf(value: unknown): string {
  try { return JSON.stringify(value, (_key, outputItem) => typeof outputItem === "bigint" ? outputItem.toString() : outputItem) ?? "null"; }
  catch (error) { return JSON.stringify({ isError: true, error: error instanceof Error ? error.message : String(error) }); }
}

async function requestFailure(response: Response): Promise<Error> {
  let errorBody = "";
  try { errorBody = (await response.text()).slice(0, 4_096).trim(); } catch {}
  return new Error(`Codex direct request failed (${response.status}${errorBody.length === 0 ? "" : `: ${errorBody}`}).`);
}

async function* readSseEvents(response: Response): AsyncGenerator<Loose> {
  if (response.body == null) throw new Error("Codex direct response did not include a stream.");
  const streamReader = response.body.getReader();
  const textDecoder = new TextDecoder();
  let pendingText = "";
  while (true) {
    const { done, value } = await streamReader.read();
    pendingText += textDecoder.decode(value, { stream: !done });
    let eventBoundary: number;
    while ((eventBoundary = pendingText.indexOf("\n\n")) !== -1) {
      const eventBlock = pendingText.slice(0, eventBoundary).replaceAll("\r", "");
      pendingText = pendingText.slice(eventBoundary + 2);
      const payload = eventBlock.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
      if (payload.length === 0 || payload === "[DONE]") continue;
      let decoded: unknown;
      try { decoded = JSON.parse(payload); }
      catch { throw new Error("Codex direct response contained malformed SSE JSON."); }
      const message = objectOf(decoded);
      if (message != null) yield message;
    }
    if (done) break;
  }
  if (pendingText.trim().length > 0 && pendingText.trim() !== "data: [DONE]") throw new Error("Codex direct response ended with an incomplete SSE event.");
}

function usageFrom(response: Loose): CodexDirectUsage {
  const usage = objectOf(response.usage) ?? {};
  const details = objectOf(usage.input_tokens_details) ?? {};
  return {
    inputTokens: Number.isFinite(usage.input_tokens) ? usage.input_tokens : 0,
    outputTokens: Number.isFinite(usage.output_tokens) ? usage.output_tokens : 0,
    cacheReadTokens: Number.isFinite(details.cached_tokens) ? details.cached_tokens : 0,
    cacheWriteTokens: 0,
  };
}

function sumUsage(runningUsage: CodexDirectUsage, addition: CodexDirectUsage): CodexDirectUsage {
  return {
    inputTokens: runningUsage.inputTokens + addition.inputTokens,
    outputTokens: runningUsage.outputTokens + addition.outputTokens,
    cacheReadTokens: runningUsage.cacheReadTokens + addition.cacheReadTokens,
    cacheWriteTokens: runningUsage.cacheWriteTokens + addition.cacheWriteTokens,
  };
}

function functionCallsOf(output: readonly unknown[]): Loose[] {
  return output.flatMap(outputItem => {
    const functionCall = objectOf(outputItem);
    return functionCall?.type === "function_call" && typeof functionCall.name === "string" && typeof functionCall.call_id === "string" ? [functionCall] : [];
  });
}

function declaredToolsOf(tools: readonly CodexDirectTool[] | undefined): Loose[] | undefined {
  if (tools == null || tools.length === 0) return undefined;
  return tools.map(tool => ({
    type: "function",
    name: tool.name,
    ...(tool.description == null ? {} : { description: tool.description }),
    parameters: tool.parameters,
    strict: false,
  }));
}

export async function* streamCodexDirectResponses(options: CodexDirectOptions): AsyncGenerator<CodexDirectEvent> {
  const stepLimit = options.maxSteps ?? 8;
  const toolIndex = new Map((options.tools ?? []).map(tool => [tool.name, tool]));
  let input: Loose[] = options.input.map(outputItem => ({ ...outputItem }));
  let text = "";
  let responseId = "";
  let usage: CodexDirectUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  for (let stepIndex = 0; stepIndex < stepLimit; stepIndex += 1) {
    const toolsPayload = declaredToolsOf(options.tools);
    const response = await options.fetch(options.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", "user-agent": "slate-router/1" },
      body: JSON.stringify({
        model: options.model,
        instructions: options.instructions,
        input,
        ...(toolsPayload == null ? {} : { tools: toolsPayload, tool_choice: "auto", parallel_tool_calls: true }),
        ...(options.reasoningEffort == null ? {} : { reasoning: { effort: options.reasoningEffort, summary: "auto" } }),
        include: ["reasoning.encrypted_content"],
        stream: true,
        store: false,
      }),
    });
    if (!response.ok) throw await requestFailure(response);

    let completionEvent: Loose | null = null;
    const streamedItems: Loose[] = [];
    for await (const message of readSseEvents(response)) {
      if (message.type === "response.output_text.delta" && typeof message.delta === "string") {
        text += message.delta;
        yield { type: "text-delta", delta: message.delta };
      } else if (message.type === "response.output_item.done") {
        const outputItem = objectOf(message.outputItem);
        if (outputItem != null) streamedItems.push(outputItem);
      } else if (message.type === "response.completed") {
        completionEvent = objectOf(message.response);
      } else if (message.type === "response.failed" || message.type === "error") {
        const failureDetail = objectOf(message.response)?.error ?? message.error ?? message;
        throw new Error(`Codex direct response failed: ${jsonTextOf(failureDetail).slice(0, 4_096)}`);
      }
    }
    if (completionEvent == null) throw new Error("Codex direct response ended without response.completed.");
    if (typeof completionEvent.id === "string") responseId = completionEvent.id;
    usage = sumUsage(usage, usageFrom(completionEvent));
    const output = Array.isArray(completionEvent.output) && completionEvent.output.length > 0 ? completionEvent.output : streamedItems;
    const calls = functionCallsOf(output);
    if (calls.length === 0) {
      yield { type: "done", text, responseId, usage };
      return;
    }
    if (options.executeTool == null) throw new Error("Codex requested a tool but Slate did not provide an executor.");

    const toolResultItems: Loose[] = [];
    for (const functionCall of calls) {
      const selectedTool = toolIndex.get(functionCall.name);
      if (selectedTool == null) {
        toolResultItems.push({ type: "function_call_output", call_id: functionCall.call_id, output: jsonTextOf({ isError: true, error: `Unknown Slate tool: ${functionCall.name}` }) });
        continue;
      }
      let parsedArguments: unknown = {};
      try { parsedArguments = typeof functionCall.arguments === "string" && functionCall.arguments.length > 0 ? JSON.parse(functionCall.arguments) : {}; }
      catch { toolResultItems.push({ type: "function_call_output", call_id: functionCall.call_id, output: jsonTextOf({ isError: true, error: "Tool arguments were not valid JSON." }) }); continue; }
      try {
        toolResultItems.push({ type: "function_call_output", call_id: functionCall.call_id, output: jsonTextOf(await options.executeTool(selectedTool, parsedArguments, functionCall.call_id)) });
      } catch (error) {
        toolResultItems.push({ type: "function_call_output", call_id: functionCall.call_id, output: jsonTextOf({ isError: true, error: error instanceof Error ? error.message : String(error) }) });
      }
    }
    input = [...input, ...output.map(outputItem => objectOf(outputItem) ?? {}), ...toolResultItems];
  }
  throw new Error(`Codex exceeded Slate's ${stepLimit}-step tool limit.`);
}
