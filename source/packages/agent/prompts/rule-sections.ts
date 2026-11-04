import { jsx, jsxs, type PromptNode } from "../../prompt-jsx/index.ts"
import type { PromptRuleDescriptor } from "./rule-sections-contracts.ts"
import { renderAlwaysAppliedRules, renderRequestableRules, renderUserRules } from "./rule-sections-renderers.ts"

export { getAgentRequestableRuleDescription, getRuleDir } from "./rule-sections-projection.ts"
export type { PromptRuleDescriptor } from "./rule-sections-contracts.ts"

/** Compose the three rule groups in the order their scope is explained to the model. */
export function RulesSection({
  globalRules,
  agentRequestableRules,
  userRules,
  readToolName,
  additionalUserRules = [],
}: {
  readonly globalRules: readonly PromptRuleDescriptor[]
  readonly agentRequestableRules: readonly PromptRuleDescriptor[]
  readonly userRules: readonly PromptRuleDescriptor[]
  readonly readToolName?: string | undefined
  readonly additionalUserRules?: readonly string[]
}): PromptNode {
  const hasUserRules = userRules.length > 0 || additionalUserRules.length > 0
  return jsxs("section", {
    title: "rules",
    children: [
      jsx("p", { children: "Workspace rules and user rules are shown separately. Some always apply, while others are read when they fit the task." }),
      jsx("br", {}),
      globalRules.length > 0 && renderAlwaysAppliedRules(globalRules),
      agentRequestableRules.length > 0 && renderRequestableRules(agentRequestableRules, readToolName),
      hasUserRules && renderUserRules(userRules, additionalUserRules),
      jsx("br", {}),
    ],
  })
}
