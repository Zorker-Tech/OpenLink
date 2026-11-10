/**
 * Which skills a session is shown, and which of them it is shown at all.
 *
 * Skills arrive by two routes — as files the workspace holds, and as entries the request context
 * carries — and a session uses one or the other, never both. Either way three filters apply before the
 * catalogue is written: a skill scoped to a different environment is dropped, a skill that refused model
 * invocation is not offered, and a skill scoped to files the workspace does not contain is not in force
 * anywhere. A subagent that exists to drive the desktop is shown only the skills about driving it.
 *
 * What survives is handed to the budgeted section, which is where the size limit is applied, so this
 * file decides what is eligible and that one decides what fits.
 */

import { SLATE_SKILLS_DIRECTORY } from "../workspace-conventions.ts"
import { EXTERNAL_SKILL_DIRECTORY_SEGMENTS } from "../../../adapters/interop/workspace/external-workspace-directories-adapter.ts"
import path from "node:path"

import type { PromptNode } from "../../prompt-jsx/index.ts"
import { getFirstNonEmptyLine } from "../utils/common-helpers.ts"
import { AgentType } from "../utils/agent-config.ts"
import { filterItemsForRunEnvironment } from "../utils/environment-filtering.ts"
import { normalizeToUnixPath } from "../../utils/paths.ts"
import { BudgetedAgentSkillsSection } from "./agent-skills-section.ts"
import { categorizePromptRules } from "./rule-categorization.ts"
import { getAgentRequestableRuleDescription, getRuleDir } from "./rule-sections.ts"
import type { UserInfoRule, UserInfoSkill } from "./user-info-data-contracts.ts"

interface AvailableSkillsPromptProps {
  readonly env?: { readonly workspacePaths?: readonly string[] | undefined } | undefined
  readonly workspaceRules: readonly UserInfoRule[]
  readonly displayOptions?: {
    readonly agentType?: AgentType | undefined
    readonly computerUseSubagentSurface?: boolean | undefined
    readonly displaySkills?: boolean | undefined
    readonly displayWorkspaceRules?: boolean | undefined
  } | undefined
  readonly agentSkills?: readonly UserInfoSkill[] | undefined
  readonly featureFlags?: { readonly protectLoopSkillDescription?: boolean | undefined } | undefined
  readonly agentTokenLimit?: number | undefined
  readonly modelInfo?: { readonly isGpt56?: boolean | undefined } | undefined
}

interface AvailableSkillsPromptOverrides {
  readonly skills?: readonly UserInfoRule[] | undefined
  readonly readToolName?: string | undefined
}

const COMPUTER_USE_SKILL_PATTERN = /computer[-_ ]use|\bcua\b/i
const SKILL_DIR_SEGMENTS = [
  SLATE_SKILLS_DIRECTORY.split("/"),
  ...EXTERNAL_SKILL_DIRECTORY_SEGMENTS,
] as const
const SEP = "/"

function normalizePath(value: string): string {
  const normalized = path.posix.normalize(normalizeToUnixPath(value))
  if (normalized === SEP) return SEP
  return normalized.replace(/\/+$/, "")
}

function isPathWithinDir(pathValue: string, dir: string): boolean {
  const normalizedDir = normalizePath(dir)
  if (normalizedDir === SEP) return pathValue.startsWith(SEP)
  return pathValue === normalizedDir || pathValue.startsWith(`${normalizedDir}/`)
}

/** The root a skill's directory belongs to: the project above its skills directory. */
function getSkillScopeRoot(skillPath: string): string {
  const normalizedPath = normalizeToUnixPath(skillPath)
  const segments = path.posix.normalize(path.posix.dirname(normalizedPath)).split(SEP)
  for (let index = segments.length - 2; index >= 0; index--) {
    for (const [configDir, subDir] of SKILL_DIR_SEGMENTS) {
      if (segments[index] === configDir && segments[index + 1] === subDir) {
        const parentSegments = segments.slice(0, index)
        if (parentSegments.length === 0 || (parentSegments.length === 1 && parentSegments[0] === "")) return SEP
        return parentSegments.join(SEP)
      }
    }
  }
  return path.posix.normalize(path.posix.dirname(normalizedPath))
}

/** A skill with globs is scoped to files; one whose directory is above the workspace root is not. */
function isFileScopedSkill(skill: UserInfoSkill, workspacePaths: readonly string[]): boolean {
  const globs = skill.globs ?? []
  if (globs.length > 0) return true
  if (!skill.fullPath) return false
  const scopeRoot = normalizePath(getSkillScopeRoot(skill.fullPath))
  const normalizedWorkspaceRoots = workspacePaths.map(normalizePath)
  const containingWorkspaceRoot = normalizedWorkspaceRoots.find(workspaceRoot => isPathWithinDir(scopeRoot, workspaceRoot))
  if (!containingWorkspaceRoot) return false
  return scopeRoot !== containingWorkspaceRoot
}

function isComputerUseGuidedSkill(skill: { readonly fullPath?: string | undefined; readonly description?: string | undefined }): boolean {
  return COMPUTER_USE_SKILL_PATTERN.test(`${skill.fullPath ?? ""}\n${skill.description ?? ""}`)
}

function toLegacySkillCatalogItems(skills: readonly UserInfoRule[]) {
  return skills.map(rule => {
    const ruleDir = getRuleDir(rule.fullPath)
    return { fullPath: rule.fullPath, description: getAgentRequestableRuleDescription(rule, ruleDir) }
  })
}

export function buildAvailableSkillsPromptSection(
  props: AvailableSkillsPromptProps,
  overrides?: AvailableSkillsPromptOverrides,
): {
  readonly section?: PromptNode
  readonly skillCount: number
  readonly renderedEstimatedTokens?: number
  readonly uncappedEstimatedTokens?: number
  readonly omittedSkillCount?: number
  readonly strategy?: "under_budget" | "shortened_descriptions" | "dropped_descriptions" | "omitted_skills"
} {
  const workspacePaths = props.env?.workspacePaths ?? []
  const skills = overrides?.skills ??
    categorizePromptRules(props.workspaceRules, workspacePaths, props.displayOptions?.agentType).skills
  const computerUseSubagentSurface = props.displayOptions?.computerUseSubagentSurface === true
  const availableSkills = filterItemsForRunEnvironment([...(props.agentSkills ?? [])], props.displayOptions?.agentType)
    .filter(skill => !skill.disableModelInvocation && !isFileScopedSkill(skill, workspacePaths))
  const useStructuredSkills = (props.agentSkills?.length ?? 0) > 0
  const filteredStructuredSkills = computerUseSubagentSurface
    ? availableSkills.filter(skill => isComputerUseGuidedSkill(skill))
    : availableSkills
  const filteredLegacySkills = computerUseSubagentSurface
    ? skills.filter(skill => isComputerUseGuidedSkill({
      fullPath: skill.fullPath,
      description: getAgentRequestableRuleDescription(skill, getRuleDir(skill.fullPath)),
    }))
    : skills
  const availableSkillCount = useStructuredSkills ? filteredStructuredSkills.length : filteredLegacySkills.length
  // A desktop subagent is shown its skills regardless; anywhere else the session has to have asked for them.
  const shouldRenderSection = availableSkillCount > 0 && (
    computerUseSubagentSurface ||
    (props.displayOptions?.displaySkills === true && props.displayOptions?.displayWorkspaceRules !== false)
  )
  if (!shouldRenderSection) return { skillCount: 0 }
  const protectLoopSkill = props.featureFlags?.protectLoopSkillDescription === true
  const budgetedSection = useStructuredSkills
    ? BudgetedAgentSkillsSection({
      skillItems: filteredStructuredSkills.map(skill => ({
        fullPath: skill.fullPath,
        description: skill.description || undefined,
      })),
      agentTokenLimit: props.agentTokenLimit,
      readToolName: overrides?.readToolName,
      isGpt56: props.modelInfo?.isGpt56 === true,
      protectLoopSkill,
    })
    : BudgetedAgentSkillsSection({
      skillItems: toLegacySkillCatalogItems(filteredLegacySkills),
      agentTokenLimit: props.agentTokenLimit,
      readToolName: overrides?.readToolName,
      isGpt56: props.modelInfo?.isGpt56 === true,
      protectLoopSkill,
    })
  return {
    section: budgetedSection.section,
    skillCount: budgetedSection.skillCount,
    renderedEstimatedTokens: budgetedSection.renderedEstimatedTokens,
    uncappedEstimatedTokens: budgetedSection.uncappedEstimatedTokens,
    omittedSkillCount: budgetedSection.omittedSkillCount,
    strategy: budgetedSection.strategy,
  }
}
