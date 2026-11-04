import path from "node:path"

import { normalizeToUnixPath } from "../../utils/paths.ts"

export type RuleScope = "file-pattern" | "global" | "other"

export interface RuleScopeLocation {
  readonly scope: RuleScope
  readonly directory?: string | undefined
}

function normalizePath(value: string): string {
  const normalized = path.posix.normalize(normalizeToUnixPath(value))
  if (normalized === "/") return "/"
  return normalized.replace(/\/+$/, "")
}

function pathIsWithin(pathValue: string, directory: string): boolean {
  if (directory === "/") return pathValue.startsWith("/")
  return pathValue === directory || pathValue.startsWith(`${directory}/`)
}

export function isFileScopedRuleLocation(
  rule: RuleScopeLocation,
  workspacePaths: readonly string[],
): boolean {
  if (rule.scope === "file-pattern") return true
  if (rule.scope !== "global" || rule.directory === undefined) return false

  const ruleDirectory = normalizePath(rule.directory)
  const workspaceRoot = workspacePaths
    .map(normalizePath)
    .find(root => pathIsWithin(ruleDirectory, root))
  return workspaceRoot !== undefined && ruleDirectory !== workspaceRoot
}
