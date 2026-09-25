import { test } from "node:test"
import assert from "node:assert/strict"

import {
  SelfSummarizer,
  executeSelfSummaryWithRetry,
  type SelfSummaryPromptSession,
  type SelfSummaryStateHandler,
  type SelfSummaryStreamResult,
  type SelfSummaryTool,
} from "../../source/packages/agent/self-summary/self-summary-handler.ts"
import { NoSummaryResponseError } from "../../source/packages/agent-summarization/error-handling.ts"
import { InputTokenLimitError } from "../../source/packages/chat-inference/prompt-executor.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import { PrivacyCapability } from "../../source/packages/redaction/classification.ts"
import { toRedactedCoreMessage, fromRedactedCoreMessage } from "../../source/packages/redaction/message-redaction.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"

// ---------------------------------------------------------------------------------------------
// the harness
// ---------------------------------------------------------------------------------------------

const ctx = createContext()

const message = (role: string, content: unknown) =>
  toRedactedCoreMessage({ role, content } as never, PrivacyMode.NO_STORAGE)

const plain = (role: string, content: unknown) => ({ role, content }) as never

const assistantText = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] }) as never

const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 6, reasoningTokens: 7 }

/** A prompt session that answers with whatever the test says, in order, and records what it was sent. */
function promptSession(answers: Array<{ text?: string; error?: unknown; role?: string }>) {
  const sent: Array<readonly unknown[]> = []
  const session: SelfSummaryPromptSession = {
    getExecutor: () => ({
      appendMessages(messages: readonly unknown[]) { sent.push(messages) },
      executeToolStream: (): SelfSummaryStreamResult => {
        const answer = answers[Math.min(sent.length - 1, answers.length - 1)] ?? {}
        return {
          fullStream: (async function* () { yield {} })(),
          extendedUsage: Promise.resolve(usage),
          usage: Promise.resolve({}),
          providerMetadata: Promise.resolve({}),
          invocationId: Promise.resolve("invocation-1"),
          response: Promise.resolve({
            messages: answer.error !== undefined
              ? [plain("assistant", [])]
              : [plain(answer.role ?? "assistant", [{ type: "text", text: answer.text ?? "" }])],
            ...(answer.error === undefined ? {} : { error: answer.error }),
          }),
        }
      },
    }),
  }
  return { session, sent }
}

function stateHandler(options: { selfSummaryCount?: number } = {}) {
  const turnUsage: unknown[] = []
  const incremented: number[] = []
  const state = {
    selfSummaryCount: options.selfSummaryCount ?? 0,
    getPrivacyMode: () => PrivacyMode.NO_STORAGE,
    addTurnUsage(value: unknown) { turnUsage.push(value) },
    incrementSelfSummaryCount() { incremented.push(1) },
  }
  return { state: state as unknown as SelfSummaryStateHandler, turnUsage, incremented }
}

const listener = { sendUpdate: async () => {} } as never

const tool = (name: string): SelfSummaryTool => ({ name, toolIdentifier: name.toUpperCase(), parameters: {} })

const conversation = (count = 5) =>
  [
    message("system", "the platform's framing"),
    message("user", "the first request"),
    message("assistant", "an answer"),
    message("tool", [{ type: "tool-result", toolName: "Read", result: { ok: true } }]),
    message("user", "the request the model is about to answer"),
  ].slice(0, count)

// ---------------------------------------------------------------------------------------------
// one exchange
// ---------------------------------------------------------------------------------------------

test("a self-summary asks the same model and takes its answer", async () => {
  const { session, sent } = promptSession([{ text: "the summary" }])
  const harnessed = stateHandler()
  const summarizer = new SelfSummarizer(session, harnessed.state, listener, [tool("Read")], {}, "model-1")
  const result = await summarizer.generateSummary(ctx, {
    systemMessage: message("system", "the platform's framing"),
    userInfoMessage: undefined,
    messagesToSummarize: [message("user", "the request")],
    preservedTailMessages: [],
    skillBlocks: [],
  }, {} as never)
  assert.equal(result.text, "the summary")
  // The instruction to summarize is the last message the model reads.
  const lastMessage = (sent[0] ?? [])[(sent[0]?.length ?? 0) - 1] as { role: string; content: string }
  assert.equal(lastMessage.role, "user")
  assert.match(lastMessage.content, /summar/i)
})

test("the usage of a self-summary is added to the turn", async () => {
  const { session } = promptSession([{ text: "the summary" }])
  const harnessed = stateHandler()
  const summarizer = new SelfSummarizer(session, harnessed.state, listener, [tool("Read")], {}, "model-1")
  await summarizer.generateSummary(ctx, {
    systemMessage: message("system", "the framing"),
    userInfoMessage: undefined,
    messagesToSummarize: [message("user", "the request")],
    preservedTailMessages: [],
    skillBlocks: [],
  }, {} as never)
  assert.deepEqual(harnessed.turnUsage, [usage])
})

test("an answer with no assistant message is its own failure", async () => {
  const { session } = promptSession([{ text: "ignored", role: "user" }])
  const harnessed = stateHandler()
  const summarizer = new SelfSummarizer(session, harnessed.state, listener, [tool("Read")], {}, "model-1")
  await assert.rejects(
    () => summarizer.generateSummary(ctx, {
      systemMessage: message("system", "the framing"),
      userInfoMessage: undefined,
      messagesToSummarize: [message("user", "the request")],
      preservedTailMessages: [],
      skillBlocks: [],
    }, {} as never),
    (error: unknown) => {
      assert.equal(error instanceof NoSummaryResponseError, true)
      return true
    },
  )
})

test("an error carried by the response is raised", async () => {
  const { session } = promptSession([{ error: new Error("the provider refused") }])
  const harnessed = stateHandler()
  const summarizer = new SelfSummarizer(session, harnessed.state, listener, [tool("Read")], {}, "model-1")
  await assert.rejects(
    () => summarizer.generateSummary(ctx, {
      systemMessage: message("system", "the framing"),
      userInfoMessage: undefined,
      messagesToSummarize: [message("user", "the request")],
      preservedTailMessages: [],
      skillBlocks: [],
    }, {} as never),
    /the provider refused/,
  )
})

// ---------------------------------------------------------------------------------------------
// retrying
// ---------------------------------------------------------------------------------------------

const retry = (session: SelfSummaryPromptSession, answers: number, options: Record<string, unknown> = {}) =>
  executeSelfSummaryWithRetry(
    ctx,
    session,
    stateHandler().state,
    listener,
    [plain("system", "the framing"), plain("user", "the request")],
    [tool("Read")],
    {},
    { preservedPrefixMessageCount: 1, ...options },
  )

test("an empty answer is retried, and the retry can succeed", async () => {
  const { session, sent } = promptSession([{ text: "   " }, { text: "the summary" }])
  const result = await retry(session, 2)
  assert.equal(result.textContent, "the summary")
  assert.equal(sent.length, 2)
})

test("an empty answer that keeps being empty exhausts the attempts", async () => {
  const { session, sent } = promptSession([{ text: "" }])
  await assert.rejects(() => retry(session, 1), /all retries exhausted without valid content/)
  // Every attempt was made before giving up.
  assert.equal(sent.length > 1, true)
})

test("a failure the platform does not retry is raised straight away", async () => {
  const { session, sent } = promptSession([{ error: new Error("the request was rejected") }])
  await assert.rejects(() => retry(session, 1, { enableRetryUncategorizedErrors: false }), /the request was rejected/)
  assert.equal(sent.length, 1)
})

test("a caller that allows it is retried even when the failure is not a summary", async () => {
  const { session, sent } = promptSession([{ error: new NoSummaryResponseError() }, { text: "the summary" }])
  const result = await retry(session, 2, { enableRetryNoSummaryResponse: true })
  assert.equal(result.textContent, "the summary")
  assert.equal(sent.length, 2)
})

test("a retry after an empty answer asks the same question again", async () => {
  const { session, sent } = promptSession([{ text: "" }, { text: "the summary" }])
  await retry(session, 2)
  // The second attempt sends the same messages: an empty answer is not about the input.
  assert.deepEqual(sent[1], sent[0])
})

// ---------------------------------------------------------------------------------------------
// shrinking the input
// ---------------------------------------------------------------------------------------------

test("a conversation that is mostly tool traffic loses it when the input is too large", async () => {
  const toolHeavy = [
    plain("system", "the framing"),
    plain("user", "the first request"),
    plain("tool", [{ type: "tool-result", toolName: "Read", result: "a large result" }]),
    plain("tool", [{ type: "tool-result", toolName: "Read", result: "another large result" }]),
    plain("assistant", [{ type: "tool-call", toolCallId: "call-1", toolName: "Read", args: {} }]),
    plain("user", "the instruction"),
  ]
  const sent: Array<readonly unknown[]> = []
  const session2: SelfSummaryPromptSession = {
    getExecutor: () => ({
      appendMessages(messages: readonly unknown[]) { sent.push(messages) },
      executeToolStream: () => {
        const attempt = sent.length
        return {
          fullStream: (async function* () { yield {} })(),
          extendedUsage: Promise.resolve(usage),
          usage: Promise.resolve({}),
          providerMetadata: Promise.resolve({}),
          invocationId: Promise.resolve("invocation-1"),
          response: Promise.resolve(attempt === 1
            ? { messages: [plain("assistant", [])], error: new InputTokenLimitError() }
            : { messages: [assistantText("the summary")] }),
        }
      },
    }),
  }
  const result = await executeSelfSummaryWithRetry(
    ctx,
    session2,
    stateHandler().state,
    listener,
    toolHeavy,
    [tool("Read")],
    {},
    { preservedPrefixMessageCount: 1, enableReduceInputsRetry: true },
  )
  assert.equal(result.textContent, "the summary")
  const secondAttempt = sent[1] ?? []
  // The system message and the instruction are kept; the tool traffic and the call that asked for it are not.
  assert.deepEqual(secondAttempt.map(entry => (entry as { role: string }).role), ["system", "user", "user"])
})

test("a conversation that is not mostly tool traffic loses its older half instead", async () => {
  const messages = [
    plain("system", "the framing"),
    plain("user", "one"),
    plain("assistant", "two"),
    plain("user", "three"),
    plain("assistant", "four"),
    plain("user", "the instruction"),
  ]
  const sent: Array<readonly unknown[]> = []
  const session: SelfSummaryPromptSession = {
    getExecutor: () => ({
      appendMessages(next: readonly unknown[]) { sent.push(next) },
      executeToolStream: () => ({
        fullStream: (async function* () { yield {} })(),
        extendedUsage: Promise.resolve(usage),
        usage: Promise.resolve({}),
        providerMetadata: Promise.resolve({}),
        invocationId: Promise.resolve("invocation-1"),
        response: Promise.resolve(sent.length === 1
          ? { messages: [plain("assistant", [])], error: new InputTokenLimitError() }
          : { messages: [assistantText("the summary")] }),
      }),
    }),
  }
  await executeSelfSummaryWithRetry(ctx, session, stateHandler().state, listener, messages, [tool("Read")], {}, {
    preservedPrefixMessageCount: 1,
    enableReduceInputsRetry: true,
  })
  const secondAttempt = sent[1] ?? []
  // The prefix and the instruction are kept, and what is between them is kept from its midpoint on.
  assert.deepEqual(secondAttempt.map(entry => (entry as { role: string }).role), ["system", "user", "assistant", "user"])
})

test("a shortened conversation does not start with a tool result whose call was dropped", async () => {
  const messages = [
    plain("system", "the framing"),
    plain("user", "one"),
    plain("assistant", "two"),
    plain("tool", [{ type: "tool-result", toolName: "Read", result: "a result" }]),
    plain("assistant", "four"),
    plain("user", "the instruction"),
  ]
  const sent: Array<readonly unknown[]> = []
  const session: SelfSummaryPromptSession = {
    getExecutor: () => ({
      appendMessages(next: readonly unknown[]) { sent.push(next) },
      executeToolStream: () => ({
        fullStream: (async function* () { yield {} })(),
        extendedUsage: Promise.resolve(usage),
        usage: Promise.resolve({}),
        providerMetadata: Promise.resolve({}),
        invocationId: Promise.resolve("invocation-1"),
        response: Promise.resolve(sent.length === 1
          ? { messages: [plain("assistant", [])], error: new InputTokenLimitError() }
          : { messages: [assistantText("the summary")] }),
      }),
    }),
  }
  await executeSelfSummaryWithRetry(ctx, session, stateHandler().state, listener, messages, [tool("Read")], {}, {
    preservedPrefixMessageCount: 1,
    enableReduceInputsRetry: true,
  })
  const roles = (sent[1] ?? []).map(entry => (entry as { role: string }).role)
  assert.equal(roles[0], "system")
  assert.equal(roles.includes("tool"), false)
})

test("an input too small to shrink is sent as it is", async () => {
  const messages = [plain("system", "the framing"), plain("user", "the instruction")]
  const sent: Array<readonly unknown[]> = []
  const session: SelfSummaryPromptSession = {
    getExecutor: () => ({
      appendMessages(next: readonly unknown[]) { sent.push(next) },
      executeToolStream: () => ({
        fullStream: (async function* () { yield {} })(),
        extendedUsage: Promise.resolve(usage),
        usage: Promise.resolve({}),
        providerMetadata: Promise.resolve({}),
        invocationId: Promise.resolve("invocation-1"),
        response: Promise.resolve(sent.length === 1
          ? { messages: [plain("assistant", [])], error: new InputTokenLimitError() }
          : { messages: [assistantText("the summary")] }),
      }),
    }),
  }
  await executeSelfSummaryWithRetry(ctx, session, stateHandler().state, listener, messages, [tool("Read")], {}, {
    preservedPrefixMessageCount: 1,
    enableReduceInputsRetry: true,
  })
  assert.deepEqual(sent[1], sent[0])
})

// ---------------------------------------------------------------------------------------------
// what the conversation becomes
// ---------------------------------------------------------------------------------------------

test("the conversation is split with the last user message kept back", () => {
  const harnessed = stateHandler()
  const summarizer = new SelfSummarizer(promptSession([]).session, harnessed.state, listener, [], {}, "model-1")
  const partitioned = summarizer.partitionMessages(conversation(), {} as never)
  assert.equal(partitioned.systemMessage?.role, "system")
  assert.equal(partitioned.preservedTailMessages.length, 1)
  assert.equal(
    fromRedactedCoreMessage(partitioned.preservedTailMessages[0] as never, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED).content,
    "the request the model is about to answer",
  )
})

test("a conversation too short to summarize is refused", () => {
  const harnessed = stateHandler()
  const summarizer = new SelfSummarizer(promptSession([]).session, harnessed.state, listener, [], {}, "model-1")
  assert.throws(() => summarizer.partitionMessages(conversation(2), {} as never), /at least 3 messages/)
})

test("the carrier message says what it is and how many summaries there have been", () => {
  const harnessed = stateHandler({ selfSummaryCount: 2 })
  const summarizer = new SelfSummarizer(promptSession([]).session, harnessed.state, listener, [], {}, "model-1")
  const partitioned = summarizer.partitionMessages(conversation(), {} as never)
  const built = summarizer.buildSummaryMessage({ text: "the summary" }, partitioned, { skillBlocks: [] } as never)
  const content = fromRedactedCoreMessage(built.message, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED).content as string
  assert.match(content, /Your conversation was summarized due to context constraints/)
  assert.match(content, /<summary_content>\nthe summary\n<\/summary_content>/)
  assert.match(content, /Total summaries generated so far for this user query: 3/)
  assert.match(content, /If the task is complete, respond to the user/)
  assert.equal(built.summaryTextLength, content.length)
})

test("the carrier message carries the blocks a summary cannot", () => {
  const harnessed = stateHandler()
  const summarizer = new SelfSummarizer(promptSession([]).session, harnessed.state, listener, [], {}, "model-1")
  const partitioned = summarizer.partitionMessages(conversation(), {} as never)
  const built = summarizer.buildSummaryMessage({ text: "the summary" }, partitioned, {
    skillBlocks: [],
    modePrompt: "the mode",
    projectRootPrompt: "the root",
  } as never)
  const content = fromRedactedCoreMessage(built.message, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED).content as string
  // The leading blocks come before the summary and the trailing ones after it.
  assert.equal(content.startsWith("the mode\n\nthe root\n\n"), true)
})

test("the summary is stored as a carrier the platform can recognize", () => {
  const harnessed = stateHandler()
  const summarizer = new SelfSummarizer(promptSession([]).session, harnessed.state, listener, [], {}, "model-1")
  const partitioned = summarizer.partitionMessages(conversation(), {} as never)
  const built = summarizer.buildSummaryMessage({ text: "the summary" }, partitioned, { skillBlocks: [] } as never)
  assert.equal(built.message.role, "user")
  assert.equal((built.message.providerOptions as { cursor?: { isSummary?: boolean } }).cursor?.isSummary, true)
})

test("the conversation becomes the summary with the tail it kept", () => {
  const harnessed = stateHandler()
  const summarizer = new SelfSummarizer(promptSession([]).session, harnessed.state, listener, [], {}, "model-1")
  const partitioned = summarizer.partitionMessages(conversation(), {} as never)
  const summary = message("user", "the summary")
  const assembled = summarizer.assembleFinalMessages(partitioned, summary)
  assert.deepEqual(assembled.map(entry => entry.role), ["system", "user", "user"])
  assert.equal(assembled.at(-1), summary)
})

test("a whole self-summary run counts itself and reports the model", async () => {
  const { session } = promptSession([{ text: "the summary" }])
  const harnessed = stateHandler()
  const summarizer = new SelfSummarizer(session, harnessed.state, listener, [tool("Read")], {}, "model-1")
  const result = await summarizer.summarize(ctx, conversation(), {} as never) as { summary: { summary: { unwrap(purpose: unknown): string } }; onPersisted?: () => void }
  assert.equal(result.summary.summary.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "the summary")
  assert.equal(summarizer.getModelId(), "model-1")
  assert.equal(summarizer.getMetricsModelLabel(), "model-1")
  // Persisting is what counts a summary, so it happens when the caller says so rather than on generation.
  assert.deepEqual(harnessed.incremented, [])
  result.onPersisted?.()
  assert.deepEqual(harnessed.incremented, [1])
})
