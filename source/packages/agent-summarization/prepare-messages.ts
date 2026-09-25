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

const USER_INFO_TAG_REGEX = /<user_info>[\s\S]*<\/user_info>/;

function hasUserInfoTag(message: RedactedCoreMessage): boolean {
  const unredactedMessage = fromRedactedCoreMessage(message, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
  const content = unredactedMessage.content;
  const textContent = Array.isArray(content)
    ? (content as readonly Record<string, unknown>[])
      .filter(part => part.type === "text")
      .map(part => part.text)
      .join("\n")
    : content;
  return USER_INFO_TAG_REGEX.test(textContent as string);
}

function isEmptyAssistantMessage(message: RedactedCoreMessage): boolean {
  if (message.role !== "assistant") return false;
  const unredacted = fromRedactedCoreMessage(message, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
  const content = unredacted.content;
  if (typeof content === "string") return content.length === 0;
  if (Array.isArray(content)) return content.length === 0;
  return false;
}

export function prepareMessagesForCompaction(messages: readonly RedactedCoreMessage[]): {
  systemMessage: RedactedCoreMessage | undefined;
  userInfoMessage: RedactedCoreMessage | undefined;
  messagesForSummarization: RedactedCoreMessage[];
} {
  const systemMessage = messages.find(message => message.role === "system");
  let messagesForSummarization = messages.filter(message => message.role !== "system" && !isEmptyAssistantMessage(message));
  let userInfoMessage: RedactedCoreMessage | undefined;
  if (
    messagesForSummarization.length >= 2 &&
    messagesForSummarization[0]!.role === "user" &&
    messagesForSummarization[1]!.role === "user" &&
    hasUserInfoTag(messagesForSummarization[0]!)
  ) {
    userInfoMessage = messagesForSummarization[0];
    messagesForSummarization = messagesForSummarization.slice(1);
  }
  return { systemMessage, userInfoMessage, messagesForSummarization };
}
