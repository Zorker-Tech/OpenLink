/**
 * Sorting what the user attached to a message into skills and ordinary rules.
 *
 * A message can carry attachments of several kinds, and the two that matter here are the same file
 * reached two ways: a rule is a rule, and a skill is a rule that lives at a SKILL.md path. Which field
 * an attachment arrives in changed once — skills used to come through the rule list and now have their
 * own — so both shapes are read, and the newer one wins when it is present, because a message that names
 * skills directly is not also expecting them to be inferred from paths.
 *
 * Whatever is not a skill is an ordinary rule and is rendered as one.
 */

interface SelectedContextRule {
  readonly fullPath?: string
  readonly content?: string
  readonly plugin?: unknown
  readonly marketplace?: unknown
  readonly pluginId?: unknown
  readonly marketplaceId?: unknown
}

interface SelectedContextCursorRule {
  readonly rule?: SelectedContextRule
}

interface SelectedContextSkill {
  readonly fullPath?: string
  readonly content?: string
  readonly plugin?: unknown
  readonly marketplace?: unknown
  readonly pluginId?: unknown
  readonly marketplaceId?: unknown
}

export interface SelectedContextSkillInput {
  readonly cursorRules?: readonly SelectedContextCursorRule[]
  readonly selectedSkills?: readonly SelectedContextSkill[]
}

export function resolveSelectedContextSkillSections(selectedContext: SelectedContextSkillInput): {
  selectedSkills: SelectedContextSkill[]
  regularRules: SelectedContextRule[]
} {
  const validRules = (selectedContext.cursorRules ?? [])
    .map(cursorRule => cursorRule.rule)
    .filter((rule): rule is SelectedContextRule =>
      rule !== undefined && rule.content !== undefined && rule.content.trim().length > 0)
  const hasSkillsField = (selectedContext.selectedSkills?.length ?? 0) > 0
  const selectedSkills = hasSkillsField
    ? (selectedContext.selectedSkills ?? [])
      .filter(skill => skill.content !== undefined && skill.content.trim().length > 0)
      .map(skill => ({
        fullPath: skill.fullPath ?? "",
        content: skill.content!,
        plugin: skill.plugin,
        marketplace: skill.marketplace,
        pluginId: skill.pluginId,
        marketplaceId: skill.marketplaceId,
      }))
    : validRules
      .filter(rule => isSelectedContextSkillFile(rule.fullPath))
      .map(rule => ({
        fullPath: rule.fullPath ?? "",
        content: rule.content ?? "",
        plugin: rule.plugin,
        marketplace: rule.marketplace,
        pluginId: rule.pluginId,
        marketplaceId: rule.marketplaceId,
      }))
  const regularRules = hasSkillsField
    ? validRules
    : validRules.filter(rule => !isSelectedContextSkillFile(rule.fullPath))
  return { selectedSkills, regularRules }
}

function isSelectedContextSkillFile(fullPath: string | undefined): boolean {
  if (!fullPath) return false
  const normalizedPath = fullPath.replace(/\\/g, "/")
  return normalizedPath.endsWith("/SKILL.md") || normalizedPath === "SKILL.md"
}
