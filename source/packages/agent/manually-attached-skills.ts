import grayMatter from "gray-matter";

type MatterReader = (source: string) => { content: string };
const readSkillFrontmatter = grayMatter as MatterReader;

const MAX_INLINE_SKILL_CHARS = 100_000;
const SKILL_ENTRY_SEPARATOR = "\n\n---\n\n";

export interface ManuallyAttachedSkill {
  readonly fullPath: string;
  readonly content: string;
}

function skillNameFromPath(fullPath: string): string {
  const pathSegments = fullPath.replace(/\\/g, "/").split("/");
  const marker = pathSegments.indexOf("SKILL.md");
  return marker > 0 ? pathSegments[marker - 1] ?? "Skill" : "Skill";
}

function instructionsFromFile(source: string): string {
  return readSkillFrontmatter(source).content.trim().slice(0, MAX_INLINE_SKILL_CHARS);
}

function formatSkillEntry(skill: ManuallyAttachedSkill): string {
  const name = skillNameFromPath(skill.fullPath);
  const instructions = instructionsFromFile(skill.content);
  return [`### ${name}`, `File: ${skill.fullPath}`, "", instructions].join("\n");
}

/** Inline attached instructions in their original order so the agent can follow them without a new file read. */
export function renderManuallyAttachedSkillsSection(
  selectedSkills: readonly ManuallyAttachedSkill[],
): string | undefined {
  if (selectedSkills.length === 0) return undefined;

  const entries = selectedSkills.map(formatSkillEntry).join(SKILL_ENTRY_SEPARATOR);
  return [
    "<manually_attached_skills>",
    "Use these user-attached instructions for this request. Their full text is included below.",
    "Follow referenced files only when the attached instructions require them.",
    "",
    entries,
    "</manually_attached_skills>",
    "",
    "",
  ].join("\n");
}
