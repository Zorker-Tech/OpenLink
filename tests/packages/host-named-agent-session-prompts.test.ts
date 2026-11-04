import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { NAMED_AGENT_STORE_SELF_PATH, SUBSCRIPTIONS_MCP_SERVER_NAME } from "../../source/packages/agent/constants.ts"
import {
  getNamedAgentSessionPromptContext,
  isNamedAgentHomePromptSession,
  renderCloudMetaParentUserTurnReminder,
  renderNamedAgentHomeUserTurnReminder,
} from "../../source/packages/agent/prompts/cloud-meta-agent/named-agent-sessions.ts"

describe("named agent session prompts", () => {
  it("marks only a standalone named-agent home session as durable configuration", () => {
    const home = { backgroundAgentSource: "named-agent", namedAgentSessionKind: " home " } as const
    assert.equal(isNamedAgentHomePromptSession(home), true)
    assert.equal(isNamedAgentHomePromptSession({ ...home, backgroundAgentSource: "cloud" } as never), false)
    assert.equal(isNamedAgentHomePromptSession({ ...home, namedAgentSessionKind: "work" }), false)
    assert.equal(isNamedAgentHomePromptSession({ ...home, isCloudMetaAgentParent: true }), false)
    assert.equal(isNamedAgentHomePromptSession({ ...home, subagentType: "review" }), false)
  })

  it("builds session context only when the id, key and kind are all present", () => {
    assert.deepEqual(getNamedAgentSessionPromptContext({
      namedAgentId: " agent-7 ",
      namedAgentSessionKey: " session-a ",
      namedAgentSessionKind: " watch ",
    }), { namedAgentId: "agent-7", sessionKey: "session-a", sessionKind: "watch" })
    assert.equal(getNamedAgentSessionPromptContext({ namedAgentId: "agent-7", namedAgentSessionKey: "session-a", namedAgentSessionKind: " " }), undefined)
  })

  it("keeps home instructions on configuration and routes subscription changes through their owning tools", () => {
    const reminder = renderNamedAgentHomeUserTurnReminder()
    assert.match(reminder, /configuration conversation/)
    assert.match(reminder, /durable configuration/)
    assert.ok(reminder.includes(NAMED_AGENT_STORE_SELF_PATH))
    assert.ok(reminder.includes(SUBSCRIPTIONS_MCP_SERVER_NAME))
    assert.match(reminder, /questions|hypothetical/i)
    assert.match(reminder, /Do not .*repository/i)
  })

  it("asks a parent to delegate substantive work and scopes notifications to material updates", () => {
    const context = getNamedAgentSessionPromptContext({ namedAgentId: "agent-7", namedAgentSessionKey: "session-a", namedAgentSessionKind: "watch" })
    const reminder = renderCloudMetaParentUserTurnReminder("TASK", context)
    assert.match(reminder, /parent/)
    assert.match(reminder, /delegate/i)
    assert.match(reminder, /TASK/)
    assert.match(reminder, /agent-7/)
    assert.match(reminder, /watch/)
    assert.match(reminder, /session-a/)
    assert.match(reminder, /material update|decision|action item/i)
    assert.match(reminder, /concise|short/i)

    const withoutSession = renderCloudMetaParentUserTurnReminder("TASK", undefined)
    assert.doesNotMatch(withoutSession, /session-a/)
  })
})
