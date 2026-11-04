/** Recognize skill files stored in supported external workspace layouts. */

import { minimatch } from "minimatch";

const SKILL_LAYOUT_PATTERNS = [
  "**/.cursor/skills/**",
  "**/.cursor/skills-cursor/**",
  "**/.claude/skills/**",
  "**/.codex/skills/**",
  "**/.agents/skills/**",
  "**/.claude/plugins/**",
  "**/.cursor/plugins/cache/**/skills/**",
  "**/SKILL.md",
];

export function isInteropSkillPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return SKILL_LAYOUT_PATTERNS.some((pattern) => minimatch(normalized, pattern, { dot: true }));
}
