import { test } from "node:test"
import assert from "node:assert/strict"

import {
  createSlateAgentConversationTurn,
  createSlateShellConversationTurn,
} from "../../source/packages/agent/conversation-turn-state.ts"
import {
  fromInteropConversationTurn,
  slateConversationTurnSerde,
  toInteropConversationTurn,
} from "../../source/adapters/interop/agent/agent-conversation-state-serdes-adapter.ts"
import {
  AgentConversationTurnStructure,
  ConversationTurnStructure,
  ShellConversationTurnStructure,
} from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"

test("constructing a Slate agent turn does not retain caller-owned arrays", () => {
  const userMessageBlobId = new Uint8Array([1])
  const firstStepBlobId = new Uint8Array([2])
  const stepBlobIds = [firstStepBlobId]
  const sendMessageStepIndices = [0]
  const turn = createSlateAgentConversationTurn({
    userMessageBlobId,
    stepBlobIds,
    requestId: "request-1",
    encryptedModel: "encrypted-model",
    dynamicToolCount: 0,
    sendMessageStepIndices,
  })

  userMessageBlobId[0] = 9
  firstStepBlobId[0] = 8
  stepBlobIds.push(new Uint8Array([3]))
  sendMessageStepIndices.push(1)

  assert.deepEqual(turn.userMessageBlobId, new Uint8Array([1]))
  assert.deepEqual(turn.stepBlobIds, [new Uint8Array([2])])
  assert.deepEqual(turn.sendMessageStepIndices, [0])
  assert.equal(turn.dynamicToolCount, 0)
})

test("constructing a Slate shell turn does not retain caller-owned blob ids", () => {
  const command = new Uint8Array([1])
  const output = new Uint8Array([2])
  const turn = createSlateShellConversationTurn({
    invocationBlobId: command,
    resultBlobId: output,
  })

  command[0] = 9
  output[0] = 8

  assert.deepEqual(turn.invocationBlobId, new Uint8Array([1]))
  assert.deepEqual(turn.resultBlobId, new Uint8Array([2]))
})

test("the persistence adapter preserves every agent turn field", () => {
  const turn = createSlateAgentConversationTurn({
    userMessageBlobId: new Uint8Array([1]),
    stepBlobIds: [new Uint8Array([2]), new Uint8Array([3])],
    requestId: "request-1",
    encryptedModel: "encrypted-model",
    dynamicToolCount: 0,
    sendMessageStepIndices: [0, 2],
  })

  const bytes = slateConversationTurnSerde.serialize(turn)
  const decoded = slateConversationTurnSerde.deserialize(bytes)

  assert.ok(new TextDecoder().decode(bytes).startsWith("SLATE-AGENT-TURN\n"))
  assert.deepEqual(decoded, turn)
  assert.notEqual(decoded.stepBlobIds[0], turn.stepBlobIds[0])
  assert.deepEqual(slateConversationTurnSerde.getBlobType?.(), {
    kind: "json",
    typeName: "slate.agent-conversation-turn",
  })
})

test("the persistence adapter preserves a shell turn", () => {
  const turn = createSlateShellConversationTurn({
    invocationBlobId: new Uint8Array([4]),
    resultBlobId: new Uint8Array([5]),
  })

  const bytes = slateConversationTurnSerde.serialize(turn)
  const decoded = slateConversationTurnSerde.deserialize(bytes)
  const envelope = JSON.parse(new TextDecoder().decode(bytes).slice("SLATE-AGENT-TURN\n".length))

  assert.equal(envelope.version, 2)
  assert.deepEqual(envelope.turn, {
    kind: "shell",
    invocationBlobId: "04",
    resultBlobId: "05",
  })
  assert.deepEqual(decoded, turn)
})

test("the adapter reconstructs the persisted envelope without changing either case", () => {
  const agent = fromInteropConversationTurn(new ConversationTurnStructure({
    turn: {
      case: "agentConversationTurn",
      value: new AgentConversationTurnStructure({
        userMessage: new Uint8Array([1]),
        steps: [new Uint8Array([2])],
        requestId: "request-1",
        encryptedModel: "encrypted-model",
        dynamicToolCount: 0,
        sendMessageStepIndices: [0],
      }),
    },
  }))
  const shell = fromInteropConversationTurn(new ConversationTurnStructure({
    turn: {
      case: "shellConversationTurn",
      value: new ShellConversationTurnStructure({
        shellCommand: new Uint8Array([3]),
        shellOutput: new Uint8Array([4]),
      }),
    },
  }))

  assert.equal(toInteropConversationTurn(agent).turn.case, "agentConversationTurn")
  assert.equal(toInteropConversationTurn(shell).turn.case, "shellConversationTurn")
})

test("a persisted envelope without a known turn case is rejected", () => {
  assert.throws(
    () => slateConversationTurnSerde.deserialize(new ConversationTurnStructure().toBinary()),
    /unsupported or invalid/,
  )
})
