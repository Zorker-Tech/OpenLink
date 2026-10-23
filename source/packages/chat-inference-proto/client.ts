/**
 * The client that speaks the inference protocol.
 *
 * Requests are built from the platform's own shapes, the stream that comes back is decoded as it arrives, and a
 * connection that breaks is reported with what the far side said rather than as a bare failure.
 */
import { createKey, type Context } from "../context/context.ts";
import { getSpanContextData } from "../context/telemetry.ts";
import { BasePromptBuilder, BasePromptExecutor, type PromptExecutor } from "../chat-inference/base.ts";
import { classifyTokenLimitErrorFromMessage } from "../chat-inference/token-limit-error-classification.ts";
import {
  InferenceMessageRole,
  type InferenceReason,
  type InferenceExtraData,
  type InferenceImageDescriptionsInfo,
  type InferenceResponseInfo,
  type InferenceStreamResponse,
} from "../proto/generated/aiserver/v1/inference_pb.ts";
import {
  buildStreamRequest,
  protoStreamErrorToError,
  toolCallArgsFromProto,
} from "./converters.ts";
import { providerOptionsFromModelName } from "./model-provider-options.ts";

type Loose = Record<string, any>;
type PromptMessage = Loose;
type Middleware = (executor: PromptExecutor<Loose>) => PromptExecutor<Loose>;

/** The value one arm of the inference stream carries. */
type StreamValue<Case extends NonNullable<InferenceStreamResponse["response"]["case"]>> =
  Extract<InferenceStreamResponse["response"], { case: Case }>["value"];

export const requestIdKey = createKey<string | undefined>(Symbol("requestId"), undefined);
export const conversationIdKey = createKey<string | undefined>(Symbol("conversationId"), undefined);
export const automationIdKey = createKey<string | undefined>(Symbol("automationId"), undefined);
export const requestedModelKey = createKey<Loose | undefined>(Symbol("requestedModel"), undefined);

/** The transport a session is built over: one inference request in, one stream of frames out. */
interface InferenceClient {
  stream(request: unknown, options: { signal: AbortSignal; headers: Record<string, string> }): AsyncIterable<InferenceStreamResponse>;
}

/** A promise a stream settles once the far side has said what it is for. */
interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------------------------
// Descriptions the model attached to images it saw

/** One image part on a user message, with the description it was given attached. */
function withImageDescription(part: Loose, description: string): Loose {
  return {
    ...part,
    providerOptions: {
      ...part.providerOptions,
      cursor: { ...part.providerOptions?.cursor, imageDescription: description },
    },
  };
}

/** One tool result, with the description for one of its images under the index it was filed at. */
function withToolResultImageDescription(part: Loose, expContentIndex: number, description: string, known: Loose): Loose {
  return {
    ...part,
    providerOptions: {
      ...part.providerOptions,
      cursor: {
        ...part.providerOptions?.cursor,
        imageDescriptions: { ...known, [expContentIndex]: description },
      },
    },
  };
}

/** A user message's content, with every description that names one of its images written in. */
function withUserImageDescriptions(content: readonly Loose[], entries: readonly Loose[]): Loose[] | undefined {
  const stamped = [...content];
  let updated = false;
  for (const entry of entries) {
    if (entry.expContentIndex !== undefined) continue;
    const part = stamped[entry.partIndex];
    if (part === undefined || part.type !== "image") continue;
    stamped[entry.partIndex] = withImageDescription(part, entry.description);
    updated = true;
  }
  return updated ? stamped : undefined;
}

/** A tool message's content, with every description that names one of its result images written in. */
function withToolResultImageDescriptions(content: readonly Loose[], entries: readonly Loose[]): Loose[] | undefined {
  const stamped = [...content];
  let updated = false;
  for (const entry of entries) {
    if (entry.expContentIndex === undefined) continue;
    const part = stamped[entry.partIndex];
    if (part === undefined || part.type !== "tool-result" || !Array.isArray(part.experimental_content) ||
        part.experimental_content[entry.expContentIndex]?.type !== "image") continue;
    const known = part.providerOptions?.cursor?.imageDescriptions ?? {};
    stamped[entry.partIndex] = withToolResultImageDescription(part, entry.expContentIndex, entry.description, known);
    updated = true;
  }
  return updated ? stamped : undefined;
}

/**
 * Writes the descriptions the model gave for a message's images onto that message's parts.
 *
 * A user message carries its images as parts of its own content; a tool message carries them inside the experimental
 * content of one result part, and the description is filed under the index it appeared at. A message of any other role —
 * or one whose content is not a list of parts — is left alone, and nothing is copied unless a description was applied.
 */
export function stampImageDescriptionsOnMessage(
  message: PromptMessage,
  entries: readonly Loose[],
): PromptMessage | undefined {
  if (!Array.isArray(message.content)) return undefined;
  const content = message.role === "user"
    ? withUserImageDescriptions(message.content, entries)
    : message.role === "tool"
      ? withToolResultImageDescriptions(message.content, entries)
      : undefined;
  return content === undefined ? undefined : { ...message, content };
}

// ---------------------------------------------------------------------------------------------
// Building and running a prompt

export class ProtoPromptBuilder extends BasePromptBuilder<PromptMessage> {
  /** Replaces one message in place, so a part the stream enriched later does not move the prompt around. */
  replaceMessage(previous: PromptMessage, next: PromptMessage): boolean {
    const index = this.messages.indexOf(previous);
    if (index < 0) return false;
    this.messages[index] = next;
    return true;
  }
}

/** The promises a stream settles as it says what the turn cost and what it answered. */
interface StreamResolvers {
  readonly usage: Deferred<Loose>;
  readonly extendedUsage: Deferred<Loose>;
  readonly providerMetadata: Deferred<unknown>;
  readonly invocationId: Deferred<string>;
  readonly response: Deferred<Loose>;
}

function createStreamResolvers(): StreamResolvers {
  return {
    usage: createDeferred(),
    extendedUsage: createDeferred(),
    providerMetadata: createDeferred(),
    invocationId: createDeferred(),
    response: createDeferred(),
  };
}

/** One frame of the inference stream, read as the messages a prompt surface emits. */
export class ProtoPromptExecutor extends BasePromptExecutor<PromptMessage> {
  private readonly protoBuilder: ProtoPromptBuilder;

  constructor(
    builder: ProtoPromptBuilder,
    private readonly client: InferenceClient,
    private readonly requestedModel: Loose,
    private readonly modelConfig?: Loose,
    private readonly inferenceReason?: InferenceReason,
  ) {
    super(builder);
    this.protoBuilder = builder;
  }

  /** What the model said about a canvas's images, applied to the messages that were sent with it. */
  private applyImageDescriptions(requestMessages: readonly PromptMessage[], info: InferenceImageDescriptionsInfo): void {
    const groups = new Map<number, Loose[]>();
    for (const entry of info.descriptions) {
      if (entry.description.length === 0) continue;
      const known = groups.get(entry.messageIndex) ?? [];
      known.push(entry);
      groups.set(entry.messageIndex, known);
    }
    for (const [messageIndex, entries] of groups) {
      const original = requestMessages[messageIndex];
      if (original === undefined) continue;
      const enriched = stampImageDescriptionsOnMessage(original, entries);
      if (enriched !== undefined) this.protoBuilder.replaceMessage(original, enriched);
    }
  }

  /** The headers one inference request carries: its request id, and the trace it belongs to when there is one. */
  private requestHeaders(context: Context): Record<string, string> {
    const headers: Record<string, string> = {};
    const requestId = context.get(requestIdKey);
    if (requestId) headers["x-request-id"] = requestId;
    try {
      const span = getSpanContextData(context);
      if (span !== undefined) {
        const traceparent = `00-${span.traceId}-${span.spanId}-${span.traceFlags.toString(16).padStart(2, "0")}`;
        headers.traceparent = traceparent;
        headers["backend-traceparent"] = traceparent;
      }
    } catch {}
    return headers;
  }

  /** Runs one inference request over this executor's builder and answers with the stream and its pending facts. */
  stream(
    context: Context,
    invocationId?: string,
    tools?: readonly Loose[],
    options?: Loose,
  ): {
    fullStream: AsyncIterable<Loose>;
    usage: Promise<Loose>;
    extendedUsage: Promise<Loose>;
    providerMetadata: Promise<unknown>;
    invocationId: Promise<string>;
    response: Promise<Loose>;
  } {
    const agentTools: Loose[] = [];
    const providerDefinedTools: Loose[] = [];
    for (const tool of tools ?? []) {
      if ("type" in tool && tool.type === "provider-defined") providerDefinedTools.push(tool);
      else agentTools.push(tool);
    }
    const modelConfig = options?.maxTokens !== undefined
      ? { ...this.modelConfig, maxTokens: options.maxTokens }
      : this.modelConfig;
    const requestedModel = context.get(requestedModelKey) ?? this.requestedModel;
    const requestMessages = this.builder.getMessages();
    const request = buildStreamRequest({
      messages: requestMessages,
      requestedModel,
      tools: agentTools,
      providerDefinedTools,
      modelConfig,
      invocationId,
      conversationId: context.get(conversationIdKey),
      automationId: context.get(automationIdKey),
      inferenceReason: this.inferenceReason,
      acceptedUnadvertisedToolNames: options!.acceptedUnadvertisedToolNames,
    });
    const headers = this.requestHeaders(context);
    const stream = this.client.stream(request, { signal: context.signal, headers });
    const resolvers = createStreamResolvers();
    return {
      fullStream: this.createFullStream(stream, resolvers, requestMessages),
      usage: resolvers.usage.promise,
      extendedUsage: resolvers.extendedUsage.promise,
      providerMetadata: resolvers.providerMetadata.promise,
      invocationId: resolvers.invocationId.promise,
      response: resolvers.response.promise,
    };
  }

  /** The stream a caller reads, with every fact the far side reports settled onto the pending promises. */
  private async *createFullStream(
    stream: AsyncIterable<InferenceStreamResponse>,
    resolvers: StreamResolvers,
    requestMessages: readonly PromptMessage[],
  ): AsyncGenerator<Loose> {
    const resolved = new Set<string>();
    let streamError: Error | undefined;
    try {
      for await (const frame of stream) {
        const parts = this.protoResponseToStreamParts(frame);
        switch (frame.response.case) {
          case "usage": {
            const usage = frame.response.value;
            resolvers.usage.resolve({
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              totalTokens: usage.totalTokens ?? 0,
            });
            resolved.add("usage");
            break;
          }
          case "extendedUsage": {
            const usage = frame.response.value;
            resolvers.extendedUsage.resolve({
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheReadTokens: usage.cacheReadTokens,
              cacheWriteTokens: usage.cacheWriteTokens,
              maxTokens: usage.maxTokens,
            });
            resolved.add("extendedUsage");
            break;
          }
          case "providerMetadata":
            resolvers.providerMetadata.resolve(frame.response.value.metadata?.toJson());
            resolved.add("providerMetadata");
            break;
          case "invocationId":
            resolvers.invocationId.resolve(frame.response.value.invocationId);
            resolved.add("invocationId");
            break;
          case "responseInfo":
            resolvers.response.resolve(this.responseInfoToResult(frame.response.value));
            resolved.add("response");
            break;
          case "error":
            streamError = protoStreamErrorToError(frame.response.value);
            break;
          case "imageDescriptions":
            this.applyImageDescriptions(requestMessages, frame.response.value);
            break;
        }
        yield* parts;
      }
    } catch (error) {
      streamError = error instanceof Error ? error : new Error(String(error));
    }
    this.settleUnreportedFacts(resolvers, resolved, streamError);
    if (streamError !== undefined) throw streamError;
  }

  /** Settles the facts the stream never reported: with the error when it failed, with an empty answer otherwise. */
  private settleUnreportedFacts(resolvers: StreamResolvers, resolved: ReadonlySet<string>, streamError: Error | undefined): void {
    const settle = <T>(deferred: Deferred<T>, reported: boolean, fallback: () => T): void => {
      if (reported) return;
      if (streamError !== undefined) deferred.reject(streamError);
      else deferred.resolve(fallback());
    };
    settle(resolvers.usage, resolved.has("usage"), () => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }));
    settle(resolvers.extendedUsage, resolved.has("extendedUsage"), () => ({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      maxTokens: 0,
    }));
    settle(resolvers.providerMetadata, resolved.has("providerMetadata"), () => undefined);
    settle(resolvers.invocationId, resolved.has("invocationId"), () => globalThis.crypto.randomUUID());
    settle(resolvers.response, resolved.has("response"), () => ({ id: "", modelId: "", timestamp: new Date(), messages: [] }));
  }

  /** The answer one response frame describes, in the shape a prompt surface hands to its caller. */
  private responseInfoToResult(info: InferenceResponseInfo): Loose {
    return {
      id: info.id,
      modelId: info.model,
      timestamp: new Date(Number(info.createdAt)),
      messages: this.protoMessagesToResponseMessages(info),
      error: info.errorMessage ? classifyTokenLimitErrorFromMessage(info.errorMessage) ?? new Error(info.errorMessage) : undefined,
      inferenceExtraData: info.inferenceExtraData ? this.protoExtraDataToInferenceExtraData(info.inferenceExtraData) : undefined,
    };
  }

  /** The text, tool-call and error parts one frame contributes to the full stream. */
  private protoResponseToStreamParts(frame: InferenceStreamResponse): Loose[] {
    switch (frame.response.case) {
      case "textPart":
        return this.textStreamParts(frame.response.value);
      case "thinkingPart":
        return this.thinkingStreamParts(frame.response.value);
      case "toolCallPart":
        return this.toolCallStreamParts(frame.response.value);
      case "error":
        return [{ type: "error", error: protoStreamErrorToError(frame.response.value) }];
      default:
        return [];
    }
  }

  private textStreamParts(part: StreamValue<"textPart">): Loose[] {
    if (part.isFinal) return [{ type: "finish", finishReason: "stop", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }];
    return part.text ? [{ type: "text-delta", textDelta: part.text }] : [];
  }

  private thinkingStreamParts(part: StreamValue<"thinkingPart">): Loose[] {
    const parts: Loose[] = [];
    if (part.text) parts.push({ type: "reasoning", textDelta: part.text });
    if (part.signature) parts.push({ type: "reasoning-signature", signature: part.signature });
    return parts;
  }

  private toolCallStreamParts(part: StreamValue<"toolCallPart">): Loose[] {
    if (part.isComplete) {
      let args: unknown;
      try { args = JSON.parse(part.args); } catch { args = {}; }
      return [{ type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, args }];
    }
    if (part.toolName) return [{ type: "tool-call-streaming-start", toolCallId: part.toolCallId, toolName: part.toolName }];
    return [{ type: "tool-call-delta", toolCallId: part.toolCallId, toolName: "", argsTextDelta: part.args }];
  }

  /** The messages one response frame describes, as the surface hands them back. */
  private protoMessagesToResponseMessages(info: InferenceResponseInfo): Loose[] {
    return info.messages.map((message) => message.role === InferenceMessageRole.TOOL
      ? this.toolResultMessage(message)
      : this.assistantMessage(message));
  }

  private assistantMessage(message: InferenceResponseInfo["messages"][number]): Loose {
    const content: Loose[] = [];
    for (const reasoning of message.reasoningParts) {
      if (reasoning.isRedacted) {
        content.push({ type: "redacted-reasoning", data: reasoning.redactedData ?? "", ...providerOptionsFromModelName(reasoning.modelName) });
        continue;
      }
      const part: Loose = { type: "reasoning", text: reasoning.text, ...providerOptionsFromModelName(reasoning.modelName) };
      if (reasoning.signature !== undefined) part.signature = reasoning.signature;
      content.push(part);
    }
    if (message.content) content.push({ type: "text", text: message.content });
    for (const call of message.toolCalls) {
      content.push({ type: "tool-call", toolCallId: call.toolCallId, toolName: call.toolName, args: toolCallArgsFromProto(call) });
    }
    return { id: message.id, role: "assistant", content };
  }

  private toolResultMessage(message: InferenceResponseInfo["messages"][number]): Loose {
    return {
      id: message.id,
      role: "tool",
      content: message.toolResult?.parts.map((part) => ({
        type: "tool-result",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        result: part.result?.toJson(),
        isError: part.isError || undefined,
      })) ?? [],
    };
  }

  /** The token-level detail one answer carries, with each list written out only when it has anything in it. */
  private protoExtraDataToInferenceExtraData(data: InferenceExtraData): Loose {
    type ExtraDataField = "tokenLogprobs" | "tokenIds" | "promptTokenIds" | "extraTokens" | "extraLogprobs" | "routingMatrix";
    const projections: ReadonlyArray<readonly [ExtraDataField, (values: readonly Loose[]) => unknown]> = [
      ["tokenLogprobs", (values) => values.map((value) => value.values)],
      ["tokenIds", (ids) => ids.map((id) => id.values.map(Number))],
      ["promptTokenIds", (ids) => ids.map((id) => id.values.map(Number))],
      ["extraTokens", (ids) => ids.map((id) => id.values.map(Number))],
      ["extraLogprobs", (values) => values.map((value) => value.values)],
      ["routingMatrix", (rows) => rows.map((row) => row.values.map((value: unknown) => value === "" ? null : value))],
    ];
    const projected: Loose = {};
    for (const [field, project] of projections) {
      const values = data[field] as unknown as readonly Loose[];
      projected[field] = values.length > 0 ? project(values) : undefined;
    }
    return projected;
  }
}

// ---------------------------------------------------------------------------------------------
// Sessions over the client

export class ProtoPromptSession {
  constructor(
    private readonly client: InferenceClient,
    private readonly requestedModel: Loose,
    private readonly middleware?: Middleware,
    private readonly modelConfig?: Loose,
    private readonly inferenceReason?: InferenceReason,
  ) {}

  getExecutor(state?: PromptMessage | readonly PromptMessage[]): PromptExecutor<Loose> {
    const builder = new ProtoPromptBuilder(state);
    const executor = new ProtoPromptExecutor(builder, this.client, this.requestedModel, this.modelConfig, this.inferenceReason);
    return this.middleware === undefined ? executor : this.middleware(executor);
  }

  getModelId(): string { return this.requestedModel.modelId; }
}

export class ProtoSessionProvider {
  constructor(
    private readonly client: InferenceClient,
    private readonly requestedModel: Loose,
    private readonly modelConfig?: Loose,
    private readonly inferenceReason?: InferenceReason,
  ) {}

  getSession(middleware?: Middleware): ProtoPromptSession {
    return new ProtoPromptSession(this.client, this.requestedModel, middleware, this.modelConfig, this.inferenceReason);
  }
  getProviderName(): string { return "proto"; }
  getModelId(): string { return this.requestedModel.modelId; }
  getThinkingDetails(): undefined { return undefined; }
}

export function createProtoSessionProvider(
  client: InferenceClient,
  requestedModel: Loose,
  modelConfig?: Loose,
  inferenceReason?: InferenceReason,
): ProtoSessionProvider {
  return new ProtoSessionProvider(client, requestedModel, modelConfig, inferenceReason);
}
