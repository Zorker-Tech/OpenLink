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

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return {
      __type: "Uint8Array",
      hex: toHex(value),
    }
  }
  if (typeof value === "bigint") {
    return value.toString()
  }
  return value
}

function jsonReviver(_key: string, value: unknown): unknown {
  if (
    value && typeof value === "object" &&
    (value as { __type?: unknown }).__type === "Uint8Array" &&
    typeof (value as { hex?: unknown }).hex === "string"
  ) {
    return fromHex((value as { hex: string }).hex)
  }
  return value
}

/**
 * A faster reader that walks the parsed tree instead of using a reviver. It is kept but not enabled: it
 * only pays off for messages large enough to matter, and it has to agree with the reviver exactly, which
 * is not something to turn on without a reason to.
 */
const FAST_CORE_MESSAGE_PARSE = false
const UINT8ARRAY_MARKER = '"__type":"Uint8Array"'
const STRICT_HEX_RE = /^[0-9a-f]*$/

function decodeHex(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase()
  if (clean.length % 2 !== 0) throw new Error("Invalid hex string length")
  if (STRICT_HEX_RE.test(clean)) {
    try {
      const out = new Uint8Array(clean.length / 2)
      Buffer.from(out.buffer, out.byteOffset, out.byteLength).write(clean, "hex")
      return out
    } catch {
      // Anything the fast path cannot write is left to the shared decoder below.
    }
  }
  return fromHex(clean)
}

function isEncodedUint8Array(value: unknown): value is { __type: "Uint8Array"; hex: string } {
  return value !== null && typeof value === "object" &&
    (value as { __type?: unknown }).__type === "Uint8Array" &&
    typeof (value as { hex?: unknown }).hex === "string"
}

function reviveUint8ArraysInPlace(node: unknown): unknown {
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index++) {
      node[index] = reviveUint8ArraysInPlace(node[index])
    }
    return node
  }
  if (node !== null && typeof node === "object") {
    const record = node as Record<string, unknown>
    for (const key of Object.keys(record)) {
      record[key] = reviveUint8ArraysInPlace(record[key])
    }
    if (isEncodedUint8Array(node)) {
      return decodeHex(node.hex)
    }
    return node
  }
  return node
}

function parseWithUint8Arrays(json: string): unknown {
  const parsed: unknown = JSON.parse(json)
  // Without the marker there is nothing to revive, so the walk is skipped.
  if (json.includes(UINT8ARRAY_MARKER)) {
    return reviveUint8ArraysInPlace(parsed)
  }
  return parsed
}

function parseCoreMessageJson(json: string): CoreMessageLike {
  if (FAST_CORE_MESSAGE_PARSE) {
    return parseWithUint8Arrays(json) as CoreMessageLike
  }
  return JSON.parse(json, jsonReviver) as CoreMessageLike
}

class CoreMessageSerde implements Serde<CoreMessageLike> {
  serialize(value: CoreMessageLike): Uint8Array {
    const json = JSON.stringify(value, jsonReplacer)
    return utf8Serde.serialize(json)
  }

  deserialize(blob: Uint8Array): CoreMessageLike {
    const json = utf8Serde.deserialize(blob)
    return parseCoreMessageJson(json)
  }

  getBlobType(): BlobType {
    return { kind: "json" }
  }
}

export const coreMessageSerde = new CoreMessageSerde()

class RedactedCoreMessageSerde implements Serde<RedactedCoreMessage> {
  constructor(private readonly privacyMode: PrivacyMode) {}

  serialize(value: RedactedCoreMessage): Uint8Array {
    const plainMessage = fromRedactedCoreMessage(value, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
    const json = JSON.stringify(plainMessage, jsonReplacer)
    return utf8Serde.serialize(json)
  }

  deserialize(blob: Uint8Array): RedactedCoreMessage {
    const json = utf8Serde.deserialize(blob)
    const plainMessage = parseCoreMessageJson(json)
    return toRedactedCoreMessage(plainMessage, this.privacyMode)
  }

  getBlobType(): BlobType {
    return { kind: "json" }
  }
}

export function createRedactedCoreMessageSerde(privacyMode: PrivacyMode): Serde<RedactedCoreMessage> {
  return new RedactedCoreMessageSerde(privacyMode)
}

/** The same arrangement for protocol messages: plain on disk, redacted in memory. */
class RedactedProtoSerde<Plain extends BinaryMessage, Redacted> implements Serde<Redacted> {
  constructor(
    private readonly protoType: BinaryMessageType<Plain>,
    private readonly toRedacted: (value: Plain, privacyMode: PrivacyMode) => Redacted,
    private readonly fromRedacted: (value: Redacted, purpose: PrivacyCapability) => Plain,
    private readonly privacyMode: PrivacyMode,
  ) {}

  serialize(value: Redacted): Uint8Array {
    const plainProto = this.fromRedacted(value, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
    return plainProto.toBinary()
  }

  deserialize(blob: Uint8Array): Redacted {
    const plainProto = this.protoType.fromBinary(blob)
    return this.toRedacted(plainProto, this.privacyMode)
  }

  getBlobType(): BlobType {
    return { kind: "proto", typeName: this.protoType.typeName }
  }
}

export function createRedactedProtoSerde<Plain extends BinaryMessage, Redacted>(
  protoType: BinaryMessageType<Plain>,
  toRedacted: (value: Plain, privacyMode: PrivacyMode) => Redacted,
  fromRedacted: (value: Redacted, purpose: PrivacyCapability) => Plain,
  privacyMode: PrivacyMode,
): Serde<Redacted> {
  return new RedactedProtoSerde(protoType, toRedacted, fromRedacted, privacyMode)
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
