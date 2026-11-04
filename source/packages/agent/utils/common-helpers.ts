/** Small transformations shared by agent prompt assembly and tool configuration. */

const RULE_MARKUP_EXTENSION = ".mdc"

export function getFilenameWithoutExtension(filePath: string): string {
  const separator = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"))
  const name = filePath.slice(separator + 1)
  return name.toLowerCase().endsWith(RULE_MARKUP_EXTENSION)
    ? name.slice(0, -RULE_MARKUP_EXTENSION.length)
    : name
}

export function getFirstNonEmptyLine(content: string): string {
  for (const line of content.split("\n")) {
    if (line.trim().length > 0) return line
  }
  return ""
}

export function getContextUsageInfo(tokenDetails: {
  maxTokens: number
  usedTokens: number
}): {
  contextWindowSize: number
  contextTokens: number
  contextUsagePercent: number
} {
  const { maxTokens, usedTokens } = tokenDetails
  return {
    contextWindowSize: maxTokens,
    contextTokens: usedTokens,
    contextUsagePercent: maxTokens > 0 ? (usedTokens / maxTokens) * 100 : 0,
  }
}

export type SkillSource = "builtin" | "plugin" | "other-tool" | "workspace" | "unknown"

export function isHookStepConfigured(configuredSteps: readonly string[] | undefined, step: string): boolean {
  return configuredSteps === undefined ? false : configuredSteps.includes(step)
}
