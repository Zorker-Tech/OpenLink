import assert from "node:assert/strict"
import { test } from "node:test"

import { createContentSearchExtensionApi } from "../../source/host/extensions/content-search/content-search-extension-api.ts"
import { bindContentSearchGateLifecycle } from "../../source/host/extensions/content-search/content-search-gate-lifecycle.ts"
import {
  AGENT_CONTENT_SEARCH_MAX_MATCHES_PER_AGENT,
  AGENT_CONTENT_SEARCH_MAX_RESULTS,
  findAgentContentMatches,
} from "../../source/host/extensions/content-search/agent-content-search.ts"

test("the search index subscribes only while its gate is enabled and stops with the host", async () => {
  let enabled = false
  let indexStarts = 0
  let indexDisposals = 0
  const applied: unknown[] = []
  const gateListeners = new Set<(value: boolean) => void>()
  const stops: Array<() => void | Promise<void>> = []
  let mutationListener: ((mutation: { readonly transcriptId: string }) => void) | undefined
  let mutationSubscriptions = 0
  let mutationUnsubscriptions = 0

  bindContentSearchGateLifecycle({
    gate: {
      get: () => enabled,
      subscribe(listener) {
        gateListeners.add(listener)
        return () => gateListeners.delete(listener)
      },
    },
    index: {
      start() { indexStarts += 1 },
      async dispose() { indexDisposals += 1 },
      applyMutation(mutation) { applied.push(mutation) },
    },
    subscribeMutations(listener) {
      mutationSubscriptions += 1
      mutationListener = listener
      return () => {
        mutationUnsubscriptions += 1
        mutationListener = undefined
      }
    },
    onStop: teardown => stops.push(teardown),
  })

  assert.equal(indexStarts, 0)
  assert.equal(mutationSubscriptions, 0)

  const setGate = (value: boolean) => {
    enabled = value
    for (const listener of gateListeners) listener(value)
  }
  setGate(true)
  setGate(true)
  assert.equal(indexStarts, 2)
  assert.equal(mutationSubscriptions, 1)
  mutationListener?.({ transcriptId: "transcript-1" })
  assert.deepEqual(applied, [{ transcriptId: "transcript-1" }])

  setGate(false)
  assert.equal(mutationUnsubscriptions, 1)
  assert.equal(mutationListener, undefined)
  setGate(true)
  assert.equal(mutationSubscriptions, 2)
  assert.equal(indexStarts, 3)

  for (const stop of [...stops].reverse()) await stop()
  assert.equal(gateListeners.size, 0)
  assert.equal(mutationUnsubscriptions, 2)
  assert.equal(indexDisposals, 1)
})

test("the extension API keeps gate status, search bounds and service projections together", () => {
  const calls: unknown[] = []
  const api = createContentSearchExtensionApi({
    get isSearchReady() { return true },
    searchMessages(query: string, limit: number) { calls.push(["messages", query, limit]); return "messages" },
    searchMedia(query: string, limit: number) { calls.push(["media", query, limit]); return "media" },
  } as never, () => true)

  assert.equal(api.isEnabled(), true)
  assert.equal(api.isSearchReady, true)
  assert.equal(api.maxMatchesPerAgent, AGENT_CONTENT_SEARCH_MAX_MATCHES_PER_AGENT)
  assert.equal(api.maxResults, AGENT_CONTENT_SEARCH_MAX_RESULTS)
  assert.equal(api.searchMessages({ query: "notes", limit: 6 }), "messages")
  assert.equal(api.searchMedia({ query: "diagram", limit: 3 }), "media")
  assert.equal(api.findTranscriptMatches, findAgentContentMatches)
  assert.deepEqual(calls, [["messages", "notes", 6], ["media", "diagram", 3]])
})
