import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createContext } from "../../source/packages/context/context.ts"
import {
  metricsKey,
  type MetricHandle,
  type MetricLabels,
  type MetricsBackend,
} from "../../source/packages/metrics/index.ts"
import { emitSkillCatalogBudgetMetrics } from "../../source/packages/agent/utils/skill-budget-metrics.ts"

interface MetricCall {
  readonly kind: "increment" | "histogram"
  readonly context: unknown
  readonly handle: MetricHandle
  readonly value: number
  readonly labels: MetricLabels | undefined
}

describe("skill catalog budget metrics", () => {
  it("emits the selected strategy, rendered cost, uncapped cost, and omitted count on one context", () => {
    const calls: MetricCall[] = []
    const record = (kind: MetricCall["kind"]): MetricsBackend["record"] => (context, handle, value, labels) => {
      calls.push({ kind, context, handle, value, labels })
    }
    const backend: MetricsBackend = {
      record: record("histogram"),
      increment: record("increment"),
      gauge: record("histogram"),
      histogram: record("histogram"),
    }
    const context = createContext().with(metricsKey, backend)

    emitSkillCatalogBudgetMetrics(context, {
      strategy: "omitted_skills",
      renderedTokens: 1_900,
      uncappedTokens: 12_400,
      omittedCount: 7,
    })

    assert.deepEqual(calls.map(({ handle, value, labels }) => [handle.name, value, labels]), [
      ["skill_catalog_budget.applied", 1, { strategy: "omitted_skills" }],
      ["skill_catalog_budget.rendered_tokens", 1_900, { strategy: "omitted_skills" }],
      ["skill_catalog_budget.uncapped_tokens", 12_400, { strategy: "omitted_skills" }],
      ["skill_catalog_budget.omitted_count", 7, { strategy: "omitted_skills" }],
    ])
    assert.deepEqual(calls.map(({ handle }) => handle.type), ["counter", "histogram", "histogram", "histogram"])
    assert.equal(calls.every(call => call.context === context), true)
    assert.ok(calls.every(call => call.handle.labelNames?.join(",") === "strategy"))
  })
})
