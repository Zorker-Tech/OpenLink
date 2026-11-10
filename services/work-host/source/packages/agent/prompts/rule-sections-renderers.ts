import { jsx, jsxs, type PromptNode } from "../../prompt-jsx/index.ts"
import type { PromptRuleDescriptor } from "./rule-sections-contracts.ts"
import { getAgentRequestableRuleDescription, getRuleDir, getRuleGlobs } from "./rule-sections-projection.ts"

export function renderAlwaysAppliedRules(rules: readonly PromptRuleDescriptor[]): PromptNode {
  return jsx("section", {
    title: "always_applied_workspace_rules",
    description: "Apply each workspace rule in this section throughout the task.",
    children: rules.map(rule => {
      const globs = rule.type?.type?.case === "fileGlobbed" ? getRuleGlobs(rule) : undefined
      const scope = globs === undefined ? "" : `, glob pattern(s) for applicable files: ${globs.join(", ")}`
      return jsxs("x", { tag: "always_applied_workspace_rule", name: rule.fullPath, children: [rule.content, scope] })
    }),
  })
}

export function renderRequestableRules(rules: readonly PromptRuleDescriptor[], readToolName?: string): PromptNode {
  const instructions = readToolName === undefined
    ? "Read the full text from a rule's absolute path when it applies to the current task."
    : `When a rule applies, use ${readToolName} to read its full text from the absolute path shown.`

  return jsx("section", {
    title: "agent_requestable_workspace_rules",
    description: instructions,
    children: rules.map(rule => jsx("x", {
      tag: "agent_requestable_workspace_rule",
      fullPath: rule.fullPath,
      children: getAgentRequestableRuleDescription(rule, getRuleDir(rule.fullPath)),
    })),
  })
}

export function renderUserRules(rules: readonly PromptRuleDescriptor[], additionalRules: readonly string[]): PromptNode {
  return jsxs("section", {
    title: "user_rules",
    description: "Follow these user-provided rules when they apply to the current task.",
    children: [
      additionalRules.map(rule => jsx("x", { tag: "user_rule", children: rule })),
      rules.map(rule => jsx("x", { tag: "user_rule", children: rule.content })),
    ],
  })
}
