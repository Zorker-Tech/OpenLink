import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"

import { SLATE_UPGRADE_RESUME_FILE_NAME } from "../../source/host/durable-file-policy.ts"
import {
  coerceUpgradeResumeMarker,
  parseUpgradeResumeFile,
  SlateUpgradeResumeStore,
  upsertResumeMarker,
  type UpgradeResumeMarker,
} from "../../source/host/transcript/slate-upgrade-resume-store.ts"

const roots: string[] = []
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })
const freshRoot = () => { const root = mkdtempSync(join(tmpdir(), "slate-upgrade-resume-")); roots.push(root); return root }
const marker = (agentId: string, markedAtMs: number, source?: string): UpgradeResumeMarker => ({
  agentId,
  markedAtMs,
  ...(source === undefined ? {} : { source }),
})

test("resume markers accept valid identity, coerce timestamps and omit malformed optional fields", () => {
  assert.deepEqual(coerceUpgradeResumeMarker({
    agentId: "agent-a",
    markedAtMs: "bad",
    source: 7,
    automationId: "routine-1",
    automationRunId: null,
  }), {
    agentId: "agent-a",
    markedAtMs: 0,
    automationId: "routine-1",
  })
  assert.equal(coerceUpgradeResumeMarker({ agentId: "", markedAtMs: 1 }), null)
  assert.equal(coerceUpgradeResumeMarker(null), null)

  assert.deepEqual(parseUpgradeResumeFile(JSON.stringify({ pending: [
    marker("agent-a", 12, "upgrade"),
    { agentId: "bad", markedAtMs: Number.NaN },
    7,
  ] })), [marker("agent-a", 12, "upgrade"), marker("bad", 0)])
  assert.deepEqual(parseUpgradeResumeFile("not-json"), [])
  assert.deepEqual(parseUpgradeResumeFile(JSON.stringify({ pending: "wrong-shape" })), [])
})

test("upserting a marker replaces its agent entry and appends the latest state", () => {
  const current = [marker("agent-a", 1), marker("agent-b", 2)]
  assert.deepEqual(upsertResumeMarker(current, marker("agent-a", 3, "recreate")), [
    marker("agent-b", 2),
    marker("agent-a", 3, "recreate"),
  ])
})

test("the store writes a snapshot, keeps one marker per agent and clears the file when empty", () => {
  const root = freshRoot()
  const store = new SlateUpgradeResumeStore(root)
  const first = marker("agent-a", 1, "upgrade")
  const second = marker("agent-b", 2, "recreate")

  assert.equal(store.filePath, join(root, SLATE_UPGRADE_RESUME_FILE_NAME))
  store.markPending(first)
  store.markPending(second)
  store.markPending(marker("agent-a", 3, "retry"))
  assert.deepEqual(store.listPending(), [second, marker("agent-a", 3, "retry")])
  assert.deepEqual(JSON.parse(readFileSync(store.filePath, "utf8")), {
    version: 1,
    pending: [second, marker("agent-a", 3, "retry")],
  })
  assert.equal(existsSync(`${store.filePath}.part`), false)

  store.clear("agent-b")
  assert.deepEqual(store.listPending(), [marker("agent-a", 3, "retry")])
  store.clear("agent-a")
  assert.equal(existsSync(store.filePath), false)
  store.clearAll()
  assert.deepEqual(store.listPending(), [])
})
