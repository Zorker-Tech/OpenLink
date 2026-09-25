/**
 * The same prompt, as a tree the user can walk into.
 *
 * The breakdown says how many tokens each category took; this says what was in them. Every node
 * carries where it came from — the message index and the path inside its content, or the offsets of
 * the block inside the prompt text — so a reader can point at the exact text a number came from.
 *
 * Two node families share the tree. The overview nodes come from the messages themselves, and they
 * pair a tool call with the result it produced rather than showing them as unrelated text; a call whose
 * result arrived is one node with two children, and a call whose result never arrived still shows its
 * own text. The category nodes come from the breakdown, and the nodes below them are the blocks the
 * platform itself added: rules and skills inside the first user message, MCP and dynamic tool blocks
 * wherever they appear, and the subagent definitions a task tool's description carries.
 *
 * Two limits keep the tree from being a copy of the conversation: a node whose text is inline carries
 * at most the first stretch of it, and the tree stops growing at a fixed node count — the first
 * categories and the first messages are what a reader needs, and a tree with everything in it would be
 * as large as the prompt.
 */

import {
  PromptContextNode,
  PromptContextSourceRef,
  PromptContextUsageTree,
} from "../../proto/generated/agent/v1/agent_pb.ts"
import { buildDescriptionGeneratorProps, toAgentTools } from "../tools/tool-execution.ts"
import { PROMPT_TOKEN_CATEGORIES } from "./prompt-token-breakdown.ts"
import type { PromptTokenBreakdownSnapshot } from "../../proto/generated/agent/v1/agent_pb.ts"
import { extractCompleteTagRanges, extractCompleteTagRangesMatching, extractMcpServerTagRanges } from "./prompt-tags.ts"
import { estimateStringTokenCount } from "./token-estimate.ts"
import type { PromptMessageLike, PromptToolLike } from "./prompt-shapes.ts"
import {
  isSummaryCarrierMessage,
  isToolDiscoveryBlockTag,
  selectOutermostRanges,
  serializeProviderFacingToolDefinition,
  splitSubagentDescriptionFromTool,
} from "./prompt-scan.ts"

export const PROMPT_CONTEXT_USAGE_TREE_SCHEMA_VERSION = 1

/** How much of an inline node's text travels with the tree; a blob node carries a reference instead. */
const INLINE_CONTENT_CHARS = 40_000
const MAX_NODES = 4_000

type CategoryId = (typeof PROMPT_TOKEN_CATEGORIES)[number]["id"]

export interface PromptContextUsageTreeParams {
  messages: readonly PromptMessageLike[]
  tools: readonly PromptToolLike[]
  descriptionProps?: Record<string, unknown> | undefined
  breakdown: PromptTokenBreakdownSnapshot
}

export function buildPromptContextUsageTree(params: PromptContextUsageTreeParams): PromptContextUsageTree {
  const nodes: PromptContextNode[] = []
  const categoryById = indexBreakdownCategoriesById(params.breakdown)
  for (const category of PROMPT_TOKEN_CATEGORIES) {
    const breakdownCategory = categoryById.get(category.id)
    nodes.push(new PromptContextNode({
      id: categoryNodeId(category.id),
      kind: "category",
      label: category.label,
      categoryId: category.id,
      estimatedTokens: breakdownCategory?.estimatedTokens ?? 0,
      characterCount: breakdownCategory?.characterCount ?? 0,
      contentAvailable: false,
    }))
  }
  appendMessageOverviewNodes(nodes, params.messages)
  appendToolOverviewNodes(nodes, params.tools, params.descriptionProps)
  return new PromptContextUsageTree({ schemaVersion: PROMPT_CONTEXT_USAGE_TREE_SCHEMA_VERSION, nodes })
}

/** One piece of a message's content, with the path it sits at and what kind of part it was. */
interface OverviewSegment {
  contentPath: string
  text: string
  partType?: string | undefined
  toolCallId?: string | undefined
  toolName?: string | undefined
}

interface BlobCarrier {
  kind: "blob"
  source: PromptContextSourceRef
}

interface InlineCarrier {
  kind: "inline"
}

function appendMessageOverviewNodes(nodes: PromptContextNode[], messages: readonly PromptMessageLike[]): void {
  let initialUserPromptSeen = false
  const pairings = pairToolCallsAndResults(messages)
  messages.forEach((message, messageIndex) => {
    const isSummary = isSummaryCarrierMessage(message)
    if (message.role === "system") {
      // The system prompt's own tool blocks are counted as MCP and dynamic tools, not as system prompt.
      if (!isSummary) {
        for (const segment of getOverviewTextSegments(message.content)) {
          appendMcpBlockOverviewNodes(nodes, { messageIndex, segment })
        }
      }
      return
    }
    const isInitialUserPrompt = message.role === "user" && !initialUserPromptSeen && !isSummary
    if (message.role === "user" && !isSummary) initialUserPromptSeen = true
    const baseCategory = getOverviewCategoryForMessage(message, isSummary)
    const baseKind = getOverviewKindForMessage(message, isSummary)
    for (const segment of getOverviewTextSegments(message.content)) {
      // Reasoning is not prompt text the platform sent, so it is not shown as part of the prompt.
      if (segment.partType === "redacted-reasoning") continue
      if (segment.partType === "tool-call" && segment.toolCallId !== undefined) {
        appendToolCallPairNodes(nodes, {
          messageIndex,
          callSegment: segment,
          pairedResult: pairings.resultByCallKey.get(messageContentKey(messageIndex, segment.contentPath)),
        })
        continue
      }
      // A result that was paired with its call is shown under that call, not twice.
      if (segment.partType === "tool-result" && pairings.pairedResultKeys.has(messageContentKey(messageIndex, segment.contentPath))) {
        continue
      }
      appendOverviewNode(nodes, {
        id: `message:${messageIndex}:${segment.contentPath}`,
        parentId: categoryNodeId(baseCategory),
        kind: baseKind,
        label: formatOverviewMessageLabel(message.role),
        categoryId: baseCategory,
        text: segment.text,
        carrier: { kind: "blob", source: rootPromptMessageSourceRef(messageIndex, segment) },
      })
      appendTaggedPromptBlockNodes(nodes, { messageIndex, segment, isInitialUserPrompt, isSummary, role: message.role })
    }
  })
}

function getOverviewTextSegments(content: unknown): OverviewSegment[] {
  if (typeof content === "string") return [{ contentPath: "content", text: content }]
  if (!Array.isArray(content)) return []
  const segments: OverviewSegment[] = []
  content.forEach((part, index) => {
    if (typeof part === "string") {
      segments.push({ contentPath: `content[${index}]`, text: part })
      return
    }
    if (typeof part !== "object" || part === null) return
    const segment = extractStructuredPartSegment(part as Record<string, unknown>, index)
    if (segment !== undefined) segments.push(segment)
  })
  return segments
}

/**
 * A structured part is shown as the text it contributed: a tool call as its arguments, a tool result
 * as its result, a text part as its text, and anything else as its own JSON.
 */
function extractStructuredPartSegment(part: Record<string, unknown>, index: number): OverviewSegment | undefined {
  const partType = typeof part.type === "string" ? part.type : undefined
  const toolCallId = typeof part.toolCallId === "string" ? part.toolCallId : undefined
  const toolName = typeof part.toolName === "string" ? part.toolName : undefined
  if (partType === "tool-call" && "args" in part) {
    return { contentPath: `content[${index}].args`, text: stringifyOverviewValue(part.args), partType, toolCallId, toolName }
  }
  if (partType === "tool-result" && "result" in part) {
    return { contentPath: `content[${index}].result`, text: stringifyOverviewValue(part.result), partType, toolCallId, toolName }
  }
  if (typeof part.text === "string") {
    return { contentPath: `content[${index}].text`, text: part.text, partType, toolCallId, toolName }
  }
  try {
    return { contentPath: `content[${index}]`, text: JSON.stringify(part, undefined, 2), partType, toolCallId, toolName }
  } catch {
    return undefined
  }
}

function getOverviewCategoryForMessage(message: PromptMessageLike, isSummary: boolean): CategoryId {
  if (message.role === "system") return "system_prompt"
  if (isSummary) return "summarized_conversation"
  return "conversation"
}

function getOverviewKindForMessage(message: PromptMessageLike, isSummary: boolean): string {
  if (message.role === "tool") return "tool_result"
  if (isSummary) return "summary_message"
  return `${message.role}_message`
}

/**
 * Matching calls to results by the call's id. A result is claimed by the first call that names it, so
 * a repeated id does not attach the same result to two calls.
 */
function pairToolCallsAndResults(messages: readonly PromptMessageLike[]): {
  resultByCallKey: Map<string, { messageIndex: number; segment: OverviewSegment }>
  pairedResultKeys: Set<string>
} {
  const resultByCallId = indexToolResultsByCallId(messages)
  const resultByCallKey = new Map<string, { messageIndex: number; segment: OverviewSegment }>()
  const pairedResultKeys = new Set<string>()
  messages.forEach((message, messageIndex) => {
    for (const segment of getOverviewTextSegments(message.content)) {
      if (segment.partType !== "tool-call" || segment.toolCallId === undefined) continue
      const result = resultByCallId.get(segment.toolCallId)
      if (result === undefined) continue
      const resultKey = messageContentKey(result.messageIndex, result.segment.contentPath)
      if (pairedResultKeys.has(resultKey)) continue
      resultByCallKey.set(messageContentKey(messageIndex, segment.contentPath), result)
      pairedResultKeys.add(resultKey)
    }
  })
  return { resultByCallKey, pairedResultKeys }
}

function indexToolResultsByCallId(
  messages: readonly PromptMessageLike[],
): Map<string, { messageIndex: number; segment: OverviewSegment }> {
  const index = new Map<string, { messageIndex: number; segment: OverviewSegment }>()
  messages.forEach((message, messageIndex) => {
    if (message.role !== "tool") return
    for (const segment of getOverviewTextSegments(message.content)) {
      if (segment.partType === "tool-result" && segment.toolCallId !== undefined && !index.has(segment.toolCallId)) {
        index.set(segment.toolCallId, { messageIndex, segment })
      }
    }
  })
  return index
}

function formatOverviewMessageLabel(role: string): string {
  if (role === "user") return "User Message"
  if (role === "assistant") return "Agent Message"
  const normalized = role.length > 0 ? role[0]!.toUpperCase() + role.slice(1) : role
  return `${normalized} Message`
}

/** A call and its result are one thing to a reader, so they hang under one node. */
function appendToolCallPairNodes(nodes: PromptContextNode[], params: {
  messageIndex: number
  callSegment: OverviewSegment
  pairedResult: { messageIndex: number; segment: OverviewSegment } | undefined
}): void {
  const { callSegment, messageIndex, pairedResult } = params
  const toolCallId = callSegment.toolCallId
  if (toolCallId === undefined) return
  if (nodes.length + 2 > MAX_NODES) return
  const parentNodeId = `tool_call_pair:${messageIndex}:${toolCallId}`
  const toolName = callSegment.toolName ?? "tool"
  nodes.push(new PromptContextNode({
    id: parentNodeId,
    parentId: categoryNodeId("conversation"),
    kind: "tool_call_pair",
    label: `${toolName} Tool`,
    categoryId: "conversation",
    estimatedTokens: 0,
    characterCount: 0,
    contentAvailable: false,
  }))
  appendOverviewNode(nodes, {
    id: `${parentNodeId}:call`,
    parentId: parentNodeId,
    kind: "tool_call",
    label: "Call",
    categoryId: "conversation",
    text: callSegment.text,
    carrier: { kind: "blob", source: rootPromptMessageSourceRef(messageIndex, callSegment) },
  })
  if (pairedResult === undefined) return
  appendOverviewNode(nodes, {
    id: `${parentNodeId}:result`,
    parentId: parentNodeId,
    kind: "tool_result",
    label: "Result",
    categoryId: "conversation",
    text: pairedResult.segment.text,
    carrier: { kind: "blob", source: rootPromptMessageSourceRef(pairedResult.messageIndex, pairedResult.segment) },
  })
}

interface TaggedPromptItemBlock {
  tagName: string
  categoryId: CategoryId
  item: {
    matcher: (tagName: string) => boolean
    kind: string
    labelPrefix: string
  }
}

/** The blocks the platform adds to the first user message, and what each one contains. */
const TAGGED_PROMPT_ITEM_BLOCKS: readonly TaggedPromptItemBlock[] = [
  {
    tagName: "rules",
    categoryId: "rules",
    item: { matcher: tagName => tagName.endsWith("_rule"), kind: "rule", labelPrefix: "Rule" },
  },
  {
    tagName: "agent_skills",
    categoryId: "skills",
    item: { matcher: tagName => tagName === "agent_skill", kind: "skill", labelPrefix: "Skill" },
  },
]

function appendTaggedPromptBlockNodes(nodes: PromptContextNode[], params: {
  messageIndex: number
  segment: OverviewSegment
  isInitialUserPrompt: boolean
  isSummary: boolean
  role: string
}): void {
  if (params.isSummary || params.role === "tool") return
  if (params.isInitialUserPrompt) {
    for (const block of TAGGED_PROMPT_ITEM_BLOCKS) {
      appendTaggedBlockItemNodes(nodes, { messageIndex: params.messageIndex, segment: params.segment, block })
    }
  }
  appendMcpBlockOverviewNodes(nodes, { messageIndex: params.messageIndex, segment: params.segment })
}

/** Each rule and each skill becomes its own node, labelled with the name it declares. */
function appendTaggedBlockItemNodes(nodes: PromptContextNode[], params: {
  messageIndex: number
  segment: OverviewSegment
  block: TaggedPromptItemBlock
}): void {
  const { block, messageIndex, segment } = params
  for (const envelopeRange of extractCompleteTagRanges(segment.text, block.tagName)) {
    const envelopeNodeId = `message:${messageIndex}:${segment.contentPath}:${block.tagName}:${envelopeRange.start}`
    const envelopeText = segment.text.slice(envelopeRange.start, envelopeRange.end)
    const itemRanges = extractCompleteTagRangesMatching(envelopeText, block.item.matcher)
    itemRanges.forEach((itemRange, index) => {
      const absoluteStart = envelopeRange.start + itemRange.start
      const absoluteEnd = envelopeRange.start + itemRange.end
      const itemText = segment.text.slice(absoluteStart, absoluteEnd)
      appendOverviewNode(nodes, {
        id: `${envelopeNodeId}:${block.item.kind}:${absoluteStart}`,
        parentId: categoryNodeId(block.categoryId),
        kind: block.item.kind,
        label: buildNestedPromptItemLabel(itemText, `${block.item.labelPrefix} ${index + 1}`),
        categoryId: block.categoryId,
        text: itemText,
        carrier: {
          kind: "blob",
          source: rootPromptMessageSourceRef(messageIndex, segment, { start: absoluteStart, end: absoluteEnd }),
        },
      })
    })
  }
}

/** A block's own name when it declares one, and a positional label when it does not. */
function buildNestedPromptItemLabel(text: string, fallback: string): string {
  const openTagEnd = text.indexOf(">")
  if (openTagEnd === -1) return fallback
  const openTag = decodePromptTagAttributeEntities(text.slice(0, openTagEnd + 1))
  return NESTED_ITEM_LABEL_PATTERN.exec(openTag)?.[1] ?? fallback
}

function decodePromptTagAttributeEntities(text: string): string {
  return text.replaceAll("&quot;", '"').replaceAll("&amp;", "&")
}

const NESTED_ITEM_LABEL_PATTERN = /\b(?:name|fullPath|title)="([^"]*)"/
const SUBAGENT_BULLET_LINE_PATTERN = /^-\s+([^:]+?)(?:\s*:\s*(.*))?$/

/** The tags that only wrap other blocks; they are structure, not content, so they get no node. */
const MCP_OVERVIEW_WRAPPER_TAGS = new Set([
  "mcp_file_system",
  "mcp_file_system_servers",
  "mcp_meta_tool_servers",
  "mcp_server_catalog",
  "mcp_file_system_server",
  "mcp_meta_tool_server",
  "dynamic_tools",
  "dynamic_tool_namespaces",
  "dynamic_tool_catalog",
  "namespace",
  // Legacy dynamic-tool prompts used this name.
  "dynamic_tool_namespace",
])

function appendMcpBlockOverviewNodes(nodes: PromptContextNode[], params: {
  messageIndex: number
  segment: OverviewSegment
}): void {
  const { messageIndex, segment } = params
  appendMcpServerEntryNodes(nodes, { messageIndex, segment })
  const discoveryRanges = extractCompleteTagRangesMatching(segment.text, isToolDiscoveryBlockTag)
  for (const range of selectOutermostRanges(discoveryRanges)) {
    if (MCP_OVERVIEW_WRAPPER_TAGS.has(range.tagName)) continue
    const parentNodeId = `message:${messageIndex}:${segment.contentPath}:mcp:${range.start}`
    appendOverviewNode(nodes, {
      id: parentNodeId,
      parentId: categoryNodeId("mcp"),
      kind: "mcp_block",
      label: `<${range.tagName}>`,
      categoryId: "mcp",
      text: segment.text.slice(range.start, range.end),
      carrier: { kind: "blob", source: rootPromptMessageSourceRef(messageIndex, segment, range) },
    })
    appendMcpBlockChildNodes(nodes, { messageIndex, segment, parentNodeId, parentRange: range })
  }
}

/** A server entry names itself, so it is labelled with that name rather than its tag. */
function appendMcpServerEntryNodes(nodes: PromptContextNode[], params: {
  messageIndex: number
  segment: OverviewSegment
}): void {
  const { messageIndex, segment } = params
  for (const range of extractMcpServerTagRanges(segment.text)) {
    const serverText = segment.text.slice(range.start, range.end)
    appendOverviewNode(nodes, {
      id: `message:${messageIndex}:${segment.contentPath}:mcp_server:${range.start}`,
      parentId: categoryNodeId("mcp"),
      kind: range.tagName,
      label: buildNestedPromptItemLabel(serverText, `<${range.tagName}>`),
      categoryId: "mcp",
      text: serverText,
      carrier: { kind: "blob", source: rootPromptMessageSourceRef(messageIndex, segment, range) },
    })
  }
}

/** The blocks inside a block: a namespace's tools, a server's own description. */
function appendMcpBlockChildNodes(nodes: PromptContextNode[], params: {
  messageIndex: number
  segment: OverviewSegment
  parentNodeId: string
  parentRange: { start: number; end: number; tagName: string }
}): void {
  const { messageIndex, segment, parentNodeId, parentRange } = params
  const parentText = segment.text.slice(parentRange.start, parentRange.end)
  const childRanges = extractCompleteTagRangesMatching(parentText, isToolDiscoveryBlockTag)
  childRanges.forEach(childRange => {
    // A range that is the parent itself is not a child of it.
    if (childRange.start === 0 && childRange.end === parentText.length && childRange.tagName === parentRange.tagName) return
    if (MCP_OVERVIEW_WRAPPER_TAGS.has(childRange.tagName)) return
    const absoluteStart = parentRange.start + childRange.start
    const absoluteEnd = parentRange.start + childRange.end
    appendOverviewNode(nodes, {
      id: `${parentNodeId}:mcp:${absoluteStart}`,
      parentId: parentNodeId,
      kind: "mcp_block",
      label: `<${childRange.tagName}>`,
      categoryId: "mcp",
      text: segment.text.slice(absoluteStart, absoluteEnd),
      carrier: {
        kind: "blob",
        source: rootPromptMessageSourceRef(messageIndex, segment, { start: absoluteStart, end: absoluteEnd }),
      },
    })
  })
}

function appendToolOverviewNodes(
  nodes: PromptContextNode[],
  tools: readonly PromptToolLike[],
  descriptionProps: Record<string, unknown> | undefined,
): void {
  const descriptionPropsToUse = descriptionProps ?? buildDescriptionGeneratorProps(tools as never)
  const agentTools = toAgentTools(tools as never, descriptionPropsToUse)
  for (let index = 0; index < tools.length; index++) {
    const tool = tools[index]
    const agentTool = agentTools[index]
    if (tool === undefined || agentTool === undefined) continue
    const split = splitSubagentDescriptionFromTool(tool, agentTool.description, descriptionPropsToUse)
    appendTokenEstimateOverviewNode(nodes, {
      id: `tool:${index}`,
      parentId: categoryNodeId("tools"),
      kind: "tool_definition",
      label: agentTool.name,
      categoryId: "tools",
      text: serializeProviderFacingToolDefinition({ ...agentTool, description: split.toolDescription }),
    })
    if (split.subagentText.length > 0) {
      appendSubagentOverviewNodes(nodes, { toolIndex: index, toolName: agentTool.name, text: split.subagentText })
    }
  }
}

/**
 * The subagent definitions inside a task tool's description. Each bullet is a subagent type, and when
 * the text has no bullets it is shown whole rather than as nothing.
 */
function appendSubagentOverviewNodes(nodes: PromptContextNode[], params: {
  toolIndex: number
  toolName: string
  text: string
}): void {
  const bullets = extractSubagentBulletLines(params.text)
  const categoryParentId = categoryNodeId("subagents")
  if (bullets.length === 0) {
    appendOverviewNode(nodes, {
      id: `tool:${params.toolIndex}:subagents`,
      parentId: categoryParentId,
      kind: "subagent_description",
      label: params.toolName,
      categoryId: "subagents",
      text: params.text,
      carrier: { kind: "inline" },
    })
    return
  }
  for (const [index, bullet] of bullets.entries()) {
    appendOverviewNode(nodes, {
      id: `tool:${params.toolIndex}:subagent:${index}`,
      parentId: categoryParentId,
      kind: "subagent_type",
      label: bullet.label,
      categoryId: "subagents",
      text: bullet.line,
      carrier: { kind: "inline" },
    })
  }
}

function extractSubagentBulletLines(text: string): Array<{ label: string; line: string }> {
  const bullets: Array<{ label: string; line: string }> = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const match = SUBAGENT_BULLET_LINE_PATTERN.exec(trimmed)
    if (match === null) continue
    bullets.push({ label: match[1]?.trim() ?? trimmed, line: trimmed })
  }
  return bullets
}

/** A node whose size is known from its text alone, with nothing to open: a tool definition. */
function appendTokenEstimateOverviewNode(nodes: PromptContextNode[], params: {
  id: string
  parentId: string
  kind: string
  label: string
  categoryId: string
  text: string
}): void {
  if (params.text.length === 0 || nodes.length >= MAX_NODES) return
  nodes.push(new PromptContextNode({
    id: params.id,
    parentId: params.parentId,
    kind: params.kind,
    label: params.label,
    categoryId: params.categoryId,
    estimatedTokens: estimateStringTokenCount(params.text),
    characterCount: params.text.length,
    contentAvailable: false,
  }))
}

/**
 * A node whose text a reader can open. An inline node carries the text with it, up to the inline
 * limit; a blob node carries a reference into the prompt instead, because the text is already there
 * and sending it twice would double the size of the tree.
 */
function appendOverviewNode(nodes: PromptContextNode[], params: {
  id: string
  parentId: string
  kind: string
  label: string
  categoryId: string
  text: string
  carrier: BlobCarrier | InlineCarrier
}): void {
  if (params.text.length === 0 || nodes.length >= MAX_NODES) return
  const truncated = params.carrier.kind === "inline" && params.text.length > INLINE_CONTENT_CHARS
  const inlineContent = params.carrier.kind === "inline"
    ? truncated ? params.text.slice(0, INLINE_CONTENT_CHARS) : params.text
    : undefined
  nodes.push(new PromptContextNode({
    id: params.id,
    parentId: params.parentId,
    kind: params.kind,
    label: params.label,
    categoryId: params.categoryId,
    estimatedTokens: estimateStringTokenCount(params.text),
    characterCount: params.text.length,
    contentAvailable: true,
    ...(inlineContent !== undefined ? { inlineContent } : {}),
    ...(params.carrier.kind === "blob" ? { source: params.carrier.source } : {}),
  }))
}

function rootPromptMessageSourceRef(
  messageIndex: number,
  segment: OverviewSegment,
  range?: { start: number; end: number },
): PromptContextSourceRef {
  return new PromptContextSourceRef({
    sourceType: "root_prompt_message",
    messageIndex,
    contentPath: segment.contentPath,
    startOffset: range?.start ?? 0,
    endOffset: range?.end ?? segment.text.length,
  })
}

function categoryNodeId(categoryId: string): string {
  return `category:${categoryId}`
}

function messageContentKey(messageIndex: number, contentPath: string): string {
  return `${messageIndex}:${contentPath}`
}

function stringifyOverviewValue(value: unknown): string {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, undefined, 2)
  } catch {
    return String(value)
  }
}

function indexBreakdownCategoriesById(
  snapshot: PromptTokenBreakdownSnapshot,
): Map<string, { estimatedTokens: number; characterCount: number }> {
  const index = new Map<string, { estimatedTokens: number; characterCount: number }>()
  for (const category of snapshot.categories) {
    index.set(category.id, {
      estimatedTokens: category.estimatedTokens ?? 0,
      characterCount: category.characterCount ?? 0,
    })
  }
  return index
}
