/**
 * Keep one inline copy of the named agent's identity in its conversation.
 */
import { createLogger, type Context } from "../../../context/index.ts"
import { PrivacyCapability } from "../../../redaction/classification.ts"
import { fromRedactedCoreMessage, toRedactedCoreMessage, type CoreMessageLike } from "../../../redaction/message-redaction.ts"
import type { PrivacyMode } from "../../../redaction/privacy-mode.ts"
import { refreshSelfDocumentContent } from "./self-document-message-content.ts"

type RedactedCoreMessage = Parameters<typeof fromRedactedCoreMessage>[0]

const logger = createLogger("agent/self-document")

export {
  extractNamedAgentSelfDocumentBlock,
  renderNamedAgentSelfDocumentBlock,
} from "./self-document-block.ts"

export async function refreshNamedAgentSelfDocumentInMessages(
  ctx: Context,
  messages: readonly RedactedCoreMessage[],
  getNamedAgentSelfDocument: () => Promise<string | null | undefined>,
  privacyMode: PrivacyMode,
): Promise<readonly RedactedCoreMessage[]> {
  let document: string | null | undefined
  try {
    document = await getNamedAgentSelfDocument()
  } catch (error) {
    logger.warn(ctx, "[self-document] refresh load failed; keeping stale copy", { error })
    return messages
  }

  let selected = false
  let changed = false
  const next: RedactedCoreMessage[] = []
  for (const message of messages) {
    if (selected || message.role !== "user") {
      next.push(message)
      continue
    }

    const plain = fromRedactedCoreMessage(message, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED) as CoreMessageLike
    if (plain.role !== "user") {
      next.push(message)
      continue
    }
    const update = refreshSelfDocumentContent(plain.content, document)
    if (!update.found) {
      next.push(message)
      continue
    }

    selected = true
    if (!update.changed) {
      next.push(message)
      continue
    }
    changed = true
    next.push(toRedactedCoreMessage({ ...plain, content: update.content }, privacyMode))
  }

  return changed ? next : messages
}
