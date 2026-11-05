/**
 * The transcript of a conversation, written where the user can read it.
 *
 * A conversation lives in the session as blobs — the right shape to restore from, the wrong shape to read. This store
 * reads them back into three files (a plain conversation, a JSON form, and a JSONL form of one event per line) and
 * writes whichever the configuration asks for; writing none is a valid answer.
 *
 * Reading is where the care is. A blob that cannot be read is left out instead of failing the transcript, because the
 * transcript is an observation of a conversation that already happened. A blob over the size threshold becomes a note
 * saying how large it was, because one enormous message would make the whole file unreadable. Summary archives are
 * read first and the live messages after, in the order they happened, and both are measured as they are read so the
 * span carries what the read cost.
 *
 * Writing is best-effort in the same way, with a second path for the common case: a turn that only appends messages
 * appends lines to the JSONL file, and a failed append falls back to writing everything unless the caller has turned
 * that off. What is appended is only what was not there last time, which is what the previous message count is for.
 *
 * Two markers end a turn's output: a line saying how the turn ended, and an overview the caller can supply a way to make.
 */
import { summaryMessageBlobIdsFromStored } from "../../../adapters/interop/agent/transcript-summary-archive-adapter.ts"
import type { Context } from "../../../packages/context/context.ts"
import { createSpan, withSuppressedChildSpans } from "../../../packages/context/telemetry.ts"
import { transcriptFilePath } from "./paths.ts"
import { stripContextTags } from "./context-stripping.ts"

/** One part of a message: what the model read or wrote, in the shape the transcript records it. */
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

export interface TranscriptState {
  readonly mode?: string
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

/** The marker a serialized blob of bytes is written with, and read back as a note in its place. */
const BINARY_TYPE_MARKER = '"__type":"Uint8Array"'

/** A blob larger than this is not shown: it becomes a note with its size instead of the whole file's unreadable bulk. */
const OVERSIZE_BLOB_THRESHOLD_BYTES = 5_000_000

/** The words the store reports with, each kept apart so the reason a transcript could not be written is not lost. */
const WRITE_FAILED = "[TranscriptStore] Failed to write transcript:"
const APPEND_FAILED = "[TranscriptStore] Failed to append transcript:"
const APPEND_FALLBACK = "[TranscriptStore] Failed to append transcript, falling back to full write:"
const OVERVIEW_FAILED = "[TranscriptStore] Failed to generate transcript overview:"

/** What each mode is called in a transcript, which is the mode's lower-case name; unspecified and unknown are agent. */
const TRANSCRIPT_MODES = new Set(["agent", "ask", "plan", "debug", "triage", "project", "multitask", "custom"])
const agentModeName = (mode: string | undefined): string => (mode !== undefined && TRANSCRIPT_MODES.has(mode) ? mode : "agent")

const hexOf = (bytes: Uint8Array): string => Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("")

/** Bytes and bigints have no JSON form, so they are written in one this reader understands. */
const jsonReplacer = (_key: string, value: unknown): unknown => {
  if (value instanceof Uint8Array) return { __type: "Uint8Array", hex: hexOf(value) }
  if (typeof value === "bigint") return value.toString()
  return value
}

/** Binary data is not put back: a transcript cannot show it, so it becomes a note saying how large it was. */
const binaryOmittedNote = (byteLength: number): string => `[Binary data omitted from transcript: ${byteLength} bytes]`

const jsonReviver = (_key: string, value: unknown): unknown => {
  if (typeof value !== "object" || value === null) return value
  const typed = value as { readonly __type?: unknown; readonly hex?: unknown }
  if (typed.__type !== "Uint8Array" || typeof typed.hex !== "string") return value
  return binaryOmittedNote(typed.hex.length / 2)
}

/** One message serialized as a session blob, and the same bytes read back as a message. */
const serializeMessage = (value: unknown): Uint8Array => textEncoder.encode(JSON.stringify(value, jsonReplacer))

const deserializeMessage = (blob: Uint8Array): TranscriptMessage => {
  const json = textDecoder.decode(blob)
  // The reviver is only needed when the text carries binary, which the common case does not.
  return JSON.parse(json, json.includes(BINARY_TYPE_MARKER) ? jsonReviver : undefined) as TranscriptMessage
}

const isSummaryMessage = (message: TranscriptMessage): boolean => message.providerOptions?.cursor?.isSummary === true

/** A blob's size as a note says it: megabytes with one decimal. */
const blobSizeNote = (byteLength: number): string => `${(byteLength / 1e6).toFixed(1)} MB`

const oversizeBlobOmittedMessage = (byteLength: number): TranscriptMessage => ({ role: "assistant", content: `[Oversize transcript blob omitted: ${blobSizeNote(byteLength)}]` })

/** What reading blobs cost and how much of it was shown; the span carries these and the writer reports them. */
interface HydrationStats {
  hydratedBlobCount: number
  hydratedBlobBytes: number
  largestHydratedBlobBytes: number
  totalDeserializeDurationMs: number
  omittedOversizeBlobCount: number
  omittedOversizeBlobBytes: number
  largestOmittedOversizeBlobBytes: number
}

/** The messages of one read, and what reading them cost. */
interface HydratedBlobs {
  readonly messages: TranscriptMessage[]
  readonly stats: HydrationStats
}

/** The summary archives of one read, and how many blobs it took to get there. */
interface HydratedArchives extends HydratedBlobs {
  readonly getBlobCount: number
}

const emptyHydrationStats = (): HydrationStats => ({
  hydratedBlobCount: 0,
  hydratedBlobBytes: 0,
  largestHydratedBlobBytes: 0,
  totalDeserializeDurationMs: 0,
  omittedOversizeBlobCount: 0,
  omittedOversizeBlobBytes: 0,
  largestOmittedOversizeBlobBytes: 0,
})

const addHydrationStats = (left: HydrationStats, right: HydrationStats): HydrationStats => ({
  hydratedBlobCount: left.hydratedBlobCount + right.hydratedBlobCount,
  hydratedBlobBytes: left.hydratedBlobBytes + right.hydratedBlobBytes,
  largestHydratedBlobBytes: Math.max(left.largestHydratedBlobBytes, right.largestHydratedBlobBytes),
  totalDeserializeDurationMs: left.totalDeserializeDurationMs + right.totalDeserializeDurationMs,
  omittedOversizeBlobCount: left.omittedOversizeBlobCount + right.omittedOversizeBlobCount,
  omittedOversizeBlobBytes: left.omittedOversizeBlobBytes + right.omittedOversizeBlobBytes,
  largestOmittedOversizeBlobBytes: Math.max(left.largestOmittedOversizeBlobBytes, right.largestOmittedOversizeBlobBytes),
})

/** What one read cost, on the span that measured it. */
const recordHydrationCost = (span: ReturnType<typeof createSpan>["span"], stats: HydrationStats): void => {
  span.setAttribute("hydratedBlobCount", stats.hydratedBlobCount)
  span.setAttribute("hydratedBlobBytes", stats.hydratedBlobBytes)
  span.setAttribute("largestHydratedBlobBytes", stats.largestHydratedBlobBytes)
  span.setAttribute("totalDeserializeDurationMs", stats.totalDeserializeDurationMs)
  span.setAttribute("omittedOversizeBlobCount", stats.omittedOversizeBlobCount)
  span.setAttribute("omittedOversizeBlobBytes", stats.omittedOversizeBlobBytes)
  span.setAttribute("largestOmittedOversizeBlobBytes", stats.largestOmittedOversizeBlobBytes)
}

/** What one read cost together with how many blobs it took, on the span that measured it. */
const recordHydrationSpan = (span: ReturnType<typeof createSpan>["span"], getBlobCount: number, stats: HydrationStats): void => {
  span.setAttribute("getBlobCount", getBlobCount)
  recordHydrationCost(span, stats)
}

/** Reads the messages behind these blobs: each on its own, with one that cannot be read left out rather than failing the rest. */
async function hydrateBlobIds(ctx: Context, blobStore: TranscriptBlobStore, blobIds: readonly Uint8Array[]): Promise<HydratedBlobs> {
  const messages: TranscriptMessage[] = []
  const stats = emptyHydrationStats()
  for (const blobId of blobIds) {
    const blob = await blobStore.getBlob(ctx, blobId)
    if (!blob) continue
    if (blob.length > OVERSIZE_BLOB_THRESHOLD_BYTES) {
      messages.push(oversizeBlobOmittedMessage(blob.length))
      stats.omittedOversizeBlobCount += 1
      stats.omittedOversizeBlobBytes += blob.length
      stats.largestOmittedOversizeBlobBytes = Math.max(stats.largestOmittedOversizeBlobBytes, blob.length)
      continue
    }
    try {
      const started = performance.now()
      messages.push(deserializeMessage(blob))
      stats.totalDeserializeDurationMs += performance.now() - started
      stats.hydratedBlobCount += 1
      stats.hydratedBlobBytes += blob.length
      stats.largestHydratedBlobBytes = Math.max(stats.largestHydratedBlobBytes, blob.length)
    } catch {
      // Observational transcript blobs are intentionally best-effort.
    }
  }
  return { messages, stats }
}

/** The summarize-away part of a conversation, read through its archive references. A malformed archive is omitted. */
async function hydrateSummaryArchives(ctx: Context, blobStore: TranscriptBlobStore, archiveRefs: readonly Uint8Array[]): Promise<HydratedArchives> {
  let getBlobCount = 0
  const archives = await Promise.all(archiveRefs.map(async (archiveRef) => {
    getBlobCount += 1
    const archiveBlob = await blobStore.getBlob(ctx, archiveRef)
    if (!archiveBlob) return undefined
    const summarizedMessageBlobIds = summaryMessageBlobIdsFromStored(archiveBlob)
    if (summarizedMessageBlobIds === undefined) return undefined
    getBlobCount += summarizedMessageBlobIds.length
    return hydrateBlobIds(ctx, blobStore, summarizedMessageBlobIds)
  }))
  const messages: TranscriptMessage[] = []
  let stats = emptyHydrationStats()
  for (const archive of archives) {
    if (archive === undefined) continue
    messages.push(...archive.messages)
    stats = addHydrationStats(stats, archive.stats)
  }
  return { messages, stats, getBlobCount }
}

/** The whole conversation: what was summarized away first, then what is still live. */
async function hydrateMessages(ctx: Context, blobStore: TranscriptBlobStore, state: TranscriptState): Promise<TranscriptMessage[] | undefined> {
  try {
    using archiveSpan = createSpan(ctx.withName("hydrateSummaryArchives"))
    const quietCtx = withSuppressedChildSpans(archiveSpan.ctx)
    const archived = await hydrateSummaryArchives(quietCtx, blobStore, state.summaryArchives)
    recordHydrationSpan(archiveSpan.span, archived.getBlobCount, archived.stats)
    using promptSpan = createSpan(ctx.withName("hydratePromptMessages"))
    const prompt = await hydrateBlobIds(quietCtx, blobStore, state.rootPromptMessagesJson)
    recordHydrationSpan(promptSpan.span, state.rootPromptMessagesJson.length, prompt.stats)
    // The system messages and the summaries are not part of the conversation as it was read.
    return [...archived.messages, ...prompt.messages.filter((message) => message.role !== "system" && !isSummaryMessage(message))]
  } catch {
    return undefined
  }
}

/** What a tool call was given, as the indented rows below its line: nothing when it was given nothing. */
const formatToolArgs = (args: unknown): string => {
  if (args === null || args === undefined || typeof args !== "object") return args == null ? "" : String(args)
  const entries = Object.entries(args)
  if (entries.length === 0) return ""
  const rows = entries.map(([key, value]) => {
    const shown = typeof value === "string" ? value : typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)
    return `  ${key}: ${shown}`
  })
  return `\n${rows.join("\n")}`
}

/** A content part as the text forms show it; a strip flag is passed only to the kinds that carry context tags. */
type ContentPartFormatter = (part: TranscriptContentPart, stripTags: boolean) => string

/** What each kind of part is as text. A kind this surface does not have says nothing rather than guessing. */
const CONTENT_PART_FORMATTERS: ReadonlyMap<string, ContentPartFormatter> = new Map<string, ContentPartFormatter>([
  ["text", (part, stripTags) => (stripTags ? stripContextTags(part.text as string) : part.text as string)],
  ["image", () => "[Image]"],
  ["file", (part) => (part.filename ? `[File: ${part.filename}]` : "[File]")],
  ["reasoning", (part) => `[Thinking] ${part.text}`],
  ["redacted-reasoning", () => "[Thinking]"],
  ["tool-call", (part) => `[Tool call] ${part.toolName}${formatToolArgs(part.args)}`],
  ["tool-result", (part) => `[Tool result] ${part.toolName}`],
])

const formatContentPart = (part: TranscriptContentPart, stripTags: boolean): string => CONTENT_PART_FORMATTERS.get(part.type)?.(part, stripTags) ?? ""

function stripHiddenThinkingTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** A part's text after the stripping its message's role asks for. */
const visiblePartText = (part: TranscriptContentPart, role: string, stripTags: boolean): string => {
  const raw = stripTags ? stripContextTags(part.text as string) : part.text as string
  return role === "assistant" ? stripHiddenThinkingTags(raw) : raw
}

const formatContent = (content: string | readonly TranscriptContentPart[] | undefined, stripTags: boolean, stripThinkTags: boolean): string => {
  if (content === undefined) return ""
  if (typeof content === "string") {
    const processed = stripTags ? stripContextTags(content) : content
    return stripThinkTags ? stripHiddenThinkingTags(processed) : processed
  }
  return content.map((part) => {
    if (stripThinkTags && part.type === "text") return stripHiddenThinkingTags(stripTags ? stripContextTags(part.text as string) : part.text as string)
    return formatContentPart(part, stripTags)
  }).filter(Boolean).join("\n")
}

/** The conversation without the platform's preamble: its system messages, and the framing user message that opens it. */
const conversationMessages = (messages: readonly TranscriptMessage[]): readonly TranscriptMessage[] => {
  const filtered = messages.filter((message) => message.role !== "system")
  return filtered.length >= 2 && filtered[0]?.role === "user" && filtered[1]?.role === "user" ? filtered.slice(1) : filtered
}

/** The conversation as text, each message under its role; a tool result speaks for itself. */
const formatTranscript = (messages: readonly TranscriptMessage[]): string => conversationMessages(messages)
  .map((message) => {
    const content = formatContent(message.content, message.role === "user", message.role === "assistant")
    if (!content.trim()) return ""
    return message.role === "tool" ? content : `${message.role}:\n${content}`
  })
  .filter(Boolean)
  .join("\n\n")

interface TranscriptJsonToolCall {
  readonly toolName?: string
  readonly args?: unknown
}

/** One message as the JSON form shows it: its words, what it thought, what it called, what came back. */
type WritableJsonMessage = {
  role: string
  text?: string
  thinking?: string
  toolCalls?: TranscriptJsonToolCall[]
  toolResult?: { toolName?: string }
}

const messageToJson = (message: TranscriptMessage, stripTags: boolean): WritableJsonMessage => {
  const json: WritableJsonMessage = { role: message.role }
  if (typeof message.content === "string") {
    const visible = visiblePartText({ type: "text", text: message.content }, message.role, stripTags)
    if (visible.trim()) json.text = visible
    return json
  }
  if (!Array.isArray(message.content)) return json
  const textParts: string[] = []
  const thinkingParts: string[] = []
  const toolCalls: TranscriptJsonToolCall[] = []
  for (const part of message.content) {
    switch (part.type) {
      case "text": {
        const visible = visiblePartText(part, message.role, stripTags)
        if (visible.trim()) textParts.push(visible)
        break
      }
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
  return json
}

/** The JSON form: the mode and the messages that have anything in them. A message with nothing is left out. */
const formatTranscriptJson = (messages: readonly TranscriptMessage[]): string => {
  const jsonMessages = conversationMessages(messages)
    .map((message) => messageToJson(message, message.role === "user"))
    .filter((message) => message.text || message.thinking || message.toolCalls || message.toolResult)
  return jsonMessages.length === 0 ? "" : JSON.stringify(jsonMessages, null, 2)
}

/** One event per line, which is what makes the JSONL form appendable. */
const messageJsonlContent = (json: WritableJsonMessage): { type: string; text?: string | undefined; name?: string | undefined; input?: unknown }[] => {
  const content: { type: string; text?: string | undefined; name?: string | undefined; input?: unknown }[] = []
  const textParts: string[] = []
  if (json.text) textParts.push(json.text)
  if (json.thinking) textParts.push(json.thinking)
  if (textParts.length > 0) content.push({ type: "text", text: textParts.join("\n\n") })
  for (const call of json.toolCalls ?? []) content.push({ type: "tool_use", name: call.toolName, input: call.args })
  return content
}

/** One message as a JSONL line, or nothing when the conversation does not show it. */
const formatMessageJsonl = (message: TranscriptMessage): string | undefined => {
  if (message.role === "system" || isSummaryMessage(message)) return undefined
  const content = messageJsonlContent(messageToJson(message, message.role === "user"))
  if (content.length === 0) return undefined
  return JSON.stringify({ role: message.role, message: { content } })
}

const formatTranscriptJsonl = (messages: readonly TranscriptMessage[]): string => conversationMessages(messages)
  .map(formatMessageJsonl)
  .filter((line): line is string => line !== undefined)
  .join("\n")

/** The line saying how the turn ended, in each status the transcript knows. An unknown status is written as it came. */
const turnEndedText = (turnEnded: TurnEndedMarker): string => {
  switch (turnEnded.status) {
    case "success": return "Turn ended: success."
    case "error": return `Turn ended: error: ${turnEnded.error}`
    case "aborted": return turnEnded.error ? `Turn ended: aborted: ${turnEnded.error}` : "Turn ended: aborted."
    default: return turnEnded as unknown as string
  }
}

/** How the turn ended, in the shape each of the three forms writes it in. */
interface TranscriptTerminalMarkers {
  readonly textSuffixes: string[]
  readonly jsonFields: Record<string, unknown>
  readonly jsonlLines: string[]
}

const terminalMarkers = (options: TranscriptWriteOptions): TranscriptTerminalMarkers => {
  const textSuffixes: string[] = []
  const jsonFields: Record<string, unknown> = {}
  const jsonlLines: string[] = []
  if (options.turnEnded !== undefined) {
    textSuffixes.push(turnEndedText(options.turnEnded))
    jsonFields.turnEnded = options.turnEnded
    jsonlLines.push(JSON.stringify({ type: "turn_ended", ...options.turnEnded }))
  }
  return { textSuffixes, jsonFields, jsonlLines }
}

/** An overview is metadata at the top of the JSONL file, ahead of the events. */
const prependOverviewMetadataLine = (jsonlContent: string, overview: string): string => `${JSON.stringify({ type: "metadata", metadata: { overview } })}\n${jsonlContent}`

const ensureTrailingNewline = (content: string): string => (content.endsWith("\n") ? content : `${content}\n`)

type ResolvedTranscriptStoreOptions = Required<Pick<TranscriptStoreOptions, "writeText" | "writeJson" | "writeJsonl" | "fallbackToFullWriteOnIncrementalFailure">> & Omit<TranscriptStoreOptions, "writeText" | "writeJson" | "writeJsonl" | "fallbackToFullWriteOnIncrementalFailure">

/** The store a transcript is written through: the blobs it reads, the files it writes and the forms it writes. */
export class TranscriptStore {
  private readonly options: ResolvedTranscriptStoreOptions

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
    const relative = transcriptFilePath({ conversationId, ext, kind: "primary" })
    return `${this.projectDir}/${relative}`
  }

  /** Writes every form the configuration asks for; a form that fails reports the write as failed rather than throwing. */
  async writeFromStateFull(ctx: Context, state: TranscriptState, conversationId: string, options: TranscriptWriteOptions = {}): Promise<boolean> {
    try {
      using span = createSpan(ctx.withName("writeFromState"))
      try {
        const messages = await hydrateMessages(span.ctx, this.blobStore, state) as TranscriptMessage[]
        const markers = terminalMarkers(options)
        // Nothing to write and nothing to say about the turn is not a failure.
        if (messages.length === 0 && markers.jsonlLines.length === 0) return true
        const formattedConversation = this.options.writeText || options.overviewFactory !== undefined ? formatTranscript(messages) : undefined
        await this.writeTextForm(conversationId, formattedConversation, markers)
        await this.writeJsonForm(conversationId, state, messages, markers)
        await this.writeJsonlForm(conversationId, messages, markers, formattedConversation, options.overviewFactory)
        return true
      } catch (error) {
        console.error(WRITE_FAILED, error)
        return false
      }
    } catch {
      return false
    }
  }

  /** The text form: the conversation with the turn's own line after it, or the line alone when there is no conversation. */
  private async writeTextForm(conversationId: string, formattedConversation: string | undefined, markers: TranscriptTerminalMarkers): Promise<void> {
    if (!this.options.writeText) return
    const body = formattedConversation ?? ""
    const suffixes = markers.textSuffixes
    const content = suffixes.length > 0 ? (body.trim().length > 0 ? `${body}\n\n${suffixes.join("\n")}` : suffixes.join("\n")) : body
    if (content.trim()) await this.writeFile(this.resolveFilePath(conversationId, "txt"), content)
  }

  /** The JSON form: the mode, the messages that have anything in them, and the turn's fields. */
  private async writeJsonForm(conversationId: string, state: TranscriptState, messages: readonly TranscriptMessage[], markers: TranscriptTerminalMarkers): Promise<void> {
    if (!this.options.writeJson) return
    const jsonContent = formatTranscriptJson(messages)
    if (!jsonContent && markers.jsonlLines.length === 0) return
    const payload = { mode: agentModeName(state.mode), messages: jsonContent ? JSON.parse(jsonContent) : [], ...markers.jsonFields }
    await this.writeFile(this.resolveFilePath(conversationId, "json"), JSON.stringify(payload, null, 2))
  }

  /** The JSONL form: the events, the turn's line, and the overview at the top when one can be made. */
  private async writeJsonlForm(conversationId: string, messages: readonly TranscriptMessage[], markers: TranscriptTerminalMarkers, formattedConversation: string | undefined, overviewFactory: ((formatted: string) => Promise<string>) | undefined): Promise<void> {
    if (!this.options.writeJsonl) return
    const body = formatTranscriptJsonl(messages)
    let content = [body, ...markers.jsonlLines].filter((line) => line.length > 0).join("\n")
    if (content && overviewFactory !== undefined && formattedConversation?.trim()) {
      // An overview is a convenience, so failing to make one does not fail the transcript.
      try {
        const overview = (await overviewFactory(formattedConversation)).trim()
        if (overview) content = prependOverviewMetadataLine(content, overview)
      } catch (error) {
        console.error(OVERVIEW_FAILED, error)
      }
    }
    if (content) await this.writeFile(this.resolveFilePath(conversationId, "jsonl"), ensureTrailingNewline(content))
  }

  /** Appends what is new when it can, and writes everything again when it cannot. */
  async writeFromStateIncremental(ctx: Context, state: TranscriptState, conversationId: string, previousRootPromptCount: number, options: TranscriptWriteOptions = {}): Promise<number> {
    const currentCount = state.rootPromptMessagesJson.length
    const markers = terminalMarkers(options)
    const hasMarker = markers.jsonlLines.length > 0
    // Nothing new and nothing to say about the turn is nothing to do.
    if (currentCount === previousRootPromptCount && !hasMarker && options.overviewFactory === undefined) return currentCount
    if (!this.canAppendIncrementally(currentCount, previousRootPromptCount, hasMarker, options)) {
      return (await this.writeFromStateFull(ctx, state, conversationId, options)) ? currentCount : 0
    }
    const appendFile = this.options.appendFile as (path: string, content: string) => Promise<void>
    try {
      using span = createSpan(ctx.withName("writeFromStateIncremental"))
      if (currentCount === previousRootPromptCount) return await this.appendOnlyMarker(span, ctx, state, conversationId, markers, options, currentCount, appendFile)
      return await this.appendNewMessages(span, ctx, state, conversationId, markers, previousRootPromptCount, options, currentCount, appendFile)
    } catch {
      return 0
    }
  }

  /**
   * Whether this write can be an append: only the JSONL form, only onto a file already written, and never when an
   * overview has to go at the top of it.
   */
  private canAppendIncrementally(currentCount: number, previousCount: number, hasMarker: boolean, options: TranscriptWriteOptions): boolean {
    if (this.options.appendFile === undefined) return false
    if (!this.options.writeJsonl || this.options.writeText || this.options.writeJson) return false
    if (previousCount <= 0 || currentCount < previousCount) return false
    if (currentCount === previousCount && !hasMarker) return false
    return options.overviewFactory === undefined
  }

  /** After a failed append: reports it, and either writes everything again or gives up as the caller configured. */
  private async recoverFromAppendFailure(ctx: Context, state: TranscriptState, conversationId: string, options: TranscriptWriteOptions, currentCount: number, error: unknown): Promise<number> {
    const fallBack = this.options.fallbackToFullWriteOnIncrementalFailure
    console.error(fallBack ? APPEND_FALLBACK : APPEND_FAILED, error)
    if (!fallBack) return 0
    return (await this.writeFromStateFull(ctx, state, conversationId, options)) ? currentCount : 0
  }

  /** Appends only the turn's line, when the conversation itself has not changed. */
  private async appendOnlyMarker(
    span: ReturnType<typeof createSpan>,
    ctx: Context,
    state: TranscriptState,
    conversationId: string,
    markers: TranscriptTerminalMarkers,
    options: TranscriptWriteOptions,
    currentCount: number,
    appendFile: (path: string, content: string) => Promise<void>,
  ): Promise<number> {
    try {
      await appendFile(this.resolveFilePath(conversationId, "jsonl"), ensureTrailingNewline(markers.jsonlLines.join("\n")))
      return currentCount
    } catch (error) {
      return this.recoverFromAppendFailure(ctx, state, conversationId, options, currentCount, error)
    }
  }

  /** Appends the messages that were not written last time, and then the turn's line. */
  private async appendNewMessages(
    span: ReturnType<typeof createSpan>,
    ctx: Context,
    state: TranscriptState,
    conversationId: string,
    markers: TranscriptTerminalMarkers,
    previousCount: number,
    options: TranscriptWriteOptions,
    currentCount: number,
    appendFile: (path: string, content: string) => Promise<void>,
  ): Promise<number> {
    try {
      const hydrated = await hydrateBlobIds(span.ctx, this.blobStore, state.rootPromptMessagesJson.slice(previousCount))
      recordHydrationCost(span.span, hydrated.stats)
      const lines = hydrated.messages.map(formatMessageJsonl).filter((line): line is string => line !== undefined)
      lines.push(...markers.jsonlLines)
      if (lines.length > 0) await appendFile(this.resolveFilePath(conversationId, "jsonl"), ensureTrailingNewline(lines.join("\n")))
      return currentCount
    } catch (error) {
      return this.recoverFromAppendFailure(ctx, state, conversationId, options, currentCount, error)
    }
  }
}
