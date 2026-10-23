/**
 * The context a summary cannot carry, and where it goes around one.
 *
 * Summarizing a conversation rewrites its history, and some of that history is not a message at all: the
 * mode the session is in, the root it is working on, the plan it is following, the todo list it is working
 * through, the transcript behind the summary, the trigger that started an automation run, the skills it has
 * loaded. A summary would lose all of it, so it is kept aside and put back around the summary — in an order
 * that depends on which summarizer wrote the summary, because each one leaves a different shape behind.
 *
 * Two of those blocks go before the summary and the rest after it, and the placement is per summarizer:
 * the platform's own summarizer puts the mode and the root in front, and the vendor-side compactors put
 * the mode and root in front as well but order the rest differently. The blocks are rendered by one
 * function per block, with an override where a summarizer wants the same information said its own way:
 * the plan becomes a plan tag for one compactor, a todo list loses its note for another, and the trigger
 * loses its framing for a third. A block that has nothing to say is left out rather than rendered empty.
 */

import { PrivacyCapability } from "../redaction/classification.ts"
import { formatTranscriptLocation } from "./transcript-location.ts"

export type DurableBlockSummarizer =
  | "external"
  | "self-summary"
  | "openai-compaction"
  | "anthropic-compaction"
  | "xai-compaction"

type DurableBlockId =
  | "mode-prompt"
  | "project-root"
  | "plan"
  | "transcript"
  | "automation-trigger"
  | "todos"
  | "skills"

const PLACEMENTS: Record<DurableBlockSummarizer, { leading: DurableBlockId[]; trailing: DurableBlockId[] }> = {
  external: {
    leading: [],
    trailing: ["plan", "transcript", "mode-prompt", "project-root", "automation-trigger", "todos", "skills"],
  },
  "self-summary": {
    leading: ["mode-prompt", "project-root"],
    trailing: ["transcript", "todos", "automation-trigger", "skills"],
  },
  "openai-compaction": {
    leading: ["mode-prompt", "project-root"],
    trailing: ["todos", "automation-trigger", "skills", "transcript"],
  },
  "anthropic-compaction": {
    leading: ["mode-prompt", "project-root"],
    trailing: ["transcript", "todos", "automation-trigger", "skills"],
  },
  "xai-compaction": {
    leading: [],
    trailing: ["plan", "mode-prompt", "project-root", "todos", "automation-trigger", "skills", "transcript"],
  },
}

const BLOCK_GAP = "\n\n"

export interface DurablePlan {
  readonly content: { unwrap(purpose: PrivacyCapability): string }
  readonly name?: string | undefined
  readonly composerId?: string | undefined
}

export interface DurableBlockEnrichments {
  readonly modePrompt?: string | undefined
  readonly projectRootPrompt?: string | undefined
  readonly currentPlan?: DurablePlan | null | undefined
  readonly agentTranscriptsFolder?: string | undefined
  readonly conversationId?: string | undefined
  readonly automationTriggerContext?: string | undefined
  readonly todoContent?: string | undefined
  readonly skillBlocks: readonly string[]
}

export interface DurableBlockRenderContext {
  readonly includeTranscript?: boolean | undefined
}

function todoUpdateTag(todoContent: string): string {
  return `<todo_update>\n${todoContent}\n</todo_update>`
}

/** A plan with nothing in it is not worth carrying, so it is treated as absent. */
function planContentText(plan: DurablePlan): string | undefined {
  const planText = plan.content.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
  return planText && planText.trim().length > 0 ? planText : undefined
}

/** The plan is addressed by the scheme the platform's own files use, with or without a session id. */
function planFilePath(plan: DurablePlan): string {
  const planName = plan.name || "plan"
  const planFilename = planName.endsWith(".plan.md") ? planName : `${planName}.plan.md`
  return plan.composerId
    ? `cursor-plan://${plan.composerId}/${planFilename}`
    : `cursor-plan:///${planFilename}`
}

function transcriptSection(agentTranscriptsFolder: string, conversationId: string | undefined, useXml: boolean): string {
  const locationText = formatTranscriptLocation(agentTranscriptsFolder, { conversationId, useXml })
  // The location text brings its own leading blank line, which the block separator already provides.
  return locationText.startsWith(BLOCK_GAP) ? locationText.slice(BLOCK_GAP.length) : locationText
}

type BlockRender = (sessionContext: DurableBlockEnrichments, renderOptions: DurableBlockRenderContext) => string | undefined
interface BlockRendererSpec { readonly render: BlockRender; readonly overrides?: Partial<Record<DurableBlockSummarizer, BlockRender>> }

function modePromptBlock(sessionContext: DurableBlockEnrichments): string | undefined {
  return sessionContext.modePrompt
}

function projectRootBlock(sessionContext: DurableBlockEnrichments): string | undefined {
  return sessionContext.projectRootPrompt
}

/** The plan is rendered as a numbered step the model reads like a file it can open. */
function planBlock(sessionContext: DurableBlockEnrichments): string | undefined {
  if (!sessionContext.currentPlan) return undefined
  const content = planContentText(sessionContext.currentPlan)
  if (content === undefined) return undefined
  const instruction = "The below plan was previously created in this session. If you are still in plan mode, continue to iterate on the plan with the user given the rest of your context on the current conversation. Otherwise, if there are remaining relevant todos, you should continue to implement them according to the plan."
  return `10. Current plan mode progress:
   ${instruction}

<file_contents path="${planFilePath(sessionContext.currentPlan)}" isFullFile="true">
${content}
</file_contents>`
}

function xaiPlanBlock(sessionContext: DurableBlockEnrichments): string | undefined {
  if (!sessionContext.currentPlan) return undefined
  const content = planContentText(sessionContext.currentPlan)
  return content === undefined ? undefined : `<current_plan>
${content}
</current_plan>`
}

// The transcript is offered in the tag shape unless the summarizer reads the markdown one.
function transcriptBlock(sessionContext: DurableBlockEnrichments, renderOptions: DurableBlockRenderContext): string | undefined {
  return renderOptions.includeTranscript !== false && sessionContext.agentTranscriptsFolder
    ? transcriptSection(sessionContext.agentTranscriptsFolder, sessionContext.conversationId, true)
    : undefined
}

function externalTranscriptBlock(sessionContext: DurableBlockEnrichments, renderOptions: DurableBlockRenderContext): string | undefined {
  return renderOptions.includeTranscript !== false && sessionContext.agentTranscriptsFolder
    ? transcriptSection(sessionContext.agentTranscriptsFolder, sessionContext.conversationId, false)
    : undefined
}

function automationTriggerBlock(sessionContext: DurableBlockEnrichments): string | undefined {
  return sessionContext.automationTriggerContext
    ? `NOTE: This is an automation run. The original trigger info that started this session:
${sessionContext.automationTriggerContext}`
    : undefined
}

function externalAutomationTriggerBlock(sessionContext: DurableBlockEnrichments): string | undefined {
  return sessionContext.automationTriggerContext
    ? `12. Automation trigger info (this is the original trigger that started this agent):

${sessionContext.automationTriggerContext}`
    : undefined
}

function xaiAutomationTriggerBlock(sessionContext: DurableBlockEnrichments): string | undefined {
  return sessionContext.automationTriggerContext
}

function todosBlock(sessionContext: DurableBlockEnrichments): string | undefined {
  return sessionContext.todoContent
    ? `NOTE: There was an active todo list in the conversation. Here is the latest update before summarization:
${todoUpdateTag(sessionContext.todoContent)}`
    : undefined
}

function xaiTodosBlock(sessionContext: DurableBlockEnrichments): string | undefined {
  return sessionContext.todoContent ? todoUpdateTag(sessionContext.todoContent) : undefined
}

function skillsBlock(sessionContext: DurableBlockEnrichments): string | undefined {
  return sessionContext.skillBlocks.length > 0 ? sessionContext.skillBlocks.join(BLOCK_GAP) : undefined
}

const RENDERERS_BY_BLOCK: Record<DurableBlockId, BlockRendererSpec> = {
  "mode-prompt": { render: modePromptBlock },
  "project-root": { render: projectRootBlock },
  plan: { render: planBlock, overrides: { "xai-compaction": xaiPlanBlock } },
  transcript: { render: transcriptBlock, overrides: { external: externalTranscriptBlock } },
  "automation-trigger": {
    render: automationTriggerBlock,
    overrides: {
      external: externalAutomationTriggerBlock,
      "xai-compaction": xaiAutomationTriggerBlock,
    },
  },
  todos: { render: todosBlock, overrides: { "xai-compaction": xaiTodosBlock } },
  skills: { render: skillsBlock },
}


/** The blocks a summarizer places at all, which is what has to be rendered for it. */
function blockOrderFor(style: DurableBlockSummarizer): DurableBlockId[] {
  const { leading, trailing } = PLACEMENTS[style]
  return [...new Set([...leading, ...trailing])]
}

/** A block that is placed twice is placed once, in the position it was placed first. */
function blockTextsFor(placedBlocks: ReadonlyMap<DurableBlockId, string>, ids: readonly DurableBlockId[]): string[] {
  const placed = new Set<DurableBlockId>()
  const renderedTexts: string[] = []
  for (const id of ids) {
    if (placed.has(id)) continue
    placed.add(id)
    const renderedText = placedBlocks.get(id)
    if (renderedText !== undefined) renderedTexts.push(renderedText)
  }
  return renderedTexts
}

/** The renderer a style reads for one block: its own wording when it has one, the default otherwise. */
function renderOneBlock(
  style: DurableBlockSummarizer,
  id: DurableBlockId,
  sessionContext: DurableBlockEnrichments,
  renderOptions: DurableBlockRenderContext,
): string | undefined {
  const renderer = RENDERERS_BY_BLOCK[id]
  const render = renderer.overrides?.[style] ?? renderer.render
  return render(sessionContext, renderOptions)
}

export function renderDurableBlocks(
  style: DurableBlockSummarizer,
  sessionContext: DurableBlockEnrichments,
  renderOptions: DurableBlockRenderContext = {},
): Map<DurableBlockId, string> {
  const placedBlocks = new Map<DurableBlockId, string>()
  for (const id of blockOrderFor(style)) {
    const renderedText = renderOneBlock(style, id, sessionContext, renderOptions)
    if (renderedText !== undefined && renderedText.length > 0) placedBlocks.set(id, renderedText)
  }
  return placedBlocks
}

/** The placed blocks, joined on the side of the summary the placement asks for. */
function joinBlocks(
  style: DurableBlockSummarizer,
  placedBlocks: ReadonlyMap<DurableBlockId, string>,
  placement: "leading" | "trailing",
): string {
  return blockTextsFor(placedBlocks, PLACEMENTS[style][placement])
    .map(renderedText => placement === "trailing" ? `${BLOCK_GAP}${renderedText}` : `${renderedText}${BLOCK_GAP}`)
    .join("")
}

export function appendDurableBlocks(style: DurableBlockSummarizer, placedBlocks: ReadonlyMap<DurableBlockId, string>): string {
  return joinBlocks(style, placedBlocks, "trailing")
}

export function prependDurableBlocks(style: DurableBlockSummarizer, placedBlocks: ReadonlyMap<DurableBlockId, string>): string {
  return joinBlocks(style, placedBlocks, "leading")
}
