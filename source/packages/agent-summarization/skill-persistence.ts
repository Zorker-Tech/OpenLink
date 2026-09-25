/**
 * The skills a conversation was given by hand, found again when its messages are compacted.
 *
 * A skill attached by hand is part of the instructions the user gave, and summarization is the one place
 * that can quietly lose it: the messages carrying it are replaced by a summary, and a summary written by a
 * model is not going to reproduce a whole skill faithfully. So the blocks are taken out before compaction
 * and carried forward verbatim, and they are taken from the most recent user message that is not itself a
 * summary — because a summary's text may mention a skill without carrying it.
 */

import { PrivacyCapability } from "../redaction/classification.ts";
import { fromRedactedCoreMessage } from "../redaction/message-redaction.ts";

type RedactedCoreMessage = Parameters<typeof fromRedactedCoreMessage>[0];

const MANUALLY_ATTACHED_SKILLS_REGEX = /<manually_attached_skills>[\s\S]*?<\/manually_attached_skills>/g;

function extractManuallyAttachedSkillBlocks(redactedMessage: RedactedCoreMessage): string[] {
  const message = fromRedactedCoreMessage(redactedMessage, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
  if (message.role !== "user") return [];
  const content = message.content;
  const textSegments = typeof content === "string"
    ? [content]
    : (content as readonly Record<string, unknown>[])
      .filter(part => part.type === "text")
      .map(part => part.text as string);
  const skillBlocks: string[] = [];
  for (const segment of textSegments) {
    const matches = segment.match(MANUALLY_ATTACHED_SKILLS_REGEX) ?? [];
    for (const match of matches) {
      const normalized = match.trim();
      if (normalized.length > 0) skillBlocks.push(normalized);
    }
  }
  return skillBlocks;
}

export function collectAllSkillBlocks(messages: readonly RedactedCoreMessage[]): string[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    const providerOptions = message.providerOptions as { cursor?: { isSummary?: unknown } } | undefined;
    if (message.role === "user" && providerOptions?.cursor?.isSummary !== true) {
      return extractManuallyAttachedSkillBlocks(message);
    }
  }
  return [];
}
