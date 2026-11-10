/** Maps service model tags and experiment switches to Slate's small prompt-guidance profile. */

import type { SlateUserRuleProfile, UserRuleToolNames } from "../../../packages/agent/prompts/user-rule-profile-contract.ts"
import { buildGeneratedUserRules } from "../../../packages/agent/prompts/custom-user-rules.ts"
import { slateModelCapabilitiesFromInterop } from "./model-capabilities-adapter.ts"

type Fields = Record<string, unknown>

function fieldsOf(value: unknown): Fields {
  return value !== null && typeof value === "object" ? value as Fields : {}
}

function enabled(value: unknown, key: string): boolean {
  return fieldsOf(value)[key] === true
}

function optionalToolName(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/** Resolve upstream-only model and flag names before the Slate prompt builder sees them. */
export function adaptInteropUserRuleProfile(
  modelInfo: unknown,
  featureFlags: unknown,
  toolNames: UserRuleToolNames = {},
  options: { readonly defaultCustomRulesWhenUnspecified?: boolean } = {},
): SlateUserRuleProfile {
  const capabilities = slateModelCapabilitiesFromInterop(modelInfo)
  const specializedModel = capabilities?.isLegacyAgentMatterhorn === true
  const rawTrainingTag = capabilities?.isRawTrainingSlug === true
  if (specializedModel && rawTrainingTag) {
    return {
      ruleSet: "suppressed",
      includeFinalResponseGuidance: false,
      includeInterfaceGuidance: false,
      preventBroadGlobSearch: false,
    }
  }

  const flagValue = fieldsOf(featureFlags).enableComposer2CustomUserRules
  const customRulesEnabled = flagValue === undefined
    ? options.defaultCustomRulesWhenUnspecified === true
    : flagValue === true
  const toolAwareWording = specializedModel && enabled(featureFlags, "enableMatterhornPromptTweaks")
  const ruleSet = customRulesEnabled ? (toolAwareWording ? "tool-aware" : "general") : "none"
  const shellToolName = toolAwareWording ? optionalToolName(toolNames.shellToolName) : undefined
  const awaitToolName = toolAwareWording ? optionalToolName(toolNames.awaitToolName) : undefined
  const grepToolName = toolAwareWording ? optionalToolName(toolNames.grepToolName) : undefined
  return {
    ruleSet,
    includeFinalResponseGuidance: enabled(featureFlags, "enableTahomaUserRuleIntervention"),
    includeInterfaceGuidance: enabled(featureFlags, "enableVegaFrontendUserRuleIntervention"),
    preventBroadGlobSearch: toolAwareWording && enabled(featureFlags, "enableGrepBroadGlobGuard"),
    ...(shellToolName === undefined ? {} : { shellToolName }),
    ...(awaitToolName === undefined ? {} : { awaitToolName }),
    ...(grepToolName === undefined ? {} : { grepToolName }),
  }
}

/** Compatibility boundary for call sites that still receive the counterpart's model and flag records. */
export function getGeneratedUserRulesForModel(
  modelInfo: unknown,
  featureFlags: unknown,
  toolNames: UserRuleToolNames = {},
  options: { readonly defaultCustomRulesWhenUnspecified?: boolean } = {},
): string[] {
  return buildGeneratedUserRules(adaptInteropUserRuleProfile(modelInfo, featureFlags, toolNames, options))
}
