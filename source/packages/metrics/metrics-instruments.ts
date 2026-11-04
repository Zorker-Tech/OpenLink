import type { Context } from "../context/context.ts"
import { getMetricsBackend } from "./metrics-context.ts"
import type { MetricHandle, MetricLabels, MetricOptions, MetricType, MetricsBackend } from "./metrics-contracts.ts"

type MetricOperation = keyof MetricsBackend

interface MetricWriters {
  record(context: Context, value: number, labels?: MetricLabels): void
  increment(context: Context, value?: number, labels?: MetricLabels): void
  gauge(context: Context, value: number, labels?: MetricLabels): void
  histogram(context: Context, value: number, labels?: MetricLabels): void
}

function declareInstrument(name: string, type: MetricType, options?: MetricOptions): MetricWriters {
  const handle: MetricHandle = {
    name,
    type,
    description: options?.description,
    labelNames: options?.labelNames,
  }
  const emit = (operation: MetricOperation, context: Context, value: number, labels?: MetricLabels): void => {
    getMetricsBackend(context)[operation](context, handle, value, labels)
  }

  return {
    record: (context, value, labels) => emit("record", context, value, labels),
    increment: (context, value = 1, labels) => emit("increment", context, value, labels),
    gauge: (context, value, labels) => emit("gauge", context, value, labels),
    histogram: (context, value, labels) => emit("histogram", context, value, labels),
  }
}

export function createCounter(name: string, options?: MetricOptions) {
  const writer = declareInstrument(name, "counter", options)
  return { increment: writer.increment, record: writer.record }
}

export function createGauge(name: string, options?: MetricOptions) {
  const writer = declareInstrument(name, "gauge", options)
  return { gauge: writer.gauge, record: writer.record }
}

export function createHistogram(name: string, options?: MetricOptions) {
  const writer = declareInstrument(name, "histogram", options)
  return { histogram: writer.histogram, record: writer.record }
}
