import assert from "node:assert/strict"
import { test } from "node:test"

import type { MemoryEpisodeProgress, TurnMemorySession, SlateTurnMemoryStore } from "../../source/host/runner/turn-memory.ts"
import { settleCompletedTurnMemory } from "../../source/host/runner/turn-memory.ts"

test("a store that records direct evidence bypasses extraction and clears queued episode turns", async () => {
  const evidence: unknown[] = []
  let clears = 0
  const store = {
    recordMemoryEvidence: (record: unknown) => evidence.push(record),
    recall() { throw new Error("evidence recording should bypass recall") },
  } as unknown as SlateTurnMemoryStore
  const progress: MemoryEpisodeProgress = {
    clearPendingEpisodeTurns() { clears += 1 },
    recordEpisodeTurn() { throw new Error("no extraction episode should be recorded") },
    getPendingEpisodeTurns() { return [] },
  }
  const session: TurnMemorySession = { getExecutor() { throw new Error("the executor should not be opened") } }

  await settleCompletedTurnMemory(store, progress, session, {}, 123, { user: "asked", agent: "answered" })
  assert.deepEqual(evidence, [{ occurredAt: 123, user: "asked", assistant: "answered" }])
  assert.equal(clears, 1)
})

test("fallback extraction summarizes every configured turn group once and stores its latest timestamp", async () => {
  const previous = process.env["SLATE_MEMORY_EPISODE_INTERVAL"]
  process.env["SLATE_MEMORY_EPISODE_INTERVAL"] = "2"
  const outputs = ["NONE", "NONE", "A review and a release were completed."]
  const prompts: Array<readonly { role: "system" | "user"; content: string }[]> = []
  const saved: unknown[][] = []
  let pending: Array<{ ts: number; user: string; agent: string }> = []
  let clearCount = 0
  const executor = {
    appendMessages(messages: readonly { role: "system" | "user"; content: string }[]) { prompts.push(messages) },
    clearMessages() {},
    getMessages: () => [],
    getState: () => ({}),
    stream: () => ({ fullStream: (async function* () { yield { type: "text-delta", textDelta: outputs.shift() ?? "" } })() }),
  }
  const store: SlateTurnMemoryStore = {
    recall: () => ({ profile: [], recent: [] }),
    listMemories: () => [],
    addMemory(content, timestamp, kind) { saved.push([content, timestamp, kind]); return null },
    removeMemoryByContent: () => false,
  }
  const progress: MemoryEpisodeProgress = {
    clearPendingEpisodeTurns() { clearCount += 1; pending = [] },
    recordEpisodeTurn(turn) { pending.push(turn) },
    getPendingEpisodeTurns: () => pending,
  }
  const session: TurnMemorySession = { getExecutor: () => executor }

  try {
    await settleCompletedTurnMemory(store, progress, session, {}, 10, { user: "request one", agent: "answer one" })
    assert.equal(saved.length, 0)
    await settleCompletedTurnMemory(store, progress, session, {}, 20, { user: "request two", agent: "answer two" })
    assert.deepEqual(saved, [["[episode] A review and a release were completed.", 20, "log"]])
    assert.equal(clearCount, 1)
    assert.equal(pending.length, 0)
    assert.equal(prompts.length, 3)
  } finally {
    if (previous === undefined) delete process.env["SLATE_MEMORY_EPISODE_INTERVAL"]
    else process.env["SLATE_MEMORY_EPISODE_INTERVAL"] = previous
  }
})

test("extraction and episode failures do not escape turn settlement, and completed episode state is cleared", async () => {
  const previous = process.env["SLATE_MEMORY_EPISODE_INTERVAL"]
  process.env["SLATE_MEMORY_EPISODE_INTERVAL"] = "1"
  let recorded = 0
  let cleared = 0
  const store: SlateTurnMemoryStore = {
    recall: () => ({ profile: [], recent: [] }),
    listMemories: () => [],
    addMemory: () => null,
    removeMemoryByContent: () => false,
  }
  const progress: MemoryEpisodeProgress = {
    clearPendingEpisodeTurns() { cleared += 1 },
    recordEpisodeTurn() { recorded += 1 },
    getPendingEpisodeTurns: () => [{ ts: 10, user: "request", agent: "answer" }],
  }
  const session: TurnMemorySession = {
    getExecutor: () => ({
      appendMessages() {},
      clearMessages() {},
      getMessages: () => [],
      getState: () => ({}),
      stream: () => ({ fullStream: (async function* () { throw new Error("provider down") })() }),
    }),
  }

  try {
    await assert.doesNotReject(settleCompletedTurnMemory(store, progress, session, {}, 10, { user: "request", agent: "answer" }))
    assert.equal(recorded, 1)
    assert.equal(cleared, 1)
  } finally {
    if (previous === undefined) delete process.env["SLATE_MEMORY_EPISODE_INTERVAL"]
    else process.env["SLATE_MEMORY_EPISODE_INTERVAL"] = previous
  }
})
