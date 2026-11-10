import path from "node:path"

import { normalizeToUnixPath } from "../../utils/paths.ts"
import { getFirstNonEmptyLine } from "../utils/common-helpers.ts"
import type { PromptRuleDescriptor } from "./rule-sections-contracts.ts"
import { SLATE_RULES_DIRECTORY } from "../workspace-conventions.ts"
import { EXTERNAL_RULE_DIRECTORIES } from "../../../adapters/interop/workspace/external-workspace-directories-adapter.ts"

const separator = "/"
const RULE_DIRECTORY_PARTS = [SLATE_RULES_DIRECTORY, ...EXTERNAL_RULE_DIRECTORIES].map(directory => directory.split(separator))

function valueRecord(rule: PromptRuleDescriptor): Record<string, unknown> | undefined {
  const value = rule.type?.type?.value
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined
}

export function getRuleGlobs(rule: PromptRuleDescriptor): readonly string[] | undefined {
  const globs = valueRecord(rule)?.globs
  return Array.isArray(globs) ? globs as string[] : undefined
}

/** Resolve the workspace root associated with a rule file, or keep its containing directory. */
export function getRuleDir(fullPath: string): string {
  const normalizedFile = normalizeToUnixPath(fullPath)
  const containingDirectory = normalizeToUnixPath(path.normalize(path.dirname(normalizedFile)))
  const segments = containingDirectory.split(separator)

  for (let cursor = segments.length - 2; cursor >= 0; cursor -= 1) {
    const matched = RULE_DIRECTORY_PARTS.some(parts =>
      parts.every((part, offset) => segments[cursor + offset] === part))
    if (!matched) continue
    const project = segments.slice(0, cursor)
    return project.length === 0 ? separator : project.join(separator)
  }
  return containingDirectory
}

/** Summarize why a rule applies and the path from which the full text can be read. */
export function getAgentRequestableRuleDescription(rule: PromptRuleDescriptor, ruleDir: string): string | undefined {
  const selected = rule.type?.type
  if (selected?.case === "fileGlobbed") {
    const patterns = (getRuleGlobs(rule) ?? []).join(", ")
    return `${getFirstNonEmptyLine(rule.content ?? "")}, glob pattern(s) for applicable files: ${patterns}`
  }
  if (selected?.case === "agentFetched") {
    const description = valueRecord(rule)?.description
    return typeof description === "string" ? description : undefined
  }
  if (selected?.case === "global") {
    return `${getFirstNonEmptyLine(rule.content ?? "")}, applicable for all files within ${ruleDir}`
  }
  return undefined
}
