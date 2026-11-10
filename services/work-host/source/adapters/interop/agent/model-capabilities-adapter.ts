/**
 * Translates external model metadata into Slate's model-capability contract.
 *
 * The external record names model families with its own fields. Slate policy asks only for the capability
 * it needs, so the external names stop here.
 */

import type { SlateModelCapabilities } from "../../../packages/agent/model-capabilities.ts"

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function slateModelCapabilitiesFromInterop(value: unknown): SlateModelCapabilities | undefined {
  const model = recordOf(value)
  if (model === undefined) return undefined
  const {
    isComposer1,
    isComposer15,
    isComposer2,
    isComposerMatterhorn,
    ...owned
  } = model
  return {
    ...owned,
    promptVersion: typeof model.promptVersion === "string" ? model.promptVersion : "latest",
    ...(model.isLegacyAgentModel1 === true || isComposer1 === true ? { isLegacyAgentModel1: true } : {}),
    ...(model.isLegacyAgentModel15 === true || isComposer15 === true ? { isLegacyAgentModel15: true } : {}),
    ...(model.isLegacyAgentModel2 === true || isComposer2 === true ? { isLegacyAgentModel2: true } : {}),
    ...(model.isLegacyAgentMatterhorn === true || isComposerMatterhorn === true ? { isLegacyAgentMatterhorn: true } : {}),
    ...(model.isRawTrainingSlug === true ? { isRawTrainingSlug: true } : {}),
  }
}
