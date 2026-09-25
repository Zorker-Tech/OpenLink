/**
 * The transcript of a conversation, written where the user can read it.
 *
 * A conversation's history lives in the session as blobs, which is the right shape to restore from and the
 * wrong shape to read. This store turns those blobs into three files — a plain text conversation, a JSON
 * form, and a JSONL form where each line is one event — because a person, a script and a reader of partial
 * output each want a different one. Which of the three is written is a configuration choice, and writing
 * none of them is a valid choice.
 *
 * Reading back is where the care is. A blob that cannot be read is left out rather than failing the
 * transcript, since a transcript is an observation of a conversation that already happened. A blob above
 * the size threshold is replaced by a note saying how large it was, because one enormous message would
 * otherwise make the whole file unreadable. The summary archives are read first and the live messages
 * after, which is the order the conversation happened in, and both are measured as they are read so the
 * span carries what the read cost.
 *
 * Writing is best-effort in the same way, and it has a second path for the common case: a turn that only
 * appends messages appends lines to the JSONL file instead of rewriting everything, and if that append
 * fails it falls back to a full write unless the caller has asked it not to. What is appended is only the
 * messages that were not there last time, which is what the previous message count is for.
 *
 * Two markers end a turn's output: a line saying how the turn ended, and an overview generated from the
 * conversation when the caller supplies a way to make one.
 */

import { ConversationSummaryArchive, AgentMode } from "../../../packages/proto/generated/agent/v1/agent_pb.ts"
import type { Context } from "../../../packages/context/context.ts"
import { createSpan, withSuppressedChildSpans } from "../../../packages/context/telemetry.ts"
import { getTranscriptRelativePath } from "./paths.ts"
import { stripContextTags } from "./context-stripping.ts"

type TranscriptContentPart = {
  readonly type: string
  readonly text?: string
  readonly filename?: string
  readonly toolName?: string
  readonly args?: unknown
}

interface TranscriptMessage {
  readonly role: string
  readonly content?: string | readonly TranscriptContentPart[]
  readonly providerOptions?: { readonly cursor?: { readonly isSummary?: boolean } }
}

interface TranscriptState {
  readonly mode?: AgentMode
  readonly rootPromptMessagesJson: readonly Uint8Array[]
  readonly summaryArchives: readonly Uint8Array[]
}

interface TranscriptBlobStore {
  getBlob(ctx: Context, blobId: Uint8Array): Promise<Uint8Array | undefined>
}

interface TranscriptStoreOptions {
  readonly writeText?: boolean | undefined
  readonly writeJson?: boolean | undefined
  readonly writeJsonl?: boolean | undefined
  readonly pathResolver?: ((conversationId: string, ext: string) => string) | undefined
  readonly appendFile?: ((path: string, content: string) => Promise<void>) | undefined
  readonly fallbackToFullWriteOnIncrementalFailure?: boolean | undefined
}

interface TurnEndedMarker {
  readonly status: "success" | "error" | "aborted" | string
  readonly error?: string
}

interface TranscriptWriteOptions {
  readonly overviewFactory?: ((formatted: string) => Promise<string>) | undefined
  readonly turnEnded?: TurnEndedMarker | undefined
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()
const SERIALIZED_UINT8_ARRAY_MARKER = '"__type":"Uint8Array"'
const OVERSIZE_TRANSCRIPT_BLOB_THRESHOLD_BYTES = 5_000_000

function agentModeToString(mode: AgentMode | undefined): string {
  switch (mode) {
    case AgentMode.AGENT: return "agent"
    case AgentMode.ASK: return "ask"
    case AgentMode.PLAN: return "plan"
    case AgentMode.DEBUG: return "debug"
    case AgentMode.TRIAGE: return "triage"
    case AgentMode.PROJECT: return "project"
    case AgentMode.MULTITASK: return "multitask"
    case AgentMode.CUSTOM: return "custom"
    case AgentMode.UNSPECIFIED:
    case undefined: return "agent"
    default: return "agent"
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** Bytes and bigints have no JSON form, so they are written in one this reader understands. */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return { __type: "Uint8Array", hex: toHex(value) }
  if (typeof value === "bigint") return value.toString()
  return value
}

/**
 * Binary data is not put back: it is what a transcript cannot show, so what was a blob becomes a note
 * saying how large it was rather than a wall of hex.
 */
function jsonReviver(_key: string, value: unknown): unknown {
  if (typeof value === "object" && value !== null && (value as { readonly __type?: unknown }).__type === "Uint8Array" && typeof (value as { readonly hex?: unknown }).hex === "string") {
    return `[Binary data omitted from transcript: ${((value as { readonly hex: string }).hex).length / 2} bytes]`
  }
  return value
}

class CoreMessageSerde {
  serialize(value: unknown): Uint8Array {
    return textEncoder.encode(JSON.stringify(value, jsonReplacer))
  }

  deserialize(blob: Uint8Array): TranscriptMessage {
    const json = textDecoder.decode(blob)
    // The reviver is only needed when the text actually carries binary, which is the common case not to.
    return JSON.parse(json, json.includes(SERIALIZED_UINT8_ARRAY_MARKER) ? jsonReviver : undefined) as TranscriptMessage
  }
}

const coreMessageSerde = new CoreMessageSerde()

function isSummaryMessage(message: TranscriptMessage): boolean {
  return message.providerOptions?.cursor?.isSummary === true
}

function formatBlobSizeMegabytes(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`
}

function createOversizeBlobOmittedMessage(blobSizeBytes: number): TranscriptMessage {
  return { role: "assistant", content: `[Oversize transcript blob omitted: ${formatBlobSizeMegabytes(blobSizeBytes)}]` }
}

interface HydratedBlobIdsResult {
  readonly messages: TranscriptMessage[]
  readonly hydratedBlobCount: number
  readonly hydratedBlobBytes: number
  readonly largestHydratedBlobBytes: number
  readonly totalDeserializeDurationMs: number
  readonly omittedOversizeBlobCount: number
  readonly omittedOversizeBlobBytes: number
  readonly largestOmittedOversizeBlobBytes: number
}

function emptyHydratedBlobIdsResult(): HydratedBlobIdsResult {
  return { messages: [], hydratedBlobCount: 0, hydratedBlobBytes: 0, largestHydratedBlobBytes: 0, totalDeserializeDurationMs: 0, omittedOversizeBlobCount: 0, omittedOversizeBlobBytes: 0, largestOmittedOversizeBlobBytes: 0 }
}

/** Each blob is read on its own, and one that cannot be read is skipped rather than failing the rest. */
async function hydrateBlobIds(ctx: Context, blobStore: TranscriptBlobStore, blobIds: readonly Uint8Array[]): Promise<HydratedBlobIdsResult> {
  const messages: TranscriptMessage[] = []
  let hydratedBlobCount = 0, hydratedBlobBytes = 0, largestHydratedBlobBytes = 0, totalDeserializeDurationMs = 0
  let omittedOversizeBlobCount = 0, omittedOversizeBlobBytes = 0, largestOmittedOversizeBlobBytes = 0
  for (const blobId of blobIds) {
    const blob = await blobStore.getBlob(ctx, blobId)
    if (!blob) continue
    if (blob.length > OVERSIZE_TRANSCRIPT_BLOB_THRESHOLD_BYTES) {
      messages.push(createOversizeBlobOmittedMessage(blob.length))
      omittedOversizeBlobCount++
      omittedOversizeBlobBytes += blob.length
      largestOmittedOversizeBlobBytes = Math.max(largestOmittedOversizeBlobBytes, blob.length)
      continue
    }
    try {
      const start = performance.now()
      messages.push(coreMessageSerde.deserialize(blob))
      const duration = performance.now() - start
      hydratedBlobCount++
      hydratedBlobBytes += blob.length
      largestHydratedBlobBytes = Math.max(largestHydratedBlobBytes, blob.length)
      totalDeserializeDurationMs += duration
    } catch {
      // Observational transcript blobs are intentionally best-effort.
    }
  }
  return { messages, hydratedBlobCount, hydratedBlobBytes, largestHydratedBlobBytes, totalDeserializeDurationMs, omittedOversizeBlobCount, omittedOversizeBlobBytes, largestOmittedOversizeBlobBytes }
}

/** The whole conversation: what was summarized away first, then what is still live. */
async function hydrateMessages(ctx: Context, blobStore: TranscriptBlobStore, state: TranscriptState): Promise<TranscriptMessage[] | undefined> {
  try {
    using archiveSpan = createSpan(ctx.withName("hydrateSummaryArchives"))
    const quietCtx = withSuppressedChildSpans(archiveSpan.ctx)
    let getBlobCount = 0
    let hydratedArchivedBlobCount = 0, hydratedArchivedBlobBytes = 0, largestHydratedArchivedBlobBytes = 0, totalArchivedDeserializeDurationMs = 0
    let omittedArchivedBlobCount = 0, omittedArchivedBlobBytes = 0, largestOmittedArchivedBlobBytes = 0
    const allMessages: TranscriptMessage[] = []
    const summaryArchives = await Promise.all(state.summaryArchives.map(async (summaryArchiveRef) => {
      getBlobCount++
      const archiveBlob = await blobStore.getBlob(quietCtx, summaryArchiveRef)
      if (archiveBlob) {
        try {
          const archive = ConversationSummaryArchive.fromBinary(archiveBlob)
          getBlobCount += archive.summarizedMessages.length
          return hydrateBlobIds(quietCtx, blobStore, archive.summarizedMessages)
        } catch {
          // A malformed summary archive is omitted from the observational transcript.
        }
      }
      return emptyHydratedBlobIdsResult()
    }))
    for (const archived of summaryArchives) {
      allMessages.push(...archived.messages)
      hydratedArchivedBlobCount += archived.hydratedBlobCount
      hydratedArchivedBlobBytes += archived.hydratedBlobBytes
      largestHydratedArchivedBlobBytes = Math.max(largestHydratedArchivedBlobBytes, archived.largestHydratedBlobBytes)
      totalArchivedDeserializeDurationMs += archived.totalDeserializeDurationMs
      omittedArchivedBlobCount += archived.omittedOversizeBlobCount
      omittedArchivedBlobBytes += archived.omittedOversizeBlobBytes
      largestOmittedArchivedBlobBytes = Math.max(largestOmittedArchivedBlobBytes, archived.largestOmittedOversizeBlobBytes)
    }
    archiveSpan.span.setAttribute("getBlobCount", getBlobCount)
    archiveSpan.span.setAttribute("hydratedBlobCount", hydratedArchivedBlobCount)
    archiveSpan.span.setAttribute("hydratedBlobBytes", hydratedArchivedBlobBytes)
    archiveSpan.span.setAttribute("largestHydratedBlobBytes", largestHydratedArchivedBlobBytes)
    archiveSpan.span.setAttribute("totalDeserializeDurationMs", totalArchivedDeserializeDurationMs)
    archiveSpan.span.setAttribute("omittedOversizeBlobCount", omittedArchivedBlobCount)
    archiveSpan.span.setAttribute("omittedOversizeBlobBytes", omittedArchivedBlobBytes)
    archiveSpan.span.setAttribute("largestOmittedOversizeBlobBytes", largestOmittedArchivedBlobBytes)
    using promptSpan = createSpan(ctx.withName("hydratePromptMessages"))
    const promptMessages = await hydrateBlobIds(quietCtx, blobStore, state.rootPromptMessagesJson)
    promptSpan.span.setAttribute("getBlobCount", state.rootPromptMessagesJson.length)
    promptSpan.span.setAttribute("hydratedBlobCount", promptMessages.hydratedBlobCount)
    promptSpan.span.setAttribute("hydratedBlobBytes", promptMessages.hydratedBlobBytes)
    promptSpan.span.setAttribute("largestHydratedBlobBytes", promptMessages.largestHydratedBlobBytes)
    promptSpan.span.setAttribute("totalDeserializeDurationMs", promptMessages.totalDeserializeDurationMs)
    promptSpan.span.setAttribute("omittedOversizeBlobCount", promptMessages.omittedOversizeBlobCount)
    promptSpan.span.setAttribute("omittedOversizeBlobBytes", promptMessages.omittedOversizeBlobBytes)
    promptSpan.span.setAttribute("largestOmittedOversizeBlobBytes", promptMessages.largestOmittedOversizeBlobBytes)
    // The system messages and the summaries are not part of the conversation as it was read.
    allMessages.push(...promptMessages.messages.filter((message) => message.role !== "system" && !isSummaryMessage(message)))
    return allMessages
  } catch {
    return undefined
  }
}

function formatToolArgs(args: unknown): string {
  if (args === null || args === undefined || typeof args !== "object") return args == null ? "" : String(args)
  const entries = Object.entries(args)
  if (entries.length === 0) return ""
  return `\n${entries.map(([key, value]) => `  ${key}: ${typeof value === "string" ? value : typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)}`).join("\n")}`
}

function formatContentPart(part: TranscriptContentPart, stripTags: boolean): string {
  switch (part.type) {
    case "text": return stripTags ? stripContextTags(part.text as string) : part.text as string
    case "image": return "[Image]"
    case "file": return part.filename ? `[File: ${part.filename}]` : "[File]"
    case "reasoning": return `[Thinking] ${part.text}`
    case "redacted-reasoning": return "[Thinking]"
    case "tool-call": return `[Tool call] ${part.toolName}${formatToolArgs(part.args)}`
    case "tool-result": return `[Tool result] ${part.toolName}`
    default: return ""
  }
}

/** Reasoning a model was asked to hide is not part of what it said. */
function stripHiddenThinkingTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").replace(/\n{3,}/g, "\n\n").trim();
}

function formatContent(content: string | readonly TranscriptContentPart[] | undefined, stripTags: boolean, stripThinkTags: boolean): string {
  if (content === undefined) return ""
  if (typeof content === "string") {
    const processed = stripTags ? stripContextTags(content) : content
    return stripThinkTags ? stripHiddenThinkingTags(processed) : processed
  }
  return content.map((part) => {
    if (stripThinkTags && part.type === "text") return formatContentPart({ ...part, text: stripHiddenThinkingTags(stripTags ? stripContextTags(part.text as string) : part.text as string) }, false)
    return formatContentPart(part, stripTags)
  }).filter(Boolean).join("\n")
}

/** The conversation as text, with the platform's own preamble left out. */
function formatTranscript(messages: readonly TranscriptMessage[]): string {
  let filtered = messages.filter((message) => message.role !== "system")
  // Two user messages at the start are the preamble and the user's own first message.
  if (filtered.length >= 2 && filtered[0]?.role === "user" && filtered[1]?.role === "user") filtered = filtered.slice(1)
  return filtered.map((message) => {
    const content = formatContent(message.content, message.role === "user", message.role === "assistant")
    if (!content.trim()) return ""
    // A tool result speaks for itself, so it is not given a role heading.
    return message.role === "tool" ? content : `${message.role}:\n${content}`
  }).filter(Boolean).join("\n\n")
}

interface JsonMessage {
  readonly role: string
  readonly text?: string
  readonly thinking?: string
  readonly toolCalls?: readonly { readonly toolName?: string; readonly args?: unknown }[]
  readonly toolResult?: { readonly toolName?: string }
}

function formatMessageToJson(message: TranscriptMessage, stripTags: boolean): JsonMessage {
  const json: { role: string; text?: string; thinking?: string; toolCalls?: { toolName?: string; args?: unknown }[]; toolResult?: { toolName?: string } } = { role: message.role }
  if (typeof message.content === "string") {
    const processed = stripTags ? stripContextTags(message.content) : message.content
    const visible = message.role === "assistant" ? stripHiddenThinkingTags(processed) : processed
    if (visible.trim()) json.text = visible
  } else if (Array.isArray(message.content)) {
    const textParts: string[] = [], thinkingParts: string[] = [], toolCalls: { toolName?: string; args?: unknown }[] = []
    for (const part of message.content) {
      switch (part.type) {
        case "text": { const visible = message.role === "assistant" ? stripHiddenThinkingTags(stripTags ? stripContextTags(part.text as string) : part.text as string) : stripTags ? stripContextTags(part.text as string) : part.text as string; if (visible.trim()) textParts.push(visible); break }
        case "reasoning": if ((part.text as string).trim()) thinkingParts.push(part.text as string); break
        case "redacted-reasoning": thinkingParts.push("[REDACTED]"); break
        case "image": textParts.push("[Image]"); break
        case "file": textParts.push(part.filename ? `[File: ${part.filename}]` : "[File]"); break
        case "tool-call": toolCalls.push({ toolName: part.toolName, args: part.args }); break
        case "tool-result": json.toolResult = { toolName: part.toolName }; break
      }
    }
    if (textParts.length > 0) json.text = textParts.join("\n")
    if (thinkingParts.length > 0) json.thinking = thinkingParts.join("\n")
    if (toolCalls.length > 0) json.toolCalls = toolCalls
  }
  return json
}

function formatTranscriptJson(messages: readonly TranscriptMessage[]): string {
  let filtered = messages.filter((message) => message.role !== "system")
  if (filtered.length >= 2 && filtered[0]?.role === "user" && filtered[1]?.role === "user") filtered = filtered.slice(1)
  // A message with nothing in it is not a message, so it is left out rather than written empty.
  const jsonMessages = filtered.map((message) => formatMessageToJson(message, message.role === "user")).filter((message) => message.text || message.thinking || message.toolCalls || message.toolResult)
  return jsonMessages.length === 0 ? "" : JSON.stringify(jsonMessages, null, 2)
}

function prependOverviewMetadataLine(jsonlContent: string, overview: string): string {
  return `${JSON.stringify({ type: "metadata", metadata: { overview } })}\n${jsonlContent}`
}

function ensureTrailingNewline(content: string): string { return content.endsWith("\n") ? content : `${content}\n` }

function formatTurnEndedText(turnEnded: TurnEndedMarker): string {
  switch (turnEnded.status) {
    case "success": return "Turn ended: success."
    case "error": return `Turn ended: error: ${turnEnded.error}`
    case "aborted": return turnEnded.error ? `Turn ended: aborted: ${turnEnded.error}` : "Turn ended: aborted."
    default: return turnEnded as unknown as string
  }
}

/** How the turn ended, in each of the three shapes a transcript is written in. */
function getTranscriptTerminalMarkers(options: TranscriptWriteOptions): { textSuffixes: string[]; jsonFields: Record<string, unknown>; jsonlLines: string[] } {
  const textSuffixes: string[] = [], jsonFields: Record<string, unknown> = {}, jsonlLines: string[] = []
  if (options.turnEnded !== undefined) {
    textSuffixes.push(formatTurnEndedText(options.turnEnded))
    jsonFields.turnEnded = options.turnEnded
    jsonlLines.push(JSON.stringify({ type: "turn_ended", ...options.turnEnded }))
  }
  return { textSuffixes, jsonFields, jsonlLines }
}

/** One event per line, which is what makes the JSONL form appendable. */
function formatSingleMessageJsonl(message: TranscriptMessage): string | undefined {
  if (message.role === "system" || isSummaryMessage(message)) return undefined
  const json = formatMessageToJson(message, message.role === "user")
  const content: { type: string; text?: string | undefined; name?: string | undefined; input?: unknown }[] = []
  const textParts: string[] = []
  if (json.text) textParts.push(json.text)
  if (json.thinking) textParts.push(json.thinking)
  if (textParts.length > 0) content.push({ type: "text", text: textParts.join("\n\n") })
  for (const call of json.toolCalls ?? []) content.push({ type: "tool_use", name: call.toolName, input: call.args })
  if (content.length === 0) return undefined
  return JSON.stringify({ role: message.role, message: { content } })
}

function formatTranscriptJsonl(messages: readonly TranscriptMessage[]): string {
  let filtered = messages.filter((message) => message.role !== "system")
  if (filtered.length >= 2 && filtered[0]?.role === "user" && filtered[1]?.role === "user") filtered = filtered.slice(1)
  return filtered.map(formatSingleMessageJsonl).filter((line): line is string => line !== undefined).join("\n")
}

export class TranscriptStore {
  private readonly options: Required<Pick<TranscriptStoreOptions, "writeText" | "writeJson" | "writeJsonl" | "fallbackToFullWriteOnIncrementalFailure">> & Omit<TranscriptStoreOptions, "writeText" | "writeJson" | "writeJsonl" | "fallbackToFullWriteOnIncrementalFailure">

  constructor(
    private readonly projectDir: string,
    private readonly blobStore: TranscriptBlobStore,
    private readonly writeFile: (path: string, content: string) => Promise<void>,
    options: TranscriptStoreOptions = {},
  ) {
    this.options = {
      writeText: options.writeText ?? true,
      writeJson: options.writeJson ?? false,
      writeJsonl: options.writeJsonl ?? false,
      pathResolver: options.pathResolver,
      appendFile: options.appendFile,
      fallbackToFullWriteOnIncrementalFailure: options.fallbackToFullWriteOnIncrementalFailure ?? true,
    }
  }

  resolveFilePath(conversationId: string, ext: string): string {
    if (this.options.pathResolver !== undefined) return this.options.pathResolver(conversationId, ext)
    const relative = getTranscriptRelativePath({ conversationId, ext, kind: "primary" })
    return `${this.projectDir}/${relative}`
  }

  async writeFromStateFull(ctx: Context, state: TranscriptState, conversationId: string, options: TranscriptWriteOptions = {}): Promise<boolean> {
    try {
      using span = createSpan(ctx.withName("writeFromState"))
      try {
        const messages = await hydrateMessages(span.ctx, this.blobStore, state) as TranscriptMessage[]
        const terminalMarkers = getTranscriptTerminalMarkers(options)
        // Nothing to write and nothing to say about the turn is not a failure.
        if (messages.length === 0 && terminalMarkers.jsonlLines.length === 0) return true
        let formattedConversation: string | undefined
        if (this.options.writeText || options.overviewFactory !== undefined) formattedConversation = formatTranscript(messages)
        if (this.options.writeText) {
          const base = formattedConversation ?? ""
          // The turn's own marker follows the conversation, or stands alone when there is no conversation.
          const textContent = terminalMarkers.textSuffixes.length > 0 ? base.trim().length > 0 ? `${base}\n\n${terminalMarkers.textSuffixes.join("\n")}` : terminalMarkers.textSuffixes.join("\n") : base
          if (textContent.trim()) await this.writeFile(this.resolveFilePath(conversationId, "txt"), textContent)
        }
        if (this.options.writeJson) {
          const jsonContent = formatTranscriptJson(messages)
          if (jsonContent || terminalMarkers.jsonlLines.length > 0) await this.writeFile(this.resolveFilePath(conversationId, "json"), JSON.stringify({ mode: agentModeToString(state.mode), messages: jsonContent ? JSON.parse(jsonContent) : [], ...terminalMarkers.jsonFields }, null, 2))
        }
        if (this.options.writeJsonl) {
          const body = formatTranscriptJsonl(messages)
          let finalJsonl = [body, ...terminalMarkers.jsonlLines].filter((line) => line.length > 0).join("\n")
          if (finalJsonl && options.overviewFactory !== undefined && formattedConversation?.trim()) {
            // An overview is a convenience, so failing to make one does not fail the transcript.
            try { const overview = (await options.overviewFactory(formattedConversation)).trim(); if (overview) finalJsonl = prependOverviewMetadataLine(finalJsonl, overview) } catch (error) { console.error("[TranscriptStore] Failed to generate transcript overview:", error) }
          }
          if (finalJsonl) await this.writeFile(this.resolveFilePath(conversationId, "jsonl"), ensureTrailingNewline(finalJsonl))
        }
        return true
      } catch (error) {
        console.error("[TranscriptStore] Failed to write transcript:", error)
        return false
      }
    } catch {
      return false
    }
  }

  /** Appends what is new when it can, and writes everything again when it cannot. */
  async writeFromStateIncremental(ctx: Context, state: TranscriptState, conversationId: string, previousRootPromptCount: number, options: TranscriptWriteOptions = {}): Promise<number> {
    const currentCount = state.rootPromptMessagesJson.length
    const terminalMarkers = getTranscriptTerminalMarkers(options)
    const hasTerminalMarker = terminalMarkers.jsonlLines.length > 0
    // Nothing new and nothing to say about the turn is nothing to do.
    if (currentCount === previousRootPromptCount && !hasTerminalMarker && options.overviewFactory === undefined) return currentCount
    const appendFile = this.options.appendFile
    // Appending is only possible for the JSONL form, only when there is something already written to append
    // to, and never when an overview has to go at the top of the file.
    const canAppend = appendFile !== undefined && this.options.writeJsonl && !this.options.writeText && !this.options.writeJson && previousRootPromptCount > 0 && currentCount >= previousRootPromptCount && (currentCount > previousRootPromptCount || hasTerminalMarker) && options.overviewFactory === undefined
    if (!canAppend) {
      const ok = await this.writeFromStateFull(ctx, state, conversationId, options)
      return ok ? currentCount : 0
    }
    try {
      using span = createSpan(ctx.withName("writeFromStateIncremental"))
      if (currentCount === previousRootPromptCount && hasTerminalMarker) {
        try { await appendFile(this.resolveFilePath(conversationId, "jsonl"), ensureTrailingNewline(terminalMarkers.jsonlLines.join("\n"))); return currentCount } catch (error) {
          console.error(this.options.fallbackToFullWriteOnIncrementalFailure ? "[TranscriptStore] Failed to append transcript, falling back to full write:" : "[TranscriptStore] Failed to append transcript:", error)
          if (!this.options.fallbackToFullWriteOnIncrementalFailure) return 0
          return (await this.writeFromStateFull(ctx, state, conversationId, options)) ? currentCount : 0
        }
      }
      try {
        // Only the messages that were not there last time are appended.
        const hydrated = await hydrateBlobIds(span.ctx, this.blobStore, state.rootPromptMessagesJson.slice(previousRootPromptCount))
        span.span.setAttribute("hydratedBlobCount", hydrated.hydratedBlobCount)
        span.span.setAttribute("hydratedBlobBytes", hydrated.hydratedBlobBytes)
        span.span.setAttribute("largestHydratedBlobBytes", hydrated.largestHydratedBlobBytes)
        span.span.setAttribute("totalDeserializeDurationMs", hydrated.totalDeserializeDurationMs)
        span.span.setAttribute("omittedOversizeBlobCount", hydrated.omittedOversizeBlobCount)
        span.span.setAttribute("omittedOversizeBlobBytes", hydrated.omittedOversizeBlobBytes)
        span.span.setAttribute("largestOmittedOversizeBlobBytes", hydrated.largestOmittedOversizeBlobBytes)
        const lines = hydrated.messages.map(formatSingleMessageJsonl).filter((line): line is string => line !== undefined)
        lines.push(...terminalMarkers.jsonlLines)
        if (lines.length > 0) await appendFile(this.resolveFilePath(conversationId, "jsonl"), ensureTrailingNewline(lines.join("\n")))
        return currentCount
      } catch (error) {
        console.error(this.options.fallbackToFullWriteOnIncrementalFailure ? "[TranscriptStore] Failed to append transcript, falling back to full write:" : "[TranscriptStore] Failed to append transcript:", error)
        if (!this.options.fallbackToFullWriteOnIncrementalFailure) return 0
        return (await this.writeFromStateFull(ctx, state, conversationId, options)) ? currentCount : 0
      }
    } catch {
      return 0
    }
  }
}
