import type { ProviderModelParams } from '@/lib/ai-provider-types'

const MAX_COST = 1_000_000
const MAX_TOKENS = 100_000_000
const MAX_NAME_LENGTH = 256
const MAX_INPUT_MODALITIES = 8

const nonNegative = (value: unknown, max = MAX_COST): number => {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? Math.min(numeric, max) : 0
}

const positiveInteger = (value: unknown, fallback: number, max = MAX_TOKENS): number => {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) && numeric >= 1 ? Math.min(Math.floor(numeric), max) : fallback
}

/**
 * Some catalogs mark variable-price routers with a negative sentinel instead
 * of a price (OpenRouter reports `-1` for its auto/router models). Those values
 * are not real costs, so they are normalized to zero before they reach the
 * settings schema, which only accepts non-negative amounts.
 */
export function normalizeModelCost(cost: ProviderModelParams['cost'] | null | undefined): ProviderModelParams['cost'] {
  const normalized: ProviderModelParams['cost'] = {
    input: nonNegative(cost?.input),
    output: nonNegative(cost?.output),
  }
  if (cost?.cacheRead !== undefined) normalized.cacheRead = nonNegative(cost.cacheRead)
  if (cost?.cacheWrite !== undefined) normalized.cacheWrite = nonNegative(cost.cacheWrite)
  return normalized
}

/**
 * Coerces catalog, stored and edited parameters into the shape the settings
 * action accepts. Bounds are deliberately conservative: unknown or invalid
 * values fall back to the documented defaults instead of blocking a save.
 */
export function normalizeModelParams(params: ProviderModelParams, fallbackName: string): ProviderModelParams {
  const input = Array.isArray(params.input)
    ? params.input.filter((value) => value === 'text' || value === 'image').slice(0, MAX_INPUT_MODALITIES)
    : []
  return {
    name: typeof params.name === 'string' && params.name.trim()
      ? params.name.slice(0, MAX_NAME_LENGTH)
      : fallbackName.slice(0, MAX_NAME_LENGTH),
    reasoning: Boolean(params.reasoning),
    input: input.length ? input : ['text'],
    contextWindow: positiveInteger(params.contextWindow, 128_000),
    maxTokens: positiveInteger(params.maxTokens, 8_192),
    cost: normalizeModelCost(params.cost),
  }
}
