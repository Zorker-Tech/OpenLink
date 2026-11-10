import type { EventLoopDelayHistogram, EventLoopUsage, EventLoopWindowValues } from "./event-loop-telemetry-contracts.ts"

function correctedDelay(valueNs: number, resolutionMs: number): number {
  return Math.max(0, valueNs / 1e6 - resolutionMs)
}

export function readEventLoopWindow(input: {
  histogram: EventLoopDelayHistogram
  previousUsage: EventLoopUsage
  currentUsage: EventLoopUsage
  elapsedMs: number
  resolutionMs: number
}): EventLoopWindowValues {
  const { histogram } = input
  const values: EventLoopWindowValues = {
    p50Ms: correctedDelay(histogram.percentile(50), input.resolutionMs),
    p95Ms: correctedDelay(histogram.percentile(95), input.resolutionMs),
    maxMs: correctedDelay(histogram.max, input.resolutionMs),
    utilization: 0,
    windowMs: input.elapsedMs,
  }

  const active = input.currentUsage.active - input.previousUsage.active
  const idle = input.currentUsage.idle - input.previousUsage.idle
  const total = active + idle
  values.utilization = total > 0 && Number.isFinite(total) ? active / total : 0

  histogram.reset()
  return values
}
