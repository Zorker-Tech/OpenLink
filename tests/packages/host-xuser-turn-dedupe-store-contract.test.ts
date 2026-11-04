import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"

import { createInMemoryXuserTurnDedupe, parseDedupeFile, SlateXuserTurnDedupeStore } from "../../source/host/rooms/xuser-turn-dedupe-store.ts"

const temporaryRoots: string[] = []
after(() => { for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true }) })

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "slate-turn-dedupe-"))
  temporaryRoots.push(root)
  return root
}

test("the file reader ignores malformed entries and keeps the last valid expiry for each nonce", () => {
  const parsed = parseDedupeFile(JSON.stringify({
    version: 99,
    seen: [
      { nonce: "one", expiresAtMs: 10 },
      { nonce: "", expiresAtMs: 20 },
      { nonce: "two", expiresAtMs: Number.NaN },
      null,
      { nonce: "one", expiresAtMs: 30 },
      { nonce: "three", expiresAtMs: Infinity },
      { nonce: "four", expiresAtMs: "40" },
    ],
  }))
  assert.deepEqual([...parsed], [["one", 30]])
  assert.deepEqual([...parseDedupeFile("not-json")], [])
  assert.deepEqual([...parseDedupeFile(null)], [])
})

test("persistent nonces expire at the boundary and successful writes leave no staging file", () => {
  const root = freshRoot()
  let now = 100
  const store = new SlateXuserTurnDedupeStore(root, 50, () => now)
  assert.equal(store.markSeenIfNew(""), false)
  assert.equal(readdirSync(root).length, 0)
  assert.equal(store.markSeenIfNew("turn-a"), true)
  assert.equal(store.markSeenIfNew("turn-a"), false)
  assert.deepEqual(JSON.parse(readFileSync(store.filePath, "utf8")), {
    version: 1,
    seen: [{ nonce: "turn-a", expiresAtMs: 150 }],
  })
  assert.deepEqual(readdirSync(root), ["host-xuser-turn-nonces.json"])

  now = 149
  assert.equal(store.markSeenIfNew("turn-a"), false)
  now = 150
  assert.equal(store.markSeenIfNew("turn-a"), true)
  assert.deepEqual(JSON.parse(readFileSync(store.filePath, "utf8")).seen, [{ nonce: "turn-a", expiresAtMs: 200 }])
})

test("each persistent instance reads once and then owns its in-memory snapshot", () => {
  const root = freshRoot()
  const store = new SlateXuserTurnDedupeStore(root, 100, () => 1)
  assert.equal(store.markSeenIfNew("turn-a"), true)

  writeFileSync(store.filePath, JSON.stringify({ version: 1, seen: [{ nonce: "external-turn", expiresAtMs: 500 }] }))
  assert.equal(store.markSeenIfNew("external-turn"), true)
  assert.deepEqual(JSON.parse(readFileSync(store.filePath, "utf8")).seen, [
    { nonce: "turn-a", expiresAtMs: 101 },
    { nonce: "external-turn", expiresAtMs: 101 },
  ])
})

test("a failed persistence keeps the accepted nonce in memory for this process", () => {
  const root = freshRoot()
  const fileInsteadOfDirectory = join(root, "not-a-directory")
  writeFileSync(fileInsteadOfDirectory, "occupied")
  const store = new SlateXuserTurnDedupeStore(fileInsteadOfDirectory, 100, () => 1)

  assert.equal(store.markSeenIfNew("turn-a"), true)
  assert.equal(store.markSeenIfNew("turn-a"), false)
})

test("the in-memory implementation follows the same expiry and empty-nonce rule", () => {
  let now = 10
  const store = createInMemoryXuserTurnDedupe(5, () => now)
  assert.equal(store.markSeenIfNew(""), false)
  assert.equal(store.markSeenIfNew("turn-b"), true)
  assert.equal(store.markSeenIfNew("turn-b"), false)
  now = 15
  assert.equal(store.markSeenIfNew("turn-b"), true)
})
