/** Slate-owned choices for which guidance belongs in a generated user-info section. */
export type GeneratedRuleSet = "suppressed" | "none" | "general" | "tool-aware"

export interface SlateUserRuleProfile {
  readonly ruleSet: GeneratedRuleSet
  readonly includeFinalResponseGuidance: boolean
  readonly includeInterfaceGuidance: boolean
  readonly preventBroadGlobSearch: boolean
  readonly shellToolName?: string | undefined
  readonly awaitToolName?: string | undefined
  readonly grepToolName?: string | undefined
}

export interface UserRuleToolNames {
  readonly shellToolName?: string | undefined
  readonly awaitToolName?: string | undefined
  readonly grepToolName?: string | undefined
}

export interface PromptRuleGroups {
  readonly globalRules: readonly import("./rule-sections-contracts.ts").PromptRuleDescriptor[]
  readonly agentRequestableRules: readonly import("./rule-sections-contracts.ts").PromptRuleDescriptor[]
  readonly userRules: readonly import("./rule-sections-contracts.ts").PromptRuleDescriptor[]
}
