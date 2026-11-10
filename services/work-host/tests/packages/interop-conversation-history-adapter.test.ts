import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { toRedactedConversationHistory } from "../../source/adapters/interop/redacted-protos/generated/agent/v1/agent_redacted.ts"
import { deserializeConversationHistoryMessages } from "../../source/adapters/interop/agent/conversation-history-adapter.ts"

describe("the conversation history interop adapter", () => {
  it("decodes redacted history and projects user content into the turn format", () => {
    const conversationHistory = toRedactedConversationHistory({
      replaceUserInfo: false,
      messages: [{
        message: {
          case: "user",
          value: { content: [{ content: { case: "text", value: { text: "prior request" } } }] },
        },
      }],
    } as never, PrivacyMode.NO_STORAGE)

    const messages = deserializeConversationHistoryMessages({ conversationHistory }, PrivacyMode.NO_STORAGE)

    assert.equal(messages.length, 1)
    assert.equal((messages[0] as { role?: string }).role, "user")
  })
})
