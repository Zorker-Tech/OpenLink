import assert from "node:assert/strict"
import { test } from "node:test"

import {
  chooseEventLoopSignal,
  toEventLoopLogRecord,
} from "../../source/host/telemetry/event-loop-telemetry-policy.ts"
import { createHostEventLoopSampler } from "../../source/host/telemetry/event-loop-telemetry.ts"
import { readEventLoopWindow } from "../../source/host/telemetry/event-loop-window-metrics.ts"
import type { EventLoopDelayHistogram } from "../../source/host/telemetry/event-loop-telemetry-contracts.ts"

test("event-loop reporting gives pressure precedence over the periodic heartbeat", () => {
  assert.equal(chooseEventLoopSignal({ windowNumber: 1, p95Milliseconds: 50 }), "pressure")
  assert.equal(chooseEventLoopSignal({ windowNumber: 4, p95Milliseconds: 49 }), undefined)
  assert.equal(chooseEventLoopSignal({ windowNumber: 5, p95Milliseconds: 49 }), "heartbeat")
})

test("event-loop measurements project into rounded structured log metadata", () => {
  assert.deepEqual(toEventLoopLogRecord({
    trigger: "pressure",
    p50Ms: 10.4,
    p95Ms: 51.6,
    maxMs: 80.2,
    utilization: 0.45678,
    windowMs: 60_001,
  }), {
    level: "warn",
    event: "slate.host.event_loop",
    metadata: {
      trigger: "pressure",
      p50_ms: "10",
      p95_ms: "52",
      max_ms: "80",
      utilization: "0.457",
      window_ms: "60001",
    },
  })
})

test("event-loop sampling reports periodically and becomes inert after disposal", () => {
  const reports: Array<{ trigger: string; windowMs: number }> = []
  const sampler = createHostEventLoopSampler({
    windowMs: 0,
    now: () => 1_000,
    report: (report, trigger) => reports.push({ trigger, windowMs: report.windowMs }),
  })

  for (let index = 0; index < 5; index += 1) sampler.onTick()
  assert.deepEqual(reports, [{ trigger: "heartbeat", windowMs: 0 }])

  sampler.dispose()
  sampler.dispose()
  sampler.onTick()
  assert.equal(reports.length, 1)
})

test("event-loop metrics compensate histogram resolution and tolerate zero activity", () => {
  const resetCalls: number[] = []
  const histogram: EventLoopDelayHistogram = {
    enable() {},
    disable() {},
    reset() { resetCalls.push(1) },
    percentile(percentile) { return percentile === 50 ? 10e6 : 75e6 },
    max: 100e6,
  }

  assert.deepEqual(readEventLoopWindow({
    histogram,
    previousUsage: { active: 20, idle: 30 },
    currentUsage: { active: 20, idle: 30 },
    elapsedMs: 2_000,
    resolutionMs: 20,
  }), {
    p50Ms: 0,
    p95Ms: 55,
    maxMs: 80,
    utilization: 0,
    windowMs: 2_000,
  })
  assert.deepEqual(resetCalls, [1])
})
