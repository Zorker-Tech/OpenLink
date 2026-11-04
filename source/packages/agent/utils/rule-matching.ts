import { projectCounterpartRuleLocation } from "../../../adapters/interop/agent/rule-scope-boundary-adapter.ts"
import { isFileScopedRuleLocation } from "./rule-matching-policy.ts"

export type { RuleScopeLocation as RulePathInput } from "./rule-matching-policy.ts"

export function isFileScopedRule(rule: unknown, workspacePaths: readonly string[]): boolean {
  return isFileScopedRuleLocation(projectCounterpartRuleLocation(rule), workspacePaths)
}
