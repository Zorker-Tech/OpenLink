/**
 * The skills section: what the agent may use, and what it is told about using them.
 *
 * A skill is a procedure the agent reads before doing a kind of work, and the section lists them by
 * path with a one-line description each — the file itself is read on demand. Which wording the agent
 * gets depends on the model: one family is told to explain why a skill it chose on its own is relevant
 * and to keep its use inside the task's scope, while the rest are told the simpler rule that a relevant
 * skill is read immediately rather than announced.
 *
 * The section is assembled in a layout that the budget can render more than once with different
 * amounts of detail, so the layout and the budget are separate: the layout knows what the section looks
 * like, the budget decides how much of it survives.
 */

import { Fragment, jsx, jsxs } from "../../prompt-jsx/index.ts"
import type { PromptNode, PromptProps } from "../../prompt-jsx/index.ts"
import { applySkillCatalogBudget } from "./skill-catalog-budget.ts"

interface CatalogSkill {
  readonly fullPath: string
  readonly description?: string | undefined
}

interface SkillsLayoutProps {
  readonly skillItems: PromptNode[]
  readonly omittedNotice?: PromptNode | undefined
  readonly hasOmittedSkills: boolean
  readonly hasListedSkills?: boolean | undefined
  readonly raw?: boolean | undefined
  readonly readToolName?: string | undefined
  readonly isGpt56?: boolean | undefined
}

interface BudgetedSkillsProps {
  readonly skillItems: readonly CatalogSkill[]
  readonly agentTokenLimit?: number | undefined
  readonly raw?: boolean | undefined
  readonly readToolName?: string | undefined
  readonly isGpt56?: boolean | undefined
  readonly protectLoopSkill?: boolean | undefined
}

function SkillsLayout({
  skillItems,
  omittedNotice,
  hasOmittedSkills,
  hasListedSkills = skillItems.length > 0,
  raw,
  readToolName,
  isGpt56,
}: SkillsLayoutProps): PromptNode {
  const instructionText = readToolName
    ? `Skills the agent can use. Use the ${readToolName} tool with the provided absolute path to fetch full contents.`
    : "Skills the agent can use. Fetch full contents from the provided absolute path."
  if (raw) {
    return jsxs("section", {
      title: "agent_skills",
      description: instructionText,
      children: [skillItems, omittedNotice],
    })
  }
  return jsxs("section", {
    title: "agent_skills",
    children: [
      isGpt56
        ? jsxs(Fragment, {
          children: [
            jsxs("p", {
              children: [
                "When the user names a skill, use it faithfully as part of the current task.",
                readToolName
                  ? ` Read the skill file using the ${readToolName} tool before following its instructions.`
                  : " Read the skill file before following its instructions.",
                " ",
                "The user's instructions take precedence over skill guidance, and an invoked skill takes precedence over autonomous judgment where they do not conflict.",
              ],
            }),
            jsxs("p", {
              children: [
                "Tell the user in `commentary` when a skill causes a material action or pause. Before using a skill the user did not name, briefly explain why it is relevant and keep its use within the task's scope. Mention material effects in the final response, but do not cite skills you merely inspected.",
                " ",
                !hasListedSkills && hasOmittedSkills
                  ? "No skills are listed below, but additional skills may exist in the directories shown in the skills section if a later task specifically requires discovering more skills."
                  : hasOmittedSkills
                    ? "Use the skills listed below. If a later task specifically requires discovering more skills, additional skills may exist in the directories shown in the skills section."
                    : "Only use skills listed below.",
              ],
            }),
          ],
        })
        : jsxs("p", {
          children: [
            "When users ask you to perform tasks, check if any of the available skills below can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge.",
            readToolName
              ? ` To use a skill, read the skill file at the provided absolute path using the ${readToolName} tool, then follow the instructions within.`
              : " To use a skill, read the skill file at the provided absolute path, then follow the instructions within.",
            " ",
            "When a skill is relevant, read and follow it IMMEDIATELY as your first action. NEVER just announce or mention a skill without actually reading and following it.",
            " ",
            !hasListedSkills && hasOmittedSkills
              ? "No skills are listed below, but additional skills may exist in the directories shown in the skills section if a later task specifically requires discovering more skills."
              : hasOmittedSkills
                ? "Use the skills listed below. If a later task specifically requires discovering more skills, additional skills may exist in the directories shown in the skills section."
                : "Only use skills listed below.",
          ],
        }),
      jsx("br", {}),
      jsxs("section", {
        title: "available_skills",
        description: instructionText,
        children: [skillItems, omittedNotice],
      }),
      jsx("br", {}),
    ],
  })
}

function skillNodesFor(skills: readonly CatalogSkill[]): PromptNode[] {
  return skills.map(catalogEntry => jsx("x", {
    tag: "agent_skill",
    fullPath: catalogEntry.fullPath,
    children: catalogEntry.description || undefined,
  }))
}

/** What was left out, and where it can still be found if a later task needs it. */
function OmittedNotice({ directories, omittedCount }: {
  readonly directories: readonly string[]
  readonly omittedCount: number
}): PromptNode {
  return jsx("p", {
    children: `Additional skills omitted from this initial list (${omittedCount}). Directories containing omitted skills: ${directories.join(", ")}.`,
  })
}

const SkillsLayoutPrompt = SkillsLayout as unknown as (props: PromptProps) => PromptNode
const OmittedNoticePrompt = OmittedNotice as unknown as (props: PromptProps) => PromptNode

export function BudgetedAgentSkillsSection({
  skillItems,
  agentTokenLimit,
  raw,
  readToolName,
  isGpt56,
  protectLoopSkill,
}: BudgetedSkillsProps) {
  const budgetOutcome = applySkillCatalogBudget({
    skills: skillItems,
    agentTokenLimit,
    protectLoopSkill,
    renderSection: (skills, omittedNotice) => jsx(SkillsLayoutPrompt, {
      skillItems: skillNodesFor(skills),
      omittedNotice,
      hasOmittedSkills: omittedNotice !== undefined,
      raw,
      readToolName,
      isGpt56,
    }),
    renderOmittedNotice: (directories, omittedCount) => jsx(OmittedNoticePrompt, { directories, omittedCount }),
  })
  return {
    section: budgetOutcome.section,
    skillCount: budgetOutcome.retainedCount,
    renderedEstimatedTokens: budgetOutcome.renderedEstimatedTokens,
    uncappedEstimatedTokens: budgetOutcome.uncappedEstimatedTokens,
    omittedSkillCount: budgetOutcome.omittedCount,
    strategy: budgetOutcome.strategy,
  }
}
