/**
 * Model identifiers the backend uses for its own summary-capable families.
 *
 * The identifiers are external wire values. Product policy asks whether a model belongs to a Slate
 * summary family and does not spell the identifiers itself.
 */

const PRIOR_SUMMARY_MODEL_IDS = new Set([
  "slate-4.5", "cursor-slate-4.5", "slate-4.5-medium", "slate-4.5-fast-medium",
  "slate-4.5-high", "slate-4.5-fast-high", "slate-4.5-xhigh", "slate-4.5-fast-xhigh",
])

const SUMMARY_MODEL_PREFIXES = [
  "cursor-slate-4.5-", "vega-", "accounts/slate/models/vega", "slate/vega", "v9-",
] as const

function providerIdentifiesV9(modelName: string): boolean {
  const providerParts = modelName.startsWith("XAIEXTERNAL--") ? modelName.split("--") : []
  const providerModel = providerParts.length === 3 && providerParts[1] ? providerParts[2] : undefined
  return providerModel === "v9" || providerModel?.startsWith("v9-") === true
}

export function isSlateSummaryModelId(modelId: string): boolean {
  const modelName = modelId.split("#", 1)[0] ?? modelId
  return PRIOR_SUMMARY_MODEL_IDS.has(modelName)
    || SUMMARY_MODEL_PREFIXES.some((prefix) => modelName.startsWith(prefix))
    || modelName === "vega"
    || modelName === "v9"
    || providerIdentifiesV9(modelName)
}
