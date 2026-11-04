import { createKey, type Context } from "../context/context.ts"
import type { MetricsBackend } from "./metrics-contracts.ts"

const emptyBackend: MetricsBackend = {
  record() {},
  increment() {},
  gauge() {},
  histogram() {},
}

export const metricsKey = createKey<MetricsBackend>(Symbol("metricsBackend"), emptyBackend)

export function getMetricsBackend(context: Context): MetricsBackend {
  return context.get(metricsKey)
}
