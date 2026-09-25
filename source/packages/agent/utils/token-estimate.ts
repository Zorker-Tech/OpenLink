/**
 * A cheap estimate of how many tokens a string costs.
 *
 * Used where an exact count is not available (or not worth the round trip): prompt budgets, warnings,
 * and comparisons between two prompts. Four characters per token is the usual rule of thumb for code
 * and prose alike, and being approximate is the point — the caller needs to know "roughly how full"
 * something is.
 */

const CHARACTERS_PER_TOKEN = 4

export function estimateStringTokenCount(value: string): number {
  return Math.round(value.length / CHARACTERS_PER_TOKEN)
}
