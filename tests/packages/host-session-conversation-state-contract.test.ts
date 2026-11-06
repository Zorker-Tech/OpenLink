import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { SlateSessionConversationState } from "../../source/host/extensions/session/session-conversation-state.ts"
import { createEmptySlateConversationCheckpointV2 } from "../../source/packages/agent/conversation-checkpoint-state.ts"
import type { SlateHydratedConversation } from "../../source/packages/agent/conversation-transcript-state.ts"

function hydratedConversation(turnCount: number): SlateHydratedConversation {
  return {
    turns: Array.from({ length: turnCount }, (_, index) => ({
      kind: "agent" as const,
      userMessage: {
        text: `turn-${index}`,
        messageId: `message-${index}`,
        mode: "unspecified" as const,
        conversationStateBlobId: new Uint8Array(),
        hookContexts: [],
      },
      steps: [],
    })),
    todos: [],
  }
}

function hostShape(overrides: Record<string, unknown> = {}) {
  return {
    rootDir: "/unused",
    ctx: { request: "context" },
    openSession: async () => { throw new Error("not expected") },
    deriveOutline: (conversation: unknown) => ({ source: conversation }),
    deriveState: async () => hydratedConversation(1),
    ...overrides,
  }
}

test("state materialization refuses unresolved or incomplete turns and returns a complete projection", async () => {
  const id = Uint8Array.from([1, 2, 3])
  const structure = {
    ...createEmptySlateConversationCheckpointV2(),
    turnBlobIds: ["010203"],
    todoBlobIds: ["010203"],
  }
  let reads = 0
  let derived = 0
  const expected = hydratedConversation(1)
  const blobStore = {
    getBlob: async (_ctx: unknown, requested: Uint8Array) => {
      reads += 1
      return Buffer.from(requested).equals(Buffer.from(id)) ? Uint8Array.from([9]) : null
    },
    setBlob: async () => {},
    flush: async () => {},
  }
  const service = new SlateSessionConversationState(hostShape({
    deriveState: async (_structure: unknown, store: typeof blobStore) => {
      derived += 1
      assert.deepEqual(await store.getBlob({ request: "context" }, id), Uint8Array.from([9]))
      return expected
    },
  }))

  assert.deepEqual(await service.resolveConversationState(structure, blobStore), expected)
  assert.equal(reads, 1, "repeated references share the session blob-read cache")
  assert.equal(derived, 1)

  const missing = new SlateSessionConversationState(hostShape({ deriveState: async () => { derived += 1; return hydratedConversation(0) } }))
  assert.equal(await missing.resolveConversationState(structure, { ...blobStore, getBlob: async () => null }), null)
  assert.equal(await service.resolveConversationState(createEmptySlateConversationCheckpointV2(), blobStore), null)
})

test("session views forward transcript and outline data, then close both handles", async () => {
  const transcript = [{ id: "entry-1", kind: "message" }]
  const conversation = hydratedConversation(1)
  const operations: string[] = []
  const session = {
    db: { getTranscriptEntries: () => transcript, close: () => operations.push("close-db") },
    agentStore: {
      getFullConversation: async (ctx: unknown) => { operations.push(`read:${(ctx as { request: string }).request}`); return conversation },
      dispose: async () => { operations.push("dispose-store") },
    },
  }
  const service = new SlateSessionConversationState(hostShape({
    openSession: async (id: string) => { operations.push(`open:${id}`); return session },
    deriveOutline: (conversation: unknown) => ({ outlined: conversation }),
  }))

  assert.equal(await service.getTranscriptEntries(session), transcript)
  assert.deepEqual(await service.getSessionOutline(session), { outlined: conversation })
  assert.deepEqual(await service.getAgentOutline("agent-a"), { outlined: conversation })
  assert.equal(await service.getAgentTranscriptEntries("agent-b"), transcript)
  assert.deepEqual(operations, [
    "read:context",
    "open:agent-a", "read:context", "dispose-store", "close-db",
    "open:agent-b", "dispose-store", "close-db",
  ])
})

test("opened session resources are closed even when an outline read fails", async () => {
  const operations: string[] = []
  const service = new SlateSessionConversationState(hostShape({
    openSession: async () => ({
      db: { getTranscriptEntries: () => [], close: () => operations.push("db-closed") },
      agentStore: { getFullConversation: async () => { throw new Error("state unavailable") }, dispose: async () => { operations.push("store-disposed") } },
    }),
  }))

  await assert.rejects(service.getAgentOutline("agent-a"), /state unavailable/)
  assert.deepEqual(operations, ["store-disposed", "db-closed"])
})

test("database projections preserve their empty fallbacks for an invalid agent path", () => {
  const service = new SlateSessionConversationState(hostShape())
  assert.deepEqual(service.readAgentTranscriptEntries("../outside"), [])
  assert.deepEqual(service.readAgentTranscriptPage("../outside", { untilMs: 10, limit: 5 }), { entries: [] })
  assert.deepEqual(service.readAgentTranscriptWindow("../outside", { limit: 5 }), { entries: [], threadCounts: {} })
  assert.deepEqual(service.readAgentTranscriptTail("../outside", { limit: 5 }), { entries: [] })
  assert.deepEqual(service.readAgentThread("../outside", "root-1"), { entries: [] })
})

test("database projections read a valid session store and dispose it after each operation", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "slate-session-conversation-state-"))
  try {
    const service = new SlateSessionConversationState(hostShape({ rootDir }))
    assert.deepEqual(service.readAgentTranscriptEntries("agent-1"), [])
    assert.deepEqual(service.readAgentTranscriptWindow("agent-1", { limit: 5 }), { entries: [], threadCounts: {} })
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
})
