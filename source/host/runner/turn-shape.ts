/**
 * Where a turn begins and ends in a transcript.
 *
 * The platform's own additions — reminders, the marker a tool leaves — are recognized so a turn can be read as what the
 * user and the agent actually said, and a turn's length is measured the same way everywhere it is asked about.
 */
import { isInjectedReminderMessage } from "./send-message-reminder-middleware.ts";
import { SLATE_REACT_TO_MESSAGE_TOOL_NAME } from "./tools/slate-reaction-tool.ts";
import { SLATE_SEND_MESSAGE_TOOL_NAME } from "./tools/send-message-tool.ts";

export const DELIVERY_TOOL_NAMES = new Set([
  SLATE_SEND_MESSAGE_TOOL_NAME,
  SLATE_REACT_TO_MESSAGE_TOOL_NAME,
]);

export interface CorePart {
  readonly type: string;
  readonly text?: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
}

export interface CoreMessage {
  readonly role: string;
  readonly content: string | readonly CorePart[];
  readonly providerOptions?: {
    readonly cursor?: { readonly highLevelToolCallResult?: unknown };
  };
}

export function asCoreMessage(candidate: unknown): CoreMessage | undefined {
  if (typeof candidate !== "object" || candidate === null) return undefined;
  if (!("role" in candidate) || typeof candidate.role !== "string") return undefined;
  if (
    !("content" in candidate)
    || (typeof candidate.content !== "string" && !Array.isArray(candidate.content))
  ) return undefined;
  return candidate as CoreMessage;
}

export function toolCallNames(transcriptMessage: CoreMessage): string[] {
  if (transcriptMessage.role !== "assistant" || typeof transcriptMessage.content === "string") {
    return [];
  }
  return transcriptMessage.content.flatMap((contentPart) =>
    contentPart.type === "tool-call" && contentPart.toolName != null
      ? [contentPart.toolName]
      : []
  );
}

export function hasDeliveryToolCall(toolNames: readonly string[]): boolean {
  return toolNames.some((toolName) => DELIVERY_TOOL_NAMES.has(toolName));
}

function deliveryToolCallIds(transcriptMessage: CoreMessage): string[] {
  if (transcriptMessage.role !== "assistant" || typeof transcriptMessage.content === "string") {
    return [];
  }
  return transcriptMessage.content.flatMap((contentPart) =>
    contentPart.type === "tool-call"
      && contentPart.toolName != null
      && DELIVERY_TOOL_NAMES.has(contentPart.toolName)
      && contentPart.toolCallId != null
      ? [contentPart.toolCallId]
      : []
  );
}

function erroredToolResultIds(
  parsedMessages: readonly (CoreMessage | undefined)[],
): Set<string> {
  const callIds = new Set<string>();
  for (const transcriptMessage of parsedMessages) {
    if (
      transcriptMessage === undefined
      || transcriptMessage.role !== "tool"
      || typeof transcriptMessage.content === "string"
    ) continue;
    const highLevelResult = transcriptMessage.providerOptions?.cursor
      ?.highLevelToolCallResult;
    if (
      typeof highLevelResult !== "object"
      || highLevelResult === null
      || Array.isArray(highLevelResult)
      || !("isError" in highLevelResult)
      || highLevelResult.isError !== true
    ) continue;
    for (const contentPart of transcriptMessage.content) {
      if (contentPart.type === "tool-result" && contentPart.toolCallId != null) {
        callIds.add(contentPart.toolCallId);
      }
    }
  }
  return callIds;
}

export function isBlankAssistantMessage(transcriptMessage: CoreMessage): boolean {
  if (transcriptMessage.role !== "assistant") return false;
  if (typeof transcriptMessage.content === "string") {
    return transcriptMessage.content.trim().length === 0;
  }
  return transcriptMessage.content.every(
    (contentPart) => contentPart.type === "text" && (contentPart.text ?? "").trim().length === 0,
  );
}

export function turnEndedOnSilentToolCalls(
  rawTranscript: readonly unknown[],
): boolean {
  const parsedMessages = rawTranscript.map(asCoreMessage);
  let tailPosition = parsedMessages.length - 1;
  while (tailPosition >= 0) {
    const transcriptMessage = parsedMessages[tailPosition];
    if (
      transcriptMessage === undefined
      || transcriptMessage.role === "tool"
      || isBlankAssistantMessage(transcriptMessage)
      || isInjectedReminderMessage(transcriptMessage)
    ) {
      tailPosition -= 1;
      continue;
    }
    break;
  }

  const tailMessage = tailPosition >= 0 ? parsedMessages[tailPosition] : undefined;
  if (tailMessage === undefined || tailMessage.role !== "assistant") return false;
  const tailToolNames = toolCallNames(tailMessage);
  if (tailToolNames.length === 0 || hasDeliveryToolCall(tailToolNames)) return false;

  let userBoundary = -1;
  for (let position = tailPosition - 1; position >= 0; position -= 1) {
    const transcriptMessage = parsedMessages[position];
    if (transcriptMessage === undefined || isInjectedReminderMessage(transcriptMessage)) continue;
    if (transcriptMessage.role === "user" || transcriptMessage.role === "system") {
      userBoundary = position;
      break;
    }
  }

  const failedCallIds = erroredToolResultIds(parsedMessages);
  let deliveryAcknowledged = false;
  for (let position = userBoundary + 1; position <= tailPosition; position += 1) {
    const transcriptMessage = parsedMessages[position];
    if (transcriptMessage === undefined || transcriptMessage.role !== "assistant") continue;
    const toolNames = toolCallNames(transcriptMessage);
    if (toolNames.length === 0) continue;
    if (!deliveryAcknowledged) {
      if (!hasDeliveryToolCall(toolNames)) return false;
      deliveryAcknowledged = true;
    } else if (
      deliveryToolCallIds(transcriptMessage).some((callId) => !failedCallIds.has(callId))
    ) {
      return false;
    }
  }
  return deliveryAcknowledged;
}
