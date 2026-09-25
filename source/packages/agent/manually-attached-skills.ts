/**
 * The skills a user attached to a single message.
 *
 * Attaching a skill is a way of saying "use this procedure for this request", so the content is inlined
 * into the message rather than described and left to be fetched: the user asked for it to be used, and a
 * round trip to read it would be a round trip the user did not ask for. The frontmatter is stripped
 * because it is metadata about the skill, not part of its instructions, and the content is capped so one
 * attached file cannot take over the message.
 *
 * The skill's name is taken from its own directory rather than from its frontmatter, since that is the
 * name the user would recognize from the path they attached.
 */

import grayMatter from "gray-matter"

type GrayMatterParser = (content: string) => { content: string }
const parseGrayMatter = grayMatter as GrayMatterParser

const MAX_SKILL_CONTENT_LENGTH = 100_000

export interface ManuallyAttachedSkill {
  readonly fullPath: string
  readonly content: string
}

export function renderManuallyAttachedSkillsSection(
  selectedSkills: readonly ManuallyAttachedSkill[],
): string | undefined {
  if (selectedSkills.length === 0) return undefined
  const prefix = `<manually_attached_skills>
The user has manually attached the following skills to their message.
These skills contain specific instructions or workflows that the user wants you to follow for this request.
Only read the files if needed, the full skill content is inlined here.
`
  const suffix = `</manually_attached_skills>`
  const skillsText = selectedSkills.map(skill => renderManuallyAttachedSkillEntry(skill)).join("\n\n---\n\n")
  return `${prefix}
${skillsText}
${suffix}

`
}

function renderManuallyAttachedSkillEntry(skill: ManuallyAttachedSkill): string {
  const fullPath = skill.fullPath
  const normalizedPath = fullPath.replace(/\\/g, "/")
  const pathParts = normalizedPath.split("/")
  const skillMdIndex = pathParts.indexOf("SKILL.md")
  const skillName = skillMdIndex > 0 ? pathParts[skillMdIndex - 1] : "Skill"
  const content = parseGrayMatter(skill.content).content.trim().slice(0, MAX_SKILL_CONTENT_LENGTH)
  return `Skill Name: ${skillName}
Path: ${fullPath}
SKILL.md content:
${content}`
}
