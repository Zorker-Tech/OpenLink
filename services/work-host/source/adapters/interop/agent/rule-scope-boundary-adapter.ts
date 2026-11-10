import path from "node:path"

import type { CursorRule } from "../proto/generated/agent/v1/rules_pb.ts"
import { normalizeToUnixPath } from "../../../packages/utils/paths.ts"
import type { RuleScopeLocation } from "../../../packages/agent/utils/rule-matching-policy.ts"

const RULES_DIRECTORY_MARKER = ".cursor/rules"
const RULES_DIRECTORY_PARTS = RULES_DIRECTORY_MARKER.split("/")

function ruleDirectoryFromCounterpartPath(rulePath: string): string {
  const normalizedPath = normalizeToUnixPath(rulePath)
  const ruleFolder = path.posix.normalize(path.posix.dirname(normalizedPath))
  const segments = ruleFolder.split("/")

  for (let index = segments.length - 2; index >= 0; index--) {
    if (segments[index] === RULES_DIRECTORY_PARTS[0] && segments[index + 1] === RULES_DIRECTORY_PARTS[1]) {
      const workspaceSegments = segments.slice(0, index)
      return workspaceSegments.length === 0 ? "/" : workspaceSegments.join("/")
    }
  }
  return ruleFolder
}

export function projectCounterpartRuleLocation(value: unknown): RuleScopeLocation {
  if (typeof value !== "object" || value === null) return { scope: "other" }
  const rule = value as CursorRule
  const typeCase = rule.type?.type?.case
  const scope = typeCase === "fileGlobbed"
    ? "file-pattern"
    : typeCase === "global"
      ? "global"
      : "other"
  if (!rule.fullPath) return { scope }
  return { scope, directory: ruleDirectoryFromCounterpartPath(rule.fullPath) }
}
