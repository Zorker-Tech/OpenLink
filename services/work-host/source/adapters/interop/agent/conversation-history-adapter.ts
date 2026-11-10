/** Decode the externally stored action history and project it into the turn's core messages. */

import { PrivacyCapability } from "../../../packages/redaction/classification.ts"
import { toRedactedCoreMessages } from "../../../packages/redaction/message-redaction.ts"
import { fromRedactedConversationHistory } from "../redacted-protos/generated/agent/v1/agent_redacted.ts"
import {
  assistantContentToCore,
  toolResultContentToCore,
  userContentToCore,
} from "../../../packages/agent/actions/user-message-action/conversation-history-content.ts"

type DynamicValue = any
type MessageProjector = (value: DynamicValue) => DynamicValue

function toolMessageToCore(value: DynamicValue): DynamicValue {
  const { toolCallId, toolName, content, isError } = value
  const result = toolResultContentToCore(content)
  return {
    role: "tool",
    content: [{
      type: "tool-result",
      toolCallId,
      toolName,
      result: result.result,
      experimental_content: result.experimentalContent,
      ...(isError !== undefined ? { isError } : {}),
    }],
  }
}

const MESSAGE_PROJECTORS: Readonly<Record<string, MessageProjector>> = {
  user: value => ({ role: "user", content: userContentToCore(value.content) }),
  assistant: value => ({ role: "assistant", content: assistantContentToCore(value.content) }),
  tool: toolMessageToCore,
}

export function conversationHistoryToCoreMessages(history: DynamicValue | undefined): DynamicValue[] {
  if (history === undefined) return []
  const messages: DynamicValue[] = []
  for (const envelope of history.messages) {
    const message = envelope.message
    const role = message.case
    if (role === undefined) continue
    if (!Object.hasOwn(MESSAGE_PROJECTORS, role)) return message
    messages.push(MESSAGE_PROJECTORS[role]!(message.value))
  }
  return messages
}

export function deserializeConversationHistoryMessages(action: DynamicValue, privacyMode: DynamicValue): DynamicValue[] {
  const history = action.conversationHistory === undefined
    ? undefined
    : fromRedactedConversationHistory(action.conversationHistory, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined)
  return toRedactedCoreMessages(conversationHistoryToCoreMessages(history), privacyMode)
}
