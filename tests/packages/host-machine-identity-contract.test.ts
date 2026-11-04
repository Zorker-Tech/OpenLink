import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"

import {
  clearHostMachineIdCacheForTests,
  getOrCreateHostMachineId,
  readMachineId,
  writeMachineId,
} from "../../source/host/host-secret-store.ts"

test("reading a machine identity accepts only a nonempty string field", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "slate-machine-id-read-"))
  const filePath = path.join(root, "machine.json")
  try {
    await writeFile(filePath, JSON.stringify({ machineId: "host-a" }))
    assert.equal(await readMachineId(filePath), "host-a")
    for (const value of [null, [], "text", {}, { machineId: "" }, { machineId: 7 }]) {
      await writeFile(filePath, JSON.stringify(value))
      assert.equal(await readMachineId(filePath), null)
    }
    await writeFile(filePath, "not json")
    assert.equal(await readMachineId(filePath), null)
    assert.equal(await readMachineId(path.join(root, "missing.json")), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("writing creates parent directories and leaves only the final JSON file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "slate-machine-id-write-"))
  try {
    const filePath = path.join(root, "nested", "machine.json")
    await writeMachineId(filePath, "host-b")
    assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), { machineId: "host-b" })
    assert.deepEqual(await readdir(path.dirname(filePath)), ["machine.json"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("the process reuses its cached identity and persists a newly minted one", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "slate-machine-id-cache-"))
  const firstPath = path.join(root, "first", "machine.json")
  const secondPath = path.join(root, "second", "machine.json")
  try {
    clearHostMachineIdCacheForTests()
    const created = await getOrCreateHostMachineId(firstPath)
    assert.match(created, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    assert.equal(await readMachineId(firstPath), created)
    assert.equal(await getOrCreateHostMachineId(secondPath), created)
    assert.equal(await readMachineId(secondPath), null)
  } finally {
    clearHostMachineIdCacheForTests()
    await rm(root, { recursive: true, force: true })
  }
})
