/**
 * Translates external feature-flag names into the Slate flags product policy reads.
 *
 * The external names describe a model family; Slate's names describe the capability the flag turns on.
 */

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function slateFeatureFlagsFromInterop(value: unknown): Record<string, unknown> | undefined {
  const flags = recordOf(value)
  if (flags === undefined) return undefined
  const {
    backgroundComposerMultiPrs,
    enableComposer2CustomUserRules,
    ...owned
  } = flags
  if (backgroundComposerMultiPrs === undefined && enableComposer2CustomUserRules === undefined &&
      flags.cloudAgentMultiPrs === undefined && flags.enableGeneratedUserRules === undefined) {
    return flags
  }
  return {
    ...owned,
    ...(flags.cloudAgentMultiPrs === true || backgroundComposerMultiPrs === true ? { cloudAgentMultiPrs: true } : {}),
    ...(flags.enableGeneratedUserRules === true || enableComposer2CustomUserRules === true ? { enableGeneratedUserRules: true } : {}),
  }
}

export function slateCloudTestingFlagFromInterop(value: unknown): boolean | undefined {
  const flags = recordOf(value)
  if (flags === undefined) return undefined
  const enabled = flags.enableCloudAgentIntelligentTestingPromptSection ?? flags.enableComposer2IntelligentTestingPromptSection
  return enabled === true ? true : undefined
}
