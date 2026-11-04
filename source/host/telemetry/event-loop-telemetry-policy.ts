import type { EventLoopSignal, EventLoopWindowReport } from "./event-loop-telemetry-contracts.ts"

export const LOOP_DELAY_RESOLUTION_MS = 20
export const LOOP_REPORT_WINDOW_MS = 60_000
export const LOOP_PRESSURE_LIMIT_MS = 50
export const LOOP_HEARTBEAT_PERIOD = 5

export function chooseEventLoopSignal(input: {
  windowNumber: number
  p95Milliseconds: number
  pressureLimitMs?: number
  heartbeatPeriod?: number
}): EventLoopSignal | undefined {
  const pressureLimit = input.pressureLimitMs ?? LOOP_PRESSURE_LIMIT_MS
  const heartbeatPeriod = input.heartbeatPeriod ?? LOOP_HEARTBEAT_PERIOD

  if (input.p95Milliseconds >= pressureLimit) return "pressure"
  if (input.windowNumber % heartbeatPeriod === 0) return "heartbeat"
  return undefined
}

export function toEventLoopLogRecord(report: EventLoopWindowReport) {
  const metadata = new Map<string, string>([
    ["trigger", report.trigger],
    ["p50_ms", String(Math.round(report.p50Ms))],
    ["p95_ms", String(Math.round(report.p95Ms))],
    ["max_ms", String(Math.round(report.maxMs))],
    ["utilization", report.utilization.toFixed(3)],
    ["window_ms", String(report.windowMs)],
  ])

  return {
    level: report.trigger === "pressure" ? "warn" : "info",
    event: "slate.host.event_loop",
    metadata: Object.fromEntries(metadata),
  }
}
