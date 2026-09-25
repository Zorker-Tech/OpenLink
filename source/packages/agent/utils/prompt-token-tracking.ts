/**
 * Measuring what the prompt costs, before the model is asked anything.
 *
 * A turn's prompt is assembled from pieces the platform can name — tool definitions, rules, skills, the
 * conversation so far, whatever the user attached — and knowing which piece is expensive is the only way
 * to notice when one of them grows without anyone deciding it should. So each piece is counted here and
 * reported as one event, together with whether MCP is enabled at all and how it is being reached, since
 * the two discovery routes cost very different amounts.
 *
 * Counting is by estimate, not by tokenizer: it is used to compare one turn with the next, not to
 * predict a bill. Redacted values are unwrapped for counting only, under the capability that says the
 * number is not the value.
 *
 * The skill catalogue is counted through the same builder the prompt uses, so the number reported is the
 * number the model was actually given — including whatever the budget shortened or left out — and the
 * strategy it chose is left on the state handler for the rest of the turn to read.
 */

import { PrivacyCapability } from "../../redaction/classification.ts"
import { fromRedactedLsDirectoryTreeNode } from "../../redacted-protos/generated/agent/v1/ls_exec_redacted.ts"
import type { Context } from "../../context/context.ts"
import type { AgentSkill } from "../../proto/generated/agent/v1/agent_skills_pb.ts"
import type { CursorRule } from "../../proto/generated/agent/v1/rules_pb.ts"
import { renderManuallyAttachedSkillsSection } from "../manually-attached-skills.ts"
import { resolveSelectedContextSkillSections, type SelectedContextSkillInput } from "../selected-context-skills.ts"
import { buildAvailableSkillsPromptSection } from "../prompts/available-skills-section.ts"
import { categorizeCursorRules } from "../prompts/rule-categorization.ts"
import { renderContent } from "../../prompt-jsx/index.ts"
import type { PromptNode } from "../../prompt-jsx/index.ts"
import { getAgentEventTracker } from "./event-tracking.ts"
import { emitMcpEligibleModelInvocation, emitMcpPromptToolStats } from "./mcp-metrics.ts"
import { emitSkillCatalogBudgetMetrics } from "./skill-budget-metrics.ts"
import { estimateStringTokenCount } from "./token-estimate.ts"
import { AgentType } from "./agent-config.ts"

interface PromptMessageLike {
  readonly role: string
  readonly content: unknown
}

interface ConversationHistoryTokenUsage {
  readonly conversationHistoryTokens: number
  readonly conversationHistoryMessageCount: number
}

interface McpToolLike {
  readonly name: string
  readonly description?: unknown
  readonly inputSchema?: unknown
}

interface McpToolTokenUsage {
  readonly mcpToolTokens: number
  readonly mcpToolCount: number
}

interface McpPromptTrackingOptions {
  readonly enabled?: unknown
  readonly mcpDescriptors: readonly unknown[]
}

interface McpPromptTrackingRequestContext {
  readonly rules: CursorRule[]
  readonly agentSkills?: AgentSkill[] | undefined
  readonly env?: { readonly workspacePaths?: readonly string[] | undefined } | undefined
  readonly mcpMetaToolOptions?: McpPromptTrackingOptions | undefined
  readonly mcpFileSystemOptions?: McpPromptTrackingOptions | undefined
}

interface McpPromptTrackingContext {
  readonly mcpEnabled: boolean
  readonly discoveryMode: "meta" | "filesystem" | "disabled"
  readonly serverCount: number
}

interface RedactedAttachmentStringLike {
  readonly length: number
  unwrap(purpose: PrivacyCapability): string
}

interface SelectedContextFileAttachmentLike {
  readonly path: RedactedAttachmentStringLike | null | undefined
  readonly content: RedactedAttachmentStringLike | null | undefined
}

interface SelectedContextTerminalLike {
  readonly content: RedactedAttachmentStringLike | null | undefined
  readonly title: RedactedAttachmentStringLike | null | undefined
}

interface SelectedContextFolderLike {
  readonly path: RedactedAttachmentStringLike | null | undefined
  readonly directoryTree?: unknown
}

interface SelectedContextFileAttachmentsLike {
  readonly codeSelections: readonly SelectedContextFileAttachmentLike[]
  readonly terminals: readonly SelectedContextTerminalLike[]
  readonly terminalSelections: readonly SelectedContextTerminalLike[]
  readonly files: readonly SelectedContextFileAttachmentLike[]
  readonly folders: readonly SelectedContextFolderLike[]
}

interface SelectedContextSkillValueLike {
  readonly fullPath?: unknown
  readonly content?: unknown
  readonly plugin?: unknown
  readonly marketplace?: unknown
  readonly pluginId?: unknown
  readonly marketplaceId?: unknown
}

interface SelectedContextCursorRuleValueLike {
  readonly rule?: SelectedContextSkillValueLike
}

interface SelectedContextSkillNormalizationInput {
  readonly selectedSkills?: readonly SelectedContextSkillValueLike[]
  readonly cursorRules?: readonly SelectedContextCursorRuleValueLike[]
}

interface PromptTokenTrackingDisplayOptions {
  readonly agentType?: AgentType | undefined
  readonly computerUseSubagentSurface?: boolean | undefined
  readonly displaySkills?: boolean | undefined
  readonly displayCursorRules?: boolean | undefined
}

interface PromptTokenTrackingFeatureFlags {
  readonly protectLoopSkillDescription?: boolean | undefined
}

interface PromptTokenTrackingParams {
  readonly ctx: Context
  readonly mcpTools: readonly McpToolLike[]
  readonly requestContext: McpPromptTrackingRequestContext
  readonly messages: readonly PromptMessageLike[]
  readonly selectedContext: (SelectedContextFileAttachmentsLike & SelectedContextSkillNormalizationInput) | null | undefined
  readonly userInfoDisplayOptions: PromptTokenTrackingDisplayOptions | undefined
  readonly readToolName: string | undefined
  readonly invocationId: string
  readonly agentTokenLimit: number | undefined
  readonly modelInfo: { readonly isGpt56?: boolean | undefined } | undefined
  readonly featureFlags: PromptTokenTrackingFeatureFlags | undefined
  readonly stateHandler: { lastSkillCatalogBudgetStrategy?: string | undefined }
}

const decodeRedactedLsDirectoryTreeNode = fromRedactedLsDirectoryTreeNode as unknown as (
  message: unknown,
  purpose: PrivacyCapability,
) => unknown

export function countConversationHistoryTokens(
  messages: readonly PromptMessageLike[],
): ConversationHistoryTokenUsage {
  let conversationHistoryTokens = 0
  // The system prompt is not history: it is the same every turn and is counted elsewhere.
  const nonSystemMessages = messages.filter(message => message.role !== "system")
  const conversationHistoryMessageCount = nonSystemMessages.length
  for (const message of nonSystemMessages) {
    if (typeof message.content === "string") {
      conversationHistoryTokens += estimateStringTokenCount(message.content)
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (typeof part === "string") {
          conversationHistoryTokens += estimateStringTokenCount(part)
        } else if (typeof part === "object" && part !== null) {
          if ("text" in part && typeof part.text === "string") {
            conversationHistoryTokens += estimateStringTokenCount(part.text)
          }
          if ("toolName" in part && typeof part.toolName === "string") {
            conversationHistoryTokens += estimateStringTokenCount(part.toolName)
          }
          if ("args" in part && part.args !== undefined) {
            conversationHistoryTokens += estimateStringTokenCount(JSON.stringify(part.args)!)
          }
          if ("result" in part && part.result !== undefined) {
            conversationHistoryTokens += estimateStringTokenCount(JSON.stringify(part.result)!)
          }
        }
      }
    }
  }
  return { conversationHistoryTokens, conversationHistoryMessageCount }
}

function countMcpToolDefinitionTokens(mcpTools: readonly McpToolLike[]): McpToolTokenUsage {
  let mcpToolTokens = 0
  const mcpToolCount = mcpTools.length
  for (const tool of mcpTools) {
    const toolStr = JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.inputSchema })
    mcpToolTokens += estimateStringTokenCount(toolStr!)
  }
  return { mcpToolTokens, mcpToolCount }
}

/** Which route MCP is being reached by, since the two cost very different amounts. */
function getMcpPromptTrackingContext(requestContext: McpPromptTrackingRequestContext): McpPromptTrackingContext {
  const metaToolOptions = requestContext.mcpMetaToolOptions
  if (metaToolOptions?.enabled) {
    return { mcpEnabled: true, discoveryMode: "meta", serverCount: metaToolOptions.mcpDescriptors.length }
  }
  const fileSystemOptions = requestContext.mcpFileSystemOptions
  if (fileSystemOptions?.enabled) {
    return { mcpEnabled: true, discoveryMode: "filesystem", serverCount: fileSystemOptions.mcpDescriptors.length }
  }
  return { mcpEnabled: false, discoveryMode: "disabled", serverCount: 0 }
}

function estimateRedactedStringTokenCount(str: {
  readonly length: number
  unwrap(purpose: PrivacyCapability): string
} | null | undefined): number {
  if (!str || str.length === 0) return 0
  return estimateStringTokenCount(str.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED))
}

function countFileAttachmentTokens(
  selectedContext: SelectedContextFileAttachmentsLike | null | undefined,
): { readonly fileAttachmentTokens: number; readonly fileAttachmentCount: number } {
  let fileAttachmentTokens = 0
  let fileAttachmentCount = 0
  if (!selectedContext) return { fileAttachmentTokens, fileAttachmentCount }
  for (const codeSelection of selectedContext.codeSelections) {
    fileAttachmentTokens += estimateRedactedStringTokenCount(codeSelection.path)
    fileAttachmentTokens += estimateRedactedStringTokenCount(codeSelection.content)
    fileAttachmentCount += 1
  }
  for (const terminal of selectedContext.terminals) {
    fileAttachmentTokens += estimateRedactedStringTokenCount(terminal.content)
    fileAttachmentTokens += estimateRedactedStringTokenCount(terminal.title)
    fileAttachmentCount += 1
  }
  for (const terminalSelection of selectedContext.terminalSelections) {
    fileAttachmentTokens += estimateRedactedStringTokenCount(terminalSelection.content)
    fileAttachmentTokens += estimateRedactedStringTokenCount(terminalSelection.title)
    fileAttachmentCount += 1
  }
  for (const file of selectedContext.files) {
    fileAttachmentTokens += estimateRedactedStringTokenCount(file.path)
    fileAttachmentTokens += estimateRedactedStringTokenCount(file.content)
    fileAttachmentCount += 1
  }
  for (const folder of selectedContext.folders) {
    fileAttachmentTokens += estimateRedactedStringTokenCount(folder.path)
    if (folder.directoryTree) {
      const unwrappedTree = decodeRedactedLsDirectoryTreeNode(folder.directoryTree, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
      fileAttachmentTokens += estimateStringTokenCount(JSON.stringify(unwrappedTree))
    }
    fileAttachmentCount += 1
  }
  return { fileAttachmentTokens, fileAttachmentCount }
}

/** What the attached skills cost is what the block that inlines them costs. */
function countManuallyAttachedSkillPromptUsage(
  selectedContext: SelectedContextSkillNormalizationInput | null | undefined,
): { readonly manuallyAttachedSkillTokens: number; readonly manuallyAttachedSkillCount: number } {
  if (!selectedContext) return { manuallyAttachedSkillTokens: 0, manuallyAttachedSkillCount: 0 }
  const normalizedSelectedContext = normalizeSelectedContextSkillInput(selectedContext)
  const { selectedSkills } = resolveSelectedContextSkillSections(
    normalizedSelectedContext as unknown as SelectedContextSkillInput,
  )
  const manuallyAttachedSkillsText = renderManuallyAttachedSkillsSection(selectedSkills as Array<{
    readonly fullPath: string
    readonly content: string
  }>)
  return {
    manuallyAttachedSkillTokens: manuallyAttachedSkillsText ? estimateStringTokenCount(manuallyAttachedSkillsText) : 0,
    manuallyAttachedSkillCount: selectedSkills.length,
  }
}

function normalizeSelectedContextSkillInput(selectedContext: SelectedContextSkillNormalizationInput): {
  readonly selectedSkills: Array<{
    readonly fullPath: string
    readonly content: string
    readonly plugin: string | undefined
    readonly marketplace: string | undefined
  }>
  readonly cursorRules: Array<{
    readonly rule: {
      readonly fullPath: string | undefined
      readonly content: string | undefined
    } | undefined
  }>
} {
  return {
    selectedSkills: (selectedContext.selectedSkills ?? []).map(skill => ({
      fullPath: unwrapMaybeRedactedString(skill.fullPath) ?? "",
      content: unwrapMaybeRedactedString(skill.content) ?? "",
      plugin: unwrapMaybeRedactedString(skill.plugin),
      marketplace: unwrapMaybeRedactedString(skill.marketplace),
    })),
    cursorRules: (selectedContext.cursorRules ?? []).map(cursorRule => ({
      rule: cursorRule.rule === undefined
        ? undefined
        : {
          fullPath: unwrapMaybeRedactedString(cursorRule.rule.fullPath),
          content: unwrapMaybeRedactedString(cursorRule.rule.content),
        },
    })),
  }
}

function unwrapMaybeRedactedString(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (typeof value === "object" && value !== null && "unwrap" in value && typeof value.unwrap === "function") {
    return (value as { unwrap(purpose: PrivacyCapability): string }).unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
  }
  return undefined
}

function renderSection(section: PromptNode): string {
  return renderContent(section)
}

function countCursorRuleTokens(params: {
  readonly rules: CursorRule[]
  readonly requestContext: McpPromptTrackingRequestContext
  readonly userInfoDisplayOptions: PromptTokenTrackingDisplayOptions | undefined
}): { readonly ruleTokens: number; readonly ruleCount: number } {
  let ruleTokens = 0
  const workspacePaths = params.requestContext.env?.workspacePaths ?? []
  const { globalRules, agentRequestableRules, userRules } = categorizeCursorRules(
    params.rules,
    workspacePaths,
    params.userInfoDisplayOptions?.agentType,
  )
  const promptRules = [...globalRules, ...agentRequestableRules, ...userRules]
  const ruleCount = promptRules.length
  for (const rule of promptRules) {
    ruleTokens += estimateStringTokenCount(rule.fullPath ?? "")
    ruleTokens += estimateStringTokenCount(rule.content ?? "")
  }
  return { ruleTokens, ruleCount }
}

function countAvailableSkillPromptUsage(params: {
  readonly ctx: Context
  readonly requestContext: McpPromptTrackingRequestContext
  readonly userInfoDisplayOptions: PromptTokenTrackingDisplayOptions | undefined
  readonly readToolName: string | undefined
  readonly agentTokenLimit: number | undefined
  readonly modelInfo: { readonly isGpt56?: boolean | undefined } | undefined
  readonly featureFlags: PromptTokenTrackingFeatureFlags | undefined
  readonly stateHandler: { lastSkillCatalogBudgetStrategy?: string | undefined } | undefined
}): { readonly availableSkillTokens: number; readonly availableSkillCount: number } {
  const { section, skillCount, renderedEstimatedTokens, uncappedEstimatedTokens, omittedSkillCount, strategy } =
    buildAvailableSkillsPromptSection({
      cursorRules: params.requestContext.rules,
      agentSkills: params.requestContext.agentSkills,
      displayOptions: params.userInfoDisplayOptions,
      env: params.requestContext.env,
      agentTokenLimit: params.agentTokenLimit,
      featureFlags: params.featureFlags,
      modelInfo: params.modelInfo,
    }, {
      readToolName: params.readToolName,
    })
  if (params.stateHandler !== undefined) params.stateHandler.lastSkillCatalogBudgetStrategy = strategy
  if (!section) return { availableSkillTokens: 0, availableSkillCount: 0 }
  if (strategy !== undefined && renderedEstimatedTokens !== undefined && uncappedEstimatedTokens !== undefined) {
    emitSkillCatalogBudgetMetrics(params.ctx, {
      strategy,
      renderedTokens: renderedEstimatedTokens,
      uncappedTokens: uncappedEstimatedTokens,
      omittedCount: omittedSkillCount ?? 0,
    })
  }
  return {
    availableSkillTokens: renderedEstimatedTokens ?? estimateStringTokenCount(renderSection(section)),
    availableSkillCount: skillCount,
  }
}

export function trackPromptTokenUsage(params: PromptTokenTrackingParams): void {
  const {
    ctx,
    mcpTools,
    requestContext,
    messages,
    selectedContext,
    userInfoDisplayOptions,
    readToolName,
    invocationId,
    agentTokenLimit,
    modelInfo,
    featureFlags,
    stateHandler,
  } = params
  const { mcpToolTokens, mcpToolCount } = countMcpToolDefinitionTokens(mcpTools)
  const { mcpEnabled, discoveryMode, serverCount } = getMcpPromptTrackingContext(requestContext)
  const { ruleTokens, ruleCount } = countCursorRuleTokens({ rules: requestContext.rules, requestContext, userInfoDisplayOptions })
  const { availableSkillTokens, availableSkillCount } = countAvailableSkillPromptUsage({
    ctx,
    requestContext,
    userInfoDisplayOptions,
    readToolName,
    agentTokenLimit,
    modelInfo,
    featureFlags,
    stateHandler,
  })
  const { manuallyAttachedSkillTokens, manuallyAttachedSkillCount } = countManuallyAttachedSkillPromptUsage(selectedContext)
  const { conversationHistoryTokens, conversationHistoryMessageCount } = countConversationHistoryTokens(messages)
  const { fileAttachmentTokens, fileAttachmentCount } = countFileAttachmentTokens(selectedContext)
  emitMcpEligibleModelInvocation(ctx, { discoveryMode, serverCount })
  emitMcpPromptToolStats(ctx, { discoveryMode, toolCount: mcpToolCount, toolTokens: mcpToolTokens })
  const event = {
    mcpToolTokens,
    mcpToolCount,
    mcpEnabled,
    mcpDiscoveryMode: discoveryMode,
    mcpServerCount: serverCount,
    ruleTokens,
    ruleCount,
    availableSkillTokens,
    availableSkillCount,
    manuallyAttachedSkillTokens,
    manuallyAttachedSkillCount,
    conversationHistoryTokens,
    conversationHistoryMessageCount,
    fileAttachmentTokens,
    fileAttachmentCount,
    invocationId,
  }
  getAgentEventTracker(ctx).trackPromptTokens(ctx, event)
}
