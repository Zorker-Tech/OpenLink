/**
 * Turning the platform's prompt shapes into the ones the inference protocol takes.
 *
 * Messages, tools, images and the options a provider understands are converted field by field, and what has no
 * equivalent in the protocol is left out rather than sent as something it is not.
 */
import { Struct, Value, type JsonValue } from "@bufbuild/protobuf";
import {
  InferenceAgentTool,
  InferenceAnthropicOptions,
  InferenceCacheControl,
  InferenceContentPart,
  InferenceContentParts,
  InferenceCoreMessage,
  InferenceCursorOptions,
  InferenceCustomToolFormat,
  InferenceImagePart,
  InferenceMessageRole,
  InferenceModelConfig,
  InferenceModelParameterValue,
  InferenceNamedProviderDefinedTool,
  InferenceProviderOptions,
  type InferenceReason,
  InferenceReasoningPart,
  InferenceRequestedModel,
  InferenceStreamErrorType,
  InferenceStreamRequest,
  InferenceTextPart,
  InferenceToolCall,
  InferenceToolResultContent,
  InferenceToolResultPart,
  type InferenceStreamError,
} from "../proto/generated/aiserver/v1/inference_pb.ts";
import { classifyTokenLimitErrorFromMessage } from "./token-limit-error-classifier-adapter.ts";
import { InputTokenLimitError, OutputTokensLimitExceededError } from "../../../packages/chat-inference/prompt-executor.ts";
import { getProviderModelName } from "./model-provider-options.ts";

type LooseRecord = Record<string, any>;
const DEFAULT_IMAGE_MIME = "image/png";

export function applyToolCallArgs(toolCall: InferenceToolCall, value: unknown, explicitRaw?: string): void {
  const plainObject = typeof value === "object" && value !== null && !Array.isArray(value);
  if (plainObject) {
    toolCall.args = Struct.fromJson(value as JsonValue);
    if (explicitRaw !== undefined) toolCall.rawToolCallArgs = explicitRaw;
    return;
  }
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  if (raw === undefined) throw new Error(`cannot represent tool call arguments of type ${typeof value} as a JSON object or raw text`);
  toolCall.rawToolCallArgs = explicitRaw ?? raw;
}

export function toolCallArgsFromProto(call: InferenceToolCall): unknown {
  return call.args?.toJson() ?? call.rawToolCallArgs ?? {};
}

function messageRole(roleName: unknown): InferenceMessageRole {
  switch (roleName) {
    case "user": return InferenceMessageRole.USER;
    case "assistant": return InferenceMessageRole.ASSISTANT;
    case "tool": return InferenceMessageRole.TOOL;
    case "system": return InferenceMessageRole.SYSTEM;
    default: return InferenceMessageRole.UNSPECIFIED;
  }
}

function cursorOptions(value: unknown): InferenceCursorOptions | undefined {
  if (!value || typeof value !== "object") return undefined;
  const fields = value as LooseRecord;
  const converted = new InferenceCursorOptions();
  let hasContent = false;
  if (typeof fields.imageDescription === "string" && fields.imageDescription.length > 0) {
    converted.imageDescription = fields.imageDescription;
    hasContent = true;
  }
  if (fields.imageDescriptions !== null && typeof fields.imageDescriptions === "object") {
    for (const [key, value] of Object.entries(fields.imageDescriptions as LooseRecord)) {
      const index = Number(key);
      if (Number.isInteger(index) && index >= 0 && typeof value === "string" && value.length > 0) {
        converted.imageDescriptions[index] = value;
        hasContent = true;
      }
    }
  }
  return hasContent ? converted : undefined;
}

function providerOptions(settings: unknown): InferenceProviderOptions | undefined {
  if (!settings || typeof settings !== "object") return undefined;
  const fields = settings as LooseRecord;
  const converted = new InferenceProviderOptions();
  let hasContent = false;
  if (fields.anthropic?.cacheControl) {
    converted.anthropic = new InferenceAnthropicOptions({
      cacheControl: new InferenceCacheControl({ type: fields.anthropic.cacheControl.type }),
    });
    hasContent = true;
  }
  const cursor = cursorOptions(fields.slate);
  if (cursor !== undefined) {
    converted.cursor = cursor;
    hasContent = true;
  }
  return hasContent ? converted : undefined;
}

function imageDataUrl(data: Uint8Array, mimeValue: unknown): string {
  const resolvedMime = typeof mimeValue === "string" && mimeValue.trim() !== "" ? mimeValue : DEFAULT_IMAGE_MIME;
  return `data:${resolvedMime};base64,${Buffer.from(data).toString("base64")}`;
}


/** A string worth carrying, or nothing at all. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** One reasoning part, redacted or not, with the model that produced it when it is known. */
function reasoningPartToProto(part: LooseRecord, redacted: boolean): InferenceReasoningPart {
    const modelName = getProviderModelName(part);
    return redacted
      ? new InferenceReasoningPart({ isRedacted: true, redactedData: part.data, ...(modelName === undefined ? {} : { modelName }) })
      : new InferenceReasoningPart({ isRedacted: false, text: part.text, signature: part.signature, ...(modelName === undefined ? {} : { modelName }) });
}

/** One tool call, with the arguments the platform already normalised. */
function toolCallToProto(part: LooseRecord): InferenceToolCall {
    const call = new InferenceToolCall({ toolCallId: part.toolCallId, toolName: part.toolName });
    const raw = part.providerOptions?.slate?.rawToolCallArgs;
    applyToolCallArgs(call, part.args, typeof raw === "string" ? raw : undefined);
    return call;
}

/** One tool result, in the protocol's own shape. */
function toolResultToProto(part: LooseRecord): InferenceToolResultPart {
    const result = new InferenceToolResultPart({ toolCallId: part.toolCallId, toolName: part.toolName });
    if (part.result !== undefined) result.result = Value.fromJson(typeof part.result === "string" ? part.result : JSON.parse(JSON.stringify(part.result)) as JsonValue);
    if (part.isError) result.isError = true;
    if (part.experimental_content?.length > 0) result.experimentalContent = experimentalContentParts(part.experimental_content);
    result.providerOptions = providerOptions(part.providerOptions)!;
    return result;
}

/** The options a part carries, as the protocol spells them, when it has any. */
function partOptions(piece: LooseRecord): { providerOptions?: InferenceProviderOptions } {
  const carried = providerOptions(piece.providerOptions);
  return carried === undefined ? {} : { providerOptions: carried };
}

/** An image part's data, whether it came as a string, a URL, bytes or a buffer. */
function imagePartData(piece: LooseRecord): string {
  if (typeof piece.image === "string") return piece.image;
  if (piece.image instanceof URL) return piece.image.toString();
  if (piece.image instanceof Uint8Array) return imageDataUrl(piece.image, piece.mimeType);
  if (piece.image instanceof ArrayBuffer) return imageDataUrl(new Uint8Array(piece.image), piece.mimeType);
  return "";
}

function userPartToProto(piece: LooseRecord): InferenceContentPart {
  const converted = new InferenceContentPart();
  if (piece.type === "text") {
    converted.part = { case: "text", value: new InferenceTextPart({ text: piece.text, ...partOptions(piece) }) };
  } else if (piece.type === "image") {
    converted.part = {
      case: "image",
      value: new InferenceImagePart({ data: imagePartData(piece), mimeType: piece.mimeType, ...partOptions(piece) }),
    };
  } else if (piece.type === "file") {
    converted.part = { case: "text", value: new InferenceTextPart({ text: "[File: " + (piece.name ?? "unnamed") + "]" }) };
  } else {
    converted.part = { case: "text", value: new InferenceTextPart({ text: "" }) };
  }
  return converted;
}

function experimentalContentParts(items: readonly LooseRecord[]): InferenceContentPart[] {
  return items.map((entry) => new InferenceContentPart({
    part: entry.type === "image"
      ? { case: "image", value: new InferenceImagePart({ data: entry.data, mimeType: entry.mimeType }) }
      : { case: "text", value: new InferenceTextPart({ text: entry.text }) },
  }));
}

export function coreMessageToProto(entry: LooseRecord): InferenceCoreMessage {
  const converted = new InferenceCoreMessage({ role: messageRole(entry.role) });
  if (entry.role === "user") {
    if (typeof entry.content === "string") converted.content = { case: "text", value: entry.content };
    else if (Array.isArray(entry.content)) converted.content = { case: "parts", value: new InferenceContentParts({ parts: entry.content.map(userPartToProto) }) };
  } else if (entry.role === "assistant") {
    const metadata = responsesMetadata(entry);
    if (metadata.modelProviderMessageId !== undefined) converted.modelProviderMessageId = metadata.modelProviderMessageId;
    if (typeof metadata.openaiPhase === "string") converted.openaiPhase = metadata.openaiPhase;
    else if (metadata.openaiPhase === null) converted.openaiPhaseNull = true;
    if (typeof entry.content === "string") converted.content = { case: "text", value: entry.content };
    else if (Array.isArray(entry.content)) {
      const textPieces: string[] = [];
      for (const piece of entry.content as LooseRecord[]) {
        if (piece.type === "text") textPieces.push(piece.text);
        else if (piece.type === "tool-call") converted.toolCalls.push(toolCallToProto(piece));
        else if (piece.type === "reasoning") converted.reasoningParts.push(reasoningPartToProto(piece, false));
        else if (piece.type === "redacted-reasoning") converted.reasoningParts.push(reasoningPartToProto(piece, true));
      }
      if (textPieces.length > 0) converted.content = { case: "text", value: textPieces.join("") };
    }
  } else if (entry.role === "tool" && Array.isArray(entry.content)) {
    const parts = (entry.content as LooseRecord[]).filter((piece) => piece.type === "tool-result").map(toolResultToProto);
    converted.content = { case: "toolContent", value: new InferenceToolResultContent({ parts }) };
  } else if (entry.role === "system") {
    converted.content = { case: "text", value: entry.content };
  }
  return converted;
}

/** The ids and phase an assistant message carries from the provider, when it has them. */
function responsesMetadata(entry: LooseRecord): { modelProviderMessageId?: string; openaiPhase?: string | null } {
  const slateOptions = entry.providerOptions?.slate;
  const modelProviderMessageId = slateOptions?.modelProviderMessageId;
  const openaiPhase = slateOptions?.openaiPhase;
  return {
    ...(typeof modelProviderMessageId === "string" ? { modelProviderMessageId } : {}),
    ...(typeof openaiPhase === "string" || openaiPhase === null ? { openaiPhase } : {}),
  };
}

function agentToolDefinition(definition: LooseRecord): InferenceAgentTool {
  const converted = new InferenceAgentTool({
    name: definition.name,
    description: definition.description,
    parameters: Struct.fromJsonString(JSON.stringify(definition.parameters)),
  });
  if (definition.customToolFormat) converted.customToolFormat = new InferenceCustomToolFormat(definition.customToolFormat);
  return converted;
}

function namedProviderToolDefinition(definition: LooseRecord): InferenceNamedProviderDefinedTool {
  const options = definition.options ? Struct.fromJson(definition.options as JsonValue) : undefined;
  return new InferenceNamedProviderDefinedTool({
    name: definition.name,
    id: definition.id,
    type: definition.type,
    ...(options === undefined ? {} : { options }),
  });
}

export function protoStreamErrorToError(streamError: InferenceStreamError): Error {
  if (streamError.errorType === InferenceStreamErrorType.INPUT_TOKEN_LIMIT || streamError.isInputTokenLimitError) return new InputTokenLimitError(streamError.message);
  if (streamError.errorType === InferenceStreamErrorType.OUTPUT_TOKEN_LIMIT || streamError.isOutputTokenLimitError) return new OutputTokensLimitExceededError(streamError.message);
  return classifyTokenLimitErrorFromMessage(streamError.message) ?? new Error(streamError.message);
}

export interface StreamRequestOptions {
  messages: readonly LooseRecord[];
  requestedModel: LooseRecord;
  tools?: readonly LooseRecord[];
  providerDefinedTools?: readonly LooseRecord[];
  modelConfig?: LooseRecord | undefined;
  invocationId?: string | undefined;
  conversationId?: string | undefined;
  automationId?: string | undefined;
  inferenceReason?: InferenceReason | undefined;
  acceptedUnadvertisedToolNames?: readonly string[] | undefined;
}

/** The model the request asks for, with its parameters as the protocol carries them. */
function requestedModelToProto(model: LooseRecord): InferenceRequestedModel {
  return new InferenceRequestedModel({
    modelId: model.modelId,
    maxMode: model.maxMode,
    parameters: model.parameters.map((parameter: LooseRecord) => new InferenceModelParameterValue({ id: parameter.id, value: parameter.value })),
    builtInModel: model.builtInModel,
    isVariantStringRepresentation: model.isVariantStringRepresentation,
  });
}

export function buildStreamRequest(settings: StreamRequestOptions): InferenceStreamRequest {
  const streamRequest = new InferenceStreamRequest({
    messages: settings.messages.map(coreMessageToProto),
    tools: (settings.tools ?? []).map(agentToolDefinition),
    providerDefinedTools: (settings.providerDefinedTools ?? []).map(namedProviderToolDefinition),
    acceptedUnadvertisedToolNames: [...(settings.acceptedUnadvertisedToolNames ?? [])],
    requestedModel: requestedModelToProto(settings.requestedModel),
  });
  if (settings.invocationId) streamRequest.invocationId = settings.invocationId;
  if (settings.conversationId) streamRequest.conversationId = settings.conversationId;
  if (settings.automationId) streamRequest.automationId = settings.automationId;
  if (settings.inferenceReason) streamRequest.inferenceReason = settings.inferenceReason;
  if (settings.modelConfig) streamRequest.modelConfig = new InferenceModelConfig({
    maxTokens: settings.modelConfig.maxTokens,
    temperature: settings.modelConfig.temperature,
    topP: settings.modelConfig.topP,
    stopSequences: settings.modelConfig.stopSequences ?? [],
  });
  return streamRequest;
}
