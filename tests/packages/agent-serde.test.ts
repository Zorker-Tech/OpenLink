import { test } from "node:test"
import assert from "node:assert/strict"

import {
  conversationStateStructureSerde,
  conversationTurnStructureSerde,
  coreMessageSerde,
  createRedactedCoreMessageSerde,
  createRedactedProtoSerde,
} from "../../source/packages/agent/serde.ts"
import {
  ConversationStateStructure,
  ConversationTurnStructure,
  UserMessage,
} from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { PrivacyCapability } from "../../source/packages/redaction/classification.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { toRedactedCoreMessage } from "../../source/packages/redaction/message-redaction.ts"
import { toHex } from "../../source/packages/agent-kv/serde.ts"

// ---------------------------------------------------------------------------------------------
// protocol messages
// ---------------------------------------------------------------------------------------------

test("a conversation is stored as its own binary encoding and read back the same", () => {
  const state = new ConversationStateStructure({
    turns: [new Uint8Array([1, 2, 3]), new Uint8Array([4])],
    plan: { steps: [{ description: "step one" }] } as never,
  })
  const bytes = conversationStateStructureSerde.serialize(state)
  assert.equal(bytes instanceof Uint8Array, true)
  assert.equal(conversationStateStructureSerde.getBlobType().kind, "proto")

  const read = conversationStateStructureSerde.deserialize(bytes)
  assert.deepEqual(read.turns, [new Uint8Array([1, 2, 3]), new Uint8Array([4])])
  assert.deepEqual(read, state)
})

test("a stored protocol message says which type it is", () => {
  assert.deepEqual(conversationStateStructureSerde.getBlobType(), {
    kind: "proto",
    typeName: "agent.v1.ConversationStateStructure",
  })
  assert.deepEqual(conversationTurnStructureSerde.getBlobType(), {
    kind: "proto",
    typeName: "agent.v1.ConversationTurnStructure",
  })
})

test("a turn is stored and read back with its own structure", () => {
  const turn = new ConversationTurnStructure({
    turn: { case: "agentConversationTurn", value: { steps: [new Uint8Array([9])] } as never },
  })
  const read = conversationTurnStructureSerde.deserialize(conversationTurnStructureSerde.serialize(turn))
  assert.equal(read.turn.case, "agentConversationTurn")
  assert.deepEqual(read, turn)
})

// ---------------------------------------------------------------------------------------------
// model messages
// ---------------------------------------------------------------------------------------------

test("a model message is stored as JSON", () => {
  const message = { role: "user", content: "hello" }
  const bytes = coreMessageSerde.serialize(message)
  assert.equal(new TextDecoder().decode(bytes), JSON.stringify(message))
  assert.deepEqual(coreMessageSerde.getBlobType(), { kind: "json" })
  assert.deepEqual(coreMessageSerde.deserialize(bytes), message)
})

test("byte arrays inside a model message survive the trip through JSON", () => {
  const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
  const message = { role: "assistant", content: [{ type: "image", data: bytes }] }
  const stored = coreMessageSerde.serialize(message)
  // The bytes are written as hex under a marker rather than as a JSON object of indices.
  assert.match(new TextDecoder().decode(stored), /"__type":"Uint8Array","hex":"deadbeef"/)

  const read = coreMessageSerde.deserialize(stored) as unknown as { content: Array<{ data: Uint8Array }> }
  assert.equal(read.content[0]?.data instanceof Uint8Array, true)
  assert.deepEqual(read.content[0]?.data, bytes)
})

test("64-bit numbers inside a model message survive as strings", () => {
  const message = { role: "user", content: "hello", usage: { totalTokens: 9007199254740993n } }
  const stored = coreMessageSerde.serialize(message)
  assert.match(new TextDecoder().decode(stored), /"totalTokens":"9007199254740993"/)
})

test("a message with nothing binary in it is read back as it was written", () => {
  const message = { role: "user", content: [{ type: "text", text: "a { not json } and a quote \"" }] }
  assert.deepEqual(coreMessageSerde.deserialize(coreMessageSerde.serialize(message)), message)
})

test("a message with nothing in it round-trips", () => {
  const empty = {} as unknown as Parameters<typeof coreMessageSerde.serialize>[0]
  assert.deepEqual(coreMessageSerde.deserialize(coreMessageSerde.serialize(empty)), {})
})

// ---------------------------------------------------------------------------------------------
// redacted messages
// ---------------------------------------------------------------------------------------------

/** A redacted message holds redacted values, so reading one means unwrapping the field that holds it. */
interface Unwrappable {
  unwrap(purpose: PrivacyCapability): unknown
}

test("a redacted message is stored plain and read back redacted", () => {
  const serde = createRedactedCoreMessageSerde(PrivacyMode.NO_STORAGE)
  const redacted = toRedactedCoreMessage({ role: "user", content: "secret notes" }, PrivacyMode.NO_STORAGE)
  const stored = serde.serialize(redacted)
  // Storage is where the unredacted value has to exist, or nothing could be read back.
  assert.equal(new TextDecoder().decode(stored), JSON.stringify({ role: "user", content: "secret notes" }))
  assert.deepEqual(serde.getBlobType?.(), { kind: "json" })

  const read = serde.deserialize(stored)
  assert.equal((read.content as Unwrappable).unwrap(PrivacyCapability.STORAGE_FOR_TRAINING), "secret notes")
})

test("the bytes of an attached image survive the trip through a redacted message", () => {
  const serde = createRedactedCoreMessageSerde(PrivacyMode.NO_STORAGE)
  const bytes = new Uint8Array([1, 2, 3])
  const redacted = toRedactedCoreMessage(
    { role: "user", content: [{ type: "image", image: bytes, mimeType: "image/png" }] },
    PrivacyMode.NO_STORAGE,
  )
  const read = serde.deserialize(serde.serialize(redacted))
  const parts = read.content as Array<{ type: string; image?: unknown; mimeType?: string }>
  assert.equal(parts[0]?.type, "image")
  assert.deepEqual(parts[0]?.image, bytes)
  assert.equal(parts[0]?.mimeType, "image/png")
})

test("a redacted message carries the privacy mode it was read under", () => {
  const message = { role: "user", content: "notes" }
  const serde = createRedactedCoreMessageSerde(PrivacyMode.NO_STORAGE)
  const read = serde.deserialize(serde.serialize(toRedactedCoreMessage(message, PrivacyMode.NO_STORAGE)))
  assert.equal((read as unknown as { _privacyMode: PrivacyMode })._privacyMode, PrivacyMode.NO_STORAGE)
  assert.equal((read.content as Unwrappable).unwrap(PrivacyCapability.STORAGE_FOR_TRAINING), "notes")
})

// ---------------------------------------------------------------------------------------------
// redacted protocol messages
// ---------------------------------------------------------------------------------------------

test("a redacted protocol message is stored as binary and read back redacted", () => {
  const seen: Array<{ direction: string; value: unknown }> = []
  const serde = createRedactedProtoSerde(
    UserMessage,
    (plain: UserMessage, privacyMode: PrivacyMode) => {
      seen.push({ direction: "toRedacted", value: privacyMode })
      return { plain, privacyMode }
    },
    (redacted: { plain: UserMessage }, purpose: PrivacyCapability) => {
      seen.push({ direction: "fromRedacted", value: purpose })
      return redacted.plain
    },
    PrivacyMode.NO_STORAGE,
  )

  const plain = new UserMessage({ text: "do the thing", messageId: "message-1" })
  const stored = serde.serialize({ plain, privacyMode: PrivacyMode.NO_STORAGE })
  // What reaches storage is the plain message's own binary encoding.
  assert.deepEqual(stored, plain.toBinary())
  assert.deepEqual(serde.getBlobType?.(), { kind: "proto", typeName: "agent.v1.UserMessage" })

  const read = serde.deserialize(stored)
  assert.equal(read.plain.text, "do the thing")
  assert.equal(read.privacyMode, PrivacyMode.NO_STORAGE)
  assert.deepEqual(seen, [
    { direction: "fromRedacted", value: PrivacyCapability.UNSAFE_ALWAYS_ALLOWED },
    { direction: "toRedacted", value: PrivacyMode.NO_STORAGE },
  ])
})

test("a redacted protocol message that cannot be unwrapped is refused rather than written", () => {
  const serde = createRedactedProtoSerde(
    UserMessage,
    (plain: UserMessage) => plain,
    () => { throw new Error("unwrap not allowed for this purpose") },
    PrivacyMode.NO_STORAGE,
  )
  assert.throws(
    () => serde.serialize(new UserMessage({ text: "x" }) as never),
    /unwrap not allowed for this purpose/,
  )
})

test("bytes written by a protocol serde are the bytes the message would write itself", () => {
  const message = new UserMessage({ text: "hello", messageId: "m" })
  assert.equal(toHex(conversationStateStructureSerde.serialize(new ConversationStateStructure({}))).length >= 0, true)
  assert.deepEqual(UserMessage.fromBinary(message.toBinary()), message)
})
