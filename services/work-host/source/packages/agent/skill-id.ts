/**
 * A skill's identifier, taken from where it lives.
 *
 * The identifier is what the platform records when a skill is used, so it has to be stable and derived rather than
 * stored: it is the skill's own directory name, with the file name and any trailing separator removed. A path that
 * names no directory falls back to the word the record needs rather than to an empty identifier, because an empty one
 * would be indistinguishable from a skill that was never used.
 */

/** A skill is described by a SKILL.md file, whatever case it is written in. */
const SKILL_FILE_SUFFIX = /\/SKILL\.md$/i;

/** A path may come with either kind of separator, and with any number of trailing ones. */
const BACKSLASH = /\\/g;
const TRAILING_SEPARATORS = /\/+$/;

/** The identifier a path that names no directory falls back to. */
const FALLBACK_SKILL_ID = "Skill";

/** The identifier of the skill whose file is at this path: its directory's name, or the fallback. */
export function getSkillIdFromPath(fullPath: string): string {
  const asPosixPath = fullPath.replace(BACKSLASH, "/");
  const withoutTrailingSeparators = asPosixPath.replace(TRAILING_SEPARATORS, "");
  const withoutSkillFile = withoutTrailingSeparators.replace(SKILL_FILE_SUFFIX, "");
  const directorySegments = withoutSkillFile.split("/").filter(Boolean);
  return directorySegments[directorySegments.length - 1] ?? FALLBACK_SKILL_ID;
}
