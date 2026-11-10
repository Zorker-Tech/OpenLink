import type { Context } from "../context/context.ts"

export type MetricType = "counter" | "gauge" | "histogram"
export type MetricLabels = Readonly<Record<string, string>>

export interface MetricHandle {
  name: string
  type: MetricType
  description?: string | undefined
  labelNames?: readonly string[] | undefined
}

export interface MetricOptions {
  readonly description?: string
  readonly labelNames?: readonly string[]
}

export interface MetricsBackend {
  record(context: Context, handle: MetricHandle, value: number, labels?: MetricLabels): void
  increment(context: Context, handle: MetricHandle, value: number, labels?: MetricLabels): void
  gauge(context: Context, handle: MetricHandle, value: number, labels?: MetricLabels): void
  histogram(context: Context, handle: MetricHandle, value: number, labels?: MetricLabels): void
}
