/** Classify rule content and the paths where skill files are stored. */

import grayMatter from "gray-matter";
import { isInteropSkillPath } from "../../../adapters/interop/agent/skill-path-layout-adapter.ts";

export function isSkillPath(path: string): boolean {
  return isInteropSkillPath(path);
}

export interface RuleContent {
  readonly content?: string | null | undefined
}

export function hasDisableModelInvocation(rule: RuleContent): boolean {
  if (!rule.content) return false
  try {
    const parsed = grayMatter(rule.content)
    return parsed.data?.["disable-model-invocation"] === true
  } catch {
    return false
  }
}
