/**
 * The rules a turn is given, and the context the message that carries them was written with.
 *
 * Two kinds of rule arrive together — the ones from the workspace and the ones a server fetched — and the
 * team's rules among them can be disabled by name and can arrive twice, so they are filtered and
 * deduplicated while the user's own are left alone. A session that was told to drop the custom prompt
 * context is given none of them at all, which is what that flag means.
 *
 * The rest of the file reads things back out of the conversation: where the cloud testing sections were
 * placed, so a later turn places them the same way, and the trigger information an automation's message
 * carries, which is the only record of what woke the run.
 */

import { PrivacyCapability } from "../../redaction/classification.ts"
export { getAllRules } from "../../../adapters/interop/agent/prompt-rule-policy-adapter.ts"
import {
  getFirstUserInfoCloudTestingSectionsPlacement as readCloudTestingSectionsPlacement,
  getFirstUserInfoMessageContent,
  type PriorUserInfoMessage,
} from "../prompts/user-info-preparation.ts"


type PriorUserMessage = PriorUserInfoMessage

function getFirstUserInfoCloudTestingSectionsPlacement(priorMessages: readonly PriorUserMessage[]) {
  return readCloudTestingSectionsPlacement(priorMessages as never)
}

export { getFirstUserInfoMessageContent }

type UnwrappableText = {
  unwrap(purpose: PrivacyCapability): string
}

type AutomationTriggerMessage = {
  readonly role: string
  readonly content: UnwrappableText | readonly { readonly type: string; readonly text: UnwrappableText }[]
}

const TRIGGER_INFO_OPEN = "<automation_trigger_info>"
const TRIGGER_INFO_CLOSE = "</automation_trigger_info>"

export function extractAutomationTriggerContext(
  messages: readonly AutomationTriggerMessage[],
): string | undefined {
  for (const message of messages) {
    if (message.role !== "user") continue
    const content = message.content
    const textParts: string[] = []
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === "text") textParts.push(part.text.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED))
      }
    } else {
      textParts.push((content as UnwrappableText).unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED))
    }
    const fullText = textParts.join("\n")
    const openIndex = fullText.indexOf(TRIGGER_INFO_OPEN)
    if (openIndex === -1) continue
    const closeIndex = fullText.indexOf(TRIGGER_INFO_CLOSE, openIndex)
    if (closeIndex === -1) continue
    return fullText.slice(openIndex, closeIndex + TRIGGER_INFO_CLOSE.length).trim()
  }
  return undefined
}
