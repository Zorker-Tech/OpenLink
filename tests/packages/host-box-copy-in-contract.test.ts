import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { runBoxCopyIn, type CopyInResult } from "../../source/host/boxes/box-store-sync/box-copy-in.ts"
import { copyInFailureResult } from "../../source/host/boxes/box-store-sync/copy-in-contracts.ts"

const storeDb = (agentId: string) => `home/box/slate-data/agents/${agentId}/store.db`
const storeDbManifest = (...agentIds: string[]) => new Map(agentIds.map(agentId => [storeDb(agentId), {}]))

function syncFor(input: {
  readonly manifest: Map<string, Record<string, unknown>>
  readonly present?: boolean
  readonly fullyHydrated?: boolean
  readonly download?: () => Promise<{ manifestEntries: number; files: number; bytes: number; verified: number; failures: string[] }>
}) {
  return {
    async readManifestStrictDetailed() {
      return { present: input.present ?? true, manifest: input.manifest, fullyHydrated: input.fullyHydrated }
    },
    async readManifestStrict() { return input.manifest },
    async download() {
      return input.download?.() ?? { manifestEntries: 0, files: 0, bytes: 0, verified: 0, failures: [] }
    },
  }
}

function resultShape(value: CopyInResult) {
  return { outcome: value.outcome, message: value.message, indexedEntries: value.indexedEntries, restoredFiles: value.restoredFiles }
}

test("failure results keep one consistent zeroed shape and copy their failure list", () => {
  const failures = ["download failed"]
  const result = copyInFailureResult({ message: "download failed", indexedEntries: 4, storeDatabases: 2, issues: failures })

  assert.deepEqual(result, {
    outcome: "failed",
    message: "download failed",
    indexedEntries: 4,
    storeDatabases: 2,
    restoredFiles: 0,
    restoredBytes: 0,
    verifiedFiles: 0,
    issues: ["download failed"],
  })
  assert.notEqual(result.issues, failures)
})

test("an unreadable primary manifest fails closed before any download", async () => {
  let downloads = 0
  const sync = syncFor({ manifest: new Map() })
  const result = await runBoxCopyIn({
    sync: {
      ...sync,
      async readManifestStrictDetailed() { throw new Error("manifest unavailable") },
      async download() { downloads += 1; return { manifestEntries: 0, files: 0, bytes: 0, verified: 0, failures: [] } },
    } as never,
    targetDir: "/unused",
  })

  assert.equal(result.outcome, "failed")
  assert.match(result.message, /store manifest unreadable/)
  assert.equal(downloads, 0)
})

test("an empty store is a no-op, while an empty legacy source cannot mask an incomplete primary", async () => {
  const emptyStore = await runBoxCopyIn({ sync: syncFor({ manifest: new Map() }) as never, targetDir: "/unused" })
  assert.equal(emptyStore.outcome, "noop")

  const primary = syncFor({ manifest: storeDbManifest("a1"), fullyHydrated: false })
  const legacy = syncFor({ manifest: new Map() })
  const incomplete = await runBoxCopyIn({ sync: primary as never, legacySync: legacy as never, targetDir: "/unused" })

  assert.equal(incomplete.outcome, "failed")
  assert.match(incomplete.message, /legacy source's manifest is empty/)
})

test("an incomplete new manifest is rejected when legacy store.db coverage would be lost", async () => {
  let downloads = 0
  const primary = syncFor({ manifest: storeDbManifest("a1"), fullyHydrated: false })
  const legacy = syncFor({ manifest: storeDbManifest("a1", "a2") })
  const result = await runBoxCopyIn({
    sync: { ...primary, async download() { downloads += 1; return { manifestEntries: 1, files: 1, bytes: 1, verified: 1, failures: [] } } } as never,
    legacySync: legacy as never,
    targetDir: "/unused",
  })

  assert.equal(result.outcome, "failed")
  assert.match(result.message, /coverage is below the legacy source/)
  assert.equal(downloads, 0)
})

test("legacy hydration marks the handoff incomplete before writing and complete only after a full restore", async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-copy-in-contract-"))
  const targetDir = join(root, "target")
  const events: string[] = []
  const path = storeDb("a1")
  const manifest = storeDbManifest("a1")
  const primary = {
    ...syncFor({ manifest: new Map(), present: false }),
    async markLegacyHydrationIncomplete() { events.push("marked-incomplete") },
    async markLegacyHydrationCompleteForHandoff() { events.push("marked-complete") },
  }
  const legacy = syncFor({
    manifest,
    async download() {
      events.push("downloaded")
      const destination = join(targetDir, path)
      mkdirSync(join(destination, ".."), { recursive: true })
      writeFileSync(destination, "store")
      return { manifestEntries: 1, files: 1, bytes: 5, verified: 1, failures: [] }
    },
  })

  try {
    const result = await runBoxCopyIn({ sync: primary as never, legacySync: legacy as never, targetDir })
    assert.deepEqual(resultShape(result), {
      outcome: "hydrated",
      message: "the store was hydrated from the legacy store",
      indexedEntries: 1,
      restoredFiles: 1,
    })
    assert.deepEqual(events, ["marked-incomplete", "downloaded", "marked-complete"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
