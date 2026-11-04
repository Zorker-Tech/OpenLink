import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"

import {
  AgentConversationTurnStructure,
  ConversationStateStructure,
  ConversationTurnStructure,
  ConversationPlan,
  UserMessage,
} from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { createSlateAgentConversationTurn } from "../../source/packages/agent/conversation-turn-state.ts"
import { createSlateAssistantMessageStep } from "../../source/packages/agent/conversation-step-state.ts"
import { slateConversationTurnSerde } from "../../source/adapters/interop/agent/agent-conversation-state-serdes-adapter.ts"
import {
  createSlateConversationStepSerde,
  createSlateConversationPlanSerde,
  createSlateUserMessageSerde,
} from "../../source/adapters/interop/agent/agent-state-message-serdes-adapter.ts"
import { createSlateTodoItemSerde } from "../../source/adapters/interop/agent/todo-schema-adapter.ts"
import { fromInteropUserMessage } from "../../source/adapters/interop/agent/user-message-action-protocol-adapter.ts"
import { encodeInteropAgentConversationCheckpoint } from "../../source/adapters/interop/agent/agent-conversation-protobuf-adapter.ts"
import { createRedactedString } from "../../source/packages/redaction/create.ts"
import { DataClassification } from "../../source/packages/redaction/classification.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import {
  collectReachableBlobHexIds,
  EDGES_NOT_WALKED_SO_REFERENTS_COLLECT,
  toHexId,
} from "../../source/adapters/interop/agent/conversation-blob-reachability-adapter.ts"
import {
  BLOB_REFERENCE_MESSAGE_TYPE_BY_NAME,
  BLOB_REFERENCE_METADATA_BY_MESSAGE_ID,
  isProtoBlobReferenceTypeName,
} from "../../source/adapters/interop/agent/blob-reference-metadata.ts"

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest()
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex")
const id = (fill: number) => new Uint8Array(32).fill(fill)

test("the adapter's descriptor table includes message edges and keeps byte/string leaves opaque", () => {
  assert.equal(Object.keys(BLOB_REFERENCE_MESSAGE_TYPE_BY_NAME).length, 19)
  assert.equal(Object.keys(BLOB_REFERENCE_METADATA_BY_MESSAGE_ID).length, 24)
  assert.equal(isProtoBlobReferenceTypeName("agent.v1.UserMessage"), true)
  assert.equal(isProtoBlobReferenceTypeName("string"), false)
  assert.deepEqual([...EDGES_NOT_WALKED_SO_REFERENTS_COLLECT].sort(), [
    "agent.v1.ConversationStateStructure.summary_archive",
    "agent.v1.ConversationStateStructure.summary_archives",
    "agent.v1.UserMessage.conversation_state_blob_id",
  ])
})

test("reachability follows nested turn and user records but skips back-links and archive edges", () => {
  const textId = id(2)
  const omittedBackLink = id(3)
  const omittedArchive = id(4)
  const userBytes = new UserMessage({ conversationStateBlobId: omittedBackLink, textBlobId: textId }).toBinary()
  const userId = digest(userBytes)
  const turnBytes = new ConversationTurnStructure({
    turn: { case: "agentConversationTurn", value: new AgentConversationTurnStructure({ userMessage: userId }) },
  }).toBinary()
  const turnId = digest(turnBytes)
  const rootBytes = new ConversationStateStructure({
    turns: [turnId, turnId],
    summaryArchive: omittedArchive,
    summaryArchives: [omittedArchive],
  }).toBinary()
  const blobs = new Map([[hex(turnId), turnBytes], [hex(userId), userBytes]])
  const reads: string[] = []

  const result = collectReachableBlobHexIds({
    rootBytes,
    getBlobByHexId: key => { reads.push(key); return blobs.get(key) },
  })

  assert.deepEqual([...result.reachableHexIds].sort(), [hex(turnId), hex(userId), hex(textId)].sort())
  assert.deepEqual(reads, [hex(turnId), hex(userId)])
  assert.equal(result.unresolvedProtoRefs, 0)
  assert.equal(result.reachableHexIds.has(hex(omittedBackLink)), false)
  assert.equal(result.reachableHexIds.has(hex(omittedArchive)), false)
})

test("reachability follows turn and step refs from Slate-encoded blobs", () => {
  const textId = id(12)
  const userBytes = createSlateUserMessageSerde(PrivacyMode.NO_STORAGE).serialize(
    fromInteropUserMessage(new UserMessage({ text: "question", textBlobId: textId })),
  )
  const stepBytes = createSlateConversationStepSerde(PrivacyMode.NO_STORAGE).serialize(
    createSlateAssistantMessageStep(
      createRedactedString("answer", DataClassification.CODE, "text", PrivacyMode.NO_STORAGE),
    ),
  )
  const userId = digest(userBytes)
  const stepId = digest(stepBytes)
  const turnBytes = slateConversationTurnSerde.serialize(createSlateAgentConversationTurn({
    userMessageBlobId: userId,
    stepBlobIds: [stepId],
    sendMessageStepIndices: [],
  }))
  const turnId = digest(turnBytes)
  const rootBytes = encodeInteropAgentConversationCheckpoint(new ConversationStateStructure({ turns: [turnId] }))
  const blobs = new Map([
    [hex(turnId), turnBytes],
    [hex(userId), userBytes],
    [hex(stepId), stepBytes],
  ])

  const result = collectReachableBlobHexIds({ rootBytes, getBlobByHexId: id => blobs.get(id) })

  assert.deepEqual([...result.reachableHexIds].sort(), [hex(turnId), hex(userId), hex(stepId), hex(textId)].sort())
  assert.equal(result.unresolvedProtoRefs, 0)
})

test("reachability validates both Slate and legacy plan blobs without treating the new schema as a missing proto", () => {
  const serde = createSlateConversationPlanSerde(PrivacyMode.NO_STORAGE)
  const newBytes = serde.serialize({ content: "# New plan" })
  const legacyBytes = new ConversationPlan({ plan: "# Old plan" }).toBinary()
  const blobs = [newBytes, legacyBytes]
  const ids = blobs.map(bytes => digest(bytes))

  for (const [index, planBytes] of blobs.entries()) {
    const planId = ids[index]!
    const rootBytes = new ConversationStateStructure({ plan: planId }).toBinary()
    const result = collectReachableBlobHexIds({
      rootBytes,
      getBlobByHexId: key => key === hex(planId) ? planBytes : undefined,
    })
    assert.deepEqual([...result.reachableHexIds], [hex(planId)])
    assert.equal(result.unresolvedProtoRefs, 0)
  }
})

test("reachability validates Slate todo blobs referenced by a checkpoint", () => {
  const todoBytes = createSlateTodoItemSerde(PrivacyMode.NO_STORAGE).serialize({
    id: "todo-1",
    content: "reachable todo",
    status: "pending",
    createdAt: 1n,
    updatedAt: 2n,
  })
  const todoId = digest(todoBytes)
  const rootBytes = new ConversationStateStructure({ todos: [todoId] }).toBinary()
  const result = collectReachableBlobHexIds({
    rootBytes,
    getBlobByHexId: key => key === hex(todoId) ? todoBytes : undefined,
  })
  assert.deepEqual([...result.reachableHexIds], [hex(todoId)])
  assert.equal(result.unresolvedProtoRefs, 0)
})

test("missing typed child blobs are retained as unresolved references", () => {
  const missingChild = id(9)
  const result = collectReachableBlobHexIds({
    rootBytes: new ConversationStateStructure({ turns: [missingChild] }).toBinary(),
    getBlobByHexId: () => undefined,
  })

  assert.deepEqual([...result.reachableHexIds], [hex(missingChild)])
  assert.equal(result.unresolvedProtoRefs, 1)
})

test("hex identifiers respect a byte view's offset and length", () => {
  const storage = Uint8Array.from([99, 1, 2, 3, 88])
  assert.equal(toHexId(storage.subarray(1, 4)), "010203")
})
