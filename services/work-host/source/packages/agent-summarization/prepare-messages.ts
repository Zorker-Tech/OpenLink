/**
 * The messages a compaction is given, and the two that are kept out of it.
 *
 * The system message and the user-info message are instructions rather than conversation, and both are
 * large and fixed: summarizing them would spend tokens to produce a worse copy of something that is already
 * in the prompt. So they are separated out — the system message by its role, the user-info message by the
 * tag it carries and by sitting directly after the system message — and the rest of the conversation is
 * what gets compacted. An assistant message with no content is dropped as well, since a model that produced
 * nothing has nothing to summarize.
 */

import { PrivacyCapability } from "../redaction/classification.ts";
import { fromRedactedCoreMessage } from "../redaction/message-redaction.ts";

type RedactedCoreMessage = Parameters<typeof fromRedactedCoreMessage>[0];

const USER_INFO_OPEN = "<user_info>";
const USER_INFO_CLOSE = "</user_info>";

function messageText(message: RedactedCoreMessage): unknown {
  const unredactedMessage = fromRedactedCoreMessage(message, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
  const content = unredactedMessage.content;
  if (!Array.isArray(content)) return content;

  const textParts: unknown[] = [];
  for (const part of content as readonly Record<string, unknown>[]) {
    if (part.type === "text") textParts.push(part.text);
  }
  return textParts.join("\n");
}

function hasUserInfoBlock(message: RedactedCoreMessage): boolean {
  const text = String(messageText(message));
  const openAt = text.indexOf(USER_INFO_OPEN);
  return openAt >= 0 && text.indexOf(USER_INFO_CLOSE, openAt + USER_INFO_OPEN.length) >= 0;
}

function isAssistantWithoutContent(message: RedactedCoreMessage): boolean {
  if (message.role !== "assistant") return false;
  const unredacted = fromRedactedCoreMessage(message, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
  const content = unredacted.content;
  if (typeof content === "string") return content.length === 0;
  if (Array.isArray(content)) return content.length === 0;
  return false;
}

function firstMessageIsUserInfo(messages: readonly RedactedCoreMessage[]): boolean {
  const candidate = messages[0];
  return candidate !== undefined &&
    candidate.role === "user" &&
    messages[1]?.role === "user" &&
    hasUserInfoBlock(candidate);
}

export function prepareMessagesForCompaction(messages: readonly RedactedCoreMessage[]): {
  systemMessage: RedactedCoreMessage | undefined;
  userInfoMessage: RedactedCoreMessage | undefined;
  messagesForSummarization: RedactedCoreMessage[];
} {
  const systemMessage = messages.find(message => message.role === "system");
  const conversation = messages.filter(message =>
    message.role !== "system" && !isAssistantWithoutContent(message));
  const keepUserInfoSeparate = firstMessageIsUserInfo(conversation);
  const userInfoMessage = keepUserInfoSeparate ? conversation[0] : undefined;
  const messagesForSummarization = keepUserInfoSeparate ? conversation.slice(1) : conversation;
  return { systemMessage, userInfoMessage, messagesForSummarization };
}
