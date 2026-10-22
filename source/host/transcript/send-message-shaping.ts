/** What a message the agent sends looks like once it arrives.
 *
 * The message a tool call carries is turned into the shape the conversation keeps: its text, the pictures with it, the
 * queue it belongs to and the item it becomes, with what the platform may hold bounded and what it may not leave out
 * rather than smuggled in. */
import { stat } from "node:fs/promises"
import { basename } from "node:path"
import { imageMimeFromPath, videoMimeFromPath } from "../../shared/media/image-mime.ts"
import { filePathFromFileUrl } from "../../shared/node/paths.ts"
import { summarizeWidget } from "../../shared/slate-widgets.ts"
import { loadSelectedImageInputs } from "../selected-image-inputs.ts"
import type { TranscriptEntry } from "./transcript-hub.ts"

/** One reaction a message can carry: who left it, under which emoji. */
export interface Reaction {
  emoji: string
  by: string
}

/** A message being sent: its type, and whatever that type carries. */
export type SendMessage = Record<string, unknown> & {
  type: string
  reply_to?: string
}

/** The message types that are not threaded and therefore never get or lose a reply target. */
const UNTHREADED_TYPES: ReadonlySet<string> = new Set([
  "auto-review-approval",
  "local-tool-permission",
  "email-draft",
  "slack-draft",
])

/** Whether an item is something the user sent, as opposed to anything the agent produced. */
export function isUserMessageEntry(item: TranscriptEntry): boolean {
  return item.kind === "message" ? item.role === "user" : item.kind === "user-attachment"
}

/** Whether one reaction is the one asked about. */
function isReactionFrom(reaction: Reaction, emoji: string, by: string): boolean {
  return reaction.emoji === emoji && reaction.by === by
}

/** Adds the user's reaction, or takes it back when it is already there; nothing left means no existingReactions. */
export function toggleReaction(
  existingReactions: readonly Reaction[] | undefined,
  symbol: string,
  author: string,
): Reaction[] | undefined {
  const pinned = existingReactions ?? []
  const next = pinned.some(reaction => isReactionFrom(reaction, symbol, author))
    ? pinned.filter(reaction => !isReactionFrom(reaction, symbol, author))
    : [...pinned, { emoji: symbol, by: author }]
  return next.length > 0 ? next : undefined
}

/** The text of an item that may be quoted: the user's own words or a sent text message. */
export function quotableEntryText(item: TranscriptEntry): string {
  if (item.kind === "message") return typeof item.content === "string" ? item.content : ""
  const message = item.message as SendMessage | undefined
  return item.kind === "send-message" && message?.type === "text" && typeof message.content === "string"
    ? message.content
    : ""
}

/** The text of a message as one line, cut at a length when one is asked for. */
function oneLineQuote(item: TranscriptEntry, limit?: number): string {
  const text = quotableEntryText(item).replace(/\s+/g, " ").trim()
  if (text.length === 0) return item.id
  return limit != null && text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** One line of a message, for a quotation. */
export function describeMessageQuote(item: TranscriptEntry, limit?: number): string {
  return oneLineQuote(item, limit)
}

/** The line a reaction is described with: short, because a reaction chip has no room. */
export function describeReactedMessageQuote(item: TranscriptEntry): string {
  return describeMessageQuote(item, 80)
}

/** The line a reply is described with: the whole message, however long. */
export function describeRepliedMessageQuote(item: TranscriptEntry): string {
  return describeMessageQuote(item)
}

/** The note a message composed while offline carries, when its time is known. */
export function buildComposedOfflineNote(composedAtMs: number): string {
  return Number.isFinite(composedAtMs) ? `[Composed offline at ${new Date(composedAtMs).toISOString()}]` : ""
}

/** What a caller may say about a user message it is creating. */
export interface UserMessageOptions {
  composedAtMs?: number
  richText?: string
  replyTo?: string
  batchId?: string
  branched?: boolean
  clientNonce?: string
}

/** The composition time of a message, when it is a usable time at all. */
function composedTimeOf(composedAtMs: number | undefined): number | undefined {
  return composedAtMs != null && Number.isFinite(composedAtMs) ? composedAtMs : undefined
}

/** The rich text a message carries, when it has any. */
function richTextOf(value: string | undefined): string | undefined {
  return value != null && value.length > 0 ? value : undefined
}

/** The client nonce a message carries, when it has one. */
function nonceOf(value: string | undefined): string | undefined {
  return value != null && value.length > 0 ? value : undefined
}

/** One user message, as the conversation keeps it. */
export function createUserMessage(id: string, content: string, settings: UserMessageOptions = {}): TranscriptEntry {
  const composedAtMs = composedTimeOf(settings.composedAtMs)
  return {
    kind: "message",
    id,
    role: "user",
    content,
    richText: richTextOf(settings.richText),
    isStreaming: false,
    timestampMs: composedAtMs ?? Date.now(),
    ...optionalEntry("replyTo", settings.replyTo),
    ...optionalEntry("batchId", settings.batchId),
    ...(settings.branched === true ? { branched: true } : {}),
    ...(nonceOf(settings.clientNonce) != null ? { clientNonce: settings.clientNonce } : {}),
    ...(composedAtMs == null ? {} : { sentWhileOfflineAtMs: composedAtMs }),
  }
}

/** One sent message, as the conversation keeps it, with its reply target when it has one. */
export function createSendMessageEntry(id: string, message: SendMessage, sentAtMs: number): TranscriptEntry {
  return {
    kind: "send-message",
    id,
    message,
    timestampMs: sentAtMs,
    ...(message.reply_to != null && message.reply_to.length > 0 ? { replyTo: message.reply_to } : {}),
  }
}

/** An item stamped with the box request that carried it. */
export function stampBoxRequestEntry<T extends object>(
  item: T,
  stamp: { requestId: string; instruction: string },
): T & { boxRequestId: string; boxInstruction: string } {
  return { ...item, boxRequestId: stamp.requestId, boxInstruction: stamp.instruction }
}

/** One attached file, as the conversation keeps it, with its measured size and picture dimensions. */
export async function createUserAttachmentEntry(
  imageReader: { readImageDimensions(path: string): Promise<{ width?: number; height?: number } | null> },
  id: string,
  attachedPath: string,
  settings: {
    fileName?: string
    batchId?: string
    clientNonce?: string
    byteSize?: number
    replyTo?: string
    branched?: boolean
  } = {},
): Promise<TranscriptEntry> {
  const dimensions = await imageReader.readImageDimensions(attachedPath)
  const fileName = settings.fileName?.trim()
  return {
    kind: "user-attachment",
    id,
    file_path: attachedPath,
    ...(fileName ? { file_name: fileName } : {}),
    ...optionalEntry("batchId", settings.batchId),
    ...(settings.clientNonce ? { clientNonce: settings.clientNonce } : {}),
    width: dimensions?.width,
    height: dimensions?.height,
    byteSize: settings.byteSize,
    ...optionalEntry("replyTo", settings.replyTo),
    ...(settings.branched === true ? { branched: true } : {}),
  }
}


/** A field to spread into a message, present only when it has a value. */
function optionalEntry<Key extends string>(key: Key, value: unknown): Partial<Record<Key, unknown>> {
  return value == null ? {} : { [key]: value } as Partial<Record<Key, unknown>>
}

/** The thread a message belongs to, as a field to spread into it. */
function threadOf(replyTo: string | undefined): { reply_to?: string } {
  return replyTo == null ? {} : { reply_to: replyTo }
}


/** The shape a message has once it may be threaded: only the fields its type owns, and its reply target. */
function shapeThreadable(message: SendMessage, replyTo?: string): SendMessage {
  const thread = threadOf(replyTo)
  switch (message.type) {
    case "text":
      return {
        type: "text",
        content: message.content,
        ...optionalEntry("images", message.images),
        ...thread,
      }
    case "widget":
      return { type: "widget", widget: message.widget, ...thread }
    case "cursor-agent":
      return { type: "cursor-agent", bcId: message.bcId, ...thread }
    case "secret-request":
      return { type: "secret-request", secretRequest: message.secretRequest, ...thread }
    case "permission-request":
      return { type: "permission-request", permission: message.permission, ...thread }
    case "connector":
      return {
        type: "connector",
        connector: message.connector,
        variant: message.variant,
        ...thread,
        ...optionalEntry("serverId", message.serverId),
        ...optionalEntry("reason", message.reason),
        ...optionalEntry("suggestions", message.suggestions),
      }
    case "connectors":
      return {
        type: "connectors",
        connectors: message.connectors,
        ...thread,
        ...optionalEntry("reason", message.reason),
      }
    case "listener-connect":
      return {
        type: "listener-connect",
        platform: message.platform,
        ...thread,
        ...optionalEntry("reason", message.reason),
      }
    case "attachment":
      return {
        type: "attachment",
        url: message.url,
        ...thread,
        ...optionalEntry("file_name", message.file_name),
        ...optionalEntry("alt", message.alt),
        ...optionalEntry("channel", message.channel),
        ...optionalEntry("width", message.width),
        ...optionalEntry("height", message.height),
      }
    default:
      return message
  }
}

/** The message with any reply target taken off, except for the types that never carry one. */
export function stripReplyTo<T extends SendMessage>(message: T): T {
  if (UNTHREADED_TYPES.has(message.type)) return message
  return shapeThreadable(message) as T
}

/** The message with a reply target on, except for the types that never carry one. */
export function withReplyTo<T extends SendMessage>(message: T, replyTo: string): T {
  if (UNTHREADED_TYPES.has(message.type)) return message
  return shapeThreadable(message, replyTo) as T
}

/** The prompt a widget message asks, when its answer decides whether the message can be skipped. */
export function skippablePromptSummary(message: SendMessage): string | undefined {
  if (message.type !== "widget") return undefined
  return summarizeWidget((message.widget ?? {}) as { prompt?: unknown; settings?: unknown })
}

/** The channel an attachment's path names: a picture, a video, or a plain file. */
type AttachmentChannel = "image" | "video" | "file"

function attachmentChannelOf(path: string): AttachmentChannel {
  if (imageMimeFromPath(path) !== undefined) return "image"
  if (videoMimeFromPath(path) !== undefined) return "video"
  return "file"
}

/** The attachment paths split by the channel each one is sent on, keeping the caller's order in each. */
export function splitAttachmentPathsByChannel(paths: readonly string[]): {
  imageAttachmentPaths: string[]
  videoAttachmentPaths: string[]
  fileAttachmentPaths: string[]
} {
  const byChannel: Record<AttachmentChannel, string[]> = { image: [], video: [], file: [] }
  for (const path of paths) byChannel[attachmentChannelOf(path)].push(path)
  return {
    imageAttachmentPaths: byChannel.image,
    videoAttachmentPaths: byChannel.video,
    fileAttachmentPaths: byChannel.file,
  }
}

/** The videos a caller selected, described the way a model is told about them. */
export function buildSelectedVideos(
  paths: readonly string[],
): Array<{ path: string; mimeType: string; filename: string; fps: number }> {
  return paths.map(path => ({
    path,
    mimeType: videoMimeFromPath(path) ?? "video/mp4",
    filename: basename(path),
    fps: 4,
  }))
}

/** The pictures inbound inbox carried. */
export function collectInboundImages(
  inbox: readonly { images?: readonly { data: string; mimeType: string }[] }[],
): Array<{ data: string; mimeType: string }> {
  return inbox.flatMap(envelope => envelope.images ?? [])
}

/** The file paths an agent's inbound pictures name, when they name any. */
function inboundImagePaths(images: readonly { url: string }[] | undefined): string[] {
  return (images ?? [])
    .map(image => filePathFromFileUrl(image.url))
    .filter((path): path is string => path != null)
}

/** The inbound pictures of an agent, loaded for a prompt. */
export async function loadAgentInboundImages(
  images: readonly { url: string }[] | undefined,
): Promise<Awaited<ReturnType<typeof loadSelectedImageInputs>>> {
  return loadSelectedImageInputs(inboundImagePaths(images))
}

/** The sizes of the files that are really there, in the caller's order. */
export async function statAttachedFileSizes(paths: readonly string[]): Promise<Map<string, number>> {
  // The measurements are taken together but put in the caller's order: a map filled as each stat landed would hand
  // its order to whichever lookup finished first.
  const measured = await Promise.all(
    paths.map(async path => {
      try {
        const info = await stat(path)
        return info.isFile() ? ([path, info.size] as const) : null
      } catch {
        return null
      }
    }),
  )
  const sizes = new Map<string, number>()
  for (const measuredPath of measured) if (measuredPath !== null) sizes.set(measuredPath[0], measuredPath[1])
  return sizes
}
