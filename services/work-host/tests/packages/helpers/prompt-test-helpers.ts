/**
 * Helpers the prompt checks share.
 *
 * A skill's own name is what the budget protects by, and it is derived from the path the same way in
 * the module under test; the check needs the same derivation to name what it expected to survive.
 */
export function getSkillNameForTest(fullPath: string): string {
  const parts = fullPath.replace(/\\/g, "/").split("/")
  const last = parts[parts.length - 1] ?? ""
  if (last === "SKILL.md" && parts.length >= 2) return parts[parts.length - 2] ?? ""
  return last
}
