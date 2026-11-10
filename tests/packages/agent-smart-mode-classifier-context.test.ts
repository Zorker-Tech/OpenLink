import { test } from "node:test"
import assert from "node:assert/strict"

import {
  tryExtractSlateAutoReviewClassifierConversationContext,
  tryExtractSmartModeClassifierConversationContext,
} from "../../source/packages/agent/smart-mode-classifier-context.ts"
import { ConversationStateHandle } from "../../source/packages/agent/state.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { toRedactedConversationStateStructure } from "../../source/adapters/interop/redacted-protos/generated/agent/v1/agent_redacted.ts"
import {
  AssistantMessage,
  ConversationStateStructure,
  ConversationStep,
  UserMessage,
} from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { ProtobufBlobSerde } from "../../source/adapters/interop/agent/protobuf-blob-serde-adapter.ts"
import { createSlateUserMessageSerde } from "../../source/adapters/interop/agent/agent-state-message-serdes-adapter.ts"
import { fromInteropUserMessage } from "../../source/adapters/interop/agent/user-message-action-protocol-adapter.ts"
import { createSlateAgentConversationTurn } from "../../source/packages/agent/conversation-turn-state.ts"
import { slateConversationTurnSerde } from "../../source/adapters/interop/agent/agent-conversation-state-serdes-adapter.ts"
import { getBlobId } from "../../source/packages/agent-kv/blob-store.ts"

// ---------------------------------------------------------------------------------------------
// a conversation the classifier can be shown, built out of real blobs
// ---------------------------------------------------------------------------------------------

const stepSerde = new ProtobufBlobSerde(ConversationStep)
const userMessageSerde = createSlateUserMessageSerde(PrivacyMode.NO_STORAGE)

interface ConversationHarness {
  readonly ctx: Context
  readonly stateHandler: { turns: Array<{ get(ctx: Context): Promise<unknown> }>; rootPromptBuilder: unknown }
}

async function conversation(options: {
  assistantMessages?: readonly string[]
  userMessages?: ReadonlyArray<{ text: string; isSimulated?: boolean }>
  extraTurns?: readonly unknown[]
} = {}): Promise<ConversationHarness> {
  const ctx = createContext()
  const blobs = new Map<string, Uint8Array>()
  const keyOf = (id: Uint8Array): string => Buffer.from(id).toString("hex")
  const blobStore = {
    async getBlob(_ctx: Context, blobId: Uint8Array) { return blobs.get(keyOf(blobId)) },
    async setBlob(_ctx: Context, blobId: Uint8Array, data: Uint8Array) { blobs.set(keyOf(blobId), data) },
    async setBlobLocallyOnly(_ctx: Context, blobId: Uint8Array, data: Uint8Array) { blobs.set(keyOf(blobId), data) },
    async flush() {},
  }
  const store = async (bytes: Uint8Array): Promise<Uint8Array> => {
    const blobId = await getBlobId(bytes)
    blobs.set(keyOf(blobId), bytes)
    return blobId
  }

  const steps: Uint8Array[] = []
  for (const text of options.assistantMessages ?? []) {
    steps.push(await store(stepSerde.serialize(new ConversationStep({
      message: { case: "assistantMessage", value: new AssistantMessage({ text }) },
    }))))
  }
  const userMessages = options.userMessages ?? []
  // Every turn has a user message blob, even when the turn's user message was not kept: a turn that points
  // at nothing cannot be read back at all.
  const userMessageBlobId = new Uint8Array(await store(userMessageSerde.serialize(fromInteropUserMessage(new UserMessage({
    text: userMessages[0]?.text ?? "",
    messageId: "message-1",
    ...(userMessages[0]?.isSimulated === true ? { isSimulatedMsg: true } : {}),
  })))))

  const turnBytes = slateConversationTurnSerde.serialize(createSlateAgentConversationTurn({
    userMessageBlobId,
    stepBlobIds: steps,
    sendMessageStepIndices: [],
  }))
  await store(turnBytes)

  // The state handle deserializes the turn with the same serdes the agent uses, so the handles the
  // classifier walks are the real ones.
  const builder = { appendMessages() {}, getState: () => [], clearMessages() {} }
  const handle = new ConversationStateHandle(
    blobStore as never,
    toRedactedConversationStateStructure(new ConversationStateStructure({}), PrivacyMode.NO_STORAGE),
    builder as never,
    {},
    "composer-2",
  )
  const turn = handle.createConversationTurnHandleSerde().deserialize(turnBytes)
  return {
    ctx,
    stateHandler: {
      turns: [{ get: async () => turn }, ...(options.extraTurns ?? []) as never],
      rootPromptBuilder: builder,
    },
  }
}

const rolesOf = (messages: readonly unknown[]): string[] =>
  messages.map(message => String((message as { role: string }).role))
const contentsOf = (messages: readonly unknown[]): string[] =>
  messages.map(message => String((message as { content: string }).content))

// ---------------------------------------------------------------------------------------------
// what the classifier is shown
// ---------------------------------------------------------------------------------------------

test("the classifier is shown what the agent said, in the order it was said", async () => {
  const { ctx, stateHandler } = await conversation({ assistantMessages: ["the first answer", "the second answer"] })
  const messages = await tryExtractSmartModeClassifierConversationContext(ctx, stateHandler as never)
  assert.deepEqual(rolesOf(messages), ["assistant", "assistant"])
  // The last messages are taken, and they are handed over oldest first so the slice reads as a conversation.
  assert.deepEqual(contentsOf(messages), ["the first answer", "the second answer"])
})

test("an empty assistant message is not a message", async () => {
  const { ctx, stateHandler } = await conversation({ assistantMessages: ["", "   ", "the answer"] })
  const messages = await tryExtractSmartModeClassifierConversationContext(ctx, stateHandler as never)
  assert.deepEqual(contentsOf(messages), ["the answer"])
})

test("the classifier is shown at most the last two of each kind", async () => {
  const { ctx, stateHandler } = await conversation({
    assistantMessages: ["one", "two", "three", "four"],
  })
  const messages = await tryExtractSmartModeClassifierConversationContext(ctx, stateHandler as never)
  assert.deepEqual(contentsOf(messages), ["three", "four"])
})

test("the auto-review classifier is shown more of the conversation than the editor one", async () => {
  const { ctx, stateHandler } = await conversation({
    assistantMessages: ["one", "two", "three", "four", "five"],
  })
  const editor = await tryExtractSmartModeClassifierConversationContext(ctx, stateHandler as never)
  const autoReview = await tryExtractSlateAutoReviewClassifierConversationContext(ctx, stateHandler as never)
  assert.equal(editor.length, 2)
  assert.equal(autoReview.length, 4)
  assert.deepEqual(contentsOf(editor), ["four", "five"])
  assert.deepEqual(contentsOf(autoReview), ["two", "three", "four", "five"])
})

test("a long message is cut for the auto-review classifier, with a marker where it was cut", async () => {
  const { ctx, stateHandler } = await conversation({ assistantMessages: ["x".repeat(10_000)] })
  const messages = await tryExtractSlateAutoReviewClassifierConversationContext(ctx, stateHandler as never)
  const content = contentsOf(messages)[0] ?? ""
  assert.equal(content.length < 10_000, true)
  assert.match(content, /\.\.\.\[auto-review context truncated\]\.\.\./)
})

test("the editor classifier is bounded by the slice budget rather than per message", async () => {
  const { ctx, stateHandler } = await conversation({ assistantMessages: ["x".repeat(10_000)] })
  const messages = await tryExtractSmartModeClassifierConversationContext(ctx, stateHandler as never)
  const content = contentsOf(messages)[0] ?? ""
  assert.equal(content.length <= 8_000, true)
  // No per-message marker is added on this path; the slice is simply bounded.
  assert.doesNotMatch(content, /auto-review context truncated/)
})

test("the slice as a whole is bounded", async () => {
  const { ctx, stateHandler } = await conversation({
    assistantMessages: Array.from({ length: 4 }, (_value, index) => `${index}`.repeat(8_000)),
  })
  const messages = await tryExtractSmartModeClassifierConversationContext(ctx, stateHandler as never)
  const total = contentsOf(messages).reduce((sum, content) => sum + content.length, 0)
  // The budget is 8k characters for the whole slice.
  assert.equal(total <= 8_000, true)
})

test("a conversation that cannot be read yields no context rather than failing", async () => {
  const broken = {
    get turns(): never { throw new Error("the conversation is gone") },
    rootPromptBuilder: {},
  }
  assert.deepEqual(await tryExtractSmartModeClassifierConversationContext(createContext(), broken as never), [])
  assert.deepEqual(await tryExtractSlateAutoReviewClassifierConversationContext(createContext(), broken as never), [])
})

test("a turn that is not an agent turn is skipped", async () => {
  const shellTurn = { get: async () => ({ getInnerStructure: () => ({ steps: [] }) }) }
  const { ctx, stateHandler } = await conversation({ assistantMessages: ["the answer"] })
  stateHandler.turns = [shellTurn as never, ...stateHandler.turns]
  const messages = await tryExtractSmartModeClassifierConversationContext(ctx, stateHandler as never)
  assert.deepEqual(contentsOf(messages), ["the answer"])
})

test("a conversation with nothing to show yields an empty slice", async () => {
  const { ctx, stateHandler } = await conversation({})
  assert.deepEqual(await tryExtractSmartModeClassifierConversationContext(ctx, stateHandler as never), [])
})

test("what the classifier is given is the message shape the classifier protocol carries", async () => {
  const { ctx, stateHandler } = await conversation({ assistantMessages: ["the answer"] })
  const messages = await tryExtractSmartModeClassifierConversationContext(ctx, stateHandler as never)
  assert.equal(messages.length, 1)
  const message = messages[0] as { role: string; content: string; constructor: { typeName?: string } }
  assert.equal(message.role, "assistant")
  assert.equal(message.content, "the answer")
  assert.equal(message.constructor.typeName, "agent.v1.SmartModeClassifierConversationMessage")
})
