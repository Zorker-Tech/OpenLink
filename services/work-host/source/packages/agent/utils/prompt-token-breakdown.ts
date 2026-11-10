/**
 * Where a prompt's tokens went, category by category.
 *
 * A prompt is assembled from pieces the platform can name: the system prompt, the tool definitions,
 * the rules and skills blocks, the MCP and dynamic tool blocks, the subagent definitions, the
 * conversation itself, and — when the conversation was summarized — the summary that stands in for it.
 * Splitting the prompt back into those pieces is what makes the token count explainable rather than a
 * single number.
 *
 * Two ways of counting exist because the two numbers mean different things. The first is a raw
 * estimate per category, and it is what gets reported when nothing better is available: the categories
 * are then apportioned to the total the provider actually reported, so the parts always add up to the
 * whole. The second reuses what the previous turn learned about each category's token-to-character
 * ratio, which keeps the breakdown stable as the prompt grows — and it only applies to the categories
 * that are cached between turns, because the conversation is new text every time and is simply given
 * whatever is left of the total.
 *
 * If the cacheable part alone would exceed the total, the provider's number and the previous
 * breakdown disagree about something the platform cannot see; the previous breakdown is kept rather
 * than inventing a negative conversation.
 */

import { createHistogram } from "../../metrics/index.ts"
import type { Context } from "../../context/context.ts"
import { buildDescriptionGeneratorProps, toAgentTools } from "../tools/tool-execution.ts"
import type { PromptTokenBreakdownSnapshotValue } from "./prompt-usage-contracts.ts"
import { estimateStringTokenCount } from "./token-estimate.ts"
import { extractCompleteTagRanges } from "./prompt-tags.ts"
import type { PromptMessageLike, PromptToolLike } from "./prompt-shapes.ts"
import {
  extractToolDiscoveryBlocks,
  getTextLikeContentParts,
  isSummaryCarrierMessage,
  isToolDiscoveryBlockTag,
  serializeProviderFacingToolDefinition,
  splitSubagentDescriptionFromTool,
  stripTagBlocks,
} from "./prompt-scan.ts"

/** The categories a breakdown reports, in the order it reports them. The ids travel to the UI. */
export const PROMPT_TOKEN_CATEGORIES = [
  { id: "system_prompt", label: "System prompt" },
  { id: "tools", label: "Tool definitions" },
  { id: "rules", label: "Rules" },
  { id: "skills", label: "Skills" },
  { id: "mcp", label: "MCP & dynamic tools" },
  { id: "subagents", label: "Subagent definitions" },
  { id: "summarized_conversation", label: "Summarized conversation" },
  { id: "conversation", label: "Conversation" },
] as const

type CategoryId = (typeof PROMPT_TOKEN_CATEGORIES)[number]["id"]

/** Everything except the conversation is cached between turns, and so can be estimated from history. */
const CACHEABLE_CATEGORY_IDS: readonly CategoryId[] =
  PROMPT_TOKEN_CATEGORIES.map(category => category.id).filter(id => id !== "conversation")

export interface PromptTokenBreakdownParams {
  messages: readonly PromptMessageLike[]
  tools: readonly PromptToolLike[]
  descriptionProps?: Record<string, unknown> | undefined
  totalUsedTokens: number
  maxTokens: number
  previousSnapshot?: PromptTokenBreakdownSnapshotValue | undefined
}

/** A category's resolved numbers, whether they came from the cache or from an estimate. */
interface ResolvedCategory {
  characterCount: number
  estimatedTokens: number
}

export function buildPromptTokenBreakdownSnapshot(ctx: Context, params: PromptTokenBreakdownParams): PromptTokenBreakdownSnapshotValue {
  const sources = collectAllCategorySources(params.messages, params.tools, params.descriptionProps)
  const charCounts = mapCategoryRecord(sources, segments => sumCharacterCount(segments))
  emitCategoryEstimatedTokensMetric(ctx, sources)
  const previousSnapshot = params.previousSnapshot
  if (previousSnapshot === undefined || !snapshotHasCharacterCounts(previousSnapshot)) {
    return buildApportionedSnapshot(sources, charCounts, params)
  }
  const previousByCategory = indexCategoriesById(previousSnapshot)
  const avgRatio = computeAvgRatio(previousByCategory)
  const resolved = resolveCacheableCategories(charCounts, previousByCategory, avgRatio)
  const cacheableSum = sumCacheableEstimatedTokens(resolved)
  const total = roundClampNonNegative(params.totalUsedTokens)
  // The cache cannot be larger than the whole; when it claims to be, the previous breakdown is kept.
  if (cacheableSum > total) return previousSnapshot
  return buildSnapshotFromResolvedCategories({
    resolved,
    conversationCharCount: charCounts.conversation,
    conversationEstimatedTokens: total - cacheableSum,
    totalUsedTokens: params.totalUsedTokens,
    maxTokens: params.maxTokens,
  })
}

/**
 * The breakdown after a summarization: only the summary's own size changed, so every other cached
 * category is carried over and the conversation keeps whatever the total leaves.
 */
export function buildSummarizeRefreshSnapshot(params: {
  previousSnapshot?: PromptTokenBreakdownSnapshotValue | undefined
  newSummarizedConversationCharCount: number
  totalUsedTokens: number
  maxTokens: number
}): PromptTokenBreakdownSnapshotValue | undefined {
  if (!snapshotHasCharacterCounts(params.previousSnapshot)) return params.previousSnapshot
  const previousByCategory = indexCategoriesById(params.previousSnapshot)
  const avgRatio = computeAvgRatio(previousByCategory)
  const resolved = new Map<CategoryId, ResolvedCategory>()
  for (const id of CACHEABLE_CATEGORY_IDS) {
    if (id === "summarized_conversation") {
      resolved.set(id, resolveCachedCategory(params.newSummarizedConversationCharCount, previousByCategory.get(id), avgRatio))
      continue
    }
    const previous = previousByCategory.get(id)
    resolved.set(id, {
      characterCount: previous?.characterCount ?? 0,
      estimatedTokens: previous?.estimatedTokens ?? 0,
    })
  }
  const cacheableSum = sumCacheableEstimatedTokens(resolved)
  const total = roundClampNonNegative(params.totalUsedTokens)
  if (cacheableSum > total) return params.previousSnapshot
  const conversationEstimatedTokens = total - cacheableSum
  const previousConversation = previousByCategory.get("conversation")
  return buildSnapshotFromResolvedCategories({
    resolved,
    conversationCharCount: previousConversation?.characterCount ?? 0,
    conversationEstimatedTokens,
    totalUsedTokens: params.totalUsedTokens,
    maxTokens: params.maxTokens,
  })
}

function collectAllCategorySources(
  messages: readonly PromptMessageLike[],
  tools: readonly PromptToolLike[],
  descriptionProps: Record<string, unknown> | undefined,
): Record<CategoryId, string[]> {
  const { tools: toolSegments, subagents: subagentSegments } = collectToolAndSubagentSegments(tools, descriptionProps)
  return {
    system_prompt: collectSystemPromptSegments(messages),
    tools: toolSegments,
    rules: collectRulesSegments(messages),
    skills: collectSkillsSegments(messages),
    mcp: collectMcpPromptBlockSegments(messages),
    subagents: [
      ...subagentSegments,
      ...collectInitialPromptBlockSegments(messages, "available_subagent_models"),
      ...collectInitialPromptBlockSegments(messages, "available_subagent_types"),
    ],
    summarized_conversation: collectSummarizedConversationSegments(messages),
    conversation: collectConversationSegments(messages),
  }
}

/** The system prompt without the tool-discovery blocks, which are counted as MCP and dynamic tools. */
function collectSystemPromptSegments(messages: readonly PromptMessageLike[]): string[] {
  const segments: string[] = []
  for (const message of messages) {
    if (message.role !== "system") continue
    for (const text of getTextLikeContentParts(message.content)) {
      segments.push(stripTagBlocks(text, isToolDiscoveryBlockTag))
    }
  }
  return segments
}

function collectToolAndSubagentSegments(
  tools: readonly PromptToolLike[],
  descriptionProps: Record<string, unknown> | undefined,
): { tools: string[]; subagents: string[] } {
  const descriptionPropsToUse = descriptionProps ?? buildDescriptionGeneratorProps(tools as never)
  const agentTools = toAgentTools(tools as never, descriptionPropsToUse)
  const toolSegments: string[] = []
  const subagentSegments: string[] = []
  for (let index = 0; index < tools.length; index++) {
    const tool = tools[index]
    const agentTool = agentTools[index]
    if (tool === undefined || agentTool === undefined) continue
    const split = splitSubagentDescriptionFromTool(tool, agentTool.description, descriptionPropsToUse)
    toolSegments.push(serializeProviderFacingToolDefinition({ ...agentTool, description: split.toolDescription }))
    if (split.subagentText.length > 0) subagentSegments.push(split.subagentText)
  }
  return { tools: toolSegments, subagents: subagentSegments }
}

function collectRulesSegments(messages: readonly PromptMessageLike[]): string[] {
  return collectTaggedBlocksInInitialPrompt(messages, "rules")
}

/** Skills are only counted when the prompt actually carries the user-info block they belong to. */
function collectSkillsSegments(messages: readonly PromptMessageLike[]): string[] {
  return collectTaggedBlocksInInitialPrompt(messages, "agent_skills", { requiresUserInfoBlock: true })
}

function collectInitialPromptBlockSegments(messages: readonly PromptMessageLike[], tagName: string): string[] {
  return collectTaggedBlocksInInitialPrompt(messages, tagName, { requiresUserInfoBlock: true })
}

function collectTaggedBlocksInInitialPrompt(
  messages: readonly PromptMessageLike[],
  tagName: string,
  options: { requiresUserInfoBlock?: boolean } = {},
): string[] {
  const initialUserMessage = findInitialUserPromptMessage(messages)
  if (initialUserMessage === undefined) return []
  const segments: string[] = []
  for (const text of getTextLikeContentParts(initialUserMessage.content)) {
    if (options.requiresUserInfoBlock === true && extractCompleteTagRanges(text, "user_info").length === 0) continue
    for (const block of extractCompleteTagRanges(text, tagName)) {
      segments.push(text.slice(block.start, block.end))
    }
  }
  return segments
}

/** MCP and dynamic tool blocks, counted wherever they appear outside the conversation. */
function collectMcpPromptBlockSegments(messages: readonly PromptMessageLike[]): string[] {
  const segments: string[] = []
  for (const message of messages) {
    if (message.role === "tool") continue
    if (isSummaryCarrierMessage(message)) continue
    for (const text of getTextLikeContentParts(message.content)) {
      for (const block of extractToolDiscoveryBlocks(text)) segments.push(block)
    }
  }
  return segments
}

const INITIAL_PROMPT_SCAFFOLD_TAGS = [
  "user_info",
  "rules",
  "agent_skills",
  "available_subagent_models",
  "available_subagent_types",
] as const

/** The blocks the platform adds to the first user message, which belong to their own categories. */
function isInitialPromptScaffoldTag(tagName: string): boolean {
  return INITIAL_PROMPT_SCAFFOLD_TAGS.some(tag => tag === tagName) || isToolDiscoveryBlockTag(tagName)
}

/** Everything the model was actually told, minus what was already counted as a category of its own. */
function collectConversationSegments(messages: readonly PromptMessageLike[]): string[] {
  const segments: string[] = []
  let initialUserPromptSeen = false
  for (const message of messages) {
    if (message.role === "system") continue
    if (isSummaryCarrierMessage(message)) continue
    const isInitialUserPrompt = message.role === "user" && !initialUserPromptSeen
    if (message.role === "user") initialUserPromptSeen = true
    collectConversationContentSegments(
      message.content,
      { scaffoldStripMode: isInitialUserPrompt ? "initial-prompt-scaffold" : "mcp-blocks" },
      segments,
    )
  }
  return segments
}

/** The summary is counted as its own category, so its carrier message is not part of the conversation. */
function collectSummarizedConversationSegments(messages: readonly PromptMessageLike[]): string[] {
  const segments: string[] = []
  for (const message of messages) {
    if (!isSummaryCarrierMessage(message)) continue
    collectConversationContentSegments(message.content, { scaffoldStripMode: "none" }, segments)
  }
  return segments
}

interface StripOptions {
  scaffoldStripMode: "initial-prompt-scaffold" | "mcp-blocks" | "none"
}

function collectConversationContentSegments(content: unknown, options: StripOptions, out: string[]): void {
  if (typeof content === "string") {
    pushConversationText(content, options, out)
    return
  }
  if (!Array.isArray(content)) return
  for (const part of content) collectConversationContentPartSegments(part, options, out)
}

function collectConversationContentPartSegments(part: unknown, options: StripOptions, out: string[]): void {
  if (typeof part === "string") {
    pushConversationText(part, options, out)
    return
  }
  if (typeof part !== "object" || part === null) return
  const record = part as Record<string, unknown>
  if ("text" in record) {
    if (isPromptTextPart(record)) collectConversationPromptValueSegments(record.text, options, out)
    else collectConversationStructuredValueSegments(record.text, out)
  }
  for (const field of ["reasoning", "thinking"]) {
    if (field in record) collectConversationStructuredValueSegments(record[field], out)
  }
  if ("toolName" in record && typeof record.toolName === "string") out.push(record.toolName)
  for (const field of ["args", "input", "result"]) {
    if (field in record) collectConversationStructuredValueSegments(record[field], out)
  }
  // A part that has content but no result is a tool result of its own; count it once, not twice.
  if (!("result" in record) && "content" in record) collectConversationStructuredValueSegments(record.content, out)
}

/** Only a plain text part is prompt text; anything else was sent to the model as data. */
function isPromptTextPart(part: Record<string, unknown>): boolean {
  return !("type" in part) || part.type === "text"
}

function collectConversationPromptValueSegments(value: unknown, options: StripOptions, out: string[]): void {
  if (value === undefined || value === null) return
  if (typeof value === "string") {
    pushConversationText(value, options, out)
    return
  }
  collectConversationStructuredValueSegments(value, out)
}

function collectConversationStructuredValueSegments(value: unknown, out: string[]): void {
  if (value === undefined || value === null) return
  if (typeof value === "string") {
    out.push(value)
    return
  }
  try {
    out.push(JSON.stringify(value))
  } catch {
    // A value that cannot be serialized was never sent as text either; counting nothing is right.
  }
}

function pushConversationText(text: string, options: StripOptions, out: string[]): void {
  switch (options.scaffoldStripMode) {
    case "initial-prompt-scaffold":
      out.push(stripTagBlocks(text, isInitialPromptScaffoldTag))
      return
    case "mcp-blocks":
      out.push(stripTagBlocks(text, isToolDiscoveryBlockTag))
      return
    case "none":
      out.push(text)
      return
  }
}

/**
 * Handing each category its share of the total the provider reported. The shares are floored and the
 * remainder goes to the categories that were closest to the next whole token, largest first and in
 * declaration order for ties, so the parts always add up to the whole and small prompts stay stable.
 */
function apportionRawWeightsToTotal(
  rawTokensByCategory: Record<CategoryId, number>,
  targetTotalTokens: number,
): Record<CategoryId, number> {
  const total = roundClampNonNegative(targetTotalTokens)
  const apportioned = Object.fromEntries(
    PROMPT_TOKEN_CATEGORIES.map(category => [category.id, 0]),
  ) as Record<CategoryId, number>
  if (total === 0) return apportioned
  const weights = PROMPT_TOKEN_CATEGORIES.map((category, index) => ({
    id: category.id,
    originalIndex: index,
    weight: Math.max(0, rawTokensByCategory[category.id] ?? 0),
  }))
  const weightTotal = weights.reduce((sum, entry) => sum + entry.weight, 0)
  // Nothing to weigh: the whole prompt is the conversation.
  if (weightTotal === 0) {
    apportioned.conversation = total
    return apportioned
  }
  const scaled = weights.map(({ id, originalIndex, weight }) => {
    const exact = (weight / weightTotal) * total
    const floored = Math.floor(exact)
    return { id, originalIndex, floored, remainder: exact - floored }
  })
  for (const { id, floored } of scaled) apportioned[id] = floored
  let remaining = total - scaled.reduce((sum, entry) => sum + entry.floored, 0)
  const byLargestRemainder = [...scaled].sort((left, right) => {
    if (right.remainder !== left.remainder) return right.remainder - left.remainder
    return left.originalIndex - right.originalIndex
  })
  for (const { id } of byLargestRemainder) {
    if (remaining <= 0) break
    apportioned[id] += 1
    remaining -= 1
  }
  return apportioned
}

function buildApportionedSnapshot(
  sources: Record<CategoryId, string[]>,
  charCounts: Record<CategoryId, number>,
  params: PromptTokenBreakdownParams,
): PromptTokenBreakdownSnapshotValue {
  const rawTokensByCategory = mapCategoryRecord(sources, segments => sumRawTokens(segments))
  const apportioned = apportionRawWeightsToTotal(rawTokensByCategory, params.totalUsedTokens)
  return assemblePromptTokenBreakdownSnapshot({
    estimatedTokensByCategory: apportioned,
    characterCountsByCategory: charCounts,
    totalUsedTokens: params.totalUsedTokens,
    maxTokens: params.maxTokens,
  })
}

/**
 * A category's tokens from what is known about it: its own previous ratio when it has one, the
 * average of the others when it does not, and a four-characters-per-token rule when nothing is known
 * at all. A category that lost characters keeps the ratio, not the count.
 */
function resolveCachedCategory(
  characterCount: number,
  cached: { characterCount?: number; estimatedTokens: number } | undefined,
  avgRatio: number | undefined,
): ResolvedCategory {
  if (characterCount === 0) return { characterCount: 0, estimatedTokens: 0 }
  if (cached?.characterCount !== undefined && cached.characterCount > 0) {
    if (cached.characterCount === characterCount) return { characterCount, estimatedTokens: cached.estimatedTokens }
    const scaled = Math.round(cached.estimatedTokens * (characterCount / cached.characterCount))
    return { characterCount, estimatedTokens: Math.max(0, scaled) }
  }
  if (avgRatio !== undefined) return { characterCount, estimatedTokens: Math.max(0, Math.round(characterCount * avgRatio)) }
  return { characterCount, estimatedTokens: Math.max(0, Math.round(characterCount / 4)) }
}

function computeAvgRatio(previousByCategory: Map<CategoryId, { characterCount?: number; estimatedTokens: number }>): number | undefined {
  let totalChars = 0
  let totalTokens = 0
  for (const category of previousByCategory.values()) {
    if (category.characterCount === undefined || category.characterCount <= 0) continue
    totalChars += category.characterCount
    totalTokens += category.estimatedTokens
  }
  if (totalChars === 0) return undefined
  return totalTokens / totalChars
}

function resolveCacheableCategories(
  charCounts: Record<CategoryId, number>,
  previousByCategory: Map<CategoryId, { characterCount?: number; estimatedTokens: number }>,
  avgRatio: number | undefined,
): Map<CategoryId, ResolvedCategory> {
  const resolved = new Map<CategoryId, ResolvedCategory>()
  for (const id of CACHEABLE_CATEGORY_IDS) {
    resolved.set(id, resolveCachedCategory(charCounts[id], previousByCategory.get(id), avgRatio))
  }
  return resolved
}

function indexCategoriesById(
  snapshot: PromptTokenBreakdownSnapshotValue | undefined,
): Map<CategoryId, { characterCount?: number; estimatedTokens: number }> {
  const index = new Map<CategoryId, { characterCount?: number; estimatedTokens: number }>()
  if (!snapshot) return index
  const knownIds = new Set<string>(PROMPT_TOKEN_CATEGORIES.map(category => category.id))
  for (const category of snapshot.categories) {
    if (knownIds.has(category.id)) index.set(category.id as CategoryId, category)
  }
  return index
}

/** A snapshot from a provider that reports only totals carries no character counts to reuse. */
function snapshotHasCharacterCounts(snapshot: PromptTokenBreakdownSnapshotValue | undefined): boolean {
  if (!snapshot) return false
  return snapshot.categories.some(category => category.characterCount !== undefined)
}

function sumCacheableEstimatedTokens(resolved: Map<CategoryId, ResolvedCategory>): number {
  let sum = 0
  for (const id of CACHEABLE_CATEGORY_IDS) sum += resolved.get(id)?.estimatedTokens ?? 0
  return sum
}

function buildSnapshotFromResolvedCategories(args: {
  resolved: Map<CategoryId, ResolvedCategory>
  conversationCharCount: number
  conversationEstimatedTokens: number
  totalUsedTokens: number
  maxTokens: number
}): PromptTokenBreakdownSnapshotValue {
  const resolved = new Map(args.resolved)
  resolved.set("conversation", {
    characterCount: args.conversationCharCount,
    estimatedTokens: args.conversationEstimatedTokens,
  })
  return {
    totalUsedTokens: roundClampNonNegative(args.totalUsedTokens),
    maxTokens: roundClampNonNegative(args.maxTokens),
    categories: PROMPT_TOKEN_CATEGORIES.map(category => {
      const entry = resolved.get(category.id) ?? { characterCount: 0, estimatedTokens: 0 }
      return {
        id: category.id,
        label: category.label,
        estimatedTokens: entry.estimatedTokens,
        characterCount: entry.characterCount,
      }
    }),
  }
}

function assemblePromptTokenBreakdownSnapshot(args: {
  estimatedTokensByCategory: Record<CategoryId, number>
  characterCountsByCategory: Record<CategoryId, number>
  totalUsedTokens: number
  maxTokens: number
}): PromptTokenBreakdownSnapshotValue {
  return {
    totalUsedTokens: roundClampNonNegative(args.totalUsedTokens),
    maxTokens: roundClampNonNegative(args.maxTokens),
    categories: PROMPT_TOKEN_CATEGORIES.map(category => ({
      id: category.id,
      label: category.label,
      estimatedTokens: args.estimatedTokensByCategory[category.id],
      characterCount: args.characterCountsByCategory[category.id],
    })),
  }
}

function sumCharacterCount(segments: string[]): number {
  let total = 0
  for (const segment of segments) total += segment.length
  return total
}

function sumRawTokens(segments: string[]): number {
  let total = 0
  for (const segment of segments) total += estimateStringTokenCount(segment)
  return total
}

function mapCategoryRecord<T>(record: Record<CategoryId, string[]>, fn: (segments: string[], id: CategoryId) => T): Record<CategoryId, T> {
  const out = {} as Record<CategoryId, T>
  for (const category of PROMPT_TOKEN_CATEGORIES) out[category.id] = fn(record[category.id], category.id)
  return out
}

function roundClampNonNegative(value: number): number {
  return Math.max(0, Math.round(value))
}

function findInitialUserPromptMessage(messages: readonly PromptMessageLike[]): PromptMessageLike | undefined {
  return messages.find(message => message.role === "user" && !isSummaryCarrierMessage(message))
}

const promptTokenCategoryEstimatedTokens = createHistogram("agent.prompt_token_breakdown.category_estimated_tokens", {
  description: "Raw (pre-apportionment) estimated tokens per category for the prompt-token breakdown visualizer. Tagged with `category` (system_prompt, tools, rules, skills, mcp, subagents, summarized_conversation, conversation).",
  labelNames: ["category"],
})

function emitCategoryEstimatedTokensMetric(ctx: Context, sources: Record<CategoryId, string[]>): void {
  for (const category of PROMPT_TOKEN_CATEGORIES) {
    promptTokenCategoryEstimatedTokens.histogram(ctx, sumRawTokens(sources[category.id]), { category: category.id })
  }
}
