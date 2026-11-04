import { test } from "node:test"
import assert from "node:assert/strict"

import { createContext } from "../../source/packages/context/context.ts"
import type { Context } from "../../source/packages/context/context.ts"
import { getBlobId, InMemoryBlobStore, isBlobDurable, toUint8Array } from "../../source/packages/agent-kv/blob-store.ts"
import { BlobNotFoundError, findBlobNotFoundError } from "../../source/packages/agent-kv/blob-not-found-error.ts"
import { fromHex, toHex, utf8Serde, type Serde } from "../../source/packages/agent-kv/serde.ts"
import { serializeSlateAgentCheckpoint } from "../../source/packages/agent-kv/agent-checkpoint-schema.ts"
import { ProtobufBlobSerde } from "../../source/adapters/interop/agent/protobuf-blob-serde-adapter.ts"
import { createSlateAgentConversationCodec } from "../../source/adapters/interop/agent/agent-conversation-protobuf-adapter.ts"
import {
  createSlateConversationStepSerde,
} from "../../source/adapters/interop/agent/agent-state-message-serdes-adapter.ts"
import {
  metadataObserverForStore,
  ensureBlobVisibleToCloudMirror,
  ObservedBlobStore,
  underlyingBlobStore,
} from "../../source/packages/agent-kv/typed-blob-store.ts"
import { EagerReference, LazyReference, Writeable } from "../../source/packages/agent-kv/references.ts"
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
  ConversationTokenDetails,
  ConversationStateStructure,
  ConversationStep,
  ConversationSummary,
  ConversationTurnStructure,
  SubagentPersistedState,
  UserMessage,
} from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { TodoItem } from "../../source/adapters/interop/proto/generated/agent/v1/todo_tool_pb.ts"
import { createRedactedString } from "../../source/packages/redaction/create.ts"
import { DataClassification } from "../../source/packages/redaction/classification.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { createSlateAssistantMessageStep } from "../../source/packages/agent/conversation-step-state.ts"

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

  const todoSerde = new ProtobufBlobSerde(TodoItem)
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

test("a shared byte view is copied before it leaves the current thread", () => {
  if (typeof SharedArrayBuffer === "undefined") return
  const shared = new Uint8Array(new SharedArrayBuffer(3))
  shared.set([1, 2, 3])

  const local = toUint8Array(shared)
  assert.notEqual(local.buffer, shared.buffer)
  shared[0] = 9
  assert.deepEqual([...local], [1, 2, 3])
})

test("a blob id is based on a snapshot of the caller's bytes", async () => {
  const source = new Uint8Array([4, 5, 6])
  const pendingId = getBlobId(source)
  source.fill(0)

  assert.deepEqual(await pendingId, await getBlobId(new Uint8Array([4, 5, 6])))
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
  const missingId = "a".repeat(64)
  const error = new BlobNotFoundError([missingId])
  assert.match(error.message, /required data is absent/)
  assert.match(error.message, /missing blob aaaaaaaaaaaa/)
  assert.equal(error.isUsageError, true)
  assert.deepEqual(error.blobIdHexes, [missingId])

  const many = new BlobNotFoundError(["1".repeat(64), "2".repeat(64), "3".repeat(64), "4".repeat(64)])
  assert.match(many.message, /4 blobs missing: 111111111111, 222222222222, 333333333333, …/)

  const wrapped = new Error("outer", { cause: new Error("inner", { cause: error }) })
  assert.equal(findBlobNotFoundError(wrapped), error)
  assert.equal(findBlobNotFoundError(new Error("unrelated")), undefined)
  assert.equal(findBlobNotFoundError(undefined), undefined)

  const marked = Object.assign(new Error("compatibility marker"), { isBlobNotFound: true })
  assert.equal(findBlobNotFoundError(marked), marked)
  const named = new Error("legacy name")
  named.name = "BlobNotFoundError"
  assert.equal(findBlobNotFoundError(new Error("wrapper", { cause: named })), named)
})

test("a typed blob store carries its metadata callback and unwraps", async () => {
  const inner = new InMemoryBlobStore()
  const seen: unknown[] = []
  const typed = new ObservedBlobStore(inner, metadata => seen.push(metadata))
  assert.equal(metadataObserverForStore(inner), undefined)
  assert.equal(typeof metadataObserverForStore(typed), "function")
  assert.equal(underlyingBlobStore(typed), inner)
  assert.equal(underlyingBlobStore(new ObservedBlobStore(typed)), inner, "unwrapping goes all the way down")

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
  await ensureBlobVisibleToCloudMirror({ blobStore: new ObservedBlobStore(writethrough), ctx, blobId: id, blobData: new Uint8Array([5]) })
  assert.deepEqual(writes, [`secondary:${toHex(id)}`], "a store that can defer does not write eagerly")

  const plain = new InMemoryBlobStore()
  await ensureBlobVisibleToCloudMirror({ blobStore: plain, ctx, blobId: id, blobData: new Uint8Array([5]) })
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

test("eager and lazy references restore cached bytes when storage loses durability", async () => {
  function durabilityAwareStore() {
    const inner = new InMemoryBlobStore()
    const notDurable = new Set<string>()
    return {
      getBlob: (context: Context, id: Uint8Array) => inner.getBlob(context, id),
      setBlob: async (context: Context, id: Uint8Array, bytes: Uint8Array) => {
        notDurable.delete(toHex(id))
        await inner.setBlob(context, id, bytes)
      },
      setBlobLocallyOnly: async (context: Context, id: Uint8Array, bytes: Uint8Array) => {
        notDurable.add(toHex(id))
        await inner.setBlob(context, id, bytes)
      },
      flush: (context: Context) => inner.flush(context),
      isBlobDurable: (id: Uint8Array) => !notDurable.has(toHex(id)),
    }
  }

  const eagerStore = durabilityAwareStore()
  const eager = new EagerReference(utf8Serde, eagerStore, "cached")
  const eagerId = await eager.writeToBlobStore(ctx)
  await eagerStore.setBlobLocallyOnly(ctx, eagerId, new Uint8Array([0]))
  assert.equal(isBlobDurable(eagerStore, eagerId), false)
  await eager.writeToBlobStore(ctx)
  assert.deepEqual(await eagerStore.getBlob(ctx, eagerId), utf8Serde.serialize("cached"))
  assert.equal(isBlobDurable(eagerStore, eagerId), true)

  const lazyStore = durabilityAwareStore()
  const lazyId = await getBlobId(utf8Serde.serialize("cached"))
  await lazyStore.setBlob(ctx, lazyId, utf8Serde.serialize("cached"))
  const lazy = new LazyReference(utf8Serde, lazyStore, lazyId)
  assert.equal(await lazy.get(ctx), "cached")
  await lazyStore.setBlobLocallyOnly(ctx, lazyId, new Uint8Array([0]))
  assert.equal(isBlobDurable(lazyStore, lazyId), false)
  await lazy.writeToBlobStore(ctx)
  assert.deepEqual(await lazyStore.getBlob(ctx, lazyId), utf8Serde.serialize("cached"))
  assert.equal(isBlobDurable(lazyStore, lazyId), true)
})

test("references delegate serialization to values that own their blob writing", async () => {
  const calls: Context[] = []
  const delegatedId = new Uint8Array([9, 8, 7])
  class DelegatedValue extends Writeable<Context> {
    async writeToBlobStore(context: Context): Promise<Uint8Array> {
      calls.push(context)
      return delegatedId
    }
  }
  const serde: Serde<DelegatedValue> = {
    serialize: () => { throw new Error("the reference must delegate") },
    deserialize: () => new DelegatedValue(),
    getBlobType: () => ({ kind: "string" }),
  }
  const store = new InMemoryBlobStore()

  const eager = new EagerReference(serde, store, new DelegatedValue())
  assert.equal(await eager.writeToBlobStore(ctx), delegatedId)
  const sourceId = await getBlobId(new Uint8Array([1]))
  const lazy = new LazyReference(serde, store, sourceId)
  lazy.set(new DelegatedValue())
  assert.equal(await lazy.writeToBlobStore(ctx), delegatedId)
  assert.deepEqual(calls, [ctx, ctx])
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
  const conversation = new AgentConversationStore(store, metadata, { codec: createSlateAgentConversationCodec<unknown>() })

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
  const emptyTurnBytes = new ConversationTurnStructure().toBinary()
  const emptyTurnId = await getBlobId(emptyTurnBytes)
  await store.setBlob(ctx, emptyTurnId, emptyTurnBytes)

  const structure = new ConversationStateStructure({ turns: [turnId, emptyTurnId] })
  await conversation.handleCheckpoint(ctx, structure)
  const persistedRoot = await store.getBlob(ctx, conversation.getMetadata("latestRootBlobId"))
  assert.ok(persistedRoot)
  assert.equal(toHex(conversation.getMetadata("latestRootBlobId")), toHex(await getBlobId(persistedRoot)))
  assert.equal(await conversation.getLastRequestIdFromConversation(ctx), "req-1")

  const full = await conversation.getFullConversation(ctx)
  assert.equal(full.turns.length, 1)
  assert.equal(full.turns[0]?.turn.case, "agentConversationTurn")

  const reloaded = new AgentConversationStore(store, metadata, { codec: createSlateAgentConversationCodec<unknown>() })
  assert.equal(await reloaded.tryResetFromDb(ctx), true)
  assert.equal(reloaded.getConversationStateStructure().turns.length, 2)
  assert.equal(toHex(reloaded.getLatestCheckpoint().turns[0] as Uint8Array), toHex(turnId))
})

test("full conversation hydration reads Slate step blobs through the compatibility boundary", async () => {
  const store = new InMemoryBlobStore()
  const metadata = metadataStore(getDefaultAgentMetadata("agent-slate-step"))
  const conversation = new AgentConversationStore(store, metadata, {
    codec: createSlateAgentConversationCodec<unknown>(),
  })

  const userMessage = new UserMessage({ text: "hello" })
  const userMessageBytes = userMessage.toBinary()
  const userMessageId = await getBlobId(userMessageBytes)
  await store.setBlob(ctx, userMessageId, userMessageBytes)

  const slateStep = createSlateAssistantMessageStep(createRedactedString(
    "Slate step restored",
    DataClassification.CODE,
    "text",
    PrivacyMode.NO_STORAGE,
  ))
  const stepBytes = createSlateConversationStepSerde(PrivacyMode.NO_STORAGE).serialize(slateStep)
  assert.ok(new TextDecoder().decode(stepBytes).startsWith("SLATE-AGENT-STEP\n"))
  const stepId = await getBlobId(stepBytes)
  await store.setBlob(ctx, stepId, stepBytes)

  const turn = new ConversationTurnStructure({
    turn: {
      case: "agentConversationTurn",
      value: new AgentConversationTurnStructure({ userMessage: userMessageId, steps: [stepId] }),
    },
  })
  const turnBytes = turn.toBinary()
  const turnId = await getBlobId(turnBytes)
  await store.setBlob(ctx, turnId, turnBytes)
  await conversation.handleCheckpoint(ctx, new ConversationStateStructure({ turns: [turnId] }))

  const full = await conversation.getFullConversation(ctx)
  const loadedTurn = full.turns[0]?.turn
  assert.equal(loadedTurn?.case, "agentConversationTurn")
  if (loadedTurn?.case !== "agentConversationTurn") assert.fail("expected the stored agent turn")
  const loadedStep = loadedTurn.value.steps[0]
  assert.equal(loadedStep?.message.case, "assistantMessage")
  if (loadedStep?.message.case !== "assistantMessage") assert.fail("expected the stored assistant step")
  assert.equal(loadedStep.message.value.text, "Slate step restored")
})

test("checkpoint roots use Slate's versioned envelope and preserve the complete runtime snapshot", async () => {
  const blobStore = new InMemoryBlobStore()
  const metadata = metadataStore(getDefaultAgentMetadata("agent-versioned"))
  const conversation = new AgentConversationStore(blobStore, metadata, {
    codec: createSlateAgentConversationCodec<unknown>(),
  })
  const checkpoint = new ConversationStateStructure({
    rootPromptMessagesJson: [new Uint8Array([1, 2])],
    todos: [new Uint8Array([3, 4])],
    pendingToolCalls: ["call-1"],
    tokenDetails: { usedTokens: 12, maxTokens: 100 },
    summary: new Uint8Array([5]),
    plan: new Uint8Array([6]),
    turns: [new Uint8Array([7, 8])],
    previousWorkspaceUris: ["file:///workspace"],
    summaryArchive: new Uint8Array([9]),
    fileStates: { "src/main.ts": new Uint8Array([10]) },
    summaryArchives: [new Uint8Array([11])],
    selfSummaryCount: 2,
    readPaths: ["src/main.ts"],
    activeBranchName: "main",
    agentType: "assistant",
    subagentThreads: { "tool-1": "thread-1" },
    communicateUpdateFinalSummary: "completed",
    conversationStartedTimestampMs: 123n,
    conversationStartedTimeZone: "Asia/Shanghai",
    communicateUpdateCompletedSubtitle: "done",
    subagentStateRefs: { "child-1": new Uint8Array([12]) },
    isRootProjectConversation: true,
    completedAskQuestionToolCallIds: ["question-1"],
  })

  await conversation.handleCheckpoint(ctx, checkpoint)
  const rootBlobId = conversation.getMetadata("latestRootBlobId")
  const rootBytes = await blobStore.getBlob(ctx, rootBlobId)
  assert.ok(rootBytes)
  const rootText = new TextDecoder().decode(rootBytes)
  const header = "SLATE-AGENT-CHECKPOINT\n"
  assert.ok(rootText.startsWith(header), "new roots use Slate's checkpoint envelope")
  const envelope = JSON.parse(rootText.slice(header.length)) as {
    format: string
    version: number
    conversation: Record<string, unknown>
  }
  assert.equal(envelope.format, "slate.agent-conversation-checkpoint")
  assert.equal(envelope.version, 2)
  assert.equal("interopSnapshot" in envelope, false)
  assert.deepEqual(envelope.conversation.promptMessageBlobIds, ["0102"])
  assert.deepEqual(envelope.conversation.todoBlobIds, ["0304"])
  assert.deepEqual(envelope.conversation.turnBlobIds, ["0708"])
  assert.deepEqual(envelope.conversation.summaryBlobId, "05")
  assert.deepEqual(envelope.conversation.activePlanBlobId, "06")
  assert.deepEqual(envelope.conversation.summaryArchiveBlobId, "09")
  assert.deepEqual(envelope.conversation.summaryArchiveBlobIds, ["0b"])
  assert.deepEqual(envelope.conversation.pendingOperationIds, ["call-1"])
  assert.deepEqual(envelope.conversation.tokenUsage, { usedTokens: 12, maximumTokens: 100 })
  assert.deepEqual(envelope.conversation.workspaceUris, ["file:///workspace"])
  assert.deepEqual(envelope.conversation.legacyFileContentBlobIds, { "src/main.ts": "0a" })
  assert.deepEqual(envelope.conversation.subagentThreads, { "tool-1": "thread-1" })
  assert.deepEqual(envelope.conversation.subagentStateBlobIds, { "child-1": "0c" })
  assert.equal(envelope.conversation.activeBranchName, "main")
  assert.equal(envelope.conversation.agentKind, "assistant")
  assert.equal(envelope.conversation.conversationStartedAtMs, "123")
  assert.deepEqual(envelope.conversation.completedQuestionCallIds, ["question-1"])
  assert.deepEqual(await getBlobId(rootBytes), rootBlobId)

  const reloaded = new AgentConversationStore(blobStore, metadata, {
    codec: createSlateAgentConversationCodec<unknown>(),
  })
  assert.equal(await reloaded.tryResetFromDb(ctx), true)
  assert.deepEqual(reloaded.getConversationStateStructure().toJson(), checkpoint.toJson())
})

test("legacy protobuf checkpoint roots load and migrate on the next write", async () => {
  const blobStore = new InMemoryBlobStore()
  const legacyCheckpoint = new ConversationStateStructure({
    turns: [new Uint8Array([1, 2, 3])],
    todos: [new Uint8Array([4, 5])],
    summaryArchives: [new Uint8Array([6])],
    activeBranchName: "legacy-branch",
    conversationStartedTimestampMs: 456n,
  })
  const legacyBytes = legacyCheckpoint.toBinary()
  const legacyBlobId = await getBlobId(legacyBytes)
  const initialMetadata = getDefaultAgentMetadata("agent-legacy")
  initialMetadata.latestRootBlobId = legacyBlobId
  const metadata = metadataStore(initialMetadata)
  await blobStore.setBlob(ctx, legacyBlobId, legacyBytes)

  const conversation = new AgentConversationStore(blobStore, metadata, {
    codec: createSlateAgentConversationCodec<unknown>(),
  })
  assert.equal(await conversation.tryResetFromDb(ctx), true, "legacy protobuf roots stay readable")
  assert.deepEqual(conversation.getConversationStateStructure().toJson(), legacyCheckpoint.toJson())

  await conversation.handleCheckpoint(ctx, conversation.getConversationStateStructure())
  const migratedBytes = await blobStore.getBlob(ctx, conversation.getMetadata("latestRootBlobId"))
  assert.ok(migratedBytes)
  assert.ok(new TextDecoder().decode(migratedBytes).startsWith("SLATE-AGENT-CHECKPOINT\n"))
  assert.equal(JSON.parse(new TextDecoder().decode(migratedBytes).slice("SLATE-AGENT-CHECKPOINT\n".length)).version, 2)
})

test("version 1 Slate roots import their old snapshot fields and migrate to the owned schema", async () => {
  const blobStore = new InMemoryBlobStore()
  const legacyCheckpoint = new ConversationStateStructure({
    turns: [new Uint8Array([8, 9])],
    todos: [new Uint8Array([10])],
    activeBranchName: "version-one",
    readPaths: ["/repo/ exact.ts "],
  })
  const interopSnapshot = { ...(legacyCheckpoint.toJson() as Record<string, unknown>) }
  delete interopSnapshot.turns
  delete interopSnapshot.todos
  delete interopSnapshot.summary
  delete interopSnapshot.summaryArchive
  delete interopSnapshot.summaryArchives
  const legacyBytes = serializeSlateAgentCheckpoint({
    turnBlobIds: ["0809"],
    todoBlobIds: ["0a"],
    summaryArchiveBlobIds: [],
  }, interopSnapshot as never)
  const legacyBlobId = await getBlobId(legacyBytes)
  const initialMetadata = getDefaultAgentMetadata("agent-version-one")
  initialMetadata.latestRootBlobId = legacyBlobId
  const metadata = metadataStore(initialMetadata)
  await blobStore.setBlob(ctx, legacyBlobId, legacyBytes)

  const conversation = new AgentConversationStore(blobStore, metadata, {
    codec: createSlateAgentConversationCodec<unknown>(),
  })
  assert.equal(await conversation.tryResetFromDb(ctx), true)
  assert.deepEqual(conversation.getConversationStateStructure().toJson(), legacyCheckpoint.toJson())

  await conversation.handleCheckpoint(ctx, conversation.getConversationStateStructure())
  const migrated = await blobStore.getBlob(ctx, conversation.getMetadata("latestRootBlobId"))
  assert.ok(migrated)
  const envelope = JSON.parse(new TextDecoder().decode(migrated).slice("SLATE-AGENT-CHECKPOINT\n".length))
  assert.equal(envelope.version, 2)
  assert.equal("interopSnapshot" in envelope, false)
  assert.deepEqual(envelope.conversation.turnBlobIds, ["0809"])
  assert.deepEqual(envelope.conversation.todoBlobIds, ["0a"])
  assert.deepEqual(envelope.conversation.readPaths, ["/repo/ exact.ts "])
})

test("unknown root and nested protobuf fields survive a Slate checkpoint write", async () => {
  function appendUnknownVarint(bytes: Uint8Array): Uint8Array {
    const result = new Uint8Array(bytes.length + 3)
    result.set(bytes)
    result.set([0xa0, 0x06, 0x07], bytes.length)
    return result
  }

  const tokenDetails = ConversationTokenDetails.fromBinary(
    appendUnknownVarint(new ConversationTokenDetails({ usedTokens: 12, maxTokens: 100 }).toBinary()),
  )
  const checkpoint = ConversationStateStructure.fromBinary(
    appendUnknownVarint(new ConversationStateStructure({
      turns: [new Uint8Array([1, 2, 3])],
      tokenDetails,
    }).toBinary()),
  )
  const rootUnknownFields = ConversationStateStructure.runtime.bin.listUnknownFields(checkpoint)
  const nestedUnknownFields = ConversationStateStructure.runtime.bin.listUnknownFields(checkpoint.tokenDetails!)
  assert.equal(rootUnknownFields.length, 1)
  assert.equal(nestedUnknownFields.length, 1)

  const blobStore = new InMemoryBlobStore()
  const metadata = metadataStore(getDefaultAgentMetadata("agent-unknown-fields"))
  const conversation = new AgentConversationStore(blobStore, metadata, {
    codec: createSlateAgentConversationCodec<unknown>(),
  })
  await conversation.handleCheckpoint(ctx, checkpoint)

  const reloaded = new AgentConversationStore(blobStore, metadata, {
    codec: createSlateAgentConversationCodec<unknown>(),
  })
  assert.equal(await reloaded.tryResetFromDb(ctx), true)
  const restored = reloaded.getConversationStateStructure()
  assert.deepEqual(restored.toJson(), checkpoint.toJson())
  assert.deepEqual(
    ConversationStateStructure.runtime.bin.listUnknownFields(restored),
    rootUnknownFields,
  )
  assert.deepEqual(
    ConversationStateStructure.runtime.bin.listUnknownFields(restored.tokenDetails!),
    nestedUnknownFields,
  )
})

test("an unsupported Slate checkpoint version is not decoded as an empty legacy root", async () => {
  const blobStore = new InMemoryBlobStore()
  const bytes = new TextEncoder().encode("SLATE-AGENT-CHECKPOINT\n" + JSON.stringify({
    format: "slate.agent-conversation-checkpoint",
    version: 3,
    conversation: {},
  }))
  const rootBlobId = await getBlobId(bytes)
  const initialMetadata = getDefaultAgentMetadata("agent-future-version")
  initialMetadata.latestRootBlobId = rootBlobId
  const metadata = metadataStore(initialMetadata)
  await blobStore.setBlob(ctx, rootBlobId, bytes)

  const conversation = new AgentConversationStore(blobStore, metadata, {
    codec: createSlateAgentConversationCodec<unknown>(),
  })
  assert.equal(await conversation.tryResetFromDb(ctx), false)
  assert.deepEqual(conversation.getConversationStateStructure().turns, [])
  assert.deepEqual(conversation.getMetadata("latestRootBlobId"), rootBlobId, "failed decoding does not rewrite the stored root")
})

test("a conversation with no readable turns still returns what it has", async () => {
  const store = new InMemoryBlobStore()
  const conversation = new AgentConversationStore(store, metadataStore(getDefaultAgentMetadata()), { codec: createSlateAgentConversationCodec<unknown>() })
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
  }), store, bytes => SubagentPersistedState.fromBinary(bytes))
  assert.equal(Object.keys(resolved).length, 2)
  assert.equal(resolved["sub-blob"]?.createdTimestampMs, 2n)

  const lostId = await getBlobId(new Uint8Array([77]))
  await assert.rejects(
    resolveSubagentPersistedStates(ctx, new ConversationStateStructure({ subagentStateRefs: { "sub-lost": lostId } }), store, bytes => SubagentPersistedState.fromBinary(bytes)),
    BlobNotFoundError,
  )

  const withFallback = await resolveSubagentPersistedStates(ctx, new ConversationStateStructure({
    subagentStates: { "sub-both": inline },
    subagentStateRefs: { "sub-both": lostId },
  }), store, bytes => SubagentPersistedState.fromBinary(bytes))
  assert.equal(withFallback["sub-both"]?.createdTimestampMs, 1n, "the inline copy is used when the blob is gone")
})
