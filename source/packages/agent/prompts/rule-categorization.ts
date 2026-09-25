/**
 * Sorting the rules a session has into the groups the prompt presents them in.
 *
 * A rule is not one thing. Some are always in force and belong in the prompt's own text; some are
 * offered to the model and read only when it asks; some belong to the user rather than to the project;
 * and the ones that are really skills are procedures to be read on demand. Which group a rule lands in
 * is decided by where it came from, where it lives, and whether it applies to the files this workspace
 * has — a file-scoped rule with no matching files is not in force anywhere.
 *
 * A rule scoped to a different environment is dropped before any of this, and a rule the user attached
 * by hand is not offered for the model to request: they already chose it.
 */

import { CursorRuleSource, type CursorRule } from "../../proto/generated/agent/v1/rules_pb.ts"
import { filterByAgentEnvironment } from "../utils/environment-filtering.ts"
import { isFileScopedRule } from "../utils/rule-matching.ts"
import { AgentType } from "../utils/agent-config.ts"
import { hasDisableModelInvocation, isSkillPath } from "./rule-predicates.ts"

export interface CategorizedRules {
  readonly globalRules: CursorRule[]
  readonly agentRequestableRules: CursorRule[]
  readonly userRules: CursorRule[]
  readonly skills: CursorRule[]
}

export function categorizeCursorRules(
  cursorRules: CursorRule[],
  workspacePaths: readonly string[] = [],
  agentType?: AgentType,
): CategorizedRules {
  const filteredRules = filterByAgentEnvironment(cursorRules, agentType)
  const globalRules: CursorRule[] = []
  const agentRequestableRules: CursorRule[] = []
  const userRules: CursorRule[] = []
  const skills: CursorRule[] = []
  for (const rule of filteredRules) {
    if (isSkillPath(rule.fullPath)) {
      // A skill that is always in force is a global rule; one that refused invocation is not offered.
      if (rule.type?.type.case === "global") globalRules.push(rule)
      else if (!hasDisableModelInvocation(rule)) skills.push(rule)
      continue
    }
    if (rule.source === CursorRuleSource.USER) {
      userRules.push(rule)
      continue
    }
    if (rule.source === CursorRuleSource.TEAM) {
      globalRules.push(rule)
      continue
    }
    if (rule.type?.type.case === "manuallyAttached") continue
    if (rule.type?.type.case !== "global") {
      agentRequestableRules.push(rule)
      continue
    }
    if (isFileScopedRule(rule, workspacePaths)) agentRequestableRules.push(rule)
    else globalRules.push(rule)
  }
  return { globalRules, agentRequestableRules, userRules, skills }
}
