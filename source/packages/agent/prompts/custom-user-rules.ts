/** Slate's generated guidance and the final composition of workspace and user rules. */

import { jsx, type PromptNode } from "../../prompt-jsx/index.ts"
import type { PromptRuleDescriptor } from "./rule-sections-contracts.ts"
import { RulesSection } from "./rule-sections.ts"
import type { PromptRuleGroups, SlateUserRuleProfile } from "./user-rule-profile-contract.ts"

const INTERFACE_DESIGN_GUIDANCE = `For interface work, choose a clear visual idea and organize the page around it.
- Make the opening viewport feel like one considered composition. Use a dashboard layout only when the task calls for one.
- Give the product or organization a visible identity. Keep headings, supporting copy and actions in a clear order.
- Choose purposeful type, color and imagery. Avoid default-looking palettes, filler decoration and repetitive card grids.
- Keep each section focused on one purpose. Give the main image enough space and avoid stacking unrelated details over it.
- Use motion selectively to reinforce hierarchy, and check that the layout still works on narrow screens.
- When working inside an established product, preserve its design language and existing component patterns.`

const LIVE_WORKSPACE_GUIDANCE = [
  "This session is connected to a live workspace. Use the available tools to inspect and complete the requested work there.",
  "- Carry out relevant actions directly when the tools allow it; do not leave the user with commands you could run yourself.",
  "- If an attempt fails, inspect the cause and choose a safe next step instead of stopping immediately.",
  "- Use the date supplied in the session context when a date matters.",
].join("\n")

const TOOL_AWARE_WORKSPACE_GUIDANCE = [
  "Work in the connected environment using its available tools. Explain a manual step only when the tools cannot perform it or the user needs to make the choice.",
  "- A failed attempt is a reason to diagnose the problem and select another safe approach.",
].join("\n")

const INSTRUCTION_GUIDANCE = [
  "Treat the user's request and the applicable system, tool and skill directions as the requirements for the task.",
  "- Read relevant instructions completely, including their format and workflow requirements.",
  "- Follow the requested names, structure and output format. Do not silently substitute a different approach.",
  "- Load an applicable skill before using its workflow, and use connected tools when they provide the needed access.",
].join("\n")

const SKILLS_AND_CONNECTED_TOOLS_GUIDANCE = [
  "Check for relevant installed skills and connected tools before starting specialized work.",
  "- Read the instructions for the ones you use and prefer them when they directly support the requested task.",
  "- Tell the user when a required skill or connection fails to provide access.",
].join("\n")

const USER_COMMUNICATION_GUIDANCE = [
  "Write clearly and directly. Lead with the result, then give only the context needed to understand it.",
  "- Use complete sentences and familiar wording. Keep the response focused on the user's current request.",
  "- Refer to code with useful file and line links when the interface supports them; link external references directly.",
  "- Use tables for tabular facts, and diagrams only when they make a complex flow easier to follow.",
].join("\n")

const TOOL_AWARE_COMMUNICATION_GUIDANCE = [
  "Write polished, direct responses that explain the result without repeating the request.",
  "- Use short sections or bullets when they make several details easier to scan.",
  "- Link to the precise code or external source when a reference will help the user verify a claim.",
  "- Keep the final response proportional to the work and omit unrelated background.",
].join("\n")

const CONVERSATION_CONTEXT_GUIDANCE = [
  "Read the latest message in the context of the full conversation. Earlier requirements continue to apply unless the user changes them.",
  "- Treat a message sent during active work as steering when it refines the current goal.",
  "- Infer the intended outcome from the conversation and preserve its constraints through the final response.",
].join("\n")

const CODE_CHANGE_GUIDANCE = [
  "For code changes, keep the edit focused and use the repository's existing conventions.",
  "- Prefer the smallest correct design and avoid adding abstractions without a real need.",
  "- Preserve unrelated work and existing behavior outside the requested change.",
  "- Add or run checks that cover the behavior being changed; report gaps honestly.",
].join("\n")

const FINAL_RESPONSE_GUIDANCE = [
  "In the final response, state the outcome first and include the evidence needed to verify it.",
  "- For longer work, group details by what changed and how it was checked.",
  "- Keep emphasis and headings restrained, and leave out unrelated caveats.",
].join("\n")

function shellGuidance(name: string): string {
  return [
    `When using ${name}, set the wait duration to zero for a server, watcher or other command meant to keep running.`,
    "- Do not background a process by adding an ampersand to the command.",
  ].join("\n")
}

function waitGuidance(name: string): string {
  return [
    `When waiting on ${name} for a background command, choose a short interval based on when useful output is expected.`,
    "- Add only a small margin, and check again sooner when the command's timing is uncertain.",
  ].join("\n")
}

function searchGuidance(name: string): string {
  return [
    `When using ${name}, narrow the search to relevant directories or file types.`,
    "- Avoid recursive catch-all patterns such as **/*.",
  ].join("\n")
}

/** Builds Slate-authored user guidance from a profile that has already crossed the model adapter. */
export function buildGeneratedUserRules(profile: SlateUserRuleProfile): string[] {
  if (profile.ruleSet === "suppressed") return []

  const rules: string[] = []
  if (profile.ruleSet === "general") {
    rules.push(INSTRUCTION_GUIDANCE, LIVE_WORKSPACE_GUIDANCE, USER_COMMUNICATION_GUIDANCE, CONVERSATION_CONTEXT_GUIDANCE, CODE_CHANGE_GUIDANCE)
  } else if (profile.ruleSet === "tool-aware") {
    rules.push(INSTRUCTION_GUIDANCE, SKILLS_AND_CONNECTED_TOOLS_GUIDANCE, TOOL_AWARE_WORKSPACE_GUIDANCE)
    rules.push(TOOL_AWARE_COMMUNICATION_GUIDANCE, CONVERSATION_CONTEXT_GUIDANCE, CODE_CHANGE_GUIDANCE)
    if (profile.shellToolName !== undefined) rules.push(shellGuidance(profile.shellToolName))
    if (profile.preventBroadGlobSearch && profile.grepToolName !== undefined) rules.push(searchGuidance(profile.grepToolName))
    if (profile.awaitToolName !== undefined) rules.push(waitGuidance(profile.awaitToolName))
  }
  if (profile.includeInterfaceGuidance) rules.push(INTERFACE_DESIGN_GUIDANCE)
  if (profile.includeFinalResponseGuidance) rules.push(FINAL_RESPONSE_GUIDANCE)
  return rules
}

export interface RulesPromptProps {
  readonly displayRules?: boolean
  readonly categorizedRules?: PromptRuleGroups
  readonly additionalUserRules?: readonly string[]
}

export interface RulesPromptOptions {
  readonly readToolName?: string | undefined
}

/** Combines the three workspace groups with user guidance, leaving source classification at its input boundary. */
export function buildRulesSection(
  props: RulesPromptProps,
  options: RulesPromptOptions = {},
): { readonly section?: PromptNode; readonly ruleCount: number } {
  if (props.displayRules === false) return { ruleCount: 0 }
  const groups: PromptRuleGroups = props.categorizedRules ?? { globalRules: [], agentRequestableRules: [], userRules: [] }
  const additionalUserRules = props.additionalUserRules ?? []
  const count = groups.globalRules.length + groups.agentRequestableRules.length + groups.userRules.length + additionalUserRules.length
  if (count === 0) return { ruleCount: 0 }
  return {
    section: jsx(RulesSection as unknown as (props: Record<string, unknown>) => PromptNode, {
      ...groups,
      readToolName: options.readToolName,
      additionalUserRules,
    }),
    ruleCount: count,
  }
}
