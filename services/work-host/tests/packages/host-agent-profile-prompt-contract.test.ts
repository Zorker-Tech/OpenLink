import assert from "node:assert/strict"
import { test } from "node:test"

import {
  agentProfileIdentitiesEqual,
  normalizeAgentProfileIdentity,
  parseLatestAgentProfileUpdate,
  renderAgentProfileUpdate,
  resolveAgentProfilePromptSnapshot,
  SLATE_AGENT_PROFILE_UPDATE_MARKER,
} from "../../source/host/runner/slate-agent-profile-prompt.ts"
import { SLATE_HIDDEN_PROMPT_MARKER } from "../../source/host/runner/slate-prompt-markers.ts"

test("profile identity is trimmed before equality comparisons", () => {
  const current = normalizeAgentProfileIdentity({ name: " Researcher ", description: " Plans experiments " })
  assert.deepEqual(current, { name: "Researcher", description: "Plans experiments" })
  assert.equal(agentProfileIdentitiesEqual(current, { name: "Researcher", description: "Plans experiments" }), true)
  assert.equal(agentProfileIdentitiesEqual(current, { name: "Researcher", description: "Other" }), false)
})

test("a prompt snapshot is reused only in the compaction epoch that created it", () => {
  const first = resolveAgentProfilePromptSnapshot({
    compactionEpoch: 4,
    profileSection: "profile one",
    identity: { name: "One", description: "First" },
  })
  assert.deepEqual(resolveAgentProfilePromptSnapshot({
    snapshot: first,
    compactionEpoch: 4,
    profileSection: "profile two",
    identity: { name: "Two", description: "Second" },
  }), first)
  assert.deepEqual(resolveAgentProfilePromptSnapshot({
    snapshot: first,
    compactionEpoch: 5,
    profileSection: "profile two",
    identity: { name: "Two", description: "Second" },
  }), {
    version: 1,
    profileSection: "profile two",
    systemIdentity: { name: "Two", description: "Second" },
    announcedIdentity: { name: "Two", description: "Second" },
    compactionEpoch: 5,
  })
})

test("profile updates are hidden, encoded, and decoded into normalized identity text", () => {
  const identity = { name: "Researcher", description: "Plans experiments" }
  const rendered = renderAgentProfileUpdate(identity)
  assert.equal(rendered.startsWith(`${SLATE_HIDDEN_PROMPT_MARKER}${SLATE_AGENT_PROFILE_UPDATE_MARKER}`), true)
  assert.match(rendered, /Agent name: Researcher/)
  assert.match(rendered, /Purpose: Plans experiments/)
  assert.deepEqual(parseLatestAgentProfileUpdate(rendered), identity)
})

test("the newest valid complete marker wins while malformed and incomplete markers are ignored", () => {
  const first = renderAgentProfileUpdate({ name: "First", description: "one" })
  const second = renderAgentProfileUpdate({ name: " Second ", description: " two " })
  const malformed = `${SLATE_AGENT_PROFILE_UPDATE_MARKER}not-base64>>`
  const incomplete = SLATE_AGENT_PROFILE_UPDATE_MARKER + Buffer.from("{}", "utf8").toString("base64url")

  assert.deepEqual(parseLatestAgentProfileUpdate(`${first}\n${malformed}\n${second}\n${incomplete}`), {
    name: "Second",
    description: "two",
  })
  assert.deepEqual(parseLatestAgentProfileUpdate(incomplete), null)
})
