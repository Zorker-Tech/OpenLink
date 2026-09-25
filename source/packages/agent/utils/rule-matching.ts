/**
 * Which rules a workspace actually applies to a file.
 *
 * A rule is either attached to file patterns or global to its directory, and a global rule that lives
 * *below* the workspace root is really a rule for the subtree it sits in — which is the distinction
 * that decides whether it is offered for a given file. The rule's own directory is found by walking up
 * to the rules directory rather than by trusting the path it was reported with.
 */

import path from "node:path"

import { normalizeToUnixPath } from "../../utils/paths.ts"

export interface RulePathInput {
  readonly fullPath?: string | undefined
  readonly type?: {
    readonly type: {
      readonly case?: string | undefined
    }
  } | undefined
}

const SEP = "/"
/** The directory rules live in on disk; it is the workspace's convention, not ours to rename. */
const RULES_SEGMENT = ".cursor/rules"

const normalizePath = (value: string): string => {
  const normalized = path.posix.normalize(normalizeToUnixPath(value))
  if (normalized === SEP) return SEP
  return normalized.replace(/\/+$/, "")
}

/** The directory a rule belongs to: the workspace root above its rules directory. */
function getRuleDir(rulePath: string): string {
  const normalizedPath = normalizeToUnixPath(rulePath)
  const literalRuleDir = path.posix.normalize(path.posix.dirname(normalizedPath))
  const segments = literalRuleDir.split(SEP)
  for (let index = segments.length - 2; index >= 0; index--) {
    if (segments[index] === ".cursor" && segments[index + 1] === "rules") {
      const parentSegments = segments.slice(0, index)
      return parentSegments.length === 0 ? SEP : parentSegments.join(SEP)
    }
  }
  return literalRuleDir
}

function isPathWithinDir(pathValue: string, dir: string): boolean {
  const normalizedDir = normalizePath(dir)
  if (normalizedDir === SEP) return pathValue.startsWith(SEP)
  return pathValue === normalizedDir || pathValue.startsWith(`${normalizedDir}/`)
}

function isNestedGlobalRule(rule: RulePathInput, workspacePaths: readonly string[]): boolean {
  if (rule.type?.type.case !== "global" || !rule.fullPath) return false
  const ruleDir = normalizePath(getRuleDir(rule.fullPath))
  const containingRoot = workspacePaths.map(normalizePath).find(root => isPathWithinDir(ruleDir, root))
  if (!containingRoot) return false
  return ruleDir !== containingRoot
}

export function isFileScopedRule(rule: RulePathInput, workspacePaths: readonly string[]): boolean {
  if (rule.type?.type.case === "fileGlobbed") return true
  if (rule.type?.type.case !== "global") return false
  return isNestedGlobalRule(rule, workspacePaths)
}
