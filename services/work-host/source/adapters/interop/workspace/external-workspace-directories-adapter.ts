/**
 * Workspace directories written by other agent hosts.
 *
 * Slate reads its own rules and skills from its own directories. Repositories and plugin bundles prepared
 * for other hosts are still recognized here, so the product modules only deal in Slate's names.
 */

export const EXTERNAL_RULE_DIRECTORIES = [".cursor/rules", ".claude/rules", ".agents/rules"] as const

export const EXTERNAL_SKILL_DIRECTORY_MARKERS = [
  "/.cursor/skills/",
  "/.cursor/skills-cursor/",
  "/.agents/skills/",
  "/.claude/skills/",
  "/.codex/skills/",
  "/.claude/plugins/",
] as const

export const EXTERNAL_SKILL_DIRECTORY_SEGMENTS = [
  [".cursor", "skills"],
  [".cursor", "skills-cursor"],
  [".agents", "skills"],
  [".claude", "skills"],
  [".codex", "skills"],
] as const

export const EXTERNAL_PLUGIN_CACHE_SKILLS_MARKER = "/.cursor/plugins/cache/"
