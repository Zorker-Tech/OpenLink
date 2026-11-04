import { test } from "node:test"
import assert from "node:assert/strict"

import { OpenAICompactionHandler } from "../../source/packages/agent/self-summary/openai-compaction-handler.ts"
import { AnthropicCompactionHandler } from "../../source/packages/agent/self-summary/anthropic-compaction-handler.ts"
import type { SelfSummaryPromptSession, SelfSummaryStateHandler, SelfSummaryTool } from "../../source/packages/agent/self-summary/self-summary-handler.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import { loggerKey } from "../../source/packages/context/logging.ts"
import { metricsKey } from "../../source/packages/metrics/index.ts"
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

const conversationWithUserInfo = () => [
  message("system", "the platform's framing"),
  message("user", "<user_info>their profile</user_info>"),
  message("user", "the request"),
  message("assistant", "an answer"),
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
  const partitioned = handler.separateMessages(largeConversation(), {} as never)
  const result = await handler.generateSummary(ctx, partitioned, {} as never)
  assert.equal(result.text, "the summary")
  assert.equal(result.inputTokens, 100)
  const lastMessage = (sent[0] ?? [])[(sent[0]?.length ?? 0) - 1] as { content: string }
  assert.match(lastMessage.content, /CONTEXT CHECKPOINT COMPACTION/)
  assert.match(lastMessage.content, /Do not make any tool calls/)
})

test("the openai compaction keeps the user's own most recent requests", () => {
  const handler = openai("the summary")
  const partitioned = handler.separateMessages([
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
  const partitioned = handler.separateMessages([
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
  const partitioned = handler.separateMessages([
    message("system", "the platform's framing"),
    message("user", "just some context"),
    message("assistant", "an answer"),
  ], {} as never)
  assert.deepEqual(partitioned.preservedTailMessages, [])
})

test("the openai compaction does not keep a summary as if the user had said it", () => {
  const handler = openai("the summary")
  const partitioned = handler.separateMessages([
    message("system", "the platform's framing"),
    message("user", "<user_query>an earlier request</user_query>", { isSummary: true }),
    message("assistant", "an answer"),
  ], {} as never)
  assert.deepEqual(partitioned.preservedTailMessages, [])
})

test("the openai summary carries a prefix telling the next model to inspect the state", () => {
  const handler = openai("the summary")
  const partitioned = handler.separateMessages(largeConversation(), {} as never)
  const built = handler.formatSummaryCarrier({ text: "the summary", inputTokens: 1, outputTokens: 2 }, partitioned, { skillBlocks: [] } as never)
  const content = textOf(built.message)
  assert.match(content, /Another language model started to solve this problem/)
  assert.match(content, /use your tools to inspect the current state of files/)
  assert.match(content, /the summary$/)
})

test("the anthropic compaction in beta asks the provider to continue", async () => {
  const { session, sent } = promptSession("the summary")
  const handler = new AnthropicCompactionHandler(session, stateHandler(), { sendUpdate: async () => {} } as never, [tool], {}, "model-1")
  const partitioned = handler.separateMessages(largeConversation(), {} as never)
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
  const partitioned = handler.separateMessages(conversation(), {} as never)
  await handler.generateSummary(ctx, partitioned, {} as never)
  const lastMessage = (sent[0] ?? [])[(sent[0]?.length ?? 0) - 1] as { content: string }
  assert.equal(lastMessage.content, "summarize this please")
})

test("the anthropic compaction in explicit mode falls back to the platform's own instructions", async () => {
  const { session, sent } = promptSession("the summary")
  const handler = new AnthropicCompactionHandler(session, stateHandler(), { sendUpdate: async () => {} } as never, [tool], {}, "model-1", { explicit: true })
  const partitioned = handler.separateMessages(conversation(), {} as never)
  await handler.generateSummary(ctx, partitioned, {} as never)
  const lastMessage = (sent[0] ?? [])[(sent[0]?.length ?? 0) - 1] as { content: string }
  assert.equal(lastMessage.content.length > 0, true)
  assert.notEqual(lastMessage.content, "Continue from where you left off.")
})

test("the beta compaction refuses a conversation that is too small to be worth it", async () => {
  const handler = anthropic("the summary")
  const partitioned = handler.separateMessages(conversation(), {} as never)
  await assert.rejects(
    () => handler.generateSummary(ctx, partitioned, {} as never),
    /Refusing anthropic compaction for fewer than 50000 tokens/,
  )
})

test("the explicit compaction is asked for a small conversation as well", async () => {
  const handler = anthropic("the summary", { explicit: true })
  const partitioned = handler.separateMessages(conversation(), {} as never)
  const result = await handler.generateSummary(ctx, partitioned, {} as never)
  assert.equal(result.text, "the summary")
})

// ---------------------------------------------------------------------------------------------
// what each compaction writes back
// ---------------------------------------------------------------------------------------------

test("the anthropic summary is written back in the tag the provider reads", () => {
  const handler = anthropic("the summary")
  const partitioned = handler.separateMessages(conversation(), {} as never)
  const built = handler.formatSummaryCarrier({ text: "the summary", inputTokens: 1, outputTokens: 2 }, partitioned, { skillBlocks: [] } as never)
  const content = textOf(built.message)
  assert.match(content, /<summary>\nthe summary\n<\/summary>/)
})

test("the analysis the model wrote before the summary is taken off it", async () => {
  const handler = anthropic("<analysis>\nreasoning about the task\n</analysis>\n<summary>\nthe summary\n</summary>", { explicit: true })
  const partitioned = handler.separateMessages(conversation(), {} as never)
  const result = await handler.generateSummary(ctx, partitioned, {} as never)
  assert.equal(result.text, "the summary")
})

test("a trailing analysis block with no summary in it is taken off too", async () => {
  const handler = anthropic("<summary>\nthe summary\n</summary>\n<analysis>\nreasoning after\n</analysis>", { explicit: true })
  const partitioned = handler.separateMessages(conversation(), {} as never)
  const result = await handler.generateSummary(ctx, partitioned, {} as never)
  assert.equal(result.text, "the summary")
})

test("an answer with no tags at all is the summary", async () => {
  const handler = anthropic("the summary, untagged", { explicit: true })
  const partitioned = handler.separateMessages(conversation(), {} as never)
  const result = await handler.generateSummary(ctx, partitioned, {} as never)
  assert.equal(result.text, "the summary, untagged")
})

test("an answer that is only reasoning is still a summary rather than nothing", async () => {
  const handler = anthropic("<analysis>\nonly reasoning\n</analysis>", { explicit: true })
  const partitioned = handler.separateMessages(conversation(), {} as never)
  const result = await handler.generateSummary(ctx, partitioned, {} as never)
  assert.equal(result.text.length > 0, true)
})

test("the anthropic compaction keeps nothing of the conversation back", () => {
  const handler = anthropic("the summary")
  const partitioned = handler.separateMessages(conversation(), {} as never)
  assert.deepEqual(partitioned.preservedTailMessages, [])
  const summary = message("user", "the summary")
  const assembled = handler.rebuildConversation(partitioned, summary)
  assert.deepEqual(assembled.map(entry => entry.role), ["system", "user"])
  assert.equal(assembled.at(-1), summary)
})

test("both compactions carry the blocks a summary cannot", () => {
  const openaiHandler = openai("the summary")
  const partitioned = openaiHandler.separateMessages(largeConversation(), {} as never)
  const openaiBuilt = openaiHandler.formatSummaryCarrier(
    { text: "the summary", inputTokens: 1, outputTokens: 2 },
    partitioned,
    { skillBlocks: [], modePrompt: "the mode", projectRootPrompt: "the root" } as never,
  )
  assert.equal(textOf(openaiBuilt.message).startsWith("the mode\n\nthe root\n\n"), true)

  const anthropicHandler = anthropic("the summary")
  const anthropicPartitioned = anthropicHandler.separateMessages(conversation(), {} as never)
  const anthropicBuilt = anthropicHandler.formatSummaryCarrier(
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

// ---------------------------------------------------------------------------------------------
// the anthropic answer, read out of its own tags
// ---------------------------------------------------------------------------------------------

test("the anthropic answer is read out of the tags it was written in", async () => {
  const cases: Array<[string, string, string]> = [
    ["a leading analysis block is taken off", "<analysis>\nreasoning\n</analysis>\n<summary>\nthe summary\n</summary>", "the summary"],
    ["a trailing analysis block with no summary is taken off", "<summary>\nthe summary\n</summary>\n<analysis>\nreasoning\n</analysis>", "the summary"],
    ["a nested summary inside the trailing analysis is kept", "<summary>first</summary><analysis>more <summary>second</summary></analysis>", "first"],
    ["an unclosed leading analysis is the answer", "<analysis>reasoning without a close", "<analysis>reasoning without a close"],
    ["an untagged answer after a closed analysis is trimmed", "<analysis>reasoning</analysis>\nplain answer", "plain answer"],
    ["an untagged answer is trimmed", "  the summary  ", "the summary"],
    ["only the tagged body counts", "  <summary>\n  the summary  \n</summary>  ", "the summary"],
  ]
  for (const [label, answer, expected] of cases) {
    const handler = anthropic(answer, { explicit: true })
    const partitioned = handler.separateMessages(conversation(), {} as never)
    const result = await handler.generateSummary(ctx, partitioned, {} as never)
    assert.equal(result.text, expected, label)
  }
})

test("the beta floor is measured at its boundary, and the estimate reads every kind of part", async () => {
  const nearFloor = anthropic("unused")
  const refused = nearFloor.separateMessages([message("system", "framing"), message("user", "x".repeat(199_990))], {} as never)
  await assert.rejects(
    () => nearFloor.generateSummary(ctx, refused, {} as never),
    { message: "Refusing anthropic compaction for fewer than 50000 tokens; estimated 49999 tokens in messagesToSummarize." },
    "one token under the floor is refused",
  )

  const aboveFloor = anthropic("the summary")
  const allowed = aboveFloor.separateMessages([message("system", "framing"), message("user", "x".repeat(200_000))], {} as never)
  assert.equal((await aboveFloor.generateSummary(ctx, allowed, {} as never)).text, "the summary", "the floor itself is allowed")

  const estimatedCases: Array<[string, string, unknown, number]> = [
    ["reasoning", "assistant", [{ type: "reasoning", text: "thinking" }], 5],
    ["tool call", "assistant", [{ type: "tool-call", toolCallId: "c1", toolName: "Read", args: { path: "/tmp/a" } }], 11],
    ["tool result", "assistant", [{ type: "tool-result", toolName: "Read", result: "ok" }], 9],
    ["image and file", "assistant", [{ type: "image" }, { type: "file" }], 7],
    ["unknown part", "assistant", [{ type: "mystery", text: "?" }], 3],
    ["untyped part", "assistant", [{ text: "untyped" }], 3],
    ["assistant text", "assistant", [{ type: "text", text: "hello back" }], 5],
    ["user request", "user", "the request", 4],
  ]
  for (const [label, role, content, expected] of estimatedCases) {
    const handler = anthropic("unused")
    const partitioned = handler.separateMessages([message("system", "framing"), message(role, content)], {} as never)
    await assert.rejects(
      () => handler.generateSummary(ctx, partitioned, {} as never),
      { message: `Refusing anthropic compaction for fewer than 50000 tokens; estimated ${expected} tokens in messagesToSummarize.` },
      label,
    )
  }
})

test("the anthropic compaction reports its usage and its outcome through the context", async () => {
  const logs: Array<{ level: string; scope?: string | undefined; message: string; metadata?: unknown }> = []
  const metrics: Array<{ method: string; handle: unknown; value: unknown; labels?: unknown }> = []
  const recordingContext = createContext()
    .with(loggerKey, { log: (_context: unknown, entry: { level: string; scope?: string; message: string; metadata?: unknown }) => logs.push({ level: entry.level, scope: entry.scope, message: entry.message, metadata: entry.metadata }) } as never)
    .with(metricsKey, {
      record: (_context: unknown, handle: unknown, value: unknown, labels?: unknown) => metrics.push({ method: "record", handle, value, labels }),
      increment: (_context: unknown, handle: unknown, value: unknown, labels?: unknown) => metrics.push({ method: "increment", handle, value, labels }),
      gauge: (_context: unknown, handle: unknown, value: unknown, labels?: unknown) => metrics.push({ method: "gauge", handle, value, labels }),
      histogram: (_context: unknown, handle: unknown, value: unknown, labels?: unknown) => metrics.push({ method: "histogram", handle, value, labels }),
    } as never)

  const explicit = anthropic("the summary", { explicit: true })
  const partitioned = explicit.separateMessages(conversation(), {} as never)
  await explicit.generateSummary(recordingContext, partitioned, {} as never)
  const compactionMetrics = () => metrics.filter(entry => (entry.handle as { name: string }).name.startsWith("anthropic_compaction"))
  assert.deepEqual(compactionMetrics().map(entry => [entry.method, entry.value, entry.labels]), [
    ["histogram", 100, { mode: "explicit" }],
    ["histogram", 20, { mode: "explicit" }],
    ["histogram", 5, { mode: "explicit" }],
    ["histogram", 6, { mode: "explicit" }],
  ])
  assert.deepEqual(compactionMetrics().map(entry => entry.handle), [
    { name: "anthropic_compaction.input_token", type: "histogram", description: "Input tokens consumed during Anthropic compaction", labelNames: ["mode"] },
    { name: "anthropic_compaction.output_token", type: "histogram", description: "Output tokens generated during Anthropic compaction", labelNames: ["mode"] },
    { name: "anthropic_compaction.cache_read_token", type: "histogram", description: "Cache read tokens during Anthropic compaction", labelNames: ["mode"] },
    { name: "anthropic_compaction.cache_write_token", type: "histogram", description: "Cache write tokens during Anthropic compaction", labelNames: ["mode"] },
  ])
  const compactionLogs = () => logs.filter(entry => entry.message.startsWith("[anthropic-compaction]"))
  assert.deepEqual(compactionLogs().map(entry => [entry.level, entry.scope, entry.message, entry.metadata]), [
    ["info", "@slate/agent", "[anthropic-compaction] generating summary via explicit user prompt", { mode: "explicit" }],
  ])

  metrics.length = 0
  logs.length = 0
  const beta = anthropic("the summary")
  await beta.summarize(recordingContext, largeConversation(), {} as never)
  assert.deepEqual(compactionLogs().map(entry => entry.message), [
    "[anthropic-compaction] summarize starting",
    "[anthropic-compaction] generating summary via compact beta",
    "[anthropic-compaction] summarize completed",
  ], "the compaction reports its own start and completion around the exchange's own lines")
  const counter = compactionMetrics().find(entry => (entry.handle as { name: string }).name === "anthropic_compaction.status")
  assert.deepEqual([counter?.method, counter?.value, counter?.labels], ["increment", 1, { outcome: "success", errorKind: "Ok", mode: "beta" }])
  assert.deepEqual(counter?.handle, { name: "anthropic_compaction.status", type: "counter", description: "Count of Anthropic compaction attempts and their outcomes", labelNames: ["outcome", "errorKind", "mode"] })
  const timing = compactionMetrics().find(entry => (entry.handle as { name: string }).name === "anthropic_compaction.time_taken_ms")
  assert.deepEqual([timing?.method, typeof timing?.value, timing?.labels], ["histogram", "number", { mode: "beta" }])
  assert.deepEqual(timing?.handle, { name: "anthropic_compaction.time_taken_ms", type: "histogram", description: "Time taken for Anthropic compaction in milliseconds", labelNames: ["mode"] })

  const failingSession: SelfSummaryPromptSession = {
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
  const failingHandler = new AnthropicCompactionHandler(failingSession, stateHandler(), { sendUpdate: async () => {} } as never, [tool], {}, "model-1")
  metrics.length = 0
  await assert.rejects(() => failingHandler.summarize(recordingContext, largeConversation(), {} as never))
  const failedCounter = compactionMetrics().find(entry => (entry.handle as { name: string }).name === "anthropic_compaction.status")
  assert.deepEqual(failedCounter?.labels, { outcome: "failed", errorKind: "NoSummaryResponseError", mode: "beta" })
})

test("the anthropic summary message carries its blocks, its length and the privacy of what it replaces", () => {
  const handler = anthropic("the summary")
  const tail = toRedactedCoreMessage({ role: "user", content: "the request" } as never, PrivacyMode.USAGE_DATA_TRAINING_ALLOWED)
  const partitioned = {
    systemMessage: message("system", "the framing"),
    userInfoMessage: message("user", "<user_info>their profile</user_info>"),
    messagesToSummarize: [],
    preservedTailMessages: [tail],
    skillBlocks: [],
  }
  const built = handler.formatSummaryCarrier(
    { text: "the summary", inputTokens: 1, outputTokens: 2 },
    partitioned as never,
    { skillBlocks: [], modePrompt: "the mode", projectRootPrompt: "the root" } as never,
  )
  const content = textOf(built.message)
  assert.equal(content, "the mode\n\nthe root\n\n\n\n<summary>\nthe summary\n</summary>")
  assert.equal(built.summaryTextLength, content.length)
  assert.equal((built.message as unknown as { _privacyMode: unknown })._privacyMode, PrivacyMode.USAGE_DATA_TRAINING_ALLOWED, "the summary is marked with the privacy of the request it replaces")
})

test("the anthropic compaction keeps the framing, the profile and the summary in that order", () => {
  const handler = anthropic("the summary")
  const partitioned = handler.separateMessages(conversationWithUserInfo(), {} as never)
  assert.notEqual(partitioned.userInfoMessage, undefined, "the profile is separated from the request")
  const assembled = handler.rebuildConversation(partitioned, message("user", "the summary") as never)
  assert.deepEqual(assembled.map(entry => entry.role), ["system", "user", "user"])
  assert.deepEqual(handler.separateMessages(conversation(), {} as never).preservedTailMessages, [], "nothing of the conversation is kept back")
  assert.throws(() => handler.rebuildConversation({ ...partitioned, systemMessage: undefined } as never, message("user", "s") as never), { message: "Expected system message in conversation" })
})
