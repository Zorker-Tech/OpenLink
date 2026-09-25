/**
 * How much of the skill catalogue survived budgeting.
 *
 * The catalogue is trimmed to fit a prompt budget, and the interesting number is not the size that
 * came out but what it cost: how many skills were dropped, how many tokens the full catalogue would
 * have been, and which strategy did the trimming. Reporting all four together is what makes a budget
 * regression diagnosable from metrics alone.
 */

import type { Context } from "../../context/context.ts"
import { createCounter, createHistogram } from "../../metrics/index.ts"

export interface SkillCatalogBudgetMetricsInput {
  readonly strategy: string
  readonly renderedTokens: number
  readonly uncappedTokens: number
  readonly omittedCount: number
}

const applied = createCounter("skill_catalog_budget.applied", {
  description: "Model invocations that ran the skill-catalog budget pipeline, tagged by which strategy was selected",
  labelNames: ["strategy"],
})
const renderedTokens = createHistogram("skill_catalog_budget.rendered_tokens", {
  description: "Estimated tokens rendered for the skill catalog after budgeting, tagged by strategy",
  labelNames: ["strategy"],
})
const uncappedTokens = createHistogram("skill_catalog_budget.uncapped_tokens", {
  description: "Estimated tokens the skill catalog would have rendered with no budget applied, tagged by the strategy that ran",
  labelNames: ["strategy"],
})
const omittedCount = createHistogram("skill_catalog_budget.omitted_count", {
  description: "Number of skills omitted from the rendered catalog, tagged by strategy",
  labelNames: ["strategy"],
})

export function emitSkillCatalogBudgetMetrics(ctx: Context, input: SkillCatalogBudgetMetricsInput): void {
  const tags = { strategy: input.strategy }
  applied.increment(ctx, 1, tags)
  renderedTokens.histogram(ctx, input.renderedTokens, tags)
  uncappedTokens.histogram(ctx, input.uncappedTokens, tags)
  omittedCount.histogram(ctx, input.omittedCount, tags)
}
