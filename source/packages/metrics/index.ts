/**
 * Metrics, reported through the context.
 *
 * Same shape as logging: a module declares its counters, gauges and histograms at module scope and
 * reports through whatever backend the *context* carries. Nothing is emitted unless a process
 * installs a backend, and this module never throws — instrumentation must not be able to fail the
 * work it is measuring.
 */

import { createKey, type Context } from "../context/context.ts"

export type MetricType = "counter" | "gauge" | "histogram"

export interface MetricHandle {
  name: string
  type: MetricType
  description?: string | undefined
  labelNames?: readonly string[] | undefined
}

export type MetricLabels = Readonly<Record<string, string>>

export interface MetricsBackend {
  record(context: Context, handle: MetricHandle, value: number, labels?: MetricLabels): void
  increment(context: Context, handle: MetricHandle, value: number, labels?: MetricLabels): void
  gauge(context: Context, handle: MetricHandle, value: number, labels?: MetricLabels): void
  histogram(context: Context, handle: MetricHandle, value: number, labels?: MetricLabels): void
}

const noopMetricsBackend: MetricsBackend = {
  record() {},
  increment() {},
  gauge() {},
  histogram() {},
}

export const metricsKey = createKey<MetricsBackend>(Symbol("metricsBackend"), noopMetricsBackend)

export function getMetricsBackend(context: Context): MetricsBackend {
  return context.get(metricsKey)
}

interface MetricOptions {
  readonly description?: string
  readonly labelNames?: readonly string[]
}

function createHandle(name: string, type: MetricType, options?: MetricOptions): MetricHandle {
  return { name, type, description: options?.description, labelNames: options?.labelNames }
}

export function createCounter(name: string, options?: MetricOptions) {
  const metric = createHandle(name, "counter", options)
  return {
    increment: (context: Context, value = 1, labels?: MetricLabels): void =>
      getMetricsBackend(context).increment(context, metric, value, labels),
    record: (context: Context, value: number, labels?: MetricLabels): void =>
      getMetricsBackend(context).record(context, metric, value, labels),
  }
}

export function createGauge(name: string, options?: MetricOptions) {
  const metric = createHandle(name, "gauge", options)
  return {
    gauge: (context: Context, value: number, labels?: MetricLabels): void =>
      getMetricsBackend(context).gauge(context, metric, value, labels),
    record: (context: Context, value: number, labels?: MetricLabels): void =>
      getMetricsBackend(context).record(context, metric, value, labels),
  }
}

export function createHistogram(name: string, options?: MetricOptions) {
  const metric = createHandle(name, "histogram", options)
  return {
    histogram: (context: Context, value: number, labels?: MetricLabels): void =>
      getMetricsBackend(context).histogram(context, metric, value, labels),
    record: (context: Context, value: number, labels?: MetricLabels): void =>
      getMetricsBackend(context).record(context, metric, value, labels),
  }
}
