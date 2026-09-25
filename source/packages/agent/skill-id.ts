/**
 * A skill's identifier, taken from where it lives.
 *
 * The identifier is what the platform records when a skill is used, so it has to be stable and derived
 * rather than stored: it is the skill's own directory name, with the file name and any trailing separator
 * removed. A path that names no directory falls back to the word the record needs rather than to an empty
 * identifier, because an empty one would be indistinguishable from a skill that was never used.
 */

export function getSkillIdFromPath(fullPath: string): string {
  const normalizedPath = fullPath.replace(/\\/g, "/").replace(/\/+$/, "")
  const withoutSkillSuffix = normalizedPath.replace(/\/SKILL\.md$/i, "")
  const pathParts = withoutSkillSuffix.split("/").filter(Boolean)
  return pathParts[pathParts.length - 1] ?? "Skill"
}
