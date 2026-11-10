import { utf8Serde } from "./serde.ts"

/** JSON data that belongs to the Slate-owned, versioned agent-checkpoint envelope. */
export type AgentCheckpointJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly AgentCheckpointJsonValue[]
  | { readonly [key: string]: AgentCheckpointJsonValue }

export interface AgentCheckpointJsonObject {
  readonly [key: string]: AgentCheckpointJsonValue
}

export interface SlateAgentConversationReferencesV1 {
  readonly turnBlobIds: readonly string[]
  readonly todoBlobIds: readonly string[]
  readonly summaryBlobId?: string
  readonly summaryArchiveBlobId?: string
  readonly summaryArchiveBlobIds: readonly string[]
}

export interface SlateAgentCheckpointV1 {
  readonly format: "slate.agent-conversation-checkpoint"
  readonly version: 1
  /** Slate-owned references to the conversation content stored separately from this root. */
  readonly conversation: SlateAgentConversationReferencesV1
  /** Remaining runner continuity data, projected at the interop boundary and opaque to the store. */
  readonly interopSnapshot: AgentCheckpointJsonObject
}

/** A complete first-party conversation snapshot in the version 2 storage format. */
export interface SlateAgentCheckpointV2 {
  readonly format: "slate.agent-conversation-checkpoint"
  readonly version: 2
  readonly conversation: AgentCheckpointJsonObject
}

export type SlateAgentCheckpoint = SlateAgentCheckpointV1 | SlateAgentCheckpointV2

const FORMAT = "slate.agent-conversation-checkpoint"
const VERSION = 1
const HEADER = utf8Serde.serialize("SLATE-AGENT-CHECKPOINT\n")

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isJsonValue(value: unknown): value is AgentCheckpointJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (!isRecord(value)) return false
  return Object.values(value).every(isJsonValue)
}

function isHexId(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{2})*$/.test(value)
}

function isHexIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isHexId)
}

function hasHeader(blob: Uint8Array): boolean {
  if (blob.length < HEADER.length) return false
  for (let index = 0; index < HEADER.length; index += 1) {
    if (blob[index] !== HEADER[index]) return false
  }
  return true
}

/** Serializes the host snapshot in Slate's own versioned root format. */
export function serializeSlateAgentCheckpoint(
  conversation: SlateAgentConversationReferencesV1,
  interopSnapshot: AgentCheckpointJsonObject,
): Uint8Array {
  const body = utf8Serde.serialize(JSON.stringify({
    format: FORMAT,
    version: VERSION,
    conversation,
    interopSnapshot,
  }))
  const blob = new Uint8Array(HEADER.length + body.length)
  blob.set(HEADER)
  blob.set(body, HEADER.length)
  return blob
}

/** Serializes a Slate-owned conversation snapshot without a generated-message JSON payload. */
export function serializeSlateAgentCheckpointV2(
  conversation: AgentCheckpointJsonObject,
): Uint8Array {
  if (!Object.values(conversation).every(isJsonValue)) {
    throw new TypeError("Slate conversation checkpoint contains non-JSON data")
  }
  const body = utf8Serde.serialize(JSON.stringify({
    format: FORMAT,
    version: 2,
    conversation,
  }))
  const blob = new Uint8Array(HEADER.length + body.length)
  blob.set(HEADER)
  blob.set(body, HEADER.length)
  return blob
}

/** Returns `undefined` for a legacy root so the interop adapter can decode its former protobuf format. */
export function deserializeSlateAgentCheckpoint(blob: Uint8Array): SlateAgentCheckpoint | undefined {
  if (!hasHeader(blob)) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(utf8Serde.deserialize(blob.subarray(HEADER.length)))
  } catch (error) {
    throw new TypeError("Slate agent checkpoint JSON is invalid", { cause: error })
  }
  if (!isRecord(parsed) || parsed.format !== FORMAT || (parsed.version !== 1 && parsed.version !== 2)) {
    throw new TypeError("Slate agent checkpoint envelope is unsupported")
  }
  if (parsed.version === 2) {
    if (!Object.keys(parsed).every(key => key === "format" || key === "version" || key === "conversation") ||
        !isRecord(parsed.conversation) || !Object.values(parsed.conversation).every(isJsonValue)) {
      throw new TypeError("Slate agent checkpoint conversation is invalid")
    }
    return parsed as unknown as SlateAgentCheckpointV2
  }
  if (!isRecord(parsed.conversation) || !isRecord(parsed.interopSnapshot)) {
    throw new TypeError("Slate agent checkpoint data is incomplete")
  }
  const conversation = parsed.conversation
  if (
    !isHexIdList(conversation.turnBlobIds) ||
    !isHexIdList(conversation.todoBlobIds) ||
    !isHexIdList(conversation.summaryArchiveBlobIds) ||
    (conversation.summaryBlobId !== undefined && !isHexId(conversation.summaryBlobId)) ||
    (conversation.summaryArchiveBlobId !== undefined && !isHexId(conversation.summaryArchiveBlobId))
  ) {
    throw new TypeError("Slate agent checkpoint references are invalid")
  }
  if (!Object.values(parsed.interopSnapshot).every(isJsonValue)) {
    throw new TypeError("Slate agent checkpoint interop snapshot is not JSON data")
  }
  return parsed as unknown as SlateAgentCheckpointV1
}
