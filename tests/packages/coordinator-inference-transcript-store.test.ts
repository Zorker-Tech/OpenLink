import assert from "node:assert/strict"
import { after, test } from "node:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { SlateSettingsStore } from "../../source/shared/node/settings/slate-settings-store.ts"
import { createCoordinatorInferenceRouter } from "../../source/coordinator/inference-router.ts"
import {
  InferenceTranscriptStore,
  nextInferenceRouterTurn,
  type StoredEntry,
} from "../../source/coordinator/inference-transcript-store.ts"

const temporaryDirectories: string[] = []

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true })
})

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "slate-inference-transcript-"))
  temporaryDirectories.push(directory)
  return directory
}

function storedEntry(id: string, overrides: Partial<StoredEntry> = {}): StoredEntry {
  return {
    provider: "codex",
    role: "user",
    content: id,
    id,
    timestampMs: 1,
    ...overrides,
  }
}

test("concurrent transcript writes preserve entries for different agents", async () => {
  const store = new InferenceTranscriptStore(temporaryDirectory())

  await Promise.all([
    store.append("agent-a", [storedEntry("t0u")]),
    store.append("agent-b", [storedEntry("t0u")]),
  ])

  const saved = await store.load()
  assert.deepEqual(Object.keys(saved.agents).sort(), ["agent-a", "agent-b"])
  assert.equal(saved.agents["agent-a"]?.[0]?.content, "t0u")
  assert.equal(saved.agents["agent-b"]?.[0]?.content, "t0u")
})

test("concurrent toggles settle in order instead of losing a reaction", async () => {
  const store = new InferenceTranscriptStore(temporaryDirectory())
  await store.append("agent-a", [storedEntry("t0u")])

  await Promise.all([
    store.toggleReaction("agent-a", "t0u", "thumbs-up"),
    store.toggleReaction("agent-a", "t0u", "thumbs-up"),
  ])

  assert.equal("reactions" in (await store.load()).agents["agent-a"]![0]!, false)
})

test("router turn numbering ignores unrelated ids and follows the newest known turn", () => {
  assert.equal(
    nextInferenceRouterTurn(
      [{ id: "t3u" }, { id: "malformed" }, { id: "t5s0" }],
      [storedEntry("t4u")],
    ),
    6,
  )
  assert.equal(nextInferenceRouterTurn([], []), 0)
})

test("a provider failure closes the turn id instead of jumping the next turn", async () => {
  const dataDir = temporaryDirectory()
  new SlateSettingsStore(join(dataDir, "settings.json")).setInferenceProvider("codex")
  const router = createCoordinatorInferenceRouter({
    dataDir,
    now: () => 10,
    postEvent() {},
    async dispatchRemote(method) {
      if (method === "getAgentTranscriptTail") return { entries: [] }
      if (method === "listAgents") return [{ id: "agent-a" }]
      if (method === "listRoutedMcpTools") return []
      throw new Error(`unexpected remote method: ${method}`)
    },
    async runText() {
      throw new Error("provider unavailable")
    },
  })

  await router.dispatch("sendPrompt", { agentId: "agent-a", prompt: "first" })
  await waitFor(() => readEntries(dataDir).length === 2)
  await router.dispatch("sendPrompt", { agentId: "agent-a", prompt: "second" })
  await waitFor(() => readEntries(dataDir).length === 4)

  assert.deepEqual(readEntries(dataDir).map(entry => entry.id), ["t0u", "t0s0", "t1u", "t1s0"])
  assert.equal(readEntries(dataDir)[1]?.content, "Router error: provider unavailable")
})

function readEntries(dataDir: string): StoredEntry[] {
  const path = join(dataDir, "inference-router-transcript.json")
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { agents?: Record<string, StoredEntry[]> }
    return value.agents?.["agent-a"] ?? []
  } catch {
    return []
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("the transcript did not reach its expected state")
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
