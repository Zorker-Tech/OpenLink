import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import type { DebouncePolicy } from "../../source/host/extensions/scheduling.ts"
import {
  DEFAULT_MAX_SNAPSHOT_BYTES,
  isStateBackstopEnabled,
  readStoreDbBytes,
  SlateStateBackstop,
  SLATE_STATE_BACKSTOP_REL_PATH,
  STATE_BACKSTOP_DEBOUNCE_MS,
  type StateBackstopDeps,
} from "../../source/host/extensions/state-backstop/state-backstop-service.ts"

function backstopHarness(overrides: Partial<StateBackstopDeps> = {}) {
  const logs: string[] = []
  const uploads: Array<{ sourceId: string; path: string; bytes: Uint8Array }> = []
  const downloads: string[] = []
  const sources: string[] = []
  const triggers: Array<(() => void) & { dispose(): void }> = []
  let disposedTriggers = 0
  const debounce: DebouncePolicy = {
    name: "test",
    wrap<Args extends unknown[]>(fn: (...args: Args) => void) {
      let active = true
      const wrapped = ((...args: Args) => { if (active) fn(...args) }) as ((...args: Args) => void) & { dispose(): void }
      wrapped.dispose = () => { active = false; disposedTriggers += 1 }
      triggers.push(wrapped)
      return wrapped
    },
  }
  const base: StateBackstopDeps = {
    objectStoreProvider: {
      forStore(sourceId) {
        return {
          async put(path, bytes) { uploads.push({ sourceId, path, bytes }) },
          async get(path) { downloads.push(`${sourceId}:${path}`); return Uint8Array.from([9]) },
        }
      },
    },
    sourceMap: {
      async getOrCreate(agentId) { sources.push(agentId); return { sourceId: `source:${agentId}` } },
    },
    debounce,
    agentsRootDir: "/agents",
    readDbBytes: () => Uint8Array.from([1, 2]),
    log: message => logs.push(message),
  }
  const service = new SlateStateBackstop({ ...base, ...overrides })
  return { service, logs, uploads, downloads, sources, triggers, disposedTriggers: () => disposedTriggers }
}

test("database reads checkpoint existing files and skip absent files", () => {
  const root = mkdtempSync(join(tmpdir(), "slate-backstop-read-"))
  try {
    const file = join(root, "store.db")
    const checkpoints: string[] = []
    assert.equal(readStoreDbBytes(file, path => checkpoints.push(path)), null)
    assert.equal(checkpoints.length, 0)
    writeFileSync(file, Buffer.from([1, 2, 3]))
    assert.deepEqual(readStoreDbBytes(file, path => checkpoints.push(path)), Buffer.from([1, 2, 3]))
    assert.deepEqual(checkpoints, [file])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("the feature switch accepts only the documented affirmative values", () => {
  assert.equal(isStateBackstopEnabled({} as NodeJS.ProcessEnv), false)
  for (const value of ["1", "true", " YES ", "True"]) {
    assert.equal(isStateBackstopEnabled({ SLATE_STATE_S3_BACKSTOP: value } as NodeJS.ProcessEnv), true)
  }
  for (const value of ["0", "on", "y", ""]) {
    assert.equal(isStateBackstopEnabled({ SLATE_STATE_S3_BACKSTOP: value } as NodeJS.ProcessEnv), false)
  }
  assert.equal(STATE_BACKSTOP_DEBOUNCE_MS, 5_000)
  assert.equal(DEFAULT_MAX_SNAPSHOT_BYTES, 64 * 1024 * 1024)
})

test("missing or over-limit databases are skipped before looking up the remote store", async () => {
  const missing = backstopHarness({ readDbBytes: () => null })
  assert.deepEqual(await missing.service.snapshotNow("agent-a"), { status: "skipped", reason: "no store.db" })
  assert.deepEqual(missing.sources, [])
  assert.deepEqual(missing.uploads, [])

  const oversized = backstopHarness({ maxSnapshotBytes: 1, readDbBytes: () => Uint8Array.from([1, 2]) })
  assert.deepEqual(await oversized.service.snapshotNow("agent-b"), {
    status: "skipped",
    reason: "store.db 2B over 1B cap",
  })
  assert.deepEqual(oversized.sources, [])
  assert.match(oversized.logs[0] ?? "", /skip agent-b/)
})

test("an accepted snapshot uses the agent's source and the fixed store-relative path", async () => {
  const bytes = Uint8Array.from([3, 4, 5])
  const harness = backstopHarness({ maxSnapshotBytes: bytes.length, readDbBytes: () => bytes })
  assert.deepEqual(await harness.service.snapshotNow("agent-c"), { status: "uploaded", bytes: 3 })
  assert.deepEqual(harness.sources, ["agent-c"])
  assert.deepEqual(harness.uploads, [{ sourceId: "source:agent-c", path: SLATE_STATE_BACKSTOP_REL_PATH, bytes }])
  assert.match(harness.logs[0] ?? "", /uploaded agent-c \(3B\)/)
  assert.equal(harness.service.dbPathFor("agent-c"), "/agents/agent-c/store.db")
})

test("read, mapping and upload failures are returned as error outcomes", async () => {
  const readFailure = backstopHarness({ readDbBytes: () => { throw new Error("database failed") } })
  assert.deepEqual(await readFailure.service.snapshotNow("agent-r"), { status: "error", error: "database failed" })

  const mapFailure = backstopHarness({ sourceMap: { getOrCreate: async () => { throw new Error("mapping failed") } } })
  assert.deepEqual(await mapFailure.service.snapshotNow("agent-m"), { status: "error", error: "mapping failed" })

  const uploadFailure = backstopHarness({ objectStoreProvider: { forStore: () => ({ put: async () => { throw new Error("upload failed") }, get: async () => null }) } })
  assert.deepEqual(await uploadFailure.service.snapshotNow("agent-u"), { status: "error", error: "upload failed" })
})

test("reads use the mapped store and debounced snapshots share one trigger per agent", async () => {
  const readHarness = backstopHarness()
  assert.deepEqual(await readHarness.service.readSnapshot("agent-a"), Uint8Array.from([9]))
  assert.deepEqual(readHarness.downloads, ["source:agent-a:state/store.db"])

  let releaseUpload: (() => void) | undefined
  const uploadEntered = new Promise<void>(resolve => { releaseUpload = resolve })
  const store: StateBackstopDeps["objectStoreProvider"] = {
    forStore: sourceId => ({
      put: async () => { releaseUpload?.() },
      get: async path => { return path === SLATE_STATE_BACKSTOP_REL_PATH && sourceId === "source:agent-a" ? Uint8Array.from([8]) : null },
    }),
  }
  const harness = backstopHarness({ objectStoreProvider: store })
  harness.service.scheduleSnapshot("agent-a")
  harness.service.scheduleSnapshot("agent-a")
  harness.service.scheduleSnapshot("agent-b")
  assert.equal(harness.triggers.length, 2)
  harness.triggers[0]!()
  await uploadEntered
  await harness.service.dispose()
  assert.equal(harness.disposedTriggers(), 2)
  harness.service.scheduleSnapshot("agent-a")
  assert.equal(harness.triggers.length, 2)
})
