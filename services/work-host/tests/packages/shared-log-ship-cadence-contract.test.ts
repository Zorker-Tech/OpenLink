import assert from "node:assert/strict"
import { test } from "node:test"

import {
  LogShipSchedule,
  LOG_SHIP_FAILURE_MAX_BACKOFF_MS,
  LOG_SHIP_INTERVAL_MS,
  LOG_SHIP_MAX_BATCH_BYTES,
  LOG_SHIP_MAX_BATCH_ENTRIES,
  LOG_SHIP_RATE_LIMIT_MAX_BACKOFF_MS,
  takeLogShipBatch,
} from "../../source/shared/observability/log-ship-cadence.ts"

test("successful sends wait for the interval unless a caller explicitly ships next", () => {
  const schedule = new LogShipSchedule()
  assert.equal(schedule.isDue(false, 0), true)

  schedule.record({ delivered: true }, 1_000)
  assert.equal(schedule.isBackingOff(), false)
  assert.equal(schedule.isDue(false, 1_000 + LOG_SHIP_INTERVAL_MS - 1), false)
  assert.equal(schedule.isDue(true, 1_000), true)
  schedule.shipNext()
  assert.equal(schedule.isDue(false, 1_000), true)
})

test("failures back off exponentially, block eager sends and clear after success", () => {
  const schedule = new LogShipSchedule()
  schedule.record({ delivered: false, error: new Error("temporary") }, 5_000)

  assert.equal(schedule.isBackingOff(), true)
  assert.equal(schedule.isDue(true, 5_000), false)
  assert.equal(schedule.isDue(false, 5_000 + LOG_SHIP_INTERVAL_MS * 2 - 1), false)
  assert.equal(schedule.isDue(false, 5_000 + LOG_SHIP_FAILURE_MAX_BACKOFF_MS * 1.25), true)
  schedule.shipNext()
  assert.equal(schedule.isDue(false, 5_000), false)

  schedule.record({ delivered: true }, 50_000)
  assert.equal(schedule.isBackingOff(), false)
})

test("rate limits honor the service delay and remain capped with jitter", () => {
  const schedule = new LogShipSchedule()
  const error = { code: 8, metadata: { get: (name: string) => name === "retry-after" ? "120" : null } }
  schedule.record({ delivered: false, error }, 2_000)

  assert.equal(schedule.isDue(true, 2_000), false)
  assert.equal(schedule.isDue(false, 2_000 + 120_000 - 1), false)
  assert.equal(schedule.isDue(false, 2_000 + 150_000), true)
  assert.equal(LOG_SHIP_RATE_LIMIT_MAX_BACKOFF_MS, 5 * 60_000)
})

test("batching keeps order, observes both limits and lets an oversized first entry make progress", () => {
  const entries = Array.from({ length: LOG_SHIP_MAX_BATCH_ENTRIES + 2 }, (_value, index) => ({
    message: `line-${index}`,
    metadata: {},
  }))
  const byCount = takeLogShipBatch(entries)
  assert.equal(byCount.batch.length, LOG_SHIP_MAX_BATCH_ENTRIES)
  assert.deepEqual(byCount.remaining, entries.slice(LOG_SHIP_MAX_BATCH_ENTRIES))

  const byBytes = takeLogShipBatch([
    { message: "x".repeat(LOG_SHIP_MAX_BATCH_BYTES - 2), metadata: { a: "b" } },
    { message: "next", metadata: {} },
  ])
  assert.equal(byBytes.batch.length, 1)
  assert.equal(byBytes.remaining[0]?.message, "next")

  const oversized = { message: "x".repeat(LOG_SHIP_MAX_BATCH_BYTES + 1), metadata: {} }
  const afterOversized = { message: "later", metadata: {} }
  assert.deepEqual(takeLogShipBatch([oversized, afterOversized]), {
    batch: [oversized],
    remaining: [afterOversized],
  })
})
