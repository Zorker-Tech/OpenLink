import assert from "node:assert/strict"
import { test } from "node:test"

import { BoxRequestEntries } from "../../source/host/transcript/box-request-entries.ts"
import { getTranscript, setTranscript } from "../../source/host/transcript/transcript-store.ts"
import type { TranscriptEntry } from "../../source/host/transcript/transcript-hub.ts"

function sessionFor(entries: TranscriptEntry[], calls: string[]) {
  const db = {
    getTranscriptEntries: () => entries,
    updateTranscriptEntry(id: string, change: (entry: TranscriptEntry) => TranscriptEntry) {
      const index = entries.findIndex((entry) => entry.id === id)
      if (index < 0) return null
      entries[index] = change(entries[index]!)
      calls.push(`update:${id}`)
      return entries[index]!
    },
    close() { calls.push("close") },
  }
  return { db, agentStore: { async dispose() { calls.push("dispose") } } }
}

test("a new active request dismisses the prior request from the same session", () => {
  const settled: unknown[][] = []
  const session = { id: "agent-1" }
  const entries = new BoxRequestEntries({
    sessions: { activeSession: session },
    resolveBoxRequestEntry: async (...args: unknown[]) => { settled.push(args) },
  } as never)

  entries.trackBoxRequestEntry({ id: "entry-1", kind: "send-message", boxRequestId: "request-1" })
  entries.trackBoxRequestEntry({ id: "entry-2", kind: "send-message", boxRequestId: "request-2" })
  assert.deepEqual(entries.activeBoxRequest, { agentId: "agent-1", entryId: "entry-2", requestId: "request-2" })
  assert.deepEqual(settled, [["agent-1", "request-1", "dismissed"]])

  entries.trackBoxRequestEntry({ id: "entry-3", kind: "send-message", boxResolution: "approved", boxRequestId: "request-3" })
  assert.equal(entries.activeBoxRequest?.requestId, "request-2")
})

test("resolving a request updates the database and the active in-memory transcript once", async () => {
  const entries: TranscriptEntry[] = [{ id: "entry-1", kind: "send-message", boxRequestId: "request-1" }]
  const calls: string[] = []
  const session = sessionFor(entries, calls)
  const events: unknown[] = []
  const manager = {
    sessions: {
      activeSession: { id: "agent-1", ...session },
      liveSessions: new Map(),
      inMemoryTranscriptAgentId: "agent-1",
      isAgentGone: () => false,
    },
    sessionStore: { async openSession() { throw new Error("the active session is already open") } },
    roster: { emit: (event: unknown) => events.push(event) },
  }
  setTranscript(entries)
  const requests = new BoxRequestEntries(manager as never)
  requests.activeBoxRequest = { agentId: "agent-1", entryId: "entry-1", requestId: "request-1" }

  await requests.resolveBoxRequestEntry("agent-1", "request-1", "approved")
  assert.equal(requests.activeBoxRequest, null)
  assert.equal(entries[0]?.boxResolution, "approved")
  assert.equal(getTranscript()[0]?.boxResolution, "approved")
  assert.deepEqual(calls, ["update:entry-1"])
  assert.deepEqual(events, [{ type: "updated", entry: entries[0] }])
})

test("a temporary session is closed after resolution, and its missing request is left alone", async () => {
  const calls: string[] = []
  const temporary = sessionFor([], calls)
  const manager = {
    sessions: {
      activeSession: undefined,
      liveSessions: new Map(),
      isAgentGone: () => false,
    },
    sessionStore: { async openSession() { calls.push("open"); return temporary } },
    roster: { emit() { calls.push("emit") } },
  }

  await new BoxRequestEntries(manager as never).resolveBoxRequestEntry("agent-2", "request-2", "dismissed")
  assert.deepEqual(calls, ["open", "dispose", "close"])
})

test("a departed agent or a store that cannot be opened does not produce an update", async () => {
  let opens = 0
  const departed = new BoxRequestEntries({
    sessions: { isAgentGone: () => true, liveSessions: new Map() },
    sessionStore: { async openSession() { opens += 1; throw new Error("unreachable") } },
  } as never)
  departed.activeBoxRequest = { agentId: "agent-3", entryId: "entry-3", requestId: "request-3" }
  await departed.resolveBoxRequestEntry("agent-3", "request-3", "expired")
  assert.equal(departed.activeBoxRequest, null)
  assert.equal(opens, 0)

  const missing = new BoxRequestEntries({
    sessions: { isAgentGone: () => false, liveSessions: new Map() },
    sessionStore: { async openSession() { opens += 1; throw new Error("database unavailable") } },
  } as never)
  await assert.doesNotReject(missing.resolveBoxRequestEntry("agent-4", "request-4", "expired"))
  assert.equal(opens, 1)
})
