import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { RosterSearch } from "../../source/host/transcript/roster-search.ts"
import { clearTranscript, setTranscript } from "../../source/host/transcript/transcript-store.ts"

interface TestEntry {
  readonly id: string
  readonly role: string
  readonly timestampMs: number
  readonly text: string
}

interface IndexedMatch {
  readonly agentId: string
  readonly entryId: string
  readonly role: string
  readonly timestampMs: number
  readonly snippet: string
}

afterEach(() => clearTranscript())

function entry(id: string, text: string, timestampMs: number, role = "assistant"): TestEntry {
  return { id, text, timestampMs, role }
}

function matchingEntries(entries: readonly unknown[], query: string) {
  return (entries as readonly TestEntry[])
    .filter((item) => item.text.toLowerCase().includes(query))
    .map((item) => ({ entryId: item.id, role: item.role, timestampMs: item.timestampMs, snippet: item.text }))
}

function searchWorld(options: {
  readonly indexed?: readonly IndexedMatch[] | null
  readonly searchReady?: boolean
  readonly liveAgentId?: string | null
  readonly activeAgentId?: string | null
  readonly agents?: readonly { readonly id: string; readonly updatedAt: number }[]
  readonly entriesByAgent?: Readonly<Record<string, readonly TestEntry[]>>
  readonly existingAgentIds?: readonly string[]
  readonly media?: readonly { readonly agentId: string; readonly id: string }[] | null
}) {
  const indexedRequests: unknown[] = []
  const linearReads: string[] = []
  const mediaRequests: unknown[] = []
  const manager = {
    contentSearch: {
      maxResults: 10,
      maxMatchesPerAgent: 2,
      isSearchReady: options.searchReady ?? true,
      async searchMessages(request: unknown) { indexedRequests.push(request); return options.indexed ?? null },
      findTranscriptMatches: matchingEntries,
      async searchMedia(request: unknown) { mediaRequests.push(request); return options.media ?? [] },
    },
    sessions: { inMemoryTranscriptAgentId: options.liveAgentId ?? null },
    sessionStore: {
      agentExists: (id: string) => (options.existingAgentIds ?? []).includes(id),
      async listAgents(activeId?: string) { linearReads.push(`list:${activeId ?? ""}`); return options.agents ?? [] },
      readAgentTranscriptEntries(id: string) { linearReads.push(id); return options.entriesByAgent?.[id] ?? [] },
    },
    getActiveAgentId: () => options.activeAgentId ?? null,
  }
  return {
    search: new RosterSearch(manager as never),
    indexedRequests,
    linearReads,
    mediaRequests,
  }
}

test("indexed transcript search normalizes the query, filters dead agents and merges the live transcript", async () => {
  setTranscript([entry("live-row", "needle in memory", 8)] as never)
  const fixture = searchWorld({
    liveAgentId: "live",
    existingAgentIds: ["agent-a", "agent-b", "live"],
    indexed: [
      { agentId: "live", entryId: "stale-live", role: "assistant", timestampMs: 100, snippet: "stale" },
      { agentId: "gone", entryId: "gone-row", role: "assistant", timestampMs: 90, snippet: "deleted" },
      { agentId: "agent-a", entryId: "a-row", role: "assistant", timestampMs: 30, snippet: "needle A" },
      { agentId: "agent-b", entryId: "b-row", role: "user", timestampMs: 10, snippet: "needle B" },
    ],
  })

  assert.deepEqual(await fixture.search.searchAgents("  NEEDLE  ", 3), [
    { agentId: "agent-a", entryId: "a-row", role: "assistant", timestampMs: 30, snippet: "needle A" },
    { agentId: "agent-b", entryId: "b-row", role: "user", timestampMs: 10, snippet: "needle B" },
    { agentId: "live", entryId: "live-row", role: "assistant", timestampMs: 8, snippet: "needle in memory" },
  ])
  assert.deepEqual(fixture.indexedRequests, [{ query: "needle", limit: 5 }])
})

test("linear fallback reads the active transcript from memory and stored transcripts for the rest", async () => {
  setTranscript([entry("active-row", "needle active", 0)] as never)
  const fixture = searchWorld({
    searchReady: false,
    activeAgentId: "active",
    agents: [{ id: "archived", updatedAt: 50 }, { id: "active", updatedAt: 200 }],
    entriesByAgent: { archived: [entry("archived-row", "needle archived", 40)] },
  })

  assert.deepEqual(await fixture.search.searchAgents("needle"), [
    { agentId: "active", entryId: "active-row", role: "assistant", timestampMs: 200, snippet: "needle active" },
    { agentId: "archived", entryId: "archived-row", role: "assistant", timestampMs: 40, snippet: "needle archived" },
  ])
  assert.deepEqual(fixture.indexedRequests, [])
  assert.deepEqual(fixture.linearReads, ["list:active", "archived"])
})

test("an index miss falls back, and an empty query does no search work", async () => {
  const fixture = searchWorld({
    indexed: null,
    activeAgentId: null,
    agents: [{ id: "agent-a", updatedAt: 20 }],
    entriesByAgent: { "agent-a": [entry("match", "needled", 15)] },
  })

  assert.deepEqual(await fixture.search.searchAgents("needle"), [
    { agentId: "agent-a", entryId: "match", role: "assistant", timestampMs: 15, snippet: "needled" },
  ])
  assert.deepEqual(await fixture.search.searchAgents("   "), [])
  assert.deepEqual(fixture.indexedRequests, [{ query: "needle", limit: 12 }])
  assert.deepEqual(fixture.linearReads, ["list:", "agent-a"])
})

test("media search trims its query and excludes agents that no longer exist", async () => {
  const fixture = searchWorld({
    existingAgentIds: ["agent-a"],
    media: [{ agentId: "agent-a", id: "media-1" }, { agentId: "gone", id: "media-2" }],
  })

  assert.deepEqual(await fixture.search.searchMedia("  vacation photo  ", 4), [{ agentId: "agent-a", id: "media-1" }])
  assert.deepEqual(fixture.mediaRequests, [{ query: "vacation photo", limit: 4 }])

  const unavailable = searchWorld({ searchReady: false })
  assert.deepEqual(await unavailable.search.searchMedia("photo"), [])
  assert.deepEqual(unavailable.mediaRequests, [])
})
