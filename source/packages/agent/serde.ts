/**
 * How conversation data is written to storage, and read back.
 *
 * Everything the platform keeps about a conversation — turns, steps, summaries, plans, shell commands, file
 * state, the model messages themselves — is stored as bytes, and each kind is stored in the form that fits
 * it: the protocol's own messages go in as their binary encoding, and a model message goes in as JSON,
 * because it is a shape the provider libraries define rather than one the protocol does. Reading has to
 * give back exactly what was written, and two values do not survive JSON on their own: byte arrays become
 * `{__type:"Uint8Array",hex}` and 64-bit integers become strings, both of which are turned back on the way
 * in. Hex decoding has a fast path for the common case and falls back to the shared decoder for anything
 * unusual.
 *
 * A message can also be stored in its redacted form, which is a different serializer rather than a flag:
 * writing unwraps it under the one capability that always allows unwrapping — storage is where the
 * unredacted value has to exist, or nothing could be read back — and reading re-applies the privacy mode
 * it was created with. The same arrangement exists for protocol messages, so a redacted conversation and a
 * redacted message are stored and loaded by the same code path with different types.
 */

import {
  AgentConversationTurnStructure,
  ConversationPlan,
  ConversationStateStructure,
  ConversationStep,
  ConversationSummary,
  ConversationSummaryArchive,
  ConversationTurn,
  ConversationTurnStructure,
  FileState,
  ShellCommand,
  ShellOutput,
  UserMessage,
} from "../proto/generated/agent/v1/agent_pb.ts"
import { TodoItem } from "../proto/generated/agent/v1/todo_tool_pb.ts"
import {
  ProtoSerde,
  fromHex,
  toHex,
  utf8Serde,
  type BinaryMessage,
  type BinaryMessageType,
  type BlobType,
  type Serde,
} from "../agent-kv/serde.ts"
import { PrivacyCapability } from "../redaction/classification.ts"
import {
  fromRedactedCoreMessage,
  toRedactedCoreMessage,
  type CoreMessageLike,
} from "../redaction/message-redaction.ts"
import type { PrivacyMode } from "../redaction/privacy-mode.ts"

type RedactedCoreMessage = ReturnType<typeof toRedactedCoreMessage>

function encodeJsonValue(_key: string, entryValue: unknown): unknown {
  if (entryValue instanceof Uint8Array) {
    return {
      __type: "Uint8Array",
      hex: toHex(entryValue),
    }
  }
  if (typeof entryValue === "bigint") {
    return entryValue.toString()
  }
  return entryValue
}

function decodeJsonValue(_key: string, entryValue: unknown): unknown {
  if (
    entryValue && typeof entryValue === "object" &&
    (entryValue as { __type?: unknown }).__type === "Uint8Array" &&
    typeof (entryValue as { hex?: unknown }).hex === "string"
  ) {
    return fromHex((entryValue as { hex: string }).hex)
  }
  return entryValue
}

/**
 * A faster reader that walks the parsed tree instead of using a reviver. It is kept but not enabled: it
 * only pays off for messages large enough to matter, and it has to agree with the reviver exactly, which
 * is not something to turn on without a reason to.
 */
const FAST_PARSE_ENABLED = false
const ENCODED_BYTES_MARKER = '"__type":"Uint8Array"'
const HEX_ONLY_RE = /^[0-9a-f]*$/

function readHexBytes(hex: string): Uint8Array {
  const normalizedHex = hex.trim().toLowerCase()
  if (normalizedHex.length % 2 !== 0) throw new Error("Invalid hex string length")
  if (HEX_ONLY_RE.test(normalizedHex)) {
    try {
      const byteResult = new Uint8Array(normalizedHex.length / 2)
      Buffer.from(byteResult.buffer, byteResult.byteOffset, byteResult.byteLength).write(normalizedHex, "hex")
      return byteResult
    } catch {
      // Anything the fast path cannot write is left to the shared decoder below.
    }
  }
  return fromHex(normalizedHex)
}

function looksEncodedBytes(entryValue: unknown): entryValue is { __type: "Uint8Array"; hex: string } {
  return entryValue !== null && typeof entryValue === "object" &&
    (entryValue as { __type?: unknown }).__type === "Uint8Array" &&
    typeof (entryValue as { hex?: unknown }).hex === "string"
}

function restoreByteArrays(tree: unknown): unknown {
  if (Array.isArray(tree)) {
    for (let position = 0; position < tree.length; position++) {
      tree[position] = restoreByteArrays(tree[position])
    }
    return tree
  }
  if (tree !== null && typeof tree === "object") {
    const objectValue = tree as Record<string, unknown>
    for (const fieldKey of Object.keys(objectValue)) {
      objectValue[fieldKey] = restoreByteArrays(objectValue[fieldKey])
    }
    if (looksEncodedBytes(tree)) {
      return readHexBytes(tree.hex)
    }
    return tree
  }
  return tree
}

function parseBytesJson(jsonText: string): unknown {
  const parsedTree: unknown = JSON.parse(jsonText)
  // Without the marker there is nothing to revive, so the walk is skipped.
  if (jsonText.includes(ENCODED_BYTES_MARKER)) {
    return restoreByteArrays(parsedTree)
  }
  return parsedTree
}

function readCoreMessageJson(jsonText: string): CoreMessageLike {
  if (FAST_PARSE_ENABLED) {
    return parseBytesJson(jsonText) as CoreMessageLike
  }
  return JSON.parse(jsonText, decodeJsonValue) as CoreMessageLike
}

class CoreMessageSerde implements Serde<CoreMessageLike> {
  serialize(entryValue: CoreMessageLike): Uint8Array {
    const jsonText = JSON.stringify(entryValue, encodeJsonValue)
    return utf8Serde.serialize(jsonText)
  }

  deserialize(storedBytes: Uint8Array): CoreMessageLike {
    const jsonText = utf8Serde.deserialize(storedBytes)
    return readCoreMessageJson(jsonText)
  }

  getBlobType(): BlobType {
    return { kind: "json" }
  }
}

export const coreMessageSerde = new CoreMessageSerde()

class RedactedCoreMessageSerde implements Serde<RedactedCoreMessage> {
  constructor(private readonly privacySetting: PrivacyMode) {}

  serialize(entryValue: RedactedCoreMessage): Uint8Array {
    const unwrappedMessage = fromRedactedCoreMessage(entryValue, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
    const jsonText = JSON.stringify(unwrappedMessage, encodeJsonValue)
    return utf8Serde.serialize(jsonText)
  }

  deserialize(storedBytes: Uint8Array): RedactedCoreMessage {
    const jsonText = utf8Serde.deserialize(storedBytes)
    const unwrappedMessage = readCoreMessageJson(jsonText)
    return toRedactedCoreMessage(unwrappedMessage, this.privacySetting)
  }

  getBlobType(): BlobType {
    return { kind: "json" }
  }
}

export function createRedactedCoreMessageSerde(privacySetting: PrivacyMode): Serde<RedactedCoreMessage> {
  return new RedactedCoreMessageSerde(privacySetting)
}

/** The same arrangement for protocol messages: plain on disk, redacted in memory. */
class RedactedProtoSerde<Plain extends BinaryMessage, Redacted> implements Serde<Redacted> {
  constructor(
    private readonly messageType: BinaryMessageType<Plain>,
    private readonly toRedacted: (entryValue: Plain, privacySetting: PrivacyMode) => Redacted,
    private readonly fromRedacted: (entryValue: Redacted, purpose: PrivacyCapability) => Plain,
    private readonly privacySetting: PrivacyMode,
  ) {}

  serialize(entryValue: Redacted): Uint8Array {
    const wireMessage = this.fromRedacted(entryValue, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
    return wireMessage.toBinary()
  }

  deserialize(storedBytes: Uint8Array): Redacted {
    const wireMessage = this.messageType.fromBinary(storedBytes)
    return this.toRedacted(wireMessage, this.privacySetting)
  }

  getBlobType(): BlobType {
    return { kind: "proto", typeName: this.messageType.typeName }
  }
}

export function createRedactedProtoSerde<Plain extends BinaryMessage, Redacted>(
  messageType: BinaryMessageType<Plain>,
  toRedacted: (entryValue: Plain, privacySetting: PrivacyMode) => Redacted,
  fromRedacted: (entryValue: Redacted, purpose: PrivacyCapability) => Plain,
  privacySetting: PrivacyMode,
): Serde<Redacted> {
  return new RedactedProtoSerde(messageType, toRedacted, fromRedacted, privacySetting)
}

// The conversation types this module knows how to store, each as its own protocol serializer. The two a
// caller reads a whole conversation through are exported; the rest are here so the set is in one place.
const conversationTurnSerde = new ProtoSerde(ConversationTurn)
const todoItemSerde = new ProtoSerde(TodoItem)
const agentConversationTurnStructureSerde = new ProtoSerde(AgentConversationTurnStructure)
const userMessageSerde = new ProtoSerde(UserMessage)
const conversationStepSerde = new ProtoSerde(ConversationStep)
export const conversationStateStructureSerde = new ProtoSerde(ConversationStateStructure)
export const conversationTurnStructureSerde = new ProtoSerde(ConversationTurnStructure)
const conversationSummarySerde = new ProtoSerde(ConversationSummary)
const conversationSummaryArchiveSerde = new ProtoSerde(ConversationSummaryArchive)
const conversationPlanSerde = new ProtoSerde(ConversationPlan)
const shellCommandSerde = new ProtoSerde(ShellCommand)
const shellOutputSerde = new ProtoSerde(ShellOutput)
const fileStateSerde = new ProtoSerde(FileState)
