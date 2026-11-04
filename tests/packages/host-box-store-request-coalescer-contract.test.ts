import assert from "node:assert/strict"
import { test } from "node:test"

import { createRequestCoalescer } from "../../source/host/boxes/box-store-sync/request-coalescer.ts"
import { BoxStoreSyncError } from "../../source/host/boxes/box-store-sync/box-store-sync-error.ts"

interface Request {
  readonly id: string
  readonly conflictKey?: string
}

function deferred<Value>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>(done => { resolve = done })
  return { promise, resolve }
}

test("requests that arrive during a drain are batched within the size limit and retain result order", async () => {
  const first = deferred<string[]>()
  const batches: string[][] = []
  let runCount = 0
  const execute = createRequestCoalescer<Request, string>({
    maxBatchSize: 2,
    async run(requests) {
      batches.push(requests.map(request => request.id))
      if (runCount++ === 0) return await first.promise
      return requests.map(request => request.id.toUpperCase())
    },
  })

  const a = execute({ id: "a" })
  const b = execute({ id: "b" })
  const c = execute({ id: "c" })
  first.resolve(["A"])

  assert.deepEqual(await Promise.all([a, b, c]), ["A", "B", "C"])
  assert.deepEqual(batches, [["a"], ["b", "c"]])
})

test("duplicate conflict keys wait for a later batch instead of sharing one write", async () => {
  const first = deferred<string[]>()
  const batches: string[][] = []
  let runCount = 0
  const execute = createRequestCoalescer<Request, string>({
    maxBatchSize: 3,
    conflictKey: request => request.conflictKey,
    async run(requests) {
      batches.push(requests.map(request => request.id))
      if (runCount++ === 0) return await first.promise
      return requests.map(request => request.id.toUpperCase())
    },
  })

  const initial = execute({ id: "initial", conflictKey: "same-file" })
  const firstWrite = execute({ id: "first-write", conflictKey: "same-file" })
  const duplicateWrite = execute({ id: "duplicate-write", conflictKey: "same-file" })
  const otherWrite = execute({ id: "other-write", conflictKey: "other-file" })
  first.resolve(["INITIAL"])

  assert.deepEqual(await Promise.all([initial, firstWrite, duplicateWrite, otherWrite]), [
    "INITIAL", "FIRST-WRITE", "DUPLICATE-WRITE", "OTHER-WRITE",
  ])
  assert.deepEqual(batches, [
    ["initial"],
    ["first-write", "other-write"],
    ["duplicate-write"],
  ])
})

test("a split-worthy batch failure retries each request separately and settles each caller", async () => {
  const first = deferred<string[]>()
  const batches: string[][] = []
  let runCount = 0
  const execute = createRequestCoalescer<Request, string>({
    maxBatchSize: 2,
    shouldSplitOnError: error => error instanceof Error && error.message === "batch limit",
    async run(requests) {
      batches.push(requests.map(request => request.id))
      if (runCount++ === 0) return await first.promise
      if (requests.length > 1) throw new Error("batch limit")
      if (requests[0]?.id === "bad") throw new Error("bad request")
      return [`result:${requests[0]?.id}`]
    },
  })

  const seed = execute({ id: "seed" })
  const good = execute({ id: "good" })
  const bad = execute({ id: "bad" })
  first.resolve(["result:seed"])

  const settled = await Promise.allSettled([seed, good, bad])
  assert.deepEqual(settled.map(item => item.status), ["fulfilled", "fulfilled", "rejected"])
  assert.deepEqual(batches, [["seed"], ["good", "bad"], ["good"], ["bad"]])
  if (settled[1]?.status === "fulfilled") assert.equal(settled[1].value, "result:good")
  if (settled[2]?.status === "rejected") assert.match(String(settled[2].reason), /bad request/)
})

test("a batch with the wrong result count rejects every request with the same contract error", async () => {
  const first = deferred<string[]>()
  let runCount = 0
  const execute = createRequestCoalescer<Request, string>({
    maxBatchSize: 2,
    async run(requests) {
      if (runCount++ === 0) return await first.promise
      return requests.length > 1 ? ["only-one"] : [requests[0]?.id ?? ""]
    },
  })
  const seed = execute({ id: "seed" })
  const a = execute({ id: "a" })
  const b = execute({ id: "b" })
  first.resolve(["seed"])

  await seed
  const outcomes = await Promise.allSettled([a, b])
  assert.deepEqual(outcomes.map(item => item.status), ["rejected", "rejected"])
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      assert.equal(outcome.reason instanceof BoxStoreSyncError, true)
      assert.match(outcome.reason.message, /returned 1 results for 2 requests/)
    }
  }
})
