import assert from "node:assert/strict"
import test from "node:test"

import { RunnerIdentity } from "../../source/host/runner/runner-identity.ts"

test("a runner identity follows host-provided ids and keeps its generated fallback stable", () => {
  const identity = new RunnerIdentity({ conversationId: "conversation-1", getAgentId: () => "agent-1" })
  const fallback = new RunnerIdentity({})
  const generated = fallback.getConversationId()

  assert.equal(identity.getConversationId(), "agent-1")
  assert.equal(identity.resolveBoxId(), "agent-1")
  assert.match(generated, /^slate-/)
  assert.equal(fallback.getConversationId(), generated)
})

test("box ids, transcript ids, terminal folders and browser endpoints resolve at their own boundaries", () => {
  const identity = new RunnerIdentity({
    conversationId: "conversation-1",
    boxId: "box-1",
    transcriptId: "transcript-1",
    getBoxTerminalsFolder: () => "/default/terminals",
    getBoxWindowIndex: () => 2,
  })

  assert.equal(identity.resolveBoxId(), "box-1")
  assert.equal(identity.getTranscriptId(), "transcript-1")
  assert.equal(identity.resolveTerminalsFolder(), "/default/terminals")
  identity.setRemoteTerminalsFolder("/remote/terminals")
  assert.equal(identity.resolveTerminalsFolder(), "/remote/terminals")
  assert.deepEqual(identity.resolveBrowserEndpoint(9_222), { display: ":2", cdpUrl: "http://127.0.0.1:9224" })
  assert.equal(new RunnerIdentity({ getBoxWindowIndex: () => undefined }).resolveBrowserEndpoint(9_222), null)
})

test("trace attributes preserve caller data and include the conversation's own identity", () => {
  const identity = new RunnerIdentity({ conversationId: "conversation-1" })
  const projected = identity.stampInheritableAttributes(
    { inheritableAttributes: { existing: "kept" } },
    "request-2",
    "user_message",
    { isSubagentRunner: true, subagentType: "explore" },
  )

  assert.deepEqual(projected.inheritableAttributes, {
    existing: "kept",
    "slate.conversation_id": "conversation-1",
    "slate.request_id": "request-2",
    "slate.turn_type": "user_message",
    "slate.subagent_type": "explore",
  })

  assert.doesNotThrow(() => identity.stampRootRequestId({ setAttribute: () => { throw new Error("closed span") } }, "request-3"))
})
