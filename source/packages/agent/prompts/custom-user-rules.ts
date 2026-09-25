/**
 * The rules the platform generates for a session, on top of the ones the workspace holds.
 *
 * A workspace's rules come from files; these come from the platform, and they exist because a model
 * left to its own judgement makes the same handful of mistakes: it hands the user instructions instead
 * of running them, it answers the literal question instead of the intended one, it writes more code
 * than the change needs, and it describes code in prose instead of citing it. Each of those is a rule
 * here.
 *
 * Which rules a model gets depends on what it was trained with, not on what it can do. A model that was
 * trained against a particular wording of a rule is given that wording rather than the general one —
 * including a version of the rules for a model that never saw the tool descriptions the general rules
 * refer to. Some rules name the tools they talk about, so they are built per session from the tools
 * that exist rather than written once with a name hardcoded in.
 *
 * The rules are also the reason a session's first user message has to be rebuilt when they change: the
 * presence or absence of a rule is checked against the message itself.
 */

import type { CursorRule } from "../../proto/generated/agent/v1/rules_pb.ts"
import { jsx } from "../../prompt-jsx/index.ts"
import type { PromptNode } from "../../prompt-jsx/index.ts"
import { buildAntiAskQuestionUserRule } from "./ask-question-guidance.ts"
import { getComposerGitUserRules } from "./git-workflow-rules.ts"
import { shouldInjectComposerGitUserRules } from "./composer-git-rule-gate.ts"
import { RulesSection } from "./rule-sections.ts"
import { categorizeCursorRules } from "./rule-categorization.ts"
import { isFileScopedRule } from "../utils/rule-matching.ts"
import { AgentType } from "../utils/agent-config.ts"

/** Frontend design rules, for models that design in the browser rather than only in code. */
const FRONTEND_DESIGN_USER_RULE = `
When doing frontend design tasks, avoid generic, overbuilt layouts.

**Use these hard rules:**
- One composition: The first viewport must read as one composition, not a dashboard (unless it's a dashboard).
- Brand first: On branded pages, the brand or product name must be a hero-level signal, not just nav text or an eyebrow. No headline should overpower the brand.
- Brand test: If the first viewport could belong to another brand after removing the nav, the branding is too weak.
- Typography: Use expressive, purposeful fonts and avoid default stacks (Inter, Roboto, Arial, system).
- Background: Don't rely on flat, single-color backgrounds; use gradients, images, or subtle patterns to build atmosphere.
- Full-bleed hero only: On landing pages and promotional surfaces, the hero image should be a dominant edge-to-edge visual plane or background by default. Do not use inset hero images, side-panel hero images, rounded media cards, tiled collages, or floating image blocks unless the existing design system clearly requires it.
- Hero budget: The first viewport should usually contain only the brand, one headline, one short supporting sentence, one CTA group, and one dominant image. Do not place stats, schedules, event listings, address blocks, promos, "this week" callouts, metadata rows, or secondary marketing content in the first viewport.
- No hero overlays: Do not place detached labels, floating badges, promo stickers, info chips, or callout boxes on top of hero media.
- Cards: Default: no cards. Never use cards in the hero. Cards are allowed only when they are the container for a user interaction. If removing a border, shadow, background, or radius does not hurt interaction or understanding, it should not be a card.
- One job per section: Each section should have one purpose, one headline, and usually one short supporting sentence.
- Real visual anchor: Imagery should show the product, place, atmosphere, or context. Decorative gradients and abstract backgrounds do not count as the main visual idea.
- Reduce clutter: Avoid pill clusters, stat strips, icon rows, boxed promos, schedule snippets, and multiple competing text blocks.
- Use motion to create presence and hierarchy, not noise. Ship at least 2-3 intentional motions for visually led work.
- Color & Look: Choose a clear visual direction; define CSS variables. AVOID defaulting to looks where AI-generated design tends to cluster: (1) purple-on-white or purple-to-indigo gradient themes; (2) a warm cream background (near #F4F1EA) with a high-contrast serif display and a terracotta accent; (3) a broadsheet-style layout with hairline rules, zero border-radius, and dense newspaper-like columns. Avoid biases to: dark mode; purple; glow effects; rounded-full pills; multi-layer shadows; emojis.
- Ensure the page loads properly on both desktop and mobile.
- For React code, prefer modern patterns including useEffectEvent, startTransition, and useDeferredValue when appropriate if used by the team. Do not add useMemo/useCallback by default unless already used; follow the repo's React Compiler guidance.

Exception: If working within an existing website or design system, preserve the established patterns, structure, and visual language.
`

function buildRealEnvironmentRule({ includeCommandExecutionEnforcement, includeDateAuthority }: {
  readonly includeCommandExecutionEnforcement: boolean
  readonly includeDateAuthority: boolean
}): string {
  return [
    "IMPORTANT: This is a real environment with full shell access and network, not a simulated one.",
    "- You MUST run commands and use tools to investigate and solve problems yourself.",
    ...(includeCommandExecutionEnforcement ? ["- You MUST NOT simply tell the user what to run — execute it yourself."] : []),
    "- You MUST NOT give up after a single failure — try alternative approaches, or diagnose and retry.",
    ...(includeDateAuthority ? ["- The `Today's date:` field in the user info section is authoritative: when giving the current date, or picking a date for search or knowledge retrieval, default to that year (2026); the year is **NOT** 2025."] : []),
    ...(includeCommandExecutionEnforcement ? ["- If you are about to write instructions for the user instead of executing them, execute or implement them yourself."] : []),
  ].join("\n")
}

const REAL_ENVIRONMENT_USER_RULE = buildRealEnvironmentRule({ includeCommandExecutionEnforcement: true, includeDateAuthority: true })
const TRAINING_ALIGNED_REAL_ENVIRONMENT_USER_RULE = buildRealEnvironmentRule({ includeCommandExecutionEnforcement: false, includeDateAuthority: false })

const INSTRUCTION_FOLLOWING_USER_RULE = `Follow ALL user, tool, system, and skill instructions precisely and completely:
- Think about ALL instructions in user rules, user queries, skills, system reminders, and MCP server/tool descriptions in FULL. Do NOT skip or only partially apply them.
- When a skill, rule, system reminder, or tool description specifies a particular format, output structure, naming convention, or step-by-step workflow, FOLLOW it — even if you think a different approach might be better.
- Pay special attention to constraints embedded in tool descriptions, skills, and MCP server instructions. These are not suggestions — they are requirements that govern how you must use each tool/skill.
- Skills are special files/instructions that users create to guide you in completing their tasks — they provide enormous value; find and use them when they are relevant rather than improvising without them.
- Users provide MCP tools to help you interact with or gather needed context from external sources — use them extensively when they fit the task.
`

const SKILLS_AND_MCP_REMINDER_USER_RULE = `Remember to use skills and MCP tools:
- If there is a <manually_attached_skills> block, read and use the skills, especially if the user references one of the skills via a slash command, like \`/skillName\`. The slash command may also reference a skill in <agent_skills>.
- Always read and remember relevant skill and MCP tool descriptions.
- Prefer using skills and MCP tools over writing scripts.
- Report issues using skills and MCPs to the user.
`

const USER_COMMUNICATION_USER_RULE = `When communicating with the user:
- Use code citation blocks to reference existing code: \`\`\`startLine:endLine:filepath format. Code citations are strictly better than describing code in prose or stringing backticked identifiers together — they give the user one-click navigation and immediate context.
- Code citation fences (the opening \`\`\`) MUST be on their own line, never prefixed by list markers or other text on the same line. E.g. "- \`\`\`12:34:path" will render incorrectly.
- Inside fenced code blocks and inline backticked text, content is shown literally: do not use HTML character references (e.g. &amp;, &lt;) expecting them to become symbols — use the actual characters.
- In code citations, it is preferred to skip large irrelevant chunks of code using \`...\`, or pseudocode comments.
- In non-citation code blocks, especially when meant for copy-pasting suggested commands, write full commands — no \`...\` or other omissions.
- Users prefer markdown links for ease of navigation when referencing web content. When you cite paths or URLs (https://, s3://, file paths, etc.), give the full string; do not shorten or elide prefixes or middle segments for brevity.
- Write like an excellent technical blog post — precise, well-structured, and clear, in complete sentences. Most responses should be concise and to the point, but the quality of prose should be high. Never use telegraphic shorthand, or sentence fragment chains.
- Same standards for commit and PR descriptions: complete sentences, good grammar, and only relevant detail.
- Prefer simple, accessible language over dense technical jargon. Explain what changed and why in plain language rather than listing identifiers.
- Keep final responses proportional to task complexity. A simple CI fix doesn't need multiple paragraphs.
- Do not overuse bolding or backticks for decoration. Use them very sparingly for emphasis.
- Avoid "\xA7" in user-facing text (these don't render well in the product UI).
- Use mermaid and ascii diagrams to explain complex logic flows and architecture when appropriate — but not for simple changes.
- Avoid engagement baiting at the end of responses. If there are obvious follow ups, simply ask the user directly if they want those done, but do not force suggestions or follow ups in every response like 'say the word and I'll do X'.
- Mark todo items done as they are completed, and do not leave todos marked as in_progress if they are actually completed.`

/** The same communication rules, worded for a model trained on prose rather than on tool use. */
const TRAINING_ALIGNED_USER_COMMUNICATION_USER_RULE = `When communicating with the user:
- Use high quality prose with complete sentences, proper grammar, correct spelling, and punctuation. Be precise and clear, and ensure that ideas flow from sentence to sentence. Avoid stuttered phrasing, unnatural sentence structures, and shorthand.
- Do not write out comma-separated lists of more than 4 items in prose or parentheticals. When enumerating many items, use bulleted or numbered lists.
- Only use tables to display tabular data for visualization or analysis.
- Emphasize important concepts through word choice rather than bolding terms. Never bold terms in the middle of a sentence. Never bold an entire sentence or paragraph.
- Do not overuse bolding or backticks for decoration. Headings or short lead sentences are viable alternatives to bolding.
- Avoid using tilde to denote approximate numbers because these may be incorrectly parsed as strikeouts. Instead, use the word "approximately" or "about".
- Use code citation blocks to reference existing code: \`\`\`startLine:endLine:filepath format. Code citations are strictly better than describing code in prose or stringing backticked identifiers together — They give the user one-click navigation and immediate context.
- Prefer citing only the code file and line numbers in the final response instead of displaying the code content.
- Code citation fences (the opening \`\`\`) MUST be on their own line, never prefixed by list markers or other text on the same line. E.g. "- \`\`\`12:34:path" will render incorrectly.
- In code citations, it is preferred to skip large irrelevant chunks of code using \`...\`, or pseudocode comments.
- In non-citation code blocks, especially when meant for copy-pasting suggested commands, write full commands — Never use \`...\`, \u2026, or other omissions.
- Users prefer markdown links for ease of navigation when referencing web content. When you cite paths or URLs (https://, s3://, file paths, etc.), give the full string; do not shorten or elide prefixes or middle segments for brevity.
- When the user asks for one item per line, use Markdown hard line breaks with two trailing spaces.
- Before running any terminal commands that mutate the environment or long-running jobs, ALWAYS inform the user with a status update before running the command or job.
- Do not include tangential background details in the final response.
- Follow these communication rules by default, but adjust them when explicitly requested by the user.
`

const CONVERSATION_INTENT_USER_RULE = `Reason about conversation history to understand user intent:
- Think about every user query in light of the full conversation history. The latest message inherits context from prior turns — e.g. "How does this work?" after discussing edge cases likely means explaining that code's behavior around those edge cases, not a generic overview.
- Identify the user's underlying goal and implicit requirements from the arc of the conversation, not just the literal text of the latest message. Think about what they are trying to accomplish, what constraints they care about, and what they would consider a successful outcome.
- When the user sends a message mid-task, think carefully about whether it's a refinement of the current task or a genuine change of direction or new task. Default to treating it as guidance for the work in progress — users are more often steering than canceling.`

const CODE_PRINCIPLES_USER_RULE = `**Always follow these principles when writing code** (recall them in your thinking but don't mention them to the user):
1. Minimize scope — Use the simplest correct diff. Do not add or change unrelated or unrequested code, especially for question-only or review-only tasks. A focused 5-line change that solves the root problem is strictly better than a 100-line diff.
2. Avoid over-engineering - Do not over abstract the code, like adding one or two line helpers that should just be inline. Do not use excessive error handling or fallbacks for edges cases that are impossible or extremely unlikely.
3. Use existing conventions — Read the surrounding code before writing. Match its naming, types, abstractions, import style, and documentation level. Your additions should read as if written by the same author. Reuse and extend existing functions and components rather than reimplementing similar logic. When no convention exists, follow language and framework best practices.
4. Comments — Good code should mostly be self-explanatory. Only add comments that explain non-obvious business logic or deep technical details.
5. Useful tests only — Only add tests if requested or they add meaningful coverage of real behavior. Do not add tests that trivially assert the obvious.`

function buildShellToolUserRule(shellToolName: string): string {
  return `When using ${shellToolName}:
- To run a command in the background, set \`block_until_ms: 0\` to immediately background (use for dev servers, watchers, or any long-running process).
- Never use '&' at the end of commands to background them.
- Do not kill a process unless explicitly requested by the user.
`
}

function buildAwaitToolUserRule(awaitToolName: string): string {
  return `When using ${awaitToolName} on a background shell:
- Configure block_until_ms duration based on the expected time until the pattern appears, plus a small margin. Do not use a large default.
- Be defensive when considering duration. The command may unexpectedly hang or not match the pattern, so a high block_until_ms will block the user. Prefer checking in sooner rather than later.
- block_until_ms should be shorter than the time it would take the command to exit.
`
}

function buildGrepUserRule(grepToolName: string): string {
  return `When using ${grepToolName}:
- NEVER glob every single file with "**/*", "**/**", or similar pattern.
`
}

const GENERATED_USER_RULES = [
  INSTRUCTION_FOLLOWING_USER_RULE,
  REAL_ENVIRONMENT_USER_RULE,
  USER_COMMUNICATION_USER_RULE,
  CONVERSATION_INTENT_USER_RULE,
  CODE_PRINCIPLES_USER_RULE,
]

/** What the final response has to read like, for models that need it said explicitly. */
const FINAL_RESPONSE_COMMUNICATION_USER_RULE = `
When writing a final response for the user, keep the following communication rules in mind:
- Communicate directly and concisely.
- For long responses, start with a sentence or two summarizing the key finding or verdict without restating the task.
- Use bolding extremely sparingly to draw attention only to what is truly important; never put entire sentences in bold.
- Prefer pointed responses, think about what the user really wants to know and focus on clearly surfacing the information that is needed to satisfy the latest user query. Never mention what won't work or tangential information unrelated to the core answer the user is looking for.
- Only provide thorough detail when requested. Prefer to keep it concise with a sentence or two if possible per point. Only expand into full sections when needed. Don't restate the bottom line in a dedicated section.
`

export interface UserRuleModelInfo {
  readonly isComposerMatterhorn?: boolean | undefined
  readonly isRawTrainingSlug?: boolean | undefined
}

export interface UserRuleFeatureFlags {
  readonly enableTahomaUserRuleIntervention?: boolean | undefined
  readonly enableVegaFrontendUserRuleIntervention?: boolean | undefined
  readonly enableComposer2CustomUserRules?: boolean | undefined
  readonly enableMatterhornPromptTweaks?: boolean | undefined
  readonly enableGrepBroadGlobGuard?: boolean | undefined
}

export interface UserRuleOptions {
  readonly awaitToolName?: string | undefined
  readonly shellToolName?: string | undefined
  readonly grepToolName?: string | undefined
}

/**
 * The generated rules for a model: the general set, or the set worded for the model's training, plus
 * the rules the session's flags ask for. A model trained against the raw slug is given none of them.
 */
export function getGeneratedUserRulesForModel(
  modelInfo: UserRuleModelInfo | undefined,
  featureFlags?: UserRuleFeatureFlags | undefined,
  options?: UserRuleOptions | undefined,
): string[] {
  if (modelInfo?.isComposerMatterhorn === true && modelInfo.isRawTrainingSlug === true) return []
  const finalResponseRule = featureFlags?.enableTahomaUserRuleIntervention === true ? [FINAL_RESPONSE_COMMUNICATION_USER_RULE] : []
  const frontendDesignRule = featureFlags?.enableVegaFrontendUserRuleIntervention === true ? [FRONTEND_DESIGN_USER_RULE] : []
  const generatedRules = featureFlags?.enableComposer2CustomUserRules === true ? GENERATED_USER_RULES : []
  if (modelInfo?.isComposerMatterhorn !== true) {
    return [...generatedRules, ...frontendDesignRule, ...finalResponseRule]
  }
  if (featureFlags?.enableComposer2CustomUserRules !== true) {
    return [...frontendDesignRule, ...finalResponseRule]
  }
  const trainingAligned = featureFlags?.enableMatterhornPromptTweaks === true
  const userCommunicationRule = trainingAligned ? TRAINING_ALIGNED_USER_COMMUNICATION_USER_RULE : USER_COMMUNICATION_USER_RULE
  const skillsReminderRule = trainingAligned ? [SKILLS_AND_MCP_REMINDER_USER_RULE] : []
  const awaitToolRule = trainingAligned && options?.awaitToolName !== undefined ? [buildAwaitToolUserRule(options.awaitToolName)] : []
  const shellToolRule = trainingAligned && options?.shellToolName !== undefined ? [buildShellToolUserRule(options.shellToolName)] : []
  const grepRule = trainingAligned && featureFlags?.enableGrepBroadGlobGuard === true && options?.grepToolName !== undefined
    ? [buildGrepUserRule(options.grepToolName)]
    : []
  return [
    INSTRUCTION_FOLLOWING_USER_RULE,
    ...skillsReminderRule,
    TRAINING_ALIGNED_REAL_ENVIRONMENT_USER_RULE,
    userCommunicationRule,
    CONVERSATION_INTENT_USER_RULE,
    CODE_PRINCIPLES_USER_RULE,
    ...shellToolRule,
    ...grepRule,
    ...awaitToolRule,
    ...frontendDesignRule,
    ...finalResponseRule,
  ]
}

export interface RulesPromptProps {
  readonly cursorRules: CursorRule[]
  readonly env?: { readonly workspacePaths?: readonly string[] | undefined } | undefined
  readonly displayOptions?: { readonly displayCursorRules?: boolean | undefined; readonly agentType?: AgentType | undefined } | undefined
  readonly backgroundAgentSource?: unknown
  readonly agentType?: AgentType | undefined
  readonly modelInfo?: UserRuleModelInfo & {
    readonly promptVersion?: string | undefined
    readonly isComposer2?: boolean | undefined
    readonly isComposer15?: boolean | undefined
  }
  readonly toolInfo?: { readonly allTools?: Record<string, { readonly name?: string | undefined } | undefined> | undefined } | undefined
  readonly featureFlags?: UserRuleFeatureFlags & {
    readonly prCreationForgeGuidance?: boolean | undefined
    readonly enableAntiAskQuestionUserRule?: boolean | undefined
    readonly awaitToolName?: string | undefined
    readonly shellToolName?: string | undefined
    readonly grepToolName?: string | undefined
  }
}

export interface RulesPromptOptions {
  readonly categorizedRules?: {
    readonly globalRules: CursorRule[]
    readonly agentRequestableRules: CursorRule[]
    readonly userRules: CursorRule[]
  }
  readonly readToolName?: string | undefined
  readonly awaitToolName?: string | undefined
  readonly shellToolName?: string | undefined
  readonly grepToolName?: string | undefined
}

/**
 * The rules section of the first user message, and how many rules went into it. A session that displays
 * no rules, or has none, gets no section at all rather than an empty one — and a cloud run gets no git
 * rules, because it submits work through the platform rather than through git itself.
 */
export function buildRulesSection(
  props: RulesPromptProps,
  options?: RulesPromptOptions,
): { readonly section?: PromptNode; readonly ruleCount: number } {
  if (props.displayOptions?.displayCursorRules === false) return { ruleCount: 0 }
  const workspacePaths = props.env?.workspacePaths ?? []
  const { globalRules, agentRequestableRules, userRules } = options?.categorizedRules ??
    categorizeCursorRules(props.cursorRules, workspacePaths, props.displayOptions?.agentType)
  const filteredAgentRequestableRules = agentRequestableRules.filter(rule => !isFileScopedRule(rule, workspacePaths))
  const isCloudAgentPrompt = props.backgroundAgentSource !== undefined
  const resolvedAgentType = props.displayOptions?.agentType ?? props.agentType
  const composerGitUserRules = !isCloudAgentPrompt &&
      shouldInjectComposerGitUserRules(props.modelInfo, resolvedAgentType) &&
      props.toolInfo?.allTools !== undefined
    ? getComposerGitUserRules(props.toolInfo, props.featureFlags?.prCreationForgeGuidance === true)
    : []
  const generatedUserRules = getGeneratedUserRulesForModel(props.modelInfo, props.featureFlags, {
    awaitToolName: options?.awaitToolName,
    shellToolName: options?.shellToolName,
    grepToolName: options?.grepToolName,
  })
  const askQuestionToolName = props.toolInfo?.allTools?.ASK_QUESTION?.name ?? "AskQuestion"
  const antiAskQuestionUserRules = props.featureFlags?.enableAntiAskQuestionUserRule === true
    ? [buildAntiAskQuestionUserRule(askQuestionToolName)]
    : []
  const customUserRules = [...antiAskQuestionUserRules, ...composerGitUserRules, ...generatedUserRules]
  const hasRules = globalRules.length > 0 ||
    filteredAgentRequestableRules.length > 0 ||
    userRules.length > 0 ||
    customUserRules.length > 0
  if (!hasRules) return { ruleCount: 0 }
  return {
    section: jsx(RulesSection as unknown as (props: Record<string, unknown>) => PromptNode, {
      globalRules,
      agentRequestableRules: filteredAgentRequestableRules,
      userRules,
      readToolName: options?.readToolName,
      composer2CustomUserRules: customUserRules,
    }),
    ruleCount: globalRules.length + filteredAgentRequestableRules.length + userRules.length + customUserRules.length,
  }
}
