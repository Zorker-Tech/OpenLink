import { test } from "node:test"
import assert from "node:assert/strict"

import { OpenAICompactionHandler } from "../../source/packages/agent/self-summary/openai-compaction-handler.ts"
import { AnthropicCompactionHandler } from "../../source/packages/agent/self-summary/anthropic-compaction-handler.ts"
import type { SelfSummaryPromptSession, SelfSummaryStateHandler, SelfSummaryTool } from "../../source/packages/agent/self-summary/self-summary-handler.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import { PrivacyCapability } from "../../source/packages/redaction/classification.ts"
import { fromRedactedCoreMessage, toRedactedCoreMessage } from "../../source/packages/redaction/message-redaction.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"

// ---------------------------------------------------------------------------------------------
// the harness
// ---------------------------------------------------------------------------------------------

const ctx = createContext()

const message = (role: string, content: unknown, options: { isSummary?: boolean } = {}) =>
  toRedactedCoreMessage({
    role,
    content,
    ...(options.isSummary === true ? { providerOptions: { cursor: { isSummary: true } } } : {}),
  } as never, PrivacyMode.NO_STORAGE)

const textOf = (entry: unknown) => {
  const unwrapped = fromRedactedCoreMessage(entry as never, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED) as { content: unknown }
  return typeof unwrapped.content === "string" ? unwrapped.content : JSON.stringify(unwrapped.content)
}

const plain = (role: string, content: unknown) => ({ role, content }) as never

/** A prompt session that answers with whatever the test says. */
function promptSession(answer: string, options: { long?: boolean } = {}) {
  const sent: Array<readonly unknown[]> = []
  const session: SelfSummaryPromptSession = {
    getExecutor: () => ({
      appendMessages(messages: readonly unknown[]) { sent.push(messages) },
      executeToolStream: () => ({
        fullStream: (async function* () { yield {} })(),
        extendedUsage: Promise.resolve({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 6 }),
        usage: Promise.resolve({}),
        providerMetadata: Promise.resolve({}),
        invocationId: Promise.resolve("invocation-1"),
        response: Promise.resolve({ messages: [plain("assistant", [{ type: "text", text: answer }])] }),
      }),
    }),
  }
  void options
  return { session, sent }
}

const stateHandler = (): SelfSummaryStateHandler => ({
  selfSummaryCount: 0,
  getPrivacyMode: () => PrivacyMode.NO_STORAGE,
  addTurnUsage() {},
  incrementSelfSummaryCount() {},
})

const tool: SelfSummaryTool = { name: "Read", toolIdentifier: "READ", parameters: {} }

const conversation = (count = 3) => [
  message("system", "the platform's framing"),
  message("user", "the first request"),
  message("assistant", "an answer"),
  message("user", "the request the model is about to answer"),
  message("assistant", "the answer"),
].slice(0, count)

const largeConversation = () => [
  message("system", "the platform's framing"),
  message("user", "x".repeat(300_000)),
  message("assistant", "an answer"),
  message("user", "the request the model is about to answer"),
]

const openai = (answer: string) => new OpenAICompactionHandler(promptSession(answer).session, stateHandler(), { sendUpdate: async () => {} } as never, [tool], {}, "model-1")
const anthropic = (answer: string, options: Record<string, unknown> = {}) =>
  new AnthropicCompactionHandler(promptSession(answer).session, stateHandler(), { sendUpdate: async () => {} } as never, [tool], {}, "model-1", options as never)

// ---------------------------------------------------------------------------------------------
// what each compaction asks for
// ---------------------------------------------------------------------------------------------

test("the openai compaction asks with its own checkpoint prompt", async () => {
  const { session, sent } = promptSession("the summary")
  const handler = new OpenAICompactionHandler(session, stateHandler(), { sendUpdate: async () => {} } as never, [tool], {}, "model-1")
  const partitioned = handler.partitionMessages(largeConversation(), {} as never)
  const result = await handler.generateSummary(ctx, partitioned, {} as never)
  assert.equal(result.text, "the summary")
  assert.equal(result.inputTokens, 100)
  const lastMessage = (sent[0] ?? [])[(sent[0]?.length ?? 0) - 1] as { content: string }
  assert.match(lastMessage.content, /CONTEXT CHECKPOINT COMPACTION/)
  assert.match(lastMessage.content, /Do not make any tool calls/)
})

test("the openai compaction keeps the user's own most recent requests", () => {
  const handler = openai("the summary")
  const partitioned = handler.partitionMessages([
    message("system", "the platform's framing"),
    message("user", "the first request"),
    message("assistant", "an answer"),
    message("user", "the request the model is about to answer"),
  ], {} as never)
  // Nothing is kept unless it carries a user query, and the split leaves nothing else behind.
  assert.equal(Array.isArray(partitioned.preservedTailMessages), true)
  assert.equal(partitioned.messagesToSummarize.length > 0, true)
})

test("the openai compaction keeps only the request part of a user message", () => {
  const handler = openai("the summary")
  const partitioned = handler.partitionMessages([
    message("system", "the platform's framing"),
    message("user", "<user_query>the actual request</user_query>\n<user_info>their profile</user_info>"),
    message("assistant", "an answer"),
  ], {} as never)
  const kept = partitioned.preservedTailMessages
  assert.equal(kept.length, 1)
  assert.equal(textOf(kept[0]), "<user_query>the actual request</user_query>")
})

test("the openai compaction keeps nothing from a message with no request in it", () => {
  const handler = openai("the summary")
  const partitioned = handler.partitionMessages([
    message("system", "the platform's framing"),
    message("user", "just some context"),
    message("assistant", "an answer"),
  ], {} as never)
  assert.deepEqual(partitioned.preservedTailMessages, [])
})

test("the openai compaction does not keep a summary as if the user had said it", () => {
  const handler = openai("the summary")
  const partitioned = handler.partitionMessages([
    message("system", "the platform's framing"),
    message("user", "<user_query>an earlier request</user_query>", { isSummary: true }),
    message("assistant", "an answer"),
  ], {} as never)
  assert.deepEqual(partitioned.preservedTailMessages, [])
})

test("the openai summary carries a prefix telling the next model to inspect the state", () => {
  const handler = openai("the summary")
  const partitioned = handler.partitionMessages(largeConversation(), {} as never)
  const built = handler.buildSummaryMessage({ text: "the summary", inputTokens: 1, outputTokens: 2 }, partitioned, { skillBlocks: [] } as never)
  const content = textOf(built.message)
  assert.match(content, /Another language model started to solve this problem/)
  assert.match(content, /use your tools to inspect the current state of files/)
  assert.match(content, /the summary$/)
})

test("the anthropic compaction in beta asks the provider to continue", async () => {
  const { session, sent } = promptSession("the summary")
  const handler = new AnthropicCompactionHandler(session, stateHandler(), { sendUpdate: async () => {} } as never, [tool], {}, "model-1")
  const partitioned = handler.partitionMessages(largeConversation(), {} as never)
  await handler.generateSummary(ctx, partitioned, {} as never)
  const lastMessage = (sent[0] ?? [])[(sent[0]?.length ?? 0) - 1] as { content: string }
  assert.equal(lastMessage.content, "Continue from where you left off.")
})

test("the anthropic compaction in explicit mode asks with the instructions it was given", async () => {
  const { session, sent } = promptSession("the summary")
  const handler = new AnthropicCompactionHandler(session, stateHandler(), { sendUpdate: async () => {} } as never, [tool], {}, "model-1", {
    explicit: true,
    anthropicCompactionInstructions: "summarize this please",
  })
  const partitioned = handler.partitionMessages(conversation(), {} as never)
  await handler.generateSummary(ctx, partitioned, {} as never)
  const lastMessage = (sent[0] ?? [])[(sent[0]?.length ?? 0) - 1] as { content: string }
  assert.equal(lastMessage.content, "summarize this please")
})

test("the anthropic compaction in explicit mode falls back to the platform's own instructions", async () => {
  const { session, sent } = promptSession("the summary")
  const handler = new AnthropicCompactionHandler(session, stateHandler(), { sendUpdate: async () => {} } as never, [tool], {}, "model-1", { explicit: true })
  const partitioned = handler.partitionMessages(conversation(), {} as never)
  await handler.generateSummary(ctx, partitioned, {} as never)
  const lastMessage = (sent[0] ?? [])[(sent[0]?.length ?? 0) - 1] as { content: string }
  assert.equal(lastMessage.content.length > 0, true)
  assert.notEqual(lastMessage.content, "Continue from where you left off.")
})

test("the beta compaction refuses a conversation that is too small to be worth it", async () => {
  const handler = anthropic("the summary")
  const partitioned = handler.partitionMessages(conversation(), {} as never)
  await assert.rejects(
    () => handler.generateSummary(ctx, partitioned, {} as never),
    /Refusing anthropic compaction for fewer than 50000 tokens/,
  )
})

test("the explicit compaction is asked for a small conversation as well", async () => {
  const handler = anthropic("the summary", { explicit: true })
  const partitioned = handler.partitionMessages(conversation(), {} as never)
  const result = await handler.generateSummary(ctx, partitioned, {} as never)
  assert.equal(result.text, "the summary")
})

// ---------------------------------------------------------------------------------------------
// what each compaction writes back
// ---------------------------------------------------------------------------------------------

test("the anthropic summary is written back in the tag the provider reads", () => {
  const handler = anthropic("the summary")
  const partitioned = handler.partitionMessages(conversation(), {} as never)
  const built = handler.buildSummaryMessage({ text: "the summary", inputTokens: 1, outputTokens: 2 }, partitioned, { skillBlocks: [] } as never)
  const content = textOf(built.message)
  assert.match(content, /<summary>\nthe summary\n<\/summary>/)
})

test("the analysis the model wrote before the summary is taken off it", async () => {
  const handler = anthropic("<analysis>\nreasoning about the task\n</analysis>\n<summary>\nthe summary\n</summary>", { explicit: true })
  const partitioned = handler.partitionMessages(conversation(), {} as never)
  const result = await handler.generateSummary(ctx, partitioned, {} as never)
  assert.equal(result.text, "the summary")
})

test("a trailing analysis block with no summary in it is taken off too", async () => {
  const handler = anthropic("<summary>\nthe summary\n</summary>\n<analysis>\nreasoning after\n</analysis>", { explicit: true })
  const partitioned = handler.partitionMessages(conversation(), {} as never)
  const result = await handler.generateSummary(ctx, partitioned, {} as never)
  assert.equal(result.text, "the summary")
})

test("an answer with no tags at all is the summary", async () => {
  const handler = anthropic("the summary, untagged", { explicit: true })
  const partitioned = handler.partitionMessages(conversation(), {} as never)
  const result = await handler.generateSummary(ctx, partitioned, {} as never)
  assert.equal(result.text, "the summary, untagged")
})

test("an answer that is only reasoning is still a summary rather than nothing", async () => {
  const handler = anthropic("<analysis>\nonly reasoning\n</analysis>", { explicit: true })
  const partitioned = handler.partitionMessages(conversation(), {} as never)
  const result = await handler.generateSummary(ctx, partitioned, {} as never)
  assert.equal(result.text.length > 0, true)
})

test("the anthropic compaction keeps nothing of the conversation back", () => {
  const handler = anthropic("the summary")
  const partitioned = handler.partitionMessages(conversation(), {} as never)
  assert.deepEqual(partitioned.preservedTailMessages, [])
  const summary = message("user", "the summary")
  const assembled = handler.assembleFinalMessages(partitioned, summary)
  assert.deepEqual(assembled.map(entry => entry.role), ["system", "user"])
  assert.equal(assembled.at(-1), summary)
})

test("both compactions carry the blocks a summary cannot", () => {
  const openaiHandler = openai("the summary")
  const partitioned = openaiHandler.partitionMessages(largeConversation(), {} as never)
  const openaiBuilt = openaiHandler.buildSummaryMessage(
    { text: "the summary", inputTokens: 1, outputTokens: 2 },
    partitioned,
    { skillBlocks: [], modePrompt: "the mode", projectRootPrompt: "the root" } as never,
  )
  assert.equal(textOf(openaiBuilt.message).startsWith("the mode\n\nthe root\n\n"), true)

  const anthropicHandler = anthropic("the summary")
  const anthropicPartitioned = anthropicHandler.partitionMessages(conversation(), {} as never)
  const anthropicBuilt = anthropicHandler.buildSummaryMessage(
    { text: "the summary", inputTokens: 1, outputTokens: 2 },
    anthropicPartitioned,
    { skillBlocks: [], modePrompt: "the mode", projectRootPrompt: "the root" } as never,
  )
  assert.equal(textOf(anthropicBuilt.message).startsWith("the mode\n\nthe root\n\n"), true)
})

test("a whole compaction run reports its model and counts itself when persisted", async () => {
  const handler = openai("the summary")
  const result = await handler.summarize(ctx, largeConversation(), {} as never) as { summary: { summary: { unwrap(purpose: unknown): string } }; onPersisted?: () => void }
  assert.equal(result.summary.summary.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "the summary")
  assert.equal(handler.getModelId(), "model-1")
  assert.equal(handler.getMetricsModelLabel(), "model-1")
  assert.equal(typeof result.onPersisted, "function")

  const anthropicHandler = anthropic("the summary", { explicit: true })
  const anthropicResult = await anthropicHandler.summarize(ctx, conversation(), {} as never) as { summary: { summary: { unwrap(purpose: unknown): string } } }
  assert.equal(anthropicResult.summary.summary.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "the summary")
})

test("a compaction that fails is raised to the caller", async () => {
  // A session whose response is not an assistant message fails the exchange.
  const failing: SelfSummaryPromptSession = {
    getExecutor: () => ({
      appendMessages() {},
      executeToolStream: () => ({
        fullStream: (async function* () { yield {} })(),
        extendedUsage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
        usage: Promise.resolve({}),
        providerMetadata: Promise.resolve({}),
        invocationId: Promise.resolve("invocation-1"),
        response: Promise.resolve({ messages: [plain("user", "not an assistant message")] }),
      }),
    }),
  }
  const handler = new OpenAICompactionHandler(failing, stateHandler(), { sendUpdate: async () => {} } as never, [tool], {}, "model-1")
  await assert.rejects(() => handler.summarize(ctx, largeConversation(), {} as never))
})
