import assert from "node:assert/strict"
import test from "node:test"

import { resolveAgentNotesDirectory } from "../../source/packages/agent/prompts/agent-notes-directory.ts"

test("meta-agent notes must be enabled before any location is selected", () => {
  assert.equal(resolveAgentNotesDirectory({
    metaAgentNotesEnabled: false,
    agentConversationNotesFolder: "/notes/existing",
    notesSessionId: "session-1",
    env: { projectFolder: "/repo" },
  }), undefined)
})

test("an explicit conversation folder wins and is returned without normalization", () => {
  assert.equal(resolveAgentNotesDirectory({
    metaAgentNotesEnabled: true,
    agentConversationNotesFolder: "  ",
    notesSessionId: "session-1",
    env: { projectFolder: "/repo" },
  }), "  ")
})

test("the session folder is derived only from a non-empty project and session id", () => {
  assert.equal(resolveAgentNotesDirectory({
    metaAgentNotesEnabled: true,
    notesSessionId: "session-2",
    env: { projectFolder: "/workspace/project" },
  }), "/workspace/project/agent-notes/session-2")
  assert.equal(resolveAgentNotesDirectory({ metaAgentNotesEnabled: true, notesSessionId: "session-2" }), undefined)
  assert.equal(resolveAgentNotesDirectory({ metaAgentNotesEnabled: true, notesSessionId: "", env: { projectFolder: "/repo" } }), undefined)
  assert.equal(resolveAgentNotesDirectory({ metaAgentNotesEnabled: true, notesSessionId: "session-2", env: { projectFolder: "" } }), undefined)
})
