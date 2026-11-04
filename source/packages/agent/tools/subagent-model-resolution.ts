import {
  canonicalizeSubagentModelId as canonicalizeCatalogModelId,
  isBuiltInSubagentModelId as isCatalogBuiltInModelId,
  SLATE_SUBAGENT_MODEL_IDS,
} from "../../../adapters/interop/agent/subagent-model-id-adapter.ts"

type ModelDefinition = { readonly slug: string }

export function isBuiltInSubagentModelId(modelId: string): boolean {
  return isCatalogBuiltInModelId(modelId)
}

export function canonicalSubagentModelId(modelId: string): string {
  return canonicalizeCatalogModelId(modelId)
}

export function isSubagentDefaultId(modelId: string): boolean {
  return isCatalogBuiltInModelId(modelId)
}

export function orderedExploreSubagentModelIds(
  defaultModelIds: string[],
  parentModelId: string,
  compareModelCosts: (candidateModelId: string, parentModelId: string) => number,
): string[] {
  const [fastModelId, standardModelId, ...otherModelIds] = defaultModelIds
  if (fastModelId !== undefined && standardModelId !== undefined && compareModelCosts(fastModelId, parentModelId) > 0) {
    return [standardModelId, fastModelId, ...otherModelIds]
  }
  return defaultModelIds
}

export function taskArgSelectsFastSubagentTier(alias: string): boolean {
  return alias.trim().toLowerCase().endsWith("-fast")
}

export function shouldNormalizeTaskArgModelInput(modelsBySlug: ReadonlyMap<string, ModelDefinition>): boolean {
  return ![...modelsBySlug.keys()].some(slug => slug !== slug.toLowerCase() || slug.includes("_"))
}

export function normalizeTaskArgModelInput(
  requestedModel: string,
  modelsBySlug: ReadonlyMap<string, ModelDefinition>,
): string {
  const trimmed = requestedModel.trim()
  if (!shouldNormalizeTaskArgModelInput(modelsBySlug)) return trimmed
  return trimmed.toLowerCase().replaceAll("_", "-")
}

export function resolveTaskArgToSubagentModelId(
  requestedModel: string,
  modelsBySlug: ReadonlyMap<string, ModelDefinition>,
): string | undefined {
  const normalized = normalizeTaskArgModelInput(requestedModel, modelsBySlug)
  const listedSlug = modelsBySlug.get(normalized)?.slug
  if (listedSlug !== undefined) return canonicalSubagentModelId(listedSlug)
  const alias = normalized.toLowerCase()
  if (taskArgSelectsFastSubagentTier(normalized)) return SLATE_SUBAGENT_MODEL_IDS.fast
  if (alias === "default" || alias === "auto") return SLATE_SUBAGENT_MODEL_IDS.standard
  return undefined
}
