import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import {
  ensureAgentProfileDocument,
  ensureAgentSettingsDocument,
  memoizeConversationBlobs,
  sameRecoveredTranscriptEntry,
} from "../../source/host/extensions/session/session-recovery.ts"

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "slate-recovery-contract-"))
}

test("recovered transcript comparison checks only the fields visible for each entry kind", () => {
  assert.equal(sameRecoveredTranscriptEntry(
    { id: "stored", kind: "message", role: "user", content: "hello", timestamp: 1 },
    { id: "rebuilt", kind: "message", role: "user", content: "hello", timestamp: 2 },
  ), true)
  assert.equal(sameRecoveredTranscriptEntry(
    { kind: "message", role: "user", content: "hello" },
    { kind: "message", role: "assistant", content: "hello" },
  ), false)
  assert.equal(sameRecoveredTranscriptEntry(
    { kind: "send-message", message: { text: "sent", options: { notify: true } } },
    { kind: "send-message", message: { options: { notify: true }, text: "sent" } },
  ), true)
  assert.equal(sameRecoveredTranscriptEntry(
    { kind: "tool-call", name: "Search", status: "done", summary: "one" },
    { kind: "tool-call", name: "Search", status: "done", summary: "two" },
  ), false)
  assert.equal(sameRecoveredTranscriptEntry({ kind: "unknown" }, { kind: "unknown" }), false)
})

test("conversation blob reads coalesce equal byte ids and forward flush without dropping the cache", async () => {
  let resolveRead!: (value: { body: string } | null) => void
  let reads = 0
  let flushes = 0
  const readResult = new Promise<{ body: string } | null>((resolve) => { resolveRead = resolve })
  const cached = memoizeConversationBlobs<{ body: string }>({
    getBlob: async () => { reads += 1; return await readResult },
    async setBlob() {},
    async flush() { flushes += 1 },
  })

  const first = cached.getBlob({}, new Uint8Array([5, 10]))
  const second = cached.getBlob({}, new Uint8Array([5, 10]))
  assert.equal(first, second)
  assert.equal(reads, 1)
  resolveRead({ body: "snapshot" })
  assert.deepEqual(await second, { body: "snapshot" })
  await cached.flush({})
  assert.equal(flushes, 1)
  assert.deepEqual(await cached.getBlob({}, new Uint8Array([5, 10])), { body: "snapshot" })
  assert.equal(reads, 1)
})

test("a blob write becomes readable immediately, keyed by the written bytes", async () => {
  let finishWrite!: () => void
  const pendingWrite = new Promise<void>((resolve) => { finishWrite = resolve })
  const cached = memoizeConversationBlobs<{ body: string }>({
    async getBlob() { throw new Error("a cached write should bypass storage") },
    setBlob: async () => await pendingWrite,
    async flush() {},
  })
  const value = { body: "new snapshot" }
  const writing = cached.setBlob({}, new Uint8Array([1, 2]), value)

  assert.deepEqual(await cached.getBlob({}, new Uint8Array([1, 2])), value)
  finishWrite()
  await writing
})

test("recovery creates missing profile and settings files without replacing existing settings", () => {
  const root = temporaryDirectory()
  try {
    const dbPath = join(root, "agent.db")
    const profilePath = ensureAgentProfileDocument(dbPath, {
      get: (key) => key === "name" ? "  Ada  " : undefined,
      getSlateProfile: () => ({ description: "  a careful helper  " }),
    })
    assert.equal(profilePath, join(root, "profile.json"))
    assert.deepEqual(JSON.parse(readFileSync(profilePath, "utf8")), {
      name: "Ada",
      description: "a careful helper",
      title: "",
      avatarShape: "",
      avatarColor: "",
    })

    const settingsPath = ensureAgentSettingsDocument(dbPath)
    const initialSettings = readFileSync(settingsPath, "utf8")
    assert.deepEqual(JSON.parse(initialSettings), {})
    mkdirSync(root, { recursive: true })
    writeFileSync(settingsPath, "{\"hiddenFromSidebar\":true}", "utf8")
    assert.equal(ensureAgentSettingsDocument(dbPath), settingsPath)
    assert.equal(readFileSync(settingsPath, "utf8"), "{\"hiddenFromSidebar\":true}")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("an existing profile is returned without consulting recovered database fields", () => {
  const root = temporaryDirectory()
  try {
    const profilePath = join(root, "profile.json")
    writeFileSync(profilePath, "existing", "utf8")
    assert.equal(ensureAgentProfileDocument(join(root, "agent.db"), {
      get() { throw new Error("existing profile should be kept") },
    }), profilePath)
    assert.equal(readFileSync(profilePath, "utf8"), "existing")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
