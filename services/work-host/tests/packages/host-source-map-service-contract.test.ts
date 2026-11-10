import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, test } from "node:test"

import {
  BOX_STORE_SOURCE_KEY,
  SlateSourceMap,
} from "../../source/host/extensions/source-map/source-map-service.ts"

const roots: string[] = []
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })
const freshFile = () => {
  const root = mkdtempSync(join(tmpdir(), "slate-source-map-"))
  roots.push(root)
  return join(root, "nested", "source-map.json")
}

test("source mappings are created once, persisted atomically and kept separate by agent", async () => {
  let nextId = 0
  const filePath = freshFile()
  const sourceMap = new SlateSourceMap(filePath, () => `source-${++nextId}`)

  assert.equal(await sourceMap.getBoxStore(), null)
  const agent = await sourceMap.getOrCreate("agent-a")
  const repeated = await sourceMap.getOrCreate("agent-a")
  const boxStore = await sourceMap.getOrCreateBoxStore()

  assert.deepEqual(agent, { sourceId: "source-1", mode: "local" })
  assert.equal(repeated, agent)
  assert.equal(boxStore.sourceId, "source-2")
  assert.equal(boxStore.mode, "local")
  assert.deepEqual(JSON.parse(readFileSync(filePath, "utf8")), {
    "agent-a": agent,
    [BOX_STORE_SOURCE_KEY]: boxStore,
  })
  assert.equal(existsSync(`${filePath}.${process.pid}.tmp`), false)
})

test("changing a source mode keeps its id and creates an id only for a new key", async () => {
  let nextId = 0
  const sourceMap = new SlateSourceMap(freshFile(), () => `source-${++nextId}`)
  const original = await sourceMap.getOrCreate("agent-a")

  assert.deepEqual(await sourceMap.setMode("agent-a", "agent-store"), {
    sourceId: original.sourceId,
    mode: "agent-store",
  })
  assert.deepEqual(await sourceMap.setMode("agent-b", "agent-store"), {
    sourceId: "source-2",
    mode: "agent-store",
  })
  assert.equal((await sourceMap.getOrCreate("agent-a")).sourceId, original.sourceId)
})

test("malformed rows are discarded while valid mappings survive a later write", async () => {
  let nextId = 0
  const filePath = freshFile()
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify({
    valid: { sourceId: "known-source", mode: "agent-store" },
    emptyId: { sourceId: "", mode: "local" },
    invalidMode: { sourceId: "bad-source", mode: "remote" },
    notRecord: "bad",
  }))
  const sourceMap = new SlateSourceMap(filePath, () => `generated-${++nextId}`)

  assert.deepEqual(await sourceMap.getOrCreate("valid"), { sourceId: "known-source", mode: "agent-store" })
  assert.deepEqual(await sourceMap.getOrCreate("emptyId"), { sourceId: "generated-1", mode: "local" })
  const persisted = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>
  assert.deepEqual(Object.keys(persisted).sort(), ["emptyId", "valid"])
})

test("object prototype names are ordinary source-map keys", async () => {
  let nextId = 0
  const sourceMap = new SlateSourceMap(freshFile(), () => `generated-${++nextId}`)

  assert.deepEqual(await sourceMap.getOrCreate("toString"), {
    sourceId: "generated-1",
    mode: "local",
  })
})
