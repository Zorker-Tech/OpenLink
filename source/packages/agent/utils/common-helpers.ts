/**
 * Small helpers the agent's prompt assembly keeps needing.
 *
 * Each one exists because the same three-line decision was being made in several places: what a rule
 * file is called without its extension, what the first real line of a file is (the title, for a rule
 * or a skill), how full a context window is, and where a skill came from — which decides whether the
 * user may edit it.
 */

export function getFilenameWithoutExtension(filePath: string): string {
  const lastSeparator = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"))
  const filename = lastSeparator >= 0 ? filePath.substring(lastSeparator + 1) : filePath
  if (filename.toLowerCase().endsWith(".mdc")) return filename.substring(0, filename.length - 4)
  return filename
}

/** The first line that has content: a rule's title, a skill's summary. */
export function getFirstNonEmptyLine(content: string): string {
  return content.split("\n").find(line => line.trim().length > 0) ?? ""
}

export function getContextUsageInfo(tokenDetails: {
  maxTokens: number
  usedTokens: number
}): {
  contextWindowSize: number
  contextTokens: number
  contextUsagePercent: number
} {
  const contextWindowSize = tokenDetails.maxTokens
  const contextTokens = tokenDetails.usedTokens
  const contextUsagePercent = contextWindowSize > 0 ? (contextTokens / contextWindowSize) * 100 : 0
  return { contextWindowSize, contextTokens, contextUsagePercent }
}

export type SkillSource = "builtin" | "plugin" | "workspace" | "unknown"

/**
 * Where a skill lives decides who may change it: ours (builtin), installed as a package (plugin), or
 * the user's own workspace.
 */
export function getSkillSourceFromPath(fullPath: string): SkillSource {
  const normalizedPath = fullPath.replace(/\\/g, "/")
  if (normalizedPath.includes("/.slate/skills-builtin/")) return "builtin"
  if (normalizedPath.includes("/.slate/plugins/")) return "plugin"
  if (normalizedPath.includes("/.slate/skills/") || normalizedPath.includes("/.agents/skills/")) return "workspace"
  return "unknown"
}

export function isHookStepConfigured(configuredSteps: readonly string[] | undefined, step: string): boolean {
  if (configuredSteps === undefined) return false
  return configuredSteps.includes(step)
}
