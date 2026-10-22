/**
 * Keeping the skill catalogue inside its share of the prompt.
 *
 * A workspace can hold hundreds of skills, and listing them all with their descriptions would take more
 * of the prompt than the work itself. The catalogue is therefore given a small fraction of the model's
 * limit, and three things happen in order when it does not fit: descriptions are shortened, then dropped
 * entirely, and only then are skills left out — with a notice naming the directories they were left in,
 * so the model knows where to look if a later task needs one.
 *
 * Two skills are never dropped (the canvas and environment-setup skills, which the platform relies on
 * being reachable), and a session can protect one more. Shortening is a binary search rather than a
 * guess: the longest description that fits the budget is the one used.
 */

import { renderContent } from "../../prompt-jsx/index.ts"
import type { PromptNode } from "../../prompt-jsx/index.ts"
import { estimateStringTokenCount } from "../utils/token-estimate.ts"

interface SkillCatalogItem {
  readonly fullPath: string
  readonly description?: string | undefined
}

interface ApplySkillCatalogBudgetInput {
  readonly skills: readonly SkillCatalogItem[]
  readonly agentTokenLimit?: number | undefined
  readonly renderSection: (skills: readonly SkillCatalogItem[], omittedNotice?: PromptNode) => PromptNode
  readonly renderOmittedNotice?: ((directories: readonly string[], omittedCount: number) => PromptNode) | undefined
  readonly protectLoopSkill?: boolean | undefined
}

interface SkillCatalogBudgetResult {
  readonly section: PromptNode
  readonly skillItems: readonly SkillCatalogItem[]
  readonly retainedCount: number
  readonly omittedCount: number
  readonly omittedDirectories: readonly string[]
  readonly renderedEstimatedTokens: number
  readonly uncappedEstimatedTokens: number
  readonly strategy: SkillCatalogBudgetStrategy
}

interface TruncatedDescriptionsResult {
  readonly section: PromptNode
  readonly skillItems: readonly SkillCatalogItem[]
  readonly renderedEstimatedTokens: number
}

/** Which of the three fits the catalogue ended up in: it was under budget, shortened, dropped or omitted. */
type SkillCatalogBudgetStrategy = "under_budget" | "shortened_descriptions" | "dropped_descriptions" | "omitted_skills"

const INITIAL_SKILL_CATALOG_CONTEXT_FRACTION = 0.02
const FALLBACK_AGENT_TOKEN_LIMIT = 200_000
const TRUNCATED_DESCRIPTION_SUFFIX = "..."
const MIN_TRUNCATED_DESCRIPTION_LENGTH = 24
const MAX_TRUNCATED_DESCRIPTION_LENGTH = 480
const SHORT_DESCRIPTION_PATH_ONLY_THRESHOLD = 80
const MAX_OMITTED_DIRECTORY_COUNT = 5
const PROTECTED_SKILL_NAMES = new Set(["canvas", "env-setup"])
const LOOP_PROTECTED_SKILL_NAMES = new Set(["loop"])

/** The token limit the catalogue is budgeted against: the agent's own, or the fallback. */
function effectiveTokenLimit(agentTokenLimit: number | undefined): number {
  return agentTokenLimit !== undefined && agentTokenLimit > 0 ? agentTokenLimit : FALLBACK_AGENT_TOKEN_LIMIT
}

/** The catalogue's own share of the model's limit, in tokens. */
function catalogueBudgetTokens(agentTokenLimit: number | undefined): number {
  return Math.floor(effectiveTokenLimit(agentTokenLimit) * INITIAL_SKILL_CATALOG_CONTEXT_FRACTION)
}

/** The tokens a rendered section is estimated to take. */
function estimatedTokens(section: PromptNode): number {
  return estimateStringTokenCount(renderContent(section))
}

/** The protection rule: the platform's own skills, plus the loop skill when the session protects it. */
function protectionRule(protectLoopSkill: boolean | undefined): (skill: SkillCatalogItem) => boolean {
  if (protectLoopSkill !== true) return isProtectedSkill
  return (skill: SkillCatalogItem) => isProtectedSkill(skill) || LOOP_PROTECTED_SKILL_NAMES.has(getSkillName(skill.fullPath))
}

/** The skills with their descriptions dropped, except the protected ones. */
function pathOnlySkillsFor(skills: readonly SkillCatalogItem[], isProtected: (skill: SkillCatalogItem) => boolean): readonly SkillCatalogItem[] {
  return skills.map((skill) => isProtected(skill) ? skill : { fullPath: skill.fullPath, description: undefined })
}

/** One budget answer, with the counts the caller reports. */
function budgetResult(args: { readonly section: PromptNode; readonly skillItems: readonly SkillCatalogItem[]; readonly omittedCount: number; readonly omittedDirectories: readonly string[]; readonly renderedEstimatedTokens: number; readonly uncappedEstimatedTokens: number; readonly strategy: SkillCatalogBudgetResult["strategy"] }): SkillCatalogBudgetResult {
  return {
    section: args.section,
    skillItems: args.skillItems,
    retainedCount: args.skillItems.length,
    omittedCount: args.omittedCount,
    omittedDirectories: args.omittedDirectories,
    renderedEstimatedTokens: args.renderedEstimatedTokens,
    uncappedEstimatedTokens: args.uncappedEstimatedTokens,
    strategy: args.strategy,
  }
}

export function applySkillCatalogBudget({
  skills,
  agentTokenLimit,
  renderSection,
  renderOmittedNotice,
  protectLoopSkill,
}: ApplySkillCatalogBudgetInput): SkillCatalogBudgetResult {
  const uncappedSection = renderSection(skills)
  const uncappedEstimatedTokens = estimatedTokens(uncappedSection)
  const isProtected = protectionRule(protectLoopSkill)
  const budgetTokens = catalogueBudgetTokens(agentTokenLimit)
  if (uncappedEstimatedTokens <= budgetTokens) {
    return budgetResult({ section: uncappedSection, skillItems: skills, omittedCount: 0, omittedDirectories: [], renderedEstimatedTokens: uncappedEstimatedTokens, uncappedEstimatedTokens, strategy: "under_budget" })
  }
  const truncatedDescriptions = truncateDescriptionsToFit({ skills, budgetTokens, renderSection, isProtected })
  if (truncatedDescriptions !== undefined) {
    return budgetResult({ section: truncatedDescriptions.section, skillItems: truncatedDescriptions.skillItems, omittedCount: 0, omittedDirectories: [], renderedEstimatedTokens: truncatedDescriptions.renderedEstimatedTokens, uncappedEstimatedTokens, strategy: "shortened_descriptions" })
  }
  const pathOnlySkills = pathOnlySkillsFor(skills, isProtected)
  const pathOnlySection = renderSection(pathOnlySkills)
  const pathOnlyEstimatedTokens = estimatedTokens(pathOnlySection)
  if (pathOnlyEstimatedTokens <= budgetTokens) {
    return budgetResult({ section: pathOnlySection, skillItems: pathOnlySkills, omittedCount: 0, omittedDirectories: [], renderedEstimatedTokens: pathOnlyEstimatedTokens, uncappedEstimatedTokens, strategy: "dropped_descriptions" })
  }
  return omitSkillsToFit({
    pathOnlySkills,
    allSkills: skills,
    budgetTokens,
    uncappedEstimatedTokens,
    renderSection,
    renderOmittedNotice,
    isProtected,
  })
}

/** The skills a pass keeps and the ones it leaves out, by the indices it retains. */
function splitByRetainedIndices(allSkills: readonly SkillCatalogItem[], pathOnlySkills: readonly SkillCatalogItem[], retainedIndices: ReadonlySet<number>, isProtected: (skill: SkillCatalogItem) => boolean): { readonly retained: SkillCatalogItem[]; readonly omitted: SkillCatalogItem[] } {
  const retained: SkillCatalogItem[] = []
  const omitted: SkillCatalogItem[] = []
  for (let index = 0; index < allSkills.length; index++) {
    if (isProtected(allSkills[index]!) || retainedIndices.has(index)) retained.push(pathOnlySkills[index]!)
    else omitted.push(allSkills[index]!)
  }
  return { retained, omitted }
}

/** The notice naming where the left-out skills live, when the call supplies a renderer for it. */
function omittedNoticeFor(omittedSkills: readonly SkillCatalogItem[], cappedDirectories: readonly string[], renderOmittedNotice: ApplySkillCatalogBudgetInput["renderOmittedNotice"]): PromptNode | undefined {
  if (renderOmittedNotice === undefined || omittedSkills.length === 0) return undefined
  return renderOmittedNotice(cappedDirectories, omittedSkills.length)
}

/** The longest description in the catalogue, or zero when none of the droppable skills has one. */
function longestDescriptionLength(skills: readonly SkillCatalogItem[], isProtected: (skill: SkillCatalogItem) => boolean): number {
  return skills.reduce((longest, skill) => isProtected(skill) ? longest : Math.max(longest, skill.description?.length ?? 0), 0)
}

/** The catalogue with every unprotected description cut to this length. */
function withDescriptionsAtLength(skills: readonly SkillCatalogItem[], isProtected: (skill: SkillCatalogItem) => boolean, maxLength: number): readonly SkillCatalogItem[] {
  return skills.map((skill) => isProtected(skill) ? skill : { fullPath: skill.fullPath, description: truncateDescription(skill.description, maxLength) })
}

/** The indices of the skills that may be left out: every skill the protection rule does not keep. */
function droppableIndicesFor(skills: readonly SkillCatalogItem[], isProtected: (skill: SkillCatalogItem) => boolean): number[] {
  const indices: number[] = []
  for (let index = 0; index < skills.length; index++) if (!isProtected(skills[index]!)) indices.push(index)
  return indices
}

/** One candidate truncation, rendered and measured: the answer at that description length. */
function truncationAtLength(skills: readonly SkillCatalogItem[], isProtected: (skill: SkillCatalogItem) => boolean, maxLength: number, renderSection: ApplySkillCatalogBudgetInput["renderSection"]): TruncatedDescriptionsResult {
  const skillItems = withDescriptionsAtLength(skills, isProtected, maxLength)
  const section = renderSection(skillItems)
  return { section, skillItems, renderedEstimatedTokens: estimatedTokens(section) }
}

/** The longest truncation that fits, found by binary search over the description length. */
function truncateDescriptionsToFit({ skills, budgetTokens, renderSection, isProtected }: {
  readonly skills: readonly SkillCatalogItem[]
  readonly budgetTokens: number
  readonly renderSection: ApplySkillCatalogBudgetInput["renderSection"]
  readonly isProtected: (skill: SkillCatalogItem) => boolean
}): TruncatedDescriptionsResult | undefined {
  const maxDescriptionLength = longestDescriptionLength(skills, isProtected)
  // Nothing long enough to be worth shortening: dropping the descriptions is the next step instead.
  if (maxDescriptionLength <= SHORT_DESCRIPTION_PATH_ONLY_THRESHOLD) return undefined
  let bestFit: TruncatedDescriptionsResult | undefined
  let lowerBound = MIN_TRUNCATED_DESCRIPTION_LENGTH
  let upperBound = Math.min(maxDescriptionLength - 1, MAX_TRUNCATED_DESCRIPTION_LENGTH)
  while (lowerBound <= upperBound) {
    const midpoint = Math.floor((lowerBound + upperBound) / 2)
    const candidate = truncationAtLength(skills, isProtected, midpoint, renderSection)
    if (candidate.renderedEstimatedTokens <= budgetTokens) {
      bestFit = candidate
      lowerBound = midpoint + 1
    } else {
      upperBound = midpoint - 1
    }
  }
  return bestFit
}

/** Leaving skills out: protected ones stay, and the rest are kept in order until the budget is met. */
function omitSkillsToFit({ pathOnlySkills, allSkills, budgetTokens, uncappedEstimatedTokens, renderSection, renderOmittedNotice, isProtected }: {
  readonly pathOnlySkills: readonly SkillCatalogItem[]
  readonly allSkills: readonly SkillCatalogItem[]
  readonly budgetTokens: number
  readonly uncappedEstimatedTokens: number
  readonly renderSection: ApplySkillCatalogBudgetInput["renderSection"]
  readonly renderOmittedNotice: ApplySkillCatalogBudgetInput["renderOmittedNotice"]
  readonly isProtected: (skill: SkillCatalogItem) => boolean
}): SkillCatalogBudgetResult {
  const droppableIndices = droppableIndicesFor(allSkills, isProtected)
  for (let retainedDroppableCount = droppableIndices.length; retainedDroppableCount >= 0; retainedDroppableCount--) {
    const retainedDroppable = new Set(droppableIndices.slice(0, retainedDroppableCount))
    const { retained: retainedSkills, omitted: omittedSkills } = splitByRetainedIndices(allSkills, pathOnlySkills, retainedDroppable, isProtected)
    const cappedDirectories = getOmittedSkillDirectories(omittedSkills).slice(0, MAX_OMITTED_DIRECTORY_COUNT)
    const omittedNotice = omittedNoticeFor(omittedSkills, cappedDirectories, renderOmittedNotice)
    const section = renderSection(retainedSkills, omittedNotice)
    const renderedEstimatedTokens = estimatedTokens(section)
    // The last pass has nothing left to drop, so it is the answer whether or not it fits.
    if (renderedEstimatedTokens <= budgetTokens || retainedDroppableCount === 0) {
      return budgetResult({ section, skillItems: retainedSkills, omittedCount: omittedSkills.length, omittedDirectories: cappedDirectories, renderedEstimatedTokens, uncappedEstimatedTokens, strategy: "omitted_skills" })
    }
  }
  throw new Error("omitSkillsToFit: loop ended without returning")
}

/** Whether a path segment is the skill's index file rather than its name. */
function isSkillIndexFile(segment: string): boolean {
  return segment === "SKILL.md"
}

/** The skill's own name: its file name, or the directory above a SKILL.md. */
function getSkillName(fullPath: string): string {
  const parts = fullPath.replace(/\\/g, "/").split("/")
  const last = parts[parts.length - 1] ?? ""
  if (isSkillIndexFile(last) && parts.length >= 2) return parts[parts.length - 2] ?? ""
  return last
}

function isProtectedSkill(skill: SkillCatalogItem): boolean {
  return PROTECTED_SKILL_NAMES.has(getSkillName(skill.fullPath))
}

/** A description cut to fit, with the suffix that says it was cut. */
function truncateDescription(description: string | undefined, maxLength: number): string | undefined {
  if (description === undefined) return undefined
  if (description.length <= maxLength) return description
  const contentLength = Math.max(0, maxLength - TRUNCATED_DESCRIPTION_SUFFIX.length)
  return `${description.slice(0, contentLength).trimEnd()}${TRUNCATED_DESCRIPTION_SUFFIX}`
}

function getOmittedSkillDirectories(skills: readonly SkillCatalogItem[]): string[] {
  return [...new Set(skills.map((skill) => getSkillDirectoryHint(skill.fullPath)))]
}

/** The directories a skill's own tree is listed under, as the model would look them up. */
const SKILL_PATH_MARKERS = [
  "/.cursor/skills/",
  "/.cursor/skills-cursor/",
  "/.agents/skills/",
  "/.claude/skills/",
  "/.codex/skills/",
  "/.claude/plugins/",
] as const

/** The skills directory of the plugin cache a path sits in, when it sits in one. */
function pluginCacheSkillsDirectory(normalizedPath: string): string | undefined {
  const cacheMarker = "/.cursor/plugins/cache/"
  const cacheIndex = normalizedPath.indexOf(cacheMarker)
  if (cacheIndex === -1) return undefined
  const skillsIndex = normalizedPath.indexOf("/skills/", cacheIndex)
  return skillsIndex === -1 ? undefined : normalizedPath.slice(0, skillsIndex + "/skills".length)
}

/** The skill tree a path sits in, when one of the known trees appears in it. */
function knownSkillTreeDirectory(normalizedPath: string): string | undefined {
  for (const marker of SKILL_PATH_MARKERS) {
    const markerIndex = normalizedPath.indexOf(marker)
    if (markerIndex !== -1) return normalizedPath.slice(0, markerIndex + marker.length - 1)
  }
  return undefined
}

/** The directory a skill lives under, in the terms the model would look in. */
function getSkillDirectoryHint(fullPath: string): string {
  const normalizedPath = fullPath.replace(/\\/g, "/")
  const knownTree = knownSkillTreeDirectory(normalizedPath)
  if (knownTree !== undefined) return knownTree
  const pluginDirectory = pluginCacheSkillsDirectory(normalizedPath)
  if (pluginDirectory !== undefined) return pluginDirectory
  const lastSlashIndex = normalizedPath.lastIndexOf("/")
  return lastSlashIndex === -1 ? normalizedPath : normalizedPath.slice(0, lastSlashIndex)
}
