/**
 * Two things a rule's own text decides about it.
 *
 * A rule can live at a path that means it is really a skill, and a skill is a procedure the model reads
 * on demand rather than a rule that is always in force — so where a rule sits changes how it is
 * presented. The recognized locations are the ones skills are written in by the tools people already
 * use, which is why they are matched as paths rather than as our own convention: the platform reads a
 * workspace as it is, not as we would have laid it out.
 *
 * A rule can also refuse to be offered to the model at all, which it says in its frontmatter. A file
 * that cannot be parsed has not refused anything, so a broken rule stays visible rather than silently
 * disappearing.
 */

import grayMatter from "gray-matter"
import { minimatch } from "minimatch"

const SKILL_PATH_PATTERNS = [
  "**/.cursor/skills/**",
  "**/.cursor/skills-cursor/**",
  "**/.claude/skills/**",
  "**/.codex/skills/**",
  "**/.claude/plugins/**",
  "**/.agents/skills/**",
  "**/SKILL.md",
  "**/.cursor/plugins/cache/**/skills/**",
]

export function isSkillPath(path: string): boolean {
  const normalizedPath = path.replace(/\\/g, "/")
  return SKILL_PATH_PATTERNS.some(pattern => minimatch(normalizedPath, pattern, { dot: true }))
}

export interface RuleContent {
  readonly content?: string | undefined
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
