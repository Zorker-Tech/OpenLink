import { monitorEventLoopDelay, performance } from "node:perf_hooks"

import type { EventLoopSamplerOptions } from "./event-loop-telemetry-contracts.ts"
import { chooseEventLoopSignal, LOOP_DELAY_RESOLUTION_MS, LOOP_REPORT_WINDOW_MS } from "./event-loop-telemetry-policy.ts"
import { readEventLoopWindow } from "./event-loop-window-metrics.ts"

export function createHostEventLoopSampler(options: EventLoopSamplerOptions) {
  const windowLengthMs = options.windowMs ?? LOOP_REPORT_WINDOW_MS
  const clock = options.now ?? Date.now
  const delayHistogram = monitorEventLoopDelay({ resolution: LOOP_DELAY_RESOLUTION_MS })
  delayHistogram.enable()

  let priorUsage = performance.eventLoopUtilization()
  let periodBeganAtMs = clock()
  let completedWindows = 0
  let stopped = false

  return {
    onTick: () => {
      if (stopped) return

      const tickAtMs = clock()
      const elapsedMs = tickAtMs - periodBeganAtMs
      if (elapsedMs < windowLengthMs) return

      completedWindows += 1
      periodBeganAtMs = tickAtMs

      const usage = performance.eventLoopUtilization()
      const values = readEventLoopWindow({
        histogram: delayHistogram,
        previousUsage: priorUsage,
        currentUsage: usage,
        elapsedMs,
        resolutionMs: LOOP_DELAY_RESOLUTION_MS,
      })
      priorUsage = usage

      const trigger = chooseEventLoopSignal({ windowNumber: completedWindows, p95Milliseconds: values.p95Ms })
      if (trigger !== undefined) options.report(values, trigger)
    },
    dispose: () => {
      if (stopped) return
      stopped = true
      delayHistogram.disable()
    },
  }
}
