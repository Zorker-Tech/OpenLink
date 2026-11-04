import { PrivacyCapability } from "../../../packages/redaction/classification.ts"
import { fromRedactedCoreMessage } from "../../../packages/redaction/message-redaction.ts"
import { extractAttachedSkillBlocks } from "../../../packages/agent-summarization/skill-persistence.ts"

type RedactedConversationMessage = Parameters<typeof fromRedactedCoreMessage>[0]

/** Read the counterpart's compacted-message envelope, then hand only text to Slate's skill-block policy. */
export function collectAttachedSkillBlocksFromConversation(
  messages: readonly RedactedConversationMessage[],
): string[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role !== "user" || carriesSummaryMarker(message.providerOptions)) continue

    const readableMessage = fromRedactedCoreMessage(message, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
    return extractAttachedSkillBlocks(readableTextSegments(readableMessage.content))
  }
  return []
}

function carriesSummaryMarker(providerOptions: unknown): boolean {
  if (typeof providerOptions !== "object" || providerOptions === null) return false
  const cursor = (providerOptions as Record<string, unknown>).cursor
  return typeof cursor === "object" && cursor !== null && (cursor as Record<string, unknown>).isSummary === true
}

function readableTextSegments(content: unknown): string[] {
  if (typeof content === "string") return [content]
  if (!Array.isArray(content)) return []

  return content.flatMap((part: unknown) => {
    if (typeof part !== "object" || part === null) return []
    const candidate = part as Record<string, unknown>
    return candidate.type === "text" && typeof candidate.text === "string" ? [candidate.text] : []
  })
}
