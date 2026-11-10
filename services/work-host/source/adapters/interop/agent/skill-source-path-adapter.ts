/** Projects external skill-directory conventions into Slate's source categories. */

import type { SkillSource } from "../../../packages/agent/utils/common-helpers.ts"

export function classifyInteropSkillSourcePath(fullPath: string): SkillSource {
  const portablePath = fullPath.replace(/\\/g, "/")
  if (portablePath.includes("/.cursor/skills-cursor/")) return "builtin"
  if (portablePath.includes("/.cursor/plugins/") || portablePath.includes("/.claude/plugins/")) return "plugin"
  if (portablePath.includes("/.claude/skills/")) return "other-tool"
  if (portablePath.includes("/.cursor/skills/") || portablePath.includes("/.agents/skills/")) return "workspace"
  return "unknown"
}
