/**
 * A quick estimate of the token budget represented by a string.
 *
 * Used where an exact count is not available (or not worth the round trip): prompt budgets, warnings,
 * and comparisons between two prompts. The ratio is four characters per estimate unit; the half-unit bias
 * rounds the result to the nearest integer so small fragments still contribute proportionally.
 */

const CHARACTER_BUDGET_PER_TOKEN = 4
const HALF_TOKEN_WIDTH = CHARACTER_BUDGET_PER_TOKEN / 2

export function estimateStringTokenCount(value: string): number {
  return Math.floor((value.length + HALF_TOKEN_WIDTH) / CHARACTER_BUDGET_PER_TOKEN)
}
