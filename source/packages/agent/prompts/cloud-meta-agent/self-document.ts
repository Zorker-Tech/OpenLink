/**
 * The named agent's self document, kept current inside the conversation.
 *
 * A named agent is defined by a file it writes about itself, and the agent has to be able to answer
 * "who am I" without reading that file on every turn. So the document is copied into the first user
 * message, and refreshed in place when it changes — replacing the block rather than appending, so the
 * conversation does not accumulate one copy per turn.
 *
 * The document is written by the agent, which means it can contain the tags this block is delimited by.
 * Those are escaped on the way in, because otherwise a document could close the block early and have its
 * text read as platform instruction. The refresh only touches the first user message that has the
 * block; a load that fails leaves the stale copy in place, since a slightly old identity is better than
 * an error in the middle of a turn.
 */

import { createLogger, type Context } from "../../../context/index.ts"
import { PrivacyCapability } from "../../../redaction/classification.ts"
import { fromRedactedCoreMessage, toRedactedCoreMessage, type CoreMessageLike } from "../../../redaction/message-redaction.ts"
import type { PrivacyMode } from "../../../redaction/privacy-mode.ts"
import { NAMED_AGENT_STORE_SELF_PATH } from "../../constants.ts"

type RedactedCoreMessage = Parameters<typeof fromRedactedCoreMessage>[0]

const logger = createLogger("agent/self-document")
const NAMED_AGENT_SELF_DOCUMENT_TAG = "agent_self_document"
const SELF_DOCUMENT_OPEN = `<${NAMED_AGENT_SELF_DOCUMENT_TAG}>`
const SELF_DOCUMENT_CLOSE = `</${NAMED_AGENT_SELF_DOCUMENT_TAG}>`
const SELF_DOCUMENT_BLOCK_REGEX = new RegExp(`${SELF_DOCUMENT_OPEN}[\s\S]*?${SELF_DOCUMENT_CLOSE}`)
const USER_INFO_CLOSE = "</user_info>"

export function renderNamedAgentSelfDocumentBlock(contents: string | null | undefined): string {
  const trimmed = contents?.trim()
  const rawBody = trimmed !== undefined && trimmed !== ""
    ? trimmed
    : `You have not written ${NAMED_AGENT_STORE_SELF_PATH} yet.`
  const body = rawBody
    .replaceAll(SELF_DOCUMENT_OPEN, `<\${NAMED_AGENT_SELF_DOCUMENT_TAG}>`)
    .replaceAll(SELF_DOCUMENT_CLOSE, `<\/${NAMED_AGENT_SELF_DOCUMENT_TAG}>`)
  return [
    SELF_DOCUMENT_OPEN,
    `The current contents of your self document (${NAMED_AGENT_STORE_SELF_PATH}). This copy is refreshed for you automatically — never read the file to learn who you are.`,
    "",
    body,
    SELF_DOCUMENT_CLOSE,
  ].join("\n")
}

export function extractNamedAgentSelfDocumentBlock(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  return SELF_DOCUMENT_BLOCK_REGEX.exec(text)?.[0]
}

/** Replaces the block where it is, or inserts it at the end of the context block when it is missing. */
function refreshNamedAgentSelfDocumentInText(text: string, contents: string | null | undefined): string | undefined {
  const block = renderNamedAgentSelfDocumentBlock(contents)
  if (SELF_DOCUMENT_BLOCK_REGEX.test(text)) return text.replace(SELF_DOCUMENT_BLOCK_REGEX, () => block)
  const userInfoCloseIndex = text.indexOf(USER_INFO_CLOSE)
  if (userInfoCloseIndex === -1) return undefined
  const insertAt = userInfoCloseIndex + USER_INFO_CLOSE.length
  return `${text.slice(0, insertAt)}\n\n${block}${text.slice(insertAt)}`
}

export async function refreshNamedAgentSelfDocumentInMessages(
  ctx: Context,
  messages: readonly RedactedCoreMessage[],
  getNamedAgentSelfDocument: () => Promise<string | null | undefined>,
  privacyMode: PrivacyMode,
): Promise<readonly RedactedCoreMessage[]> {
  let contents: string | null | undefined
  try {
    contents = await getNamedAgentSelfDocument()
  } catch (error) {
    logger.warn(ctx, "[self-document] refresh load failed; keeping stale copy", { error })
    return messages
  }
  let foundTarget = false
  let didRefresh = false
  const refreshed = messages.map(message => {
    if (foundTarget || message.role !== "user") return message
    const unredacted = fromRedactedCoreMessage(message, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED) as CoreMessageLike
    if (unredacted.role !== "user") return message
    const content = unredacted.content
    if (typeof content === "string") {
      const updated = refreshNamedAgentSelfDocumentInText(content, contents)
      if (updated === undefined) return message
      foundTarget = true
      if (updated === content) return message
      didRefresh = true
      return toRedactedCoreMessage({ ...unredacted, content: updated }, privacyMode)
    }
    let didUpdatePart = false
    const updatedParts = (content as readonly {
      readonly type: string
      readonly text?: string
      readonly [key: string]: unknown
    }[]).map(part => {
      if (foundTarget || part.type !== "text") return part
      const updated = refreshNamedAgentSelfDocumentInText(part.text!, contents)
      if (updated === undefined) return part
      foundTarget = true
      if (updated === part.text!) return part
      didUpdatePart = true
      return { ...part, text: updated }
    })
    if (!didUpdatePart) return message
    didRefresh = true
    return toRedactedCoreMessage({ ...unredacted, content: updatedParts }, privacyMode)
  })
  return didRefresh ? refreshed : messages
}
