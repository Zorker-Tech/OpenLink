/**
 * Turning what a model asked for into a subagent model slug.
 *
 * A model asked to pick a model writes whatever it thinks the name is: a slug, a family name, "default",
 * "auto", or something with underscores. So the request is normalized — lowercased and hyphenated, but
 * only when every slug in the catalogue is already lowercase and hyphenated, since otherwise the
 * normalization would invent a slug that does not exist — and then matched against the catalogue, with
 * two words given meanings of their own: a request for the fast tier and a request for the default.
 *
 * One legacy slug is mapped to its replacement, because conversations and configurations written before
 * the rename still name it.
 */

import { SubagentModelId } from "./subagent-model-ids.ts"

type ModelDefinition = { readonly slug: string }

const LEGACY_SUBAGENT_SLUG = "composer-1.5"
const BUILT_IN_MODEL_ID_PATTERN = /^composer-\d+(?:\.\d+)?(?:-fast)?$/

export function isBuiltInComposerSubagentSlug(modelId: string): boolean {
  return BUILT_IN_MODEL_ID_PATTERN.test(canonicalSubagentComposerSlug(modelId))
}

export function canonicalSubagentComposerSlug(slug: string): string {
  return slug === LEGACY_SUBAGENT_SLUG ? SubagentModelId.standard : slug
}

export function isComposerSubagentDefaultId(modelId: string): boolean {
  return BUILT_IN_MODEL_ID_PATTERN.test(canonicalSubagentComposerSlug(modelId))
}

/** The cheaper tier first, when it is cheaper than the parent's model. */
export function orderedExploreSubagentComposerIds(
  defaultModelIds: string[],
  parentModelId: string,
  compareModelCosts: (candidateModelId: string, parentModelId: string) => number,
): string[] {
  const [fastModelId, standardModelId, ...restModelIds] = defaultModelIds
  if (fastModelId !== undefined && standardModelId !== undefined && compareModelCosts(fastModelId, parentModelId) > 0) {
    return [standardModelId, fastModelId, ...restModelIds]
  }
  return defaultModelIds
}

export function taskArgSelectsFastComposerTier(alias: string): boolean {
  const trimmed = alias.trim().toLowerCase()
  return trimmed.endsWith("-fast")
}

/** Normalizing is only safe when the catalogue's own slugs would survive it unchanged. */
export function shouldNormalizeTaskArgModelInput(modelsBySlug: ReadonlyMap<string, ModelDefinition>): boolean {
  return ![...modelsBySlug.keys()].some(slug => slug !== slug.toLowerCase() || slug.includes("_"))
}

export function normalizeTaskArgModelInput(
  requestedModel: string,
  modelsBySlug: ReadonlyMap<string, ModelDefinition>,
): string {
  const trimmedRequestedModel = requestedModel.trim()
  if (!shouldNormalizeTaskArgModelInput(modelsBySlug)) return trimmedRequestedModel
  return trimmedRequestedModel.toLowerCase().replaceAll("_", "-")
}

export function resolveTaskArgToSubagentComposerSlug(
  requestedModel: string,
  modelsBySlug: ReadonlyMap<string, ModelDefinition>,
): string | undefined {
  const normalizedRequestedModel = normalizeTaskArgModelInput(requestedModel, modelsBySlug)
  const mapped = modelsBySlug.get(normalizedRequestedModel)?.slug
  if (mapped !== undefined) return canonicalSubagentComposerSlug(mapped)
  const lowercased = normalizedRequestedModel.toLowerCase()
  if (taskArgSelectsFastComposerTier(normalizedRequestedModel)) return SubagentModelId.fast
  if (lowercased === "default" || lowercased === "auto") return SubagentModelId.standard
  return undefined
}
