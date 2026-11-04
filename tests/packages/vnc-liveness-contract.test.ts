import assert from "node:assert/strict"
import test from "node:test"
import {
  isValidVncLivenessReport,
  VNC_LIVENESS_CHANNEL,
  VNC_LIVENESS_MIN_IMPACTFUL_INPUTS,
  VNC_LIVENESS_WINDOW_MS,
} from "../../source/shared/vnc-liveness.ts"

const valid = { phase: "post_connect", stallMs: 0, keys: 0, clicks: 0, moves: 0, inBytes: 0 }

test("the channel and sampling thresholds are fixed product values", () => {
  assert.equal(VNC_LIVENESS_CHANNEL, "slate:vnc-liveness")
  assert.equal(VNC_LIVENESS_WINDOW_MS, 10_000)
  assert.equal(VNC_LIVENESS_MIN_IMPACTFUL_INPUTS, 3)
})

test("all report counts accept finite non-negative numbers, including fractions", () => {
  assert.equal(isValidVncLivenessReport(valid), true)
  assert.equal(isValidVncLivenessReport({ ...valid, stallMs: 0.25, keys: 3, clicks: 1, moves: 20, inBytes: 2048 }), true)
})

test("invalid phase, missing fields and non-finite or negative counters are rejected", () => {
  assert.equal(isValidVncLivenessReport(null), false)
  assert.equal(isValidVncLivenessReport({ ...valid, phase: "running" }), false)
  assert.equal(isValidVncLivenessReport({ phase: "post_connect" }), false)

  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, "3", null]) {
    for (const key of ["stallMs", "keys", "clicks", "moves", "inBytes"] as const) {
      assert.equal(isValidVncLivenessReport({ ...valid, [key]: invalid }), false, `${key}=${String(invalid)}`)
    }
  }
})
