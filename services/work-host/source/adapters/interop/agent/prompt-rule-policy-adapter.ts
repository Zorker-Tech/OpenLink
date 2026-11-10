/** Apply Slate's prompt rule policy to the generated rule records before they reach the Agent action. */

import { CursorRuleSource, type CursorRule } from "../proto/generated/agent/v1/rules_pb.ts"

type RequestContextWithRules = {
  readonly rules: readonly CursorRule[]
  readonly disabledTeamRules: readonly string[]
}

type RuleFeatureFlags = {
  readonly dropCustomPromptContext?: boolean | undefined
}

/** Keep user rules, filter disabled team rules, and retain only the first duplicate team entry. */
export function getAllRules(
  requestContext: RequestContextWithRules,
  serverFetchedRules: readonly CursorRule[],
  featureFlags?: RuleFeatureFlags,
): CursorRule[] {
  if (featureFlags?.dropCustomPromptContext === true) return []
  const teamRuleName = (rule: CursorRule) => rule.fullPath.split("/").pop() ?? rule.fullPath
  const allRules = [...requestContext.rules, ...serverFetchedRules]
  const disabled = new Set(requestContext.disabledTeamRules)
  const enabledRules = allRules.filter(rule =>
    rule.source !== CursorRuleSource.TEAM || rule.isRequired || !disabled.has(teamRuleName(rule)))
  const seenTeamRules = new Set<string>()
  return enabledRules.filter(rule => {
    if (rule.source !== CursorRuleSource.TEAM) return true
    const name = teamRuleName(rule)
    if (seenTeamRules.has(name)) return false
    seenTeamRules.add(name)
    return true
  })
}
