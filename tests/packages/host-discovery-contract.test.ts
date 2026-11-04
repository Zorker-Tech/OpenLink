import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"

import {
  clearGatewayDiscovery,
  isGatewayDiscoveryInfo,
  writeGatewayDiscovery,
} from "../../source/host/host-discovery.ts"

const validRecord = {
  port: 43123,
  pid: 101,
  startedAt: Date.now(),
  scheme: "https",
  host: "127.0.0.1",
  token: "opaque",
} as const

test("discovery records require positive integer identifiers and supported optional fields", () => {
  assert.equal(isGatewayDiscoveryInfo(validRecord), true)
  assert.equal(isGatewayDiscoveryInfo({ ...validRecord, scheme: undefined, host: "", token: "" }), true)
  assert.equal(isGatewayDiscoveryInfo({ ...validRecord, port: 0 }), false)
  assert.equal(isGatewayDiscoveryInfo({ ...validRecord, pid: 1.5 }), false)
  assert.equal(isGatewayDiscoveryInfo({ ...validRecord, startedAt: "now" }), false)
  assert.equal(isGatewayDiscoveryInfo({ ...validRecord, scheme: "ftp" }), false)
  assert.equal(isGatewayDiscoveryInfo({ ...validRecord, host: 1 }), false)
  assert.equal(isGatewayDiscoveryInfo({ ...validRecord, token: null }), false)
  assert.equal(isGatewayDiscoveryInfo(null), false)
  assert.equal(isGatewayDiscoveryInfo([]), false)
})

test("writing creates parent directories and atomically replaces the discovery record", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "slate-discovery-"))
  try {
    const recordPath = path.join(root, "nested", "gateway.json")
    await writeGatewayDiscovery(validRecord, recordPath)

    assert.deepEqual(JSON.parse(await readFile(recordPath, "utf8")), validRecord)
    assert.match(await readFile(recordPath, "utf8"), /\n  "port": 43123,/)
    assert.deepEqual(await readdir(path.dirname(recordPath)), ["gateway.json"])
    assert.equal((await stat(path.dirname(recordPath))).isDirectory(), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("invalid data is refused before any file is created", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "slate-discovery-invalid-"))
  try {
    const recordPath = path.join(root, "gateway.json")
    await assert.rejects(writeGatewayDiscovery({ ...validRecord, port: 0 }, recordPath), /invalid gateway discovery info/)
    assert.deepEqual(await readdir(root), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("clearing discovery is safe when the record has already gone", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "slate-discovery-clear-"))
  try {
    const recordPath = path.join(root, "gateway.json")
    await writeGatewayDiscovery(validRecord, recordPath)
    await clearGatewayDiscovery(recordPath)
    await clearGatewayDiscovery(recordPath)
    assert.deepEqual(await readdir(root), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
