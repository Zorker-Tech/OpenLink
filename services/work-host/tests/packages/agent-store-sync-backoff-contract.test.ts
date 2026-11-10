import assert from "node:assert/strict"
import { test } from "node:test"

import { AgentStoreRetrySchedule } from "../../source/packages/agent-store-sync/backoff-scheduler.ts"

test("sync retries grow to a cap, and peeking does not count a failure", () => {
  const schedule = new AgentStoreRetrySchedule({ initialDelayMs: 100, maximumDelayMs: 350 })

  assert.equal(schedule.failureCount, 0)
  assert.equal(schedule.peekNextDelayMs(), 100)
  assert.equal(schedule.failureCount, 0)
  assert.deepEqual([schedule.noteFailure(), schedule.peekNextDelayMs(), schedule.noteFailure(), schedule.peekNextDelayMs(), schedule.noteFailure(), schedule.noteFailure()], [100, 200, 200, 350, 350, 350])
  assert.equal(schedule.failureCount, 4)

  schedule.noteSuccess()
  assert.equal(schedule.failureCount, 0)
  assert.equal(schedule.peekNextDelayMs(), 100)
})

test("restoring a failure count floors positive values and clears non-positive values", () => {
  const schedule = new AgentStoreRetrySchedule({ initialDelayMs: 100, maximumDelayMs: 1_000 })
  schedule.restoreFailureCount(2.9)
  assert.equal(schedule.failureCount, 2)
  assert.equal(schedule.peekNextDelayMs(), 400)
  schedule.restoreFailureCount(-3)
  assert.equal(schedule.failureCount, 0)
})

test("jitter stays within its configured range and clamps invalid random samples", () => {
  const samples = [0, 1, 0.5, Number.NaN, 2]
  const schedule = new AgentStoreRetrySchedule({
    initialDelayMs: 100,
    maximumDelayMs: 500,
    jitterFraction: 0.5,
    randomSample: () => samples.shift() ?? 0,
  })

  assert.deepEqual([
    schedule.noteFailure(),
    schedule.noteFailure(),
    schedule.noteFailure(),
    schedule.noteFailure(),
    schedule.noteFailure(),
  ], [50, 300, 400, 250, 500])
})

test("constructor validation refuses invalid delay bounds, growth and jitter", () => {
  assert.throws(() => new AgentStoreRetrySchedule({ initialDelayMs: 0, maximumDelayMs: 100 }), RangeError)
  assert.throws(() => new AgentStoreRetrySchedule({ initialDelayMs: 101, maximumDelayMs: 100 }), RangeError)
  assert.throws(() => new AgentStoreRetrySchedule({ initialDelayMs: 1, maximumDelayMs: 100, growthFactor: 0.5 }), RangeError)
  assert.throws(() => new AgentStoreRetrySchedule({ initialDelayMs: 1, maximumDelayMs: 100, jitterFraction: 1.1 }), RangeError)
})

test("a fully downward jitter still schedules at least one millisecond", () => {
  const schedule = new AgentStoreRetrySchedule({ initialDelayMs: 10, maximumDelayMs: 100, jitterFraction: 1, randomSample: () => 0 })
  assert.equal(schedule.noteFailure(), 1)
})
