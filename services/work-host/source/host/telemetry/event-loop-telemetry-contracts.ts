export type EventLoopSignal = "pressure" | "heartbeat"

export interface EventLoopWindowValues {
  p50Ms: number
  p95Ms: number
  maxMs: number
  utilization: number
  windowMs: number
}

export interface EventLoopWindowReport extends EventLoopWindowValues {
  trigger: EventLoopSignal
}

export interface EventLoopSamplerOptions {
  windowMs?: number
  now?: () => number
  report: (report: EventLoopWindowValues, trigger: EventLoopSignal) => void
}

export interface EventLoopDelayHistogram {
  enable(): void
  disable(): void
  reset(): void
  percentile(percentile: number): number
  max: number
}

export interface EventLoopUsage {
  active: number
  idle: number
}
