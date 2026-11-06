import { test } from "node:test"
import assert from "node:assert/strict"

import { ConversationStateStructure, SubagentPersistedState } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import {
  createSlateAgentConversationCodec,
  interopAgentConversationCheckpointFromSlate,
} from "../../source/adapters/interop/agent/agent-conversation-protobuf-adapter.ts"
import { createSlateSubagentPersistedStateSerde } from "../../source/adapters/interop/agent/agent-state-message-serdes-adapter.ts"
import { slateCheckpointSubagentFromInterop } from "../../source/adapters/interop/agent/slate-agent-checkpoint-interop-adapter.ts"
import { runnerConversationStateFromStoreCheckpoint } from "../../source/adapters/interop/agent/turn-agent-run-projection-adapter.ts"
import { getBlobId } from "../../source/packages/agent-kv/blob-store.ts"
import { toHex } from "../../source/packages/agent-kv/serde.ts"
import { PrivacyCapability } from "../../source/packages/redaction/classification.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import {
  AgentConversationStore,
  getDefaultAgentMetadata,
  type AgentMetadata,
  type AgentMetadataKey,
  type AgentMetadataStore,
} from "../../source/packages/agent-kv/agent-conversation-store.ts"
import {
  createEmptySlateConversationCheckpointV2,
  isSlateConversationCheckpointV2,
} from "../../source/packages/agent/conversation-checkpoint-state.ts"
import {
  createEmptySlateSubagentConversationSnapshot,
  createSlateSubagentPersistedState,
} from "../../source/packages/agent/subagent-persisted-state.ts"
import {
  createSlateShellInvocation,
  createSlateShellResult,
  storeSlateShellInvocation,
  storeSlateShellResult,
} from "../../source/packages/agent/shell-state.ts"
import { createSlateShellConversationTurn } from "../../source/packages/agent/conversation-turn-state.ts"
import { slateConversationTurnSerde } from "../../source/adapters/interop/agent/agent-conversation-state-serdes-adapter.ts"
import { createSlateShellInvocationSerde, createSlateShellResultSerde } from "../../source/adapters/storage/agent/shell-state-storage-adapter.ts"
import { importLegacyShellInvocation, importLegacyShellResult } from "../../source/adapters/interop/agent/legacy-shell-state-adapter.ts"

const codec = createSlateAgentConversationCodec<unknown>()

function metadataStore(initial: AgentMetadata): AgentMetadataStore {
  const values = { ...initial }
  return {
    get<Key extends AgentMetadataKey>(key: Key) { return values[key] },
    set<Key extends AgentMetadataKey>(key: Key, value: AgentMetadata[Key]) { values[key] = value as never },
    subscribe() { return () => {} },
  }
}

test("the Slate conversation store owns V2 as its checkpoint type", () => {
  const checkpoint: unknown = codec.createEmptyCheckpoint()
  assert.equal(isSlateConversationCheckpointV2(checkpoint), true)
  assert.deepEqual(checkpoint, createEmptySlateConversationCheckpointV2())
})

test("legacy protobuf roots decode directly into Slate V2 references", () => {
  const legacy = new ConversationStateStructure({
    turns: [new Uint8Array([1, 2, 3])],
    todos: [new Uint8Array([4])],
    previousWorkspaceUris: ["file:///workspace"],
  })

  const checkpoint: unknown = codec.decodeCheckpoint(legacy.toBinary())
  assert.equal(isSlateConversationCheckpointV2(checkpoint), true)
  assert.deepEqual((checkpoint as { turnBlobIds: readonly string[] }).turnBlobIds, ["010203"])
  assert.deepEqual((checkpoint as { todoBlobIds: readonly string[] }).todoBlobIds, ["04"])
  assert.deepEqual((checkpoint as { workspaceUris: readonly string[] }).workspaceUris, ["file:///workspace"])
})

test("new codec writes serialize the owned Slate V2 checkpoint directly", () => {
  const checkpoint = {
    ...createEmptySlateConversationCheckpointV2(),
    turnBlobIds: ["aabb"],
  }

  const bytes = codec.encodeCheckpoint(checkpoint as never)
  const text = new TextDecoder().decode(bytes)
  const header = "SLATE-AGENT-CHECKPOINT\n"
  assert.ok(text.startsWith(header))
  const envelope = JSON.parse(text.slice(header.length)) as {
    format: string
    version: number
    conversation: { turnBlobIds: readonly string[] }
  }
  assert.equal(envelope.format, "slate.agent-conversation-checkpoint")
  assert.equal(envelope.version, 2)
  assert.deepEqual(envelope.conversation.turnBlobIds, ["aabb"])
})

test("the store normalizes a runner checkpoint before exposing or persisting it", async () => {
  const blobs = new Map<string, Uint8Array>()
  const blobStore = {
    async getBlob(_context: unknown, id: Uint8Array) { return blobs.get(toHex(id)) ?? null },
    async setBlob(_context: unknown, id: Uint8Array, value: Uint8Array) { blobs.set(toHex(id), new Uint8Array(value)) },
    async setBlobLocallyOnly(_context: unknown, id: Uint8Array, value: Uint8Array) { blobs.set(toHex(id), new Uint8Array(value)) },
    async flush() {},
  }
  const store = new AgentConversationStore(blobStore as never, metadataStore(getDefaultAgentMetadata("agent-owned-checkpoint")), {
    codec,
  })
  const legacy = new ConversationStateStructure({
    turns: [new Uint8Array([0x10, 0x20])],
    previousWorkspaceUris: ["file:///workspace"],
  })

  await store.handleCheckpoint(undefined, legacy as never)

  const checkpoint = store.getConversationStateStructure()
  assert.equal(isSlateConversationCheckpointV2(checkpoint), true)
  assert.deepEqual(checkpoint.turnBlobIds, ["1020"])
  assert.deepEqual(checkpoint.workspaceUris, ["file:///workspace"])
  const persisted = await blobStore.getBlob(undefined, store.getMetadata("latestRootBlobId"))
  assert.ok(persisted)
  const header = "SLATE-AGENT-CHECKPOINT\n"
  assert.ok(new TextDecoder().decode(persisted).startsWith(header))
  assert.equal(JSON.parse(new TextDecoder().decode(persisted).slice(header.length)).version, 2)
})

test("the runner projection adapts owned V2 checkpoints and clones legacy runner values", () => {
  const slateCheckpoint = {
    ...createEmptySlateConversationCheckpointV2(),
    turnBlobIds: ["010203"],
    workspaceUris: ["file:///workspace"],
  }
  const runnerState = runnerConversationStateFromStoreCheckpoint(slateCheckpoint)
  assert.deepEqual(runnerState.turns, [new Uint8Array([1, 2, 3])])
  assert.deepEqual(runnerState.previousWorkspaceUris, ["file:///workspace"])

  const legacyState = new ConversationStateStructure({ turns: [new Uint8Array([4])] })
  const legacyProjection = runnerConversationStateFromStoreCheckpoint(legacyState)
  assert.notEqual(legacyProjection, legacyState)
  assert.deepEqual(legacyProjection.turns, [new Uint8Array([4])])
})

test("subconversation resolution returns Slate checkpoint records for inline and referenced children", async () => {
  const subagentState = createSlateSubagentPersistedState({
    conversationSnapshot: createEmptySlateSubagentConversationSnapshot(),
    createdAtMs: 12n,
    lastUsedAtMs: 34n,
    executionEnvironment: "local",
  })
  const bytes = createSlateSubagentPersistedStateSerde(PrivacyMode.UNSPECIFIED).serialize(subagentState)
  const blobId = await getBlobId(bytes)
  const blobStore = {
    async getBlob(_context: unknown, requested: Uint8Array) {
      return Buffer.from(requested).equals(Buffer.from(blobId)) ? bytes : undefined
    },
  }
  const inlineConversation = {
    ...createEmptySlateConversationCheckpointV2(),
    turnBlobIds: ["0102"],
  }
  const checkpoint = {
    ...createEmptySlateConversationCheckpointV2(),
    subagents: {
      inline: {
        createdAtMs: "1",
        lastUsedAtMs: "2",
        environment: "local" as const,
        conversation: inlineConversation,
      },
    },
    subagentStateBlobIds: { referenced: toHex(blobId) },
  }

  const resolved = await codec.resolveSubconversations(undefined, checkpoint, blobStore)
  assert.deepEqual(resolved.inline?.conversationState, inlineConversation)
  assert.equal(resolved.inline?.createdTimestampMs, 1n)
  assert.equal(isSlateConversationCheckpointV2(resolved.referenced?.conversationState), true)
  assert.equal(resolved.referenced?.createdTimestampMs, 12n)
  assert.equal(resolved.referenced?.lastUsedTimestampMs, 34n)
  assert.equal(resolved.referenced?.subagentType, undefined)
})

test("unknown fields in referenced subagent records survive the Slate V2 projection", () => {
  const appendUnknownVarint = (bytes: Uint8Array): Uint8Array => {
    const result = new Uint8Array(bytes.length + 3)
    result.set(bytes)
    result.set([0xa0, 0x06, 0x07], bytes.length)
    return result
  }
  const nestedConversation = ConversationStateStructure.fromBinary(appendUnknownVarint(
    new ConversationStateStructure({ turns: [new Uint8Array([1, 2])] }).toBinary(),
  ))
  const legacySubagent = SubagentPersistedState.fromBinary(appendUnknownVarint(
    new SubagentPersistedState({ conversationState: nestedConversation, createdTimestampMs: 7n }).toBinary(),
  ))
  const subagentUnknown = SubagentPersistedState.runtime.bin.listUnknownFields(legacySubagent)
  const nestedUnknown = ConversationStateStructure.runtime.bin.listUnknownFields(legacySubagent.conversationState!)

  const slateSubagent = slateCheckpointSubagentFromInterop(legacySubagent)
  assert.equal(slateSubagent.compatibility?.legacyUnknownFields?.length, 2)
  const checkpoint = {
    ...createEmptySlateConversationCheckpointV2(),
    subagents: { child: slateSubagent },
  }
  assert.equal(isSlateConversationCheckpointV2(checkpoint), true)

  const roundTrip = interopAgentConversationCheckpointFromSlate(checkpoint)
  const restored = roundTrip.subagentStates.child!
  assert.deepEqual(SubagentPersistedState.runtime.bin.listUnknownFields(restored), subagentUnknown)
  assert.deepEqual(
    ConversationStateStructure.runtime.bin.listUnknownFields(restored.conversationState!),
    nestedUnknown,
  )
})

test("full conversation hydration returns Slate shell values from stored shell blobs", async () => {
  const invocationSerde = createSlateShellInvocationSerde(PrivacyMode.NO_STORAGE, importLegacyShellInvocation)
  const resultSerde = createSlateShellResultSerde(PrivacyMode.NO_STORAGE, importLegacyShellResult)
  const invocationBytes = invocationSerde.serialize(storeSlateShellInvocation(
    createSlateShellInvocation("echo slate"),
    PrivacyMode.NO_STORAGE,
  ))
  const resultBytes = resultSerde.serialize(storeSlateShellResult(createSlateShellResult({
    standardOutput: "result",
    standardError: "",
    exitCode: 7,
  }), PrivacyMode.NO_STORAGE))
  const invocationBlobId = await getBlobId(invocationBytes)
  const resultBlobId = await getBlobId(resultBytes)
  const turnBytes = slateConversationTurnSerde.serialize(createSlateShellConversationTurn({
    invocationBlobId,
    resultBlobId,
  }))
  const turnBlobId = await getBlobId(turnBytes)
  const blobs = new Map<string, Uint8Array>([
    [toHex(invocationBlobId), invocationBytes],
    [toHex(resultBlobId), resultBytes],
    [toHex(turnBlobId), turnBytes],
  ])
  const conversation = await codec.hydrateConversation(undefined, {
    ...createEmptySlateConversationCheckpointV2(),
    turnBlobIds: [toHex(turnBlobId)],
  }, {
    async getBlob(_context: unknown, id: Uint8Array) { return blobs.get(toHex(id)) },
  })

  const turn = conversation.turns[0]
  assert.equal(turn?.kind, "shell")
  if (turn?.kind !== "shell") assert.fail("expected a Slate shell turn")
  const command = turn.invocation.commandText
  const stdout = turn.result.standardOutput
  assert.equal(typeof command === "string" ? command : command.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "echo slate")
  assert.equal(typeof stdout === "string" ? stdout : stdout.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "result")
  assert.equal(turn.result.exitCode, 7)
})
