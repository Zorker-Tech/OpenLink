/**
 * The client that speaks the inference protocol.
 *
 * What is pinned here is the translation layer: the descriptions stamped onto image parts, the request the executor
 * builds from a context and a builder, the headers it carries, every frame the stream turns into prompt parts, the facts
 * a stream settles for its caller, the fallbacks a stream that said nothing still answers, and the session/provider
 * surface that wraps it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { InputTokenLimitError, OutputTokensLimitExceededError } from "../../source/packages/chat-inference/prompt-executor.ts";
import {
  automationIdKey,
  conversationIdKey,
  createProtoSessionProvider,
  ProtoPromptBuilder,
  ProtoPromptExecutor,
  ProtoPromptSession,
  ProtoSessionProvider,
  requestIdKey,
  requestedModelKey,
  stampImageDescriptionsOnMessage,
} from "../../source/adapters/interop/chat-inference-proto/client.ts";
import { createContext } from "../../source/packages/context/context.ts";
import { withSpan } from "../../source/packages/context/telemetry.ts";
import {
  InferenceExtendedUsageInfo,
  InferenceImageDescription,
  InferenceImageDescriptionsInfo,
  InferenceInvocationIdInfo,
  InferenceMessageRole,
  InferenceReason,
  InferenceProviderMetadataInfo,
  InferenceResponseInfo,
  InferenceStreamError,
  InferenceStreamResponse,
  InferenceTextStreamPart,
  InferenceThinkingStreamPart,
  InferenceToolCallStreamPart,
  InferenceUsageInfo,
} from "../../source/adapters/interop/proto/generated/aiserver/v1/inference_pb.ts";

const MODEL = {
  modelId: "probe-model",
  maxMode: false,
  parameters: [{ id: "p", value: "v" }],
  builtInModel: false,
  isVariantStringRepresentation: false,
};

const arm = (response: InferenceStreamResponse["response"]): InferenceStreamResponse => new InferenceStreamResponse({ response });
const textFrame = (text: string, isFinal = false): InferenceStreamResponse => arm({ case: "textPart", value: new InferenceTextStreamPart({ text, isFinal }) });
const thinkingFrame = (text: string, signature?: string): InferenceStreamResponse => arm({ case: "thinkingPart", value: new InferenceThinkingStreamPart({ text, ...(signature === undefined ? {} : { signature }) }) });
const toolCallFrame = (value: Record<string, unknown>): InferenceStreamResponse => arm({ case: "toolCallPart", value: new InferenceToolCallStreamPart(value as never) });
const usageFrame = (promptTokens: number, completionTokens: number, totalTokens?: number): InferenceStreamResponse => arm({ case: "usage", value: new InferenceUsageInfo({ promptTokens, completionTokens, ...(totalTokens === undefined ? {} : { totalTokens }) }) });
const extendedUsageFrame = (value: Record<string, number>): InferenceStreamResponse => arm({ case: "extendedUsage", value: new InferenceExtendedUsageInfo(value as never) });
const providerMetadataFrame = (metadata?: Record<string, unknown>): InferenceStreamResponse => arm({ case: "providerMetadata", value: new InferenceProviderMetadataInfo().fromJson((metadata === undefined ? {} : { metadata }) as never) });
const invocationIdFrame = (invocationId: string): InferenceStreamResponse => arm({ case: "invocationId", value: new InferenceInvocationIdInfo({ invocationId }) });
const errorFrame = (message: string): InferenceStreamResponse => arm({ case: "error", value: new InferenceStreamError({ message }) });
const imageDescriptionsFrame = (descriptions: Array<Record<string, unknown>>): InferenceStreamResponse =>
  arm({ case: "imageDescriptions", value: new InferenceImageDescriptionsInfo({ descriptions: descriptions.map((description) => new InferenceImageDescription(description as never)) }) });

const responseInfoJson = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "response-1",
  model: "model-9",
  createdAt: "1700000000000",
  messages: [
    {
      id: "assistant-1",
      role: "INFERENCE_MESSAGE_ROLE_ASSISTANT",
      content: "the answer",
      reasoningParts: [
        { isRedacted: false, text: "thinking", signature: "sig-1", modelName: "thinking-model" },
        { isRedacted: true, redactedData: "secret", modelName: "other-model" },
        { isRedacted: false, text: "plain" },
      ],
      toolCalls: [{ toolCallId: "call-1", toolName: "tool-1", args: { a: 1 } }],
    },
    {
      id: "tool-1",
      role: "INFERENCE_MESSAGE_ROLE_TOOL",
      toolResult: {
        parts: [
          { toolCallId: "call-1", toolName: "tool-1", result: "done", isError: false },
          { toolCallId: "call-2", toolName: "tool-2", result: { nested: true }, isError: true },
        ],
      },
    },
    { id: "empty", role: "INFERENCE_MESSAGE_ROLE_UNSPECIFIED" },
  ],
  ...over,
});
const responseInfoFrame = (over: Record<string, unknown> = {}): InferenceStreamResponse =>
  arm({ case: "responseInfo", value: new InferenceResponseInfo().fromJson(responseInfoJson(over) as never) });

interface ClientCall {
  readonly request: {
    messages: Array<Record<string, unknown>>;
    tools: Array<Record<string, unknown>>;
    providerDefinedTools: Array<Record<string, unknown>>;
    invocationId?: string;
    conversationId?: string;
    automationId?: string;
    inferenceReason?: number;
    acceptedUnadvertisedToolNames: string[];
    modelConfig?: { maxTokens?: number; temperature?: number; topP?: number };
    requestedModel: { modelId: string };
  };
  readonly headers: Record<string, string>;
  readonly signal: AbortSignal;
}

/** A transport that records what it was asked to send and answers with the frames it was given. */
function recordingClient(frames: readonly InferenceStreamResponse[], failure?: unknown): {
  client: { stream(request: ClientCall["request"], options: { signal: AbortSignal; headers: Record<string, string> }): AsyncIterable<InferenceStreamResponse> };
  calls: ClientCall[];
} {
  const calls: ClientCall[] = [];
  return {
    calls,
    client: {
      stream(request, options) {
        calls.push({ request, headers: options.headers, signal: options.signal });
        return (async function* () {
          for (const streamed of frames) yield streamed;
          if (failure !== undefined) throw failure;
        })();
      },
    },
  };
}

function executorFor(client: { stream: never }, messages: Array<Record<string, unknown>> = [{ role: "user", content: "hello" }], modelConfig?: Record<string, unknown>): ProtoPromptExecutor {
  return new ProtoPromptExecutor(new ProtoPromptBuilder(messages as never), client as never, MODEL as never, modelConfig as never);
}

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const parts: unknown[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

// ---------------------------------------------------------------------------------------------
// context keys and stamped descriptions
// ---------------------------------------------------------------------------------------------

test("the context keys carry one fact each", () => {
  const context = createContext();
  assert.deepEqual([
    context.get(requestIdKey),
    context.get(conversationIdKey),
    context.get(automationIdKey),
    context.get(requestedModelKey),
  ], [undefined, undefined, undefined, undefined]);
  const set = context.with(requestIdKey, "request-1").with(conversationIdKey, "conversation-1");
  assert.deepEqual([set.get(requestIdKey), set.get(conversationIdKey)], ["request-1", "conversation-1"]);
  assert.equal(new Set([requestIdKey, conversationIdKey, automationIdKey, requestedModelKey]).size, 4);
});

test("a user message's images take the descriptions given for them", () => {
  const message = { role: "user", content: [{ type: "text", text: "look" }, { type: "image", providerOptions: { cursor: { existing: true } } }] };
  const before = JSON.stringify(message);
  const stamped = stampImageDescriptionsOnMessage(message, [{ partIndex: 1, description: "a screenshot" }]);
  assert.deepEqual(stamped, {
    role: "user",
    content: [
      { type: "text", text: "look" },
      { type: "image", providerOptions: { cursor: { existing: true, imageDescription: "a screenshot" } } },
    ],
  });
  // The message the caller owns is untouched.
  assert.equal(JSON.stringify(message), before);
});

test("a description filed under an experimental content index does not belong to a user message", () => {
  const message = { role: "user", content: [{ type: "image" }] };
  assert.equal(stampImageDescriptionsOnMessage(message, [{ partIndex: 0, description: "x", expContentIndex: 0 }]), undefined);
  assert.equal(stampImageDescriptionsOnMessage(message, []), undefined);
});

test("a tool result's image descriptions are merged under their index", () => {
  const message = {
    role: "tool",
    content: [{
      type: "tool-result",
      experimental_content: [{ type: "text" }, { type: "image" }],
      providerOptions: { cursor: { imageDescriptions: { 0: "known" }, other: 1 } },
    }],
  };
  const before = JSON.stringify(message);
  const stamped = stampImageDescriptionsOnMessage(message, [{ partIndex: 0, expContentIndex: 1, description: "described" }]);
  // The message the caller owns is untouched.
  assert.equal(JSON.stringify(message), before);
  assert.deepEqual(stamped, {
    role: "tool",
    content: [{
      type: "tool-result",
      experimental_content: [{ type: "text" }, { type: "image" }],
      providerOptions: { cursor: { imageDescriptions: { 0: "known", 1: "described" }, other: 1 } },
    }],
  });
});

test("only image parts and image experimental content are described", () => {
  assert.equal(stampImageDescriptionsOnMessage({ role: "user", content: [{ type: "text", text: "x" }] }, [{ partIndex: 0, description: "no" }]), undefined);
  assert.equal(stampImageDescriptionsOnMessage({ role: "tool", content: [{ type: "tool-result", experimental_content: [{ type: "text" }] }] }, [{ partIndex: 0, expContentIndex: 0, description: "no" }]), undefined);
  assert.equal(stampImageDescriptionsOnMessage({ role: "tool", content: [{ type: "tool-result" }] }, [{ partIndex: 0, expContentIndex: 0, description: "no" }]), undefined);
  assert.equal(stampImageDescriptionsOnMessage({ role: "tool", content: [{ type: "text", experimental_content: [{ type: "image" }] }] }, [{ partIndex: 0, expContentIndex: 0, description: "no" }]), undefined);
  assert.equal(stampImageDescriptionsOnMessage({ role: "assistant", content: [{ type: "image" }] }, [{ partIndex: 0, description: "no" }]), undefined);
  assert.equal(stampImageDescriptionsOnMessage({ role: "user" }, [{ partIndex: 0, description: "no" }]), undefined);
  assert.equal(stampImageDescriptionsOnMessage({ role: "user", content: "not a list" }, [{ partIndex: 0, description: "no" }]), undefined);
});

// ---------------------------------------------------------------------------------------------
// the builder
// ---------------------------------------------------------------------------------------------

test("the builder replaces a message it still holds and refuses one it does not", () => {
  const first = { role: "user", content: "first" };
  const second = { role: "user", content: "second" };
  const builder = new ProtoPromptBuilder([first, second]);
  assert.equal(builder.replaceMessage({ role: "user", content: "ghost" }, { role: "user", content: "next" }), false);
  assert.equal(builder.replaceMessage(first, { role: "user", content: "first again" }), true);
  assert.deepEqual(builder.getMessages(), [{ role: "user", content: "first again" }, second]);
});

// ---------------------------------------------------------------------------------------------
// the request the executor builds
// ---------------------------------------------------------------------------------------------

test("the executor builds a request from the context, the builder and the stream options", () => {
  const { client, calls } = recordingClient([]);
  const context = createContext()
    .with(requestIdKey, "request-1")
    .with(conversationIdKey, "conversation-1")
    .with(automationIdKey, "automation-1");
  const executor = executorFor(client as never, [{ role: "user", content: "hello" }], { maxTokens: 10, temperature: 0.25, topP: 0.9 });
  executor.stream(context, "invocation-1", [
    { name: "plain", description: "a plain tool", parameters: { type: "object", properties: {} } },
    { name: "provider", id: "provider-id", type: "provider-defined" },
  ], { maxTokens: 99, acceptedUnadvertisedToolNames: ["secret"] });

  assert.equal(calls.length, 1);
  const request = calls[0]!.request as unknown as {
    messages: Array<{ role: number; content: { case: string; value: unknown } }>;
    tools: Array<{ name: string }>;
    providerDefinedTools: Array<{ name: string }>;
    invocationId?: string;
    conversationId?: string;
    automationId?: string;
    acceptedUnadvertisedToolNames: string[];
    modelConfig?: { maxTokens?: number; temperature?: number; topP?: number; stopSequences: string[] };
    requestedModel: { modelId: string };
  };
  assert.deepEqual(request.messages.map((message) => [message.role, message.content.case, message.content.value]), [
    [InferenceMessageRole.USER, "text", "hello"],
  ]);
  assert.deepEqual(request.tools.map((tool) => tool.name), ["plain"]);
  assert.deepEqual(request.providerDefinedTools.map((tool) => tool.name), ["provider"]);
  assert.equal(request.invocationId, "invocation-1");
  assert.equal(request.conversationId, "conversation-1");
  assert.equal(request.automationId, "automation-1");
  assert.deepEqual(request.acceptedUnadvertisedToolNames, ["secret"]);
  assert.deepEqual({
    maxTokens: request.modelConfig?.maxTokens,
    temperature: request.modelConfig?.temperature,
    topP: request.modelConfig?.topP,
    stopSequences: [...(request.modelConfig?.stopSequences ?? [])],
  }, { maxTokens: 99, temperature: 0.25, topP: 0.9, stopSequences: [] });
  assert.equal(request.requestedModel.modelId, "probe-model");
});

test("a model chosen on the context overrides the one the executor was built with", () => {
  const { client, calls } = recordingClient([]);
  const context = createContext().with(requestedModelKey, { ...MODEL, modelId: "context-model" });
  executorFor(client as never).stream(context, undefined, [], {});
  assert.equal(calls[0]!.request.requestedModel.modelId, "context-model");
});

test("the request carries the request id and the trace it belongs to", () => {
  const withRequestId = recordingClient([]);
  executorFor(withRequestId.client as never).stream(createContext().with(requestIdKey, "request-2"), undefined, [], {});
  assert.deepEqual(withRequestId.calls[0]!.headers, { "x-request-id": "request-2" });

  const plain = recordingClient([]);
  executorFor(plain.client as never).stream(createContext(), undefined, [], {});
  assert.deepEqual(plain.calls[0]!.headers, {});

  const traced = recordingClient([]);
  executorFor(traced.client as never).stream(withSpan(createContext()), undefined, [], {});
  const headers = traced.calls[0]!.headers;
  assert.match(headers.traceparent ?? "", /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
  assert.equal(headers["backend-traceparent"], headers.traceparent);
});

test("the context's own signal is what the transport watches", () => {
  const controller = new AbortController();
  controller.abort();
  const { client, calls } = recordingClient([]);
  const context = createContext();
  (context as unknown as { signal: AbortSignal }).signal = controller.signal;
  executorFor(client as never).stream(context, undefined, [], {});
  assert.equal(calls[0]!.signal, controller.signal);
});

test("a stream without options is a mistake, not a silent default", () => {
  const { client } = recordingClient([]);
  assert.throws(() => executorFor(client as never).stream(createContext()), TypeError);
});

// ---------------------------------------------------------------------------------------------
// the parts the stream turns into
// ---------------------------------------------------------------------------------------------

test("text frames become text deltas and a finish part", async () => {
  const { client } = recordingClient([textFrame("hel"), textFrame(""), textFrame("lo"), textFrame("", true)]);
  const result = executorFor(client as never).stream(createContext(), undefined, [], {});
  assert.deepEqual(await collect(result.fullStream), [
    { type: "text-delta", textDelta: "hel" },
    { type: "text-delta", textDelta: "lo" },
    { type: "finish", finishReason: "stop", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } },
  ]);
});

test("thinking frames become reasoning and signature parts", async () => {
  const { client } = recordingClient([thinkingFrame("thinking"), thinkingFrame("", "sig"), thinkingFrame("both", "sig-2"), thinkingFrame("", ""), thinkingFrame("only text", "")]);
  const result = executorFor(client as never).stream(createContext(), undefined, [], {});
  assert.deepEqual(await collect(result.fullStream), [
    { type: "reasoning", textDelta: "thinking" },
    { type: "reasoning-signature", signature: "sig" },
    { type: "reasoning", textDelta: "both" },
    { type: "reasoning-signature", signature: "sig-2" },
    // An empty signature is no signature; text is still text.
    { type: "reasoning", textDelta: "only text" },
  ]);
});

test("tool-call frames become complete calls, starts and deltas", async () => {
  const { client } = recordingClient([
    toolCallFrame({ toolCallId: "c1", toolName: "search", args: "{\"query\":\"x\"}", isComplete: true }),
    toolCallFrame({ toolCallId: "c2", toolName: "search", isComplete: false }),
    toolCallFrame({ toolCallId: "c3", toolName: "", args: "part", isComplete: false }),
    toolCallFrame({ toolCallId: "c4", toolName: "broken", args: "not json", isComplete: true }),
  ]);
  const result = executorFor(client as never).stream(createContext(), undefined, [], {});
  assert.deepEqual(await collect(result.fullStream), [
    { type: "tool-call", toolCallId: "c1", toolName: "search", args: { query: "x" } },
    { type: "tool-call-streaming-start", toolCallId: "c2", toolName: "search" },
    { type: "tool-call-delta", toolCallId: "c3", toolName: "", argsTextDelta: "part" },
    { type: "tool-call", toolCallId: "c4", toolName: "broken", args: {} },
  ]);
});

// ---------------------------------------------------------------------------------------------
// the facts a stream settles
// ---------------------------------------------------------------------------------------------

test("usage and extended usage are settled with the counts the stream reported", async () => {
  const { client } = recordingClient([
    usageFrame(3, 4),
    extendedUsageFrame({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, maxTokens: 5 }),
  ]);
  const result = executorFor(client as never).stream(createContext(), undefined, [], {});
  await collect(result.fullStream);
  assert.deepEqual(await result.usage, { promptTokens: 3, completionTokens: 4, totalTokens: 0 });
  assert.deepEqual(await result.extendedUsage, { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, maxTokens: 5 });
});

test("a total token count the stream reported is kept", async () => {
  const { client } = recordingClient([usageFrame(5, 6, 11)]);
  const result = executorFor(client as never).stream(createContext(), undefined, [], {});
  await collect(result.fullStream);
  assert.deepEqual(await result.usage, { promptTokens: 5, completionTokens: 6, totalTokens: 11 });
});

test("provider metadata and the invocation id are settled as the stream reported them", async () => {
  const { client } = recordingClient([providerMetadataFrame({ alpha: 1, nested: { b: "c" } }), invocationIdFrame("invocation-1")]);
  const result = executorFor(client as never).stream(createContext(), undefined, [], {});
  await collect(result.fullStream);
  assert.deepEqual(await result.providerMetadata, { alpha: 1, nested: { b: "c" } });
  assert.equal(await result.invocationId, "invocation-1");

  // A metadata frame that carries none answers with nothing rather than failing.
  const bare = recordingClient([providerMetadataFrame()]);
  const bareResult = executorFor(bare.client as never).stream(createContext(), undefined, [], {});
  await collect(bareResult.fullStream);
  assert.equal(await bareResult.providerMetadata, undefined);
});

test("a response frame is settled as the answer a prompt surface hands back", async () => {
  const { client } = recordingClient([responseInfoFrame()]);
  const result = executorFor(client as never).stream(createContext(), undefined, [], {});
  await collect(result.fullStream);
  const response = await result.response as {
    id: string;
    modelId: string;
    timestamp: Date;
    messages: Array<Record<string, unknown>>;
    error?: unknown;
    inferenceExtraData?: unknown;
  };
  assert.equal(response.id, "response-1");
  assert.equal(response.modelId, "model-9");
  assert.equal(response.timestamp.getTime(), 1_700_000_000_000);
  assert.equal(response.error, undefined);
  assert.equal(response.inferenceExtraData, undefined);
  const [assistant, tool, empty] = response.messages as Array<Record<string, unknown>>;
  assert.deepEqual(assistant, {
    id: "assistant-1",
    role: "assistant",
    content: [
      { type: "reasoning", text: "thinking", providerOptions: { cursor: { modelName: "thinking-model" } }, signature: "sig-1" },
      { type: "redacted-reasoning", data: "secret", providerOptions: { cursor: { modelName: "other-model" } } },
      { type: "reasoning", text: "plain" },
      { type: "text", text: "the answer" },
      { type: "tool-call", toolCallId: "call-1", toolName: "tool-1", args: { a: 1 } },
    ],
  });
  assert.deepEqual(tool, {
    id: "tool-1",
    role: "tool",
    content: [
      { type: "tool-result", toolCallId: "call-1", toolName: "tool-1", result: "done", isError: undefined },
      { type: "tool-result", toolCallId: "call-2", toolName: "tool-2", result: { nested: true }, isError: true },
    ],
  });
  assert.deepEqual(empty, { id: "empty", role: "assistant", content: [] });
});

test("a response's token detail is flattened, with empty lists left out", async () => {
  const { client } = recordingClient([responseInfoFrame({
    inferenceExtraData: {
      tokenLogprobs: [{ values: [0.5, -1] }],
      tokenIds: [{ values: ["1", "2"] }],
      promptTokenIds: [{ values: ["3"] }],
      extraTokens: [{ values: ["4"] }],
      extraLogprobs: [{ values: [0.25] }],
      routingMatrix: [{ values: ["a", "", "b"] }],
    },
  })]);
  const result = executorFor(client as never).stream(createContext(), undefined, [], {});
  await collect(result.fullStream);
  const response = await result.response as { inferenceExtraData: Record<string, unknown> };
  assert.deepEqual(response.inferenceExtraData, {
    tokenLogprobs: [[0.5, -1]],
    tokenIds: [[1, 2]],
    promptTokenIds: [[3]],
    extraTokens: [[4]],
    extraLogprobs: [[0.25]],
    routingMatrix: [["a", null, "b"]],
  });

  const empty = recordingClient([responseInfoFrame({ inferenceExtraData: {} })]);
  const emptyResult = executorFor(empty.client as never).stream(createContext(), undefined, [], {});
  await collect(emptyResult.fullStream);
  assert.deepEqual((await emptyResult.response as { inferenceExtraData: Record<string, unknown> }).inferenceExtraData, {
    tokenLogprobs: undefined,
    tokenIds: undefined,
    promptTokenIds: undefined,
    extraTokens: undefined,
    extraLogprobs: undefined,
    routingMatrix: undefined,
  });
});

test("a response error is classified when it is one of the token limits", async () => {
  const limited = recordingClient([responseInfoFrame({ errorMessage: "the prompt is too long" })]);
  const limitedResult = executorFor(limited.client as never).stream(createContext(), undefined, [], {});
  await collect(limitedResult.fullStream);
  const limitedError = (await limitedResult.response as { error: Error }).error;
  assert.equal(limitedError instanceof InputTokenLimitError, true);
  assert.equal(limitedError.message, "the prompt is too long");

  const output = recordingClient([responseInfoFrame({ errorMessage: "exceeded max output tokens" })]);
  const outputResult = executorFor(output.client as never).stream(createContext(), undefined, [], {});
  await collect(outputResult.fullStream);
  assert.equal((await outputResult.response as { error: Error }).error instanceof OutputTokensLimitExceededError, true);

  const plain = recordingClient([responseInfoFrame({ errorMessage: "something else broke" })]);
  const plainResult = executorFor(plain.client as never).stream(createContext(), undefined, [], {});
  await collect(plainResult.fullStream);
  const plainError = (await plainResult.response as { error: Error }).error;
  assert.equal(plainError.constructor, Error);
  assert.equal(plainError.message, "something else broke");
});

test("a redacted reasoning part may carry no data, and a reasoning part's empty signature is still a signature", async () => {
  const { client } = recordingClient([responseInfoFrame({
    messages: [{
      id: "assistant-2",
      role: "INFERENCE_MESSAGE_ROLE_ASSISTANT",
      reasoningParts: [
        { isRedacted: true },
        { isRedacted: false, text: "with empty signature", signature: "" },
      ],
    }],
  })]);
  const result = executorFor(client as never).stream(createContext(), undefined, [], {});
  await collect(result.fullStream);
  const response = await result.response as { messages: Array<{ content: unknown[] }> };
  assert.deepEqual(response.messages[0]?.content, [
    { type: "redacted-reasoning", data: "" },
    { type: "reasoning", text: "with empty signature", signature: "" },
  ]);
});

// ---------------------------------------------------------------------------------------------
// what a stream that said nothing answers
// ---------------------------------------------------------------------------------------------

test("an empty stream still answers every fact", async () => {
  const { client } = recordingClient([]);
  const result = executorFor(client as never).stream(createContext(), undefined, [], {});
  assert.deepEqual(await collect(result.fullStream), []);
  assert.deepEqual(await result.usage, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  assert.deepEqual(await result.extendedUsage, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, maxTokens: 0 });
  assert.equal(await result.providerMetadata, undefined);
  assert.match(await result.invocationId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const response = await result.response as { id: string; modelId: string; timestamp: Date; messages: unknown[] };
  assert.deepEqual([response.id, response.modelId, response.messages], ["", "", []]);
  assert.equal(Math.abs(response.timestamp.getTime() - Date.now()) < 60_000, true);
});

test("an error frame is a stream part, and the turn fails with the error", async () => {
  const { client } = recordingClient([textFrame("before"), errorFrame("upstream died")]);
  const result = executorFor(client as never).stream(createContext(), undefined, [], {});
  const parts: unknown[] = [];
  await assert.rejects(async () => {
    for await (const part of result.fullStream) parts.push(part);
  }, (error: unknown) => (error as Error).message === "upstream died");
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0], { type: "text-delta", textDelta: "before" });
  assert.equal((parts[1] as { type: string }).type, "error");
  assert.equal(((parts[1] as { error: Error }).error).message, "upstream died");
  // What the stream never settled is rejected with the same error.
  await assert.rejects(result.usage, (error: unknown) => (error as Error).message === "upstream died");
  await assert.rejects(result.extendedUsage, (error: unknown) => (error as Error).message === "upstream died");
  await assert.rejects(result.providerMetadata, (error: unknown) => (error as Error).message === "upstream died");
  await assert.rejects(result.invocationId, (error: unknown) => (error as Error).message === "upstream died");
  await assert.rejects(result.response, (error: unknown) => (error as Error).message === "upstream died");
});

test("a stream that fails mid-way keeps what it already emitted and rejects the rest", async () => {
  const failure = new Error("iterable broke");
  const { client } = recordingClient([textFrame("one")], failure);
  const result = executorFor(client as never).stream(createContext(), undefined, [], {});
  const parts: unknown[] = [];
  await assert.rejects(async () => {
    for await (const part of result.fullStream) parts.push(part);
  }, (error: unknown) => error === failure);
  assert.deepEqual(parts, [{ type: "text-delta", textDelta: "one" }]);
  await assert.rejects(result.usage, (error: unknown) => error === failure);
  await assert.rejects(result.extendedUsage, (error: unknown) => error === failure);
  await assert.rejects(result.providerMetadata, (error: unknown) => error === failure);
  await assert.rejects(result.invocationId, (error: unknown) => error === failure);
  await assert.rejects(result.response, (error: unknown) => error === failure);
});

test("image descriptions the stream reports are written onto the messages that were sent", async () => {
  const { client } = recordingClient([
    imageDescriptionsFrame([
      { messageIndex: 0, partIndex: 1, description: "a screen" },
      { messageIndex: 1, partIndex: 0, description: "a tool image", expContentIndex: 0 },
      { messageIndex: 9, partIndex: 0, description: "nobody" },
      { messageIndex: 0, partIndex: 1, description: "" },
    ]),
    textFrame("done"),
  ]);
  const builder = new ProtoPromptBuilder([
    { role: "user", content: [{ type: "text", text: "look" }, { type: "image" }] },
    { role: "tool", content: [{ type: "tool-result", experimental_content: [{ type: "image" }] }] },
  ]);
  const executor = new ProtoPromptExecutor(builder, client as never, MODEL as never);
  const result = executor.stream(createContext(), undefined, [], {});
  await collect(result.fullStream);
  assert.deepEqual(builder.getMessages(), [
    { role: "user", content: [{ type: "text", text: "look" }, { type: "image", providerOptions: { cursor: { imageDescription: "a screen" } } }] },
    { role: "tool", content: [{ type: "tool-result", experimental_content: [{ type: "image" }], providerOptions: { cursor: { imageDescriptions: { 0: "a tool image" } } } }] },
  ]);
});

// ---------------------------------------------------------------------------------------------
// sessions and providers
// ---------------------------------------------------------------------------------------------

test("a session builds executors over the client, with middleware applied when it was given", () => {
  const client = recordingClient([]).client;
  const marker = { middleware: true };
  const applyMarker = (executor: unknown) => Object.assign(Object.create(executor as object), marker);
  const session = new ProtoPromptSession(client as never, MODEL as never, applyMarker as never);
  const executor = session.getExecutor([{ role: "user", content: "one" }]);
  assert.deepEqual(executor.getMessages(), [{ role: "user", content: "one" }]);
  assert.equal((executor as unknown as Record<string, unknown>).middleware, true);
  assert.equal(session.getModelId(), "probe-model");

  const plain = new ProtoPromptSession(client as never, MODEL as never);
  assert.deepEqual(plain.getExecutor().getMessages(), []);
  assert.equal((plain.getExecutor() as unknown as Record<string, unknown>).middleware, undefined);

  // The session's model config and inference reason travel into the request its executor builds.
  const capturing = recordingClient([]);
  const configured = new ProtoPromptSession(capturing.client as never, MODEL as never, undefined, { maxTokens: 5, temperature: 0.1 }, InferenceReason.GEMINI_VIDEO_SUBAGENT);
  configured.getExecutor().stream(createContext(), undefined, [], {});
  const request = capturing.calls[0]!.request as unknown as { modelConfig?: { maxTokens?: number; temperature?: number }; inferenceReason?: number };
  assert.deepEqual([request.modelConfig?.maxTokens, request.modelConfig?.temperature, request.inferenceReason], [5, 0.1, InferenceReason.GEMINI_VIDEO_SUBAGENT]);
});

test("a provider hands out sessions, names itself and has no thinking details of its own", () => {
  const client = recordingClient([]).client;
  const provider = new ProtoSessionProvider(client as never, MODEL as never);
  const session = provider.getSession();
  assert.equal(session.constructor, ProtoPromptSession);
  assert.equal(session.getModelId(), "probe-model");
  assert.equal(provider.getProviderName(), "proto");
  assert.equal(provider.getModelId(), "probe-model");
  assert.equal(provider.getThinkingDetails(), undefined);

  const created = createProtoSessionProvider(client as never, MODEL as never);
  assert.equal(created.constructor, ProtoSessionProvider);
  assert.equal(created.getProviderName(), "proto");
  assert.equal(created.getSession().getModelId(), "probe-model");

  // What the factory was given travels through the provider it builds.
  const factoryClient = recordingClient([]);
  const fromFactory = createProtoSessionProvider(factoryClient.client as never, MODEL as never, { maxTokens: 9, temperature: 0.3 }, InferenceReason.GEMINI_VIDEO_SUBAGENT);
  fromFactory.getSession().getExecutor().stream(createContext(), undefined, [], {});
  const factoryRequest = factoryClient.calls[0]!.request as unknown as { modelConfig?: { maxTokens?: number; temperature?: number }; inferenceReason?: number };
  assert.deepEqual([factoryRequest.modelConfig?.maxTokens, factoryRequest.modelConfig?.temperature, factoryRequest.inferenceReason], [9, 0.3, InferenceReason.GEMINI_VIDEO_SUBAGENT]);

  // What the provider was built with travels through the sessions it hands out.
  const capturing = recordingClient([]);
  const configured = new ProtoSessionProvider(capturing.client as never, MODEL as never, { maxTokens: 6, temperature: 0.2 }, InferenceReason.GEMINI_VIDEO_SUBAGENT);
  configured.getSession().getExecutor().stream(createContext(), undefined, [], {});
  const request = capturing.calls[0]!.request as unknown as { modelConfig?: { maxTokens?: number; temperature?: number }; inferenceReason?: number };
  assert.deepEqual([request.modelConfig?.maxTokens, request.modelConfig?.temperature, request.inferenceReason], [6, 0.2, InferenceReason.GEMINI_VIDEO_SUBAGENT]);
});