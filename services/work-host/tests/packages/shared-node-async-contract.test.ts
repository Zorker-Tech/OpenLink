import assert from "node:assert/strict"
import test from "node:test"

import type { Clock } from "../../source/host/extensions/scheduling.ts"
import { delayWith } from "../../source/shared/node/async.ts"

test("invalid delays are scheduled as zero and positive delays are preserved", async () => {
  const observed: number[] = []
  const clock: Clock = {
    now: () => 0,
    monotonicNow: () => 0,
    schedule(milliseconds, callback) {
      observed.push(milliseconds)
      callback()
      return { dispose() {} }
    },
  }

  for (const duration of [Number.NaN, Number.POSITIVE_INFINITY, -2, 0, 8]) {
    await delayWith(clock, duration)
  }
  assert.deepEqual(observed, [0, 0, 0, 0, 8])
})

test("aborting a scheduled delay resolves it and disposes its clock task", async () => {
  const controller = new AbortController()
  let scheduledDelay = -1
  let disposeCount = 0
  const clock: Clock = {
    now: () => 0,
    monotonicNow: () => 0,
    schedule(milliseconds) {
      scheduledDelay = milliseconds
      return { dispose: () => { disposeCount += 1 } }
    },
  }

  const waiting = delayWith(clock, 25, controller.signal)
  controller.abort()
  await waiting

  assert.equal(scheduledDelay, 25)
  assert.equal(disposeCount, 1)
})
