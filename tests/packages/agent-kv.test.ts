import { test } from "node:test"
import assert from "node:assert/strict"

import { createContext } from "../../source/packages/context/context.ts"
import type { Context } from "../../source/packages/context/context.ts"
import { getBlobId, InMemoryBlobStore, isBlobDurable, toUint8Array } from "../../source/packages/agent-kv/blob-store.ts"
import { BlobNotFoundError, findBlobNotFoundError } from "../../source/packages/agent-kv/blob-not-found-error.ts"
import { fromHex, ProtoSerde, toHex, utf8Serde } from "../../source/packages/agent-kv/serde.ts"
import {
  getBlobMetadataCallback,
  setBlobReadableFromCloudMirror,
  TypedBlobStore,
  unwrapBlobStore,
} from "../../source/packages/agent-kv/typed-blob-store.ts"
import { EagerReference, LazyReference } from "../../source/packages/agent-kv/references.ts"
import {
  AgentConversationStore,
  AgentMetadataSerde,
  generateBlobEncryptionKeyHex,
  getDefaultAgentMetadata,
  isValidBlobEncryptionKeyHex,
  type AgentMetadata,
  type AgentMetadataStore,
} from "../../source/packages/agent-kv/agent-conversation-store.ts"
import { resolveSubagentPersistedStates } from "../../source/packages/agent-kv/subagent-states.ts"
import {
  AgentConversationTurn,
  AgentConversationTurnStructure,
  ConversationStateStructure,
  ConversationStep,
  ConversationSummary,
  ConversationTurnStructure,
  SubagentPersistedState,
  UserMessage,
} from "../../source/packages/proto/generated/agent/v1/agent_pb.ts"
import { TodoItem } from "../../source/packages/proto/generated/agent/v1/todo_tool_pb.ts"

const ctx = createContext()

function metadataStore(initial: AgentMetadata): AgentMetadataStore {
  const values = new Map<string, unknown>(Object.entries(initial))
  const listeners = new Map<string, Set<() => void>>()
  return {
    subscribe(key, callback) {
      if (!listeners.has(key)) listeners.set(key, new Set())
      listeners.get(key)?.add(callback)
      return () => listeners.get(key)?.delete(callback)
    },
    set(key, value) {
      values.set(key, value)
      for (const listener of listeners.get(key) ?? []) listener()
      return value
    },
    get(key) {
      return values.get(key) as never
    },
  }
}

test("serdes turn values into blobs and back", () => {
  assert.equal(utf8Serde.deserialize(utf8Serde.serialize("hello")), "hello")
  assert.deepEqual(utf8Serde.getBlobType(), { kind: "string" })

  const todoSerde = new ProtoSerde(TodoItem)
  const todo = new TodoItem({ id: "1", content: "do it", status: 1 })
  assert.deepEqual(todoSerde.deserialize(todoSerde.serialize(todo)).toJson(), todo.toJson())
  assert.deepEqual(todoSerde.getBlobType(), { kind: "proto", typeName: "agent.v1.TodoItem" })

  const bytes = new Uint8Array([0, 1, 255])
  assert.deepEqual(fromHex(toHex(bytes)), bytes)
  assert.equal(toHex(new Uint8Array()), "")
  assert.throws(() => fromHex("abc"), /Invalid hex string length/)
})

test("a blob id is the hash of the bytes", async () => {
  const first = await getBlobId(new Uint8Array([1, 2, 3]))
  const again = await getBlobId(new Uint8Array([1, 2, 3]))
  const different = await getBlobId(new Uint8Array([1, 2, 4]))
  assert.equal(toHex(first), toHex(again), "the same bytes have the same address")
  assert.notEqual(toHex(first), toHex(different))
  assert.equal(first.byteLength, 32, "SHA-256")

  const source = new Uint8Array([1, 2, 3])
  const view = toUint8Array(source)
  assert.deepEqual([...view], [1, 2, 3])
  assert.equal(view.buffer, source.buffer, "an ordinary buffer is viewed, not copied")
})

test("the in-memory store keeps blobs and reports durability", async () => {
  const store = new InMemoryBlobStore()
  const id = await getBlobId(new Uint8Array([9]))
  assert.equal(await store.getBlob(ctx, id), undefined)
  await store.setBlob(ctx, id, new Uint8Array([9]))
  assert.deepEqual(await store.getBlob(ctx, id), new Uint8Array([9]))
  await store.setBlobLocallyOnly(ctx, id, new Uint8Array([9, 9]))
  assert.deepEqual(await store.getBlob(ctx, id), new Uint8Array([9, 9]))
  await store.flush(ctx)
  assert.equal(isBlobDurable(store, id), true, "a store that cannot say is assumed durable")
})

test("a missing blob produces one error that survives being wrapped", () => {
  const error = new BlobNotFoundError(["a".repeat(64)])
  assert.match(error.message, /data is missing and can't be restored/)
  assert.match(error.message, /missing blob aaaaaaaaaaaa/)
  assert.equal(error.isUsageError, true)
  assert.deepEqual(error.blobIdHexes, ["a".repeat(64)])

  const many = new BlobNotFoundError(["1".repeat(64), "2".repeat(64), "3".repeat(64), "4".repeat(64)])
  assert.match(many.message, /4 missing blobs: 111111111111, 222222222222, 333333333333, …/)

  const wrapped = new Error("outer", { cause: new Error("inner", { cause: error }) })
  assert.equal(findBlobNotFoundError(wrapped), error)
  assert.equal(findBlobNotFoundError(new Error("unrelated")), undefined)
  assert.equal(findBlobNotFoundError(undefined), undefined)
})

test("a typed blob store carries its metadata callback and unwraps", async () => {
  const inner = new InMemoryBlobStore()
  const seen: unknown[] = []
  const typed = new TypedBlobStore(inner, metadata => seen.push(metadata))
  assert.equal(getBlobMetadataCallback(inner), undefined)
  assert.equal(typeof getBlobMetadataCallback(typed), "function")
  assert.equal(unwrapBlobStore(typed), inner)
  assert.equal(unwrapBlobStore(new TypedBlobStore(typed)), inner, "unwrapping goes all the way down")

  const id = await getBlobId(new Uint8Array([7]))
  await typed.setBlob(ctx, id, new Uint8Array([7]))
  assert.deepEqual(await typed.getBlob(ctx, id), new Uint8Array([7]))
  assert.equal(typed.isBlobDurable(id), true)
  assert.deepEqual(seen, [])
})

test("writing for the cloud mirror defers replication when the store can", async () => {
  const writes: string[] = []
  const writethrough = Object.assign(new InMemoryBlobStore(), {
    setBlobAwaitingSecondary: async (_ctx: Context, blobId: Uint8Array) => {
      writes.push(`secondary:${toHex(blobId)}`)
    },
  })
  const id = await getBlobId(new Uint8Array([5]))
  await setBlobReadableFromCloudMirror({ blobStore: new TypedBlobStore(writethrough), ctx, blobId: id, blobData: new Uint8Array([5]) })
  assert.deepEqual(writes, [`secondary:${toHex(id)}`], "a store that can defer does not write eagerly")

  const plain = new InMemoryBlobStore()
  await setBlobReadableFromCloudMirror({ blobStore: plain, ctx, blobId: id, blobData: new Uint8Array([5]) })
  assert.deepEqual(await plain.getBlob(ctx, id), new Uint8Array([5]))
})

test("an eager reference writes once for an unchanged value", async () => {
  const store = new InMemoryBlobStore()
  const reference = new EagerReference(utf8Serde, store, "first")
  const firstId = await reference.writeToBlobStore(ctx)
  assert.deepEqual(await store.getBlob(ctx, firstId), utf8Serde.serialize("first"))
  assert.equal(toHex(await reference.writeToBlobStore(ctx)), toHex(firstId), "an unchanged value writes nothing new")

  reference.set("second")
  const secondId = await reference.writeToBlobStore(ctx)
  assert.notEqual(toHex(secondId), toHex(firstId))
  assert.deepEqual(await store.getBlob(ctx, secondId), utf8Serde.serialize("second"))
  assert.equal(await reference.get(ctx), "second")
})

test("a lazy reference writes nothing until it is read or changed", async () => {
  const store = new InMemoryBlobStore()
  const originalId = await getBlobId(utf8Serde.serialize("original"))
  await store.setBlob(ctx, originalId, utf8Serde.serialize("original"))

  const untouched = new LazyReference(utf8Serde, store, originalId)
  assert.equal(toHex(await untouched.writeToBlobStore(ctx)), toHex(originalId), "never read, never written")

  const read = new LazyReference(utf8Serde, store, originalId)
  assert.equal(await read.get(ctx), "original")
  assert.equal(toHex(await read.writeToBlobStore(ctx)), toHex(originalId), "read but unchanged keeps its id")

  const changed = new LazyReference(utf8Serde, store, originalId)
  await changed.get(ctx)
  changed.set("changed")
  const changedId = await changed.writeToBlobStore(ctx)
  assert.notEqual(toHex(changedId), toHex(originalId))
  assert.equal(await changed.get(ctx), "changed")
})

test("reading a lazy reference whose blob is gone reports the missing data", async () => {
  const store = new InMemoryBlobStore()
  const reference = new LazyReference(utf8Serde, store, await getBlobId(new Uint8Array([1])))
  await assert.rejects(reference.get(ctx), BlobNotFoundError)
})

test("agent metadata survives a round trip and forgives what it does not recognize", () => {
  const defaults = getDefaultAgentMetadata("agent-1")
  assert.equal(defaults.agentId, "agent-1")
  assert.equal(defaults.mode, "default")
  assert.equal(defaults.name, "New Agent")
  assert.equal(isValidBlobEncryptionKeyHex(defaults.blobEncryptionKey), true)
  assert.equal(isValidBlobEncryptionKeyHex("short"), false)
  assert.equal(isValidBlobEncryptionKeyHex(undefined), false)
  assert.notEqual(generateBlobEncryptionKeyHex(), generateBlobEncryptionKeyHex())

  const serde = new AgentMetadataSerde()
  const stored: AgentMetadata = {
    ...defaults,
    name: "Research",
    mode: "plan",
    isRunEverything: true,
    approvalMode: "auto-review",
    lastUsedModel: "some-model",
    latestRootBlobId: new Uint8Array([1, 2, 3]),
  }
  const loaded = serde.deserialize(serde.serialize(stored))
  assert.equal(loaded.name, "Research")
  assert.equal(loaded.mode, "plan")
  assert.equal(loaded.approvalMode, "auto-review")
  assert.deepEqual(loaded.latestRootBlobId, new Uint8Array([1, 2, 3]))
  assert.deepEqual(serde.getBlobType(), { kind: "json" })

  const legacy = serde.deserialize(utf8Serde.serialize(JSON.stringify({ agentId: "a", mode: "auto-run" })))
  assert.equal(legacy.mode, "default", "the old auto-run mode becomes the default one")
  assert.equal(legacy.isRunEverything, true, "and it keeps the behaviour it meant")

  const unknown = serde.deserialize(utf8Serde.serialize(JSON.stringify({ mode: "nonsense", blobEncryptionKey: "no" })))
  assert.equal(unknown.mode, "default")
  assert.equal(isValidBlobEncryptionKeyHex(unknown.blobEncryptionKey), true, "an unusable key is replaced")
})

test("checkpointing writes the structure and reloading finds it again", async () => {
  const store = new InMemoryBlobStore()
  const metadata = metadataStore(getDefaultAgentMetadata("agent-1"))
  const conversation = new AgentConversationStore(store, metadata)

  assert.equal(await conversation.tryResetFromDb(ctx), false, "a fresh agent has nothing to load")
  assert.deepEqual(conversation.getConversationStateStructure().turns, [])

  const userMessage = new UserMessage({ text: "hello" })
  const userMessageId = await getBlobId(userMessage.toBinary())
  await store.setBlob(ctx, userMessageId, userMessage.toBinary())
  const step = new ConversationStep({})
  const stepId = await getBlobId(step.toBinary())
  await store.setBlob(ctx, stepId, step.toBinary())
  const turnId = await getBlobId(new Uint8Array([9]))
  await store.setBlob(ctx, turnId, new ConversationTurnStructure({
    turn: {
      case: "agentConversationTurn",
      value: new AgentConversationTurnStructure({ userMessage: userMessageId, steps: [stepId], requestId: "req-1" }),
    },
  }).toBinary())

  const structure = new ConversationStateStructure({ turns: [turnId] })
  await conversation.handleCheckpoint(ctx, structure)
  assert.equal(toHex(conversation.getMetadata("latestRootBlobId")), toHex(await getBlobId(structure.toBinary())))
  assert.equal(await conversation.getLastRequestIdFromConversation(ctx), "req-1")

  const full = await conversation.getFullConversation(ctx)
  assert.equal(full.turns.length, 1)
  assert.equal(full.turns[0]?.turn.case, "agentConversationTurn")

  const reloaded = new AgentConversationStore(store, metadata)
  assert.equal(await reloaded.tryResetFromDb(ctx), true)
  assert.equal(reloaded.getConversationStateStructure().turns.length, 1)
  assert.equal(toHex(reloaded.getLatestCheckpoint().turns[0] as Uint8Array), toHex(turnId))
})

test("a conversation with no readable turns still returns what it has", async () => {
  const store = new InMemoryBlobStore()
  const conversation = new AgentConversationStore(store, metadataStore(getDefaultAgentMetadata()))
  const missingTurnId = await getBlobId(new Uint8Array([42]))
  const full = await conversation.deserializeConversationStateStructure(
    ctx,
    new ConversationStateStructure({ turns: [missingTurnId] }),
  )
  assert.deepEqual(full.turns, [], "a turn whose blob is gone is skipped, not fatal")
})

test("subagent states resolve from inline entries and blobs, and a lost one is fatal", async () => {
  const store = new InMemoryBlobStore()
  const inline = new SubagentPersistedState({ createdTimestampMs: 1n })
  const blobState = new SubagentPersistedState({ createdTimestampMs: 2n })
  const blobId = await getBlobId(blobState.toBinary())
  await store.setBlob(ctx, blobId, blobState.toBinary())

  const resolved = await resolveSubagentPersistedStates(ctx, new ConversationStateStructure({
    subagentStates: { "sub-inline": inline },
    subagentStateRefs: { "sub-blob": blobId },
  }), store)
  assert.equal(Object.keys(resolved).length, 2)
  assert.equal(resolved["sub-blob"]?.createdTimestampMs, 2n)

  const lostId = await getBlobId(new Uint8Array([77]))
  await assert.rejects(
    resolveSubagentPersistedStates(ctx, new ConversationStateStructure({ subagentStateRefs: { "sub-lost": lostId } }), store),
    BlobNotFoundError,
  )

  const withFallback = await resolveSubagentPersistedStates(ctx, new ConversationStateStructure({
    subagentStates: { "sub-both": inline },
    subagentStateRefs: { "sub-both": lostId },
  }), store)
  assert.equal(withFallback["sub-both"]?.createdTimestampMs, 1n, "the inline copy is used when the blob is gone")
})
