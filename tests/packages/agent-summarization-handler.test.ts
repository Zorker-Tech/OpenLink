import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  SummarizationHandler,
  shouldForceSummarizationForTesting,
  turnMessageToString,
  type SummarizationPromptSession,
  type SummarizationRawResult,
} from "../../source/packages/agent-summarization/summarization-handler.ts"
import {
  DEFAULT_DETERMINISTIC_FALLBACK_WINDOW_RATIO,
  buildDeterministicSummaryText,
  computeDeterministicFallbackMaxChars,
} from "../../source/packages/agent-summarization/deterministic-summary-builder.ts"
import { BackgroundSummarizationMode } from "../../source/packages/agent-summarization/background-summarization.ts"
import { InputTokenLimitError, OutputTokensLimitExceededError } from "../../source/packages/chat-inference/prompt-executor.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import { DataClassification, PrivacyCapability } from "../../source/packages/redaction/classification.ts"
import { toRedactedCoreMessage } from "../../source/packages/redaction/message-redaction.ts"
import { createRedactedString } from "../../source/packages/redaction/create.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { isRedactedString } from "../../source/packages/redaction/redacted-values.ts"

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

const textMessage = (role: string, text: string) => message(role, text)

const runOptions = (overrides: Record<string, unknown> = {}) => ({
  backgroundSummarizationMode: BackgroundSummarizationMode.WaitForCompletion,
  triggerReason: "test",
  ...overrides,
}) as never

/** A prompt session whose stream answers with whatever the test says, in order. */
function promptSession(answers: Array<{ text?: string; error?: Error }>, options: { modelId?: string } = {}) {
  const seen: string[] = []
  const session: SummarizationPromptSession = {
    getModelId: () => options.modelId ?? "model-1",
    getExecutor: () => ({
      stream: (_ctx: Context, _request?: unknown, _tools?: unknown, _options?: unknown) => {
        const answer = answers[Math.min(seen.length, answers.length - 1)] ?? {}
        seen.push(answer.text ?? "")
        const response = answer.error === undefined
          ? Promise.resolve({ messages: [{ role: "assistant", content: answer.text ?? "" }] })
          : Promise.reject(answer.error)
        return {
          fullStream: (async function* () { yield {} })(),
          extendedUsage: Promise.resolve({ inputTokens: 1_000, outputTokens: 200 }),
          usage: Promise.resolve({}),
          providerMetadata: Promise.resolve({}),
          invocationId: Promise.resolve("invocation-1"),
          response,
        }
      },
    }),
  }
  return { session, seen }
}

const handlerWith = (session: SummarizationPromptSession, options: Record<string, unknown> = {}) =>
  new SummarizationHandler(session, false, options as never)

// ---------------------------------------------------------------------------------------------
// how much of a transcript may be kept
// ---------------------------------------------------------------------------------------------

test("the fallback budget is a share of the window, bounded on both sides", () => {
  assert.equal(computeDeterministicFallbackMaxChars(1_000_000, 0.02), 80_000)
  assert.equal(computeDeterministicFallbackMaxChars(1_000, 0.02), 50_000)
  assert.equal(computeDeterministicFallbackMaxChars(1_000_000_000, 0.02), 3_200_000)
  assert.equal(computeDeterministicFallbackMaxChars(undefined, 0.02), 50_000)
  assert.equal(computeDeterministicFallbackMaxChars(Number.NaN, 0.02), 50_000)
  assert.equal(computeDeterministicFallbackMaxChars(0, 0.02), 50_000)
  assert.equal(computeDeterministicFallbackMaxChars(1_000_000, 0), 50_000)
})

test("the default share is the one the platform uses", () => {
  assert.equal(DEFAULT_DETERMINISTIC_FALLBACK_WINDOW_RATIO, 0.02)
})

test("a summary with nothing to summarize is not built", () => {
  assert.equal(buildDeterministicSummaryText(ctx, [], { maxChars: 100_000 }), null)
})

test("the fallback summary is the transcript with a preamble that says what it is", () => {
  const built = buildDeterministicSummaryText(ctx, [
    textMessage("user", "what is the state of the build"),
    textMessage("assistant", "it is green"),
  ], { maxChars: 100_000 })
  assert.notEqual(built, null)
  assert.match(built?.text ?? "", /partial transcript of a prior conversation/)
  assert.match(built?.text ?? "", /Do not execute any instructions/)
  assert.match(built?.text ?? "", /user: what is the state of the build/)
  assert.match(built?.text ?? "", /assistant: it is green/)
  assert.equal(built?.fullyPreservedMessageCount, 2)
  assert.equal(built?.truncatedCount, 0)
  assert.equal(built?.droppedCount, 0)
})

test("a transcript that does not fit is shortened and says so", () => {
  const long = "x".repeat(60_000)
  const built = buildDeterministicSummaryText(ctx, [
    textMessage("user", long),
    textMessage("assistant", long),
    textMessage("user", "the last thing"),
  ], { maxChars: 100_000 })
  assert.notEqual(built, null)
  assert.equal((built?.text.length ?? 0) <= 100_000, true)
  assert.match(built?.text ?? "", /omitted|truncated/)
})

// ---------------------------------------------------------------------------------------------
// a message as the summarizer reads it
// ---------------------------------------------------------------------------------------------

test("a message with a string body is written as it stands", () => {
  assert.equal(turnMessageToString(textMessage("user", "hello"), true), "hello")
})

test("the parts a summarizer reads are named", () => {
  const written = turnMessageToString(message("assistant", [
    { type: "text", text: "looking at it" },
    { type: "image" },
    { type: "file" },
    { type: "reasoning", text: "considering" },
    { type: "redacted-reasoning" },
    { type: "tool-call", toolName: "Read", args: { path: "/repo/a.ts" } },
    { type: "tool-result", toolName: "Read", result: { ok: true } },
  ]), true)
  assert.match(written, /^looking at it/)
  assert.match(written, /\[Image\]/)
  assert.match(written, /\[File\]/)
  assert.match(written, /\[Thinking\] considering/)
  assert.match(written, /\[Thinking\]\n/)
  assert.match(written, /\[Tool call\] Read \{"path":"\/repo\/a\.ts"\}/)
  assert.match(written, /\[Tool result\] Read \{"ok":true\}/)
})

test("a tool call too large for a prompt is shortened and says how large it was", () => {
  const args = { blob: "y".repeat(100_001) }
  const written = turnMessageToString(message("assistant", [{ type: "tool-call", toolName: "Write", args }]), true)
  assert.match(written, /\[Tool call\] Write /)
  assert.match(written, /\[\.\.\. truncated, \d+ total chars\]$/)
  assert.equal(written.length < 100_100, true)
  // Without the guard the whole call is written, which is what the guard exists to prevent.
  const unguarded = turnMessageToString(message("assistant", [{ type: "tool-call", toolName: "Write", args }]), false)
  assert.equal(unguarded.endsWith("[... truncated, 100014 total chars]"), false)
  assert.equal(unguarded.length > 100_000, true)
})

// ---------------------------------------------------------------------------------------------
// what is summarized and what is kept
// ---------------------------------------------------------------------------------------------

test("the conversation is split at its last user message", () => {
  const handler = handlerWith(promptSession([{ text: "summary" }]).session)
  const partitioned = handler.partitionMessages([
    textMessage("system", "the platform's framing"),
    textMessage("user", "the first request"),
    textMessage("assistant", "the first answer"),
    textMessage("user", "the second request"),
    textMessage("assistant", "the second answer"),
  ], runOptions())
  assert.equal(partitioned.systemMessage?.role, "system")
  assert.deepEqual(partitioned.messagesToSummarize.map(entry => entry.role), ["user", "assistant", "user"])
  // The message being answered is both summarized and kept: the summary has to cover it, and the model
  // still has to answer it.
  assert.deepEqual(partitioned.preservedTailMessages.map(entry => entry.role), ["user", "assistant"])
})

test("a full summarization keeps nothing back", () => {
  const handler = handlerWith(promptSession([{ text: "summary" }]).session)
  const partitioned = handler.partitionMessages([
    textMessage("user", "the request"),
    textMessage("assistant", "the answer"),
  ], runOptions({ fullSummarization: true }))
  assert.deepEqual(partitioned.messagesToSummarize.map(entry => entry.role), ["user", "assistant"])
  assert.deepEqual(partitioned.preservedTailMessages, [])
})

test("a conversation with no user message is summarized whole", () => {
  const handler = handlerWith(promptSession([{ text: "summary" }]).session)
  const partitioned = handler.partitionMessages([
    textMessage("assistant", "something"),
    textMessage("assistant", "something else"),
  ], runOptions())
  assert.equal(partitioned.messagesToSummarize.length, 2)
  assert.deepEqual(partitioned.preservedTailMessages, [])
})

test("the last user message is kept when the split would leave no tail", () => {
  const handler = handlerWith(promptSession([{ text: "summary" }]).session)
  const partitioned = handler.partitionMessages([
    textMessage("user", "the first request"),
    textMessage("assistant", "an answer"),
    textMessage("user", "the request the model is about to answer"),
  ], runOptions())
  // The final user message is the one being answered, so it is kept as the tail as well as summarized.
  assert.equal(partitioned.preservedTailMessages.length, 1)
  assert.equal(turnMessageToString(partitioned.preservedTailMessages[0] as never, true), "the request the model is about to answer")
  assert.equal(partitioned.messagesToSummarize.length, 3)
})

test("a carrier message is not mistaken for something the user said", () => {
  const handler = handlerWith(promptSession([{ text: "summary" }]).session)
  const partitioned = handler.partitionMessages([
    textMessage("user", "the first request"),
    message("user", "an earlier summary", { isSummary: true }),
    textMessage("user", "the request the model is about to answer"),
  ], runOptions())
  assert.equal(turnMessageToString(partitioned.preservedTailMessages[0] as never, true), "the request the model is about to answer")
})

test("a caller that does not want the last user message preserved gets a plain split", () => {
  const handler = handlerWith(promptSession([{ text: "summary" }]).session, { preserveLastUserMessage: false })
  const partitioned = handler.partitionMessages([
    textMessage("user", "the first request"),
    textMessage("assistant", "the first answer"),
    textMessage("user", "the request the model is about to answer"),
    textMessage("assistant", "the answer"),
  ], runOptions())
  assert.deepEqual(partitioned.messagesToSummarize.map(entry => entry.role), ["user", "assistant"])
  assert.deepEqual(partitioned.preservedTailMessages.map(entry => entry.role), ["user", "assistant"])
})

// ---------------------------------------------------------------------------------------------
// writing the summary
// ---------------------------------------------------------------------------------------------

test("a summary that is written comes back with its text and its tokens", async () => {
  const { session, seen } = promptSession([{ text: "the summary" }])
  const handler = handlerWith(session)
  const partitioned = handler.partitionMessages([textMessage("user", "the request")], runOptions())
  const result = await handler.generateSummary(ctx, partitioned, runOptions())
  assert.equal(result.text, "the summary")
  assert.equal(result.hadError, false)
  assert.equal(result.inputTokens, 1_000)
  assert.equal(result.outputTokens, 200)
  // The prompt the summarizer read carries the instructions and the conversation.
  assert.equal(seen.length, 1)
})

test("a summary that cannot be written is reported rather than thrown", async () => {
  const { session } = promptSession([{ error: new Error("the provider is down") }])
  const handler = handlerWith(session)
  const partitioned = handler.partitionMessages([textMessage("user", "the request")], runOptions())
  const result = await handler.generateSummary(ctx, partitioned, runOptions())
  assert.equal(result.text, "No summary generated")
  assert.equal(result.hadError, true)
  assert.notEqual(result.errorKind, undefined)
})

test("a caller that asks for it gets the failure thrown instead", async () => {
  const { session } = promptSession([{ error: new Error("the provider is down") }])
  const handler = handlerWith(session, { throwOnRetryExhaustion: true })
  const partitioned = handler.partitionMessages([textMessage("user", "the request")], runOptions())
  await assert.rejects(() => handler.generateSummary(ctx, partitioned, runOptions()), /Summarization failed after \d+ attempts/)
})

test("an empty answer is a failure rather than an empty summary", async () => {
  const { session } = promptSession([{ text: "   " }])
  const handler = handlerWith(session)
  const partitioned = handler.partitionMessages([textMessage("user", "the request")], runOptions())
  const result = await handler.generateSummary(ctx, partitioned, runOptions())
  assert.equal(result.hadError, true)
})

test("a cancelled run stops trying", async () => {
  const { session, seen } = promptSession([{ error: new Error("the provider is down") }])
  const handler = handlerWith(session)
  const partitioned = handler.partitionMessages([textMessage("user", "the request")], runOptions())
  const result = await handler.generateSummary(ctx, partitioned, runOptions({ cancellationToken: { cancelled: true } }))
  assert.equal(result.hadError, true)
  assert.equal(result.errorKind, "Cancelled")
  assert.deepEqual(seen, [])
})

test("a summary the model could not write falls back to the transcript when allowed", async () => {
  const { session } = promptSession([{ error: new Error("the provider is down") }])
  const handler = handlerWith(session, { enableDeterministicFallback: true })
  const partitioned = handler.partitionMessages([
    textMessage("user", "the request"),
    textMessage("assistant", "an answer"),
  ], runOptions())
  const result = await handler.generateSummary(ctx, partitioned, runOptions({ contextWindowTokens: 1_000_000 }))
  assert.equal(result.hadError, true)
  assert.match(result.text, /partial transcript of a prior conversation/)
  assert.match(result.text, /the request/)
})

test("the fallback is not used unless the caller asked for it", async () => {
  const { session } = promptSession([{ error: new Error("the provider is down") }])
  const handler = handlerWith(session)
  const partitioned = handler.partitionMessages([textMessage("user", "the request")], runOptions())
  const result = await handler.generateSummary(ctx, partitioned, runOptions({ contextWindowTokens: 1_000_000 }))
  assert.equal(result.text, "No summary generated")
})

test("a cancellation is not answered with a substitute summary", () => {
  const handler = handlerWith(promptSession([]).session, { enableDeterministicFallback: true })
  const failed = (errorKind: string): SummarizationRawResult => ({ text: "", inputTokens: undefined, outputTokens: undefined, hadError: true, errorKind })
  assert.equal(handler.shouldUseDeterministicFallback(failed("Cancelled")), false)
  assert.equal(handler.shouldUseDeterministicFallback(failed("Aborted")), false)
  assert.equal(handler.shouldUseDeterministicFallback(failed("InputTokenLimit")), true)
  assert.equal(handler.shouldUseDeterministicFallback({ ...failed("InputTokenLimit"), hadError: false }), false)
  const disabled = handlerWith(promptSession([]).session)
  assert.equal(disabled.shouldUseDeterministicFallback(failed("InputTokenLimit")), false)
})

test("the handler knows a token limit failure when it sees one", () => {
  assert.equal(SummarizationHandler.isTokenLimitError(new InputTokenLimitError()), true)
  assert.equal(SummarizationHandler.isTokenLimitError(new Error("something else")), false)
})

// ---------------------------------------------------------------------------------------------
// the message that carries the summary
// ---------------------------------------------------------------------------------------------

test("the summary is carried by a user message marked as a summary", () => {
  const handler = handlerWith(promptSession([]).session)
  const partitioned = handler.partitionMessages([textMessage("user", "the request")], runOptions())
  const built = handler.buildSummaryMessage(
    { text: "the summary", inputTokens: undefined, outputTokens: undefined, hadError: false },
    partitioned,
    { skillBlocks: [] } as never,
  )
  assert.equal(built.message.role, "user")
  assert.equal(built.summaryTextLength, "[Previous conversation summary]: the summary".length)
  const content = (built.message as unknown as { content: { unwrap(purpose: unknown): string } }).content
  assert.equal(content.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "[Previous conversation summary]: the summary")
})

test("the blocks a summary cannot carry are put back with it", () => {
  const handler = handlerWith(promptSession([]).session)
  const partitioned = handler.partitionMessages([textMessage("user", "the request")], runOptions())
  const built = handler.buildSummaryMessage(
    { text: "the summary", inputTokens: undefined, outputTokens: undefined, hadError: false },
    partitioned,
    { skillBlocks: [], todoContent: "- pending: one", modePrompt: "the mode" } as never,
  )
  const text = (built.message as unknown as { content: { unwrap(purpose: unknown): string } }).content.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
  assert.match(text, /^\[Previous conversation summary\]: the summary/)
  assert.match(text, /NOTE: There was an active todo list/)
  assert.match(text, /the mode/)
})

test("the conversation becomes the two set-aside messages, the summary and the tail", () => {
  const handler = handlerWith(promptSession([]).session)
  const partitioned = handler.partitionMessages([
    textMessage("system", "the platform's framing"),
    textMessage("user", "the first request"),
    textMessage("assistant", "the first answer"),
    textMessage("user", "the request the model is about to answer"),
    textMessage("assistant", "the answer"),
  ], runOptions())
  const summary = textMessage("user", "[Previous conversation summary]: the summary")
  const assembled = handler.assembleFinalMessages(partitioned, summary)
  assert.deepEqual(assembled.map(entry => entry.role), ["system", "user", "user", "assistant"])
  assert.equal(assembled[1], summary)
})

test("a conversation with nothing set aside becomes the summary and the tail", () => {
  const handler = handlerWith(promptSession([]).session)
  const partitioned = handler.partitionMessages([
    textMessage("user", "the first request"),
    textMessage("assistant", "the first answer"),
    textMessage("user", "the request the model is about to answer"),
    textMessage("assistant", "the answer"),
  ], runOptions())
  const summary = textMessage("user", "the summary")
  assert.deepEqual(handler.assembleFinalMessages(partitioned, summary).map(entry => entry.role), ["user", "user", "assistant"])
})

// ---------------------------------------------------------------------------------------------
// what is measured
// ---------------------------------------------------------------------------------------------

test("the length of a conversation is measured on the text the summarizer reads", () => {
  const handler = handlerWith(promptSession([]).session)
  const length = handler.totalRawSerializedCharLength([
    textMessage("user", "hello"),
    message("assistant", [{ type: "text", text: "hi" }]),
  ])
  assert.equal(length, "hello".length + "hi".length)
})

test("a run reports the tokens it used and how much it compressed", () => {
  const handler = handlerWith(promptSession([]).session, { metricsModelLabel: "the-model" })
  // Metrics are reported rather than returned, so what can be checked here is that reporting does not throw
  // and that the labels come from the handler's own model.
  assert.equal(handler.getMetricsModelLabel(), "the-model")
  handler.recordMetrics(ctx, {
    rawSummary: { text: "the summary", inputTokens: 1_000, outputTokens: 200, hadError: false },
    durationMs: 12,
    timeBetweenMessages: 5,
    originalMessages: [textMessage("user", "hello")],
    fullReplacementMessages: [textMessage("user", "the summary")],
    summaryTextLength: 11,
  })
})

test("the model a run is measured against is the session's unless it was labelled", () => {
  const labelled = handlerWith(promptSession([], { modelId: "session-model" }).session, { metricsModelLabel: "labelled" })
  assert.equal(labelled.getMetricsModelLabel(), "labelled")
  const plain = handlerWith(promptSession([], { modelId: "session-model" }).session)
  assert.equal(plain.getMetricsModelLabel(), "session-model")
  assert.equal(plain.getModelId(), "session-model")
})

// ---------------------------------------------------------------------------------------------
// forcing a summary, for the platform's own runs
// ---------------------------------------------------------------------------------------------

test("nothing is forced in production", () => {
  const previous = process.env.NODE_ENV
  process.env.NODE_ENV = "production"
  delete process.env.IS_EVALS_SERVICE
  try {
    assert.equal(shouldForceSummarizationForTesting([textMessage("user", "hello")], "next-human"), undefined)
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous
  }
})

test("an eval can ask for the next human message or for one already in flight", () => {
  assert.equal(shouldForceSummarizationForTesting([textMessage("user", "hello")], "next-human"), BackgroundSummarizationMode.WaitForCompletion)
  assert.equal(shouldForceSummarizationForTesting([textMessage("assistant", "hello")], "next-human"), undefined)
  assert.equal(shouldForceSummarizationForTesting([textMessage("assistant", "hello")], "in-flight"), BackgroundSummarizationMode.WaitForCompletionIfStarted)
  assert.equal(shouldForceSummarizationForTesting([], "next-human"), undefined)
})

test("a debug file can force a summary, and is removed once it fires", () => {
  const file = path.join(os.homedir(), "debug-summarization-strategy.txt")
  const existed = fs.existsSync(file)
  const previous = existed ? fs.readFileSync(file, "utf8") : undefined
  try {
    fs.writeFileSync(file, "next-human")
    assert.equal(shouldForceSummarizationForTesting([textMessage("user", "hello")], undefined), BackgroundSummarizationMode.WaitForCompletion)
    // The file is gone, so the next turn is not forced again.
    assert.equal(fs.existsSync(file), false)
    assert.equal(shouldForceSummarizationForTesting([textMessage("user", "hello")], undefined), undefined)

    fs.writeFileSync(file, "every-human:2")
    // Every second user message, so one on its own is not enough.
    assert.equal(shouldForceSummarizationForTesting([textMessage("user", "one")], undefined), undefined)
    assert.equal(shouldForceSummarizationForTesting([textMessage("user", "one"), textMessage("user", "two")], undefined), BackgroundSummarizationMode.WaitForCompletion)

    fs.writeFileSync(file, "next-tool")
    assert.equal(shouldForceSummarizationForTesting([textMessage("user", "hello")], undefined), undefined)
    assert.equal(
      shouldForceSummarizationForTesting([message("tool", [{ type: "tool-result", toolName: "Read" }])], undefined),
      BackgroundSummarizationMode.WaitForCompletion,
    )
  } finally {
    if (previous === undefined) fs.rmSync(file, { force: true })
    else fs.writeFileSync(file, previous)
  }
})

test("a debug file that says nothing useful forces nothing", () => {
  const file = path.join(os.homedir(), "debug-summarization-strategy.txt")
  const existed = fs.existsSync(file)
  const previous = existed ? fs.readFileSync(file, "utf8") : undefined
  try {
    fs.writeFileSync(file, "something else")
    assert.equal(shouldForceSummarizationForTesting([textMessage("user", "hello")], undefined), undefined)
    fs.writeFileSync(file, "every-human:0")
    assert.equal(shouldForceSummarizationForTesting([textMessage("user", "hello")], undefined), undefined)
  } finally {
    if (previous === undefined) fs.rmSync(file, { force: true })
    else fs.writeFileSync(file, previous)
  }
})

// ---------------------------------------------------------------------------------------------
// what a summary is stored as
// ---------------------------------------------------------------------------------------------

test("the summary text is stored redacted, without the carrier's prefix", () => {
  const prefix = "[Previous conversation summary]: "
  const carrier = toRedactedCoreMessage({
    role: "user",
    content: `${prefix}the summary`,
    providerOptions: { cursor: { isSummary: true } },
  } as never, PrivacyMode.NO_STORAGE)
  const content = (carrier as unknown as { content: unknown }).content
  assert.equal(isRedactedString(content), true)
  const summary = (content as { safeTransform(fn: (value: string) => string): unknown }).safeTransform(value =>
    value.startsWith(prefix) ? value.slice(prefix.length) : value)
  assert.equal((summary as { unwrap(purpose: unknown): string }).unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "the summary")
})

test("a summary written without a carrier is redacted as code", () => {
  const summary = createRedactedString("the summary", DataClassification.CODE, "summary", PrivacyMode.NO_STORAGE)
  assert.equal(summary.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "the summary")
})
// ---------------------------------------------------------------------------------------------
// the edges summarization keeps
// ---------------------------------------------------------------------------------------------

/** A prompt session that records what it was asked and answers from a script. */
function recordingSession(answers: Array<{ text?: string; error?: Error; messages?: Array<{ role: string; content: string }> }>) {
  const prompts: Array<{ messages: readonly { role: string; content: unknown }[]; maxTokens?: number }> = []
  const session: SummarizationPromptSession = {
    getModelId: () => "model-1",
    getExecutor: (messages) => ({
      stream: (_ctx: Context, _request?: unknown, _tools?: unknown, options?: { readonly maxTokens?: number }) => {
        prompts.push({ messages, ...(options?.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }) })
        const answer = answers[Math.min(prompts.length - 1, answers.length - 1)] ?? {}
        return {
          fullStream: (async function* () { yield {} })(),
          extendedUsage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
          usage: Promise.resolve({}),
          providerMetadata: Promise.resolve({}),
          invocationId: Promise.resolve("invocation-1"),
          response: answer.error === undefined
            ? Promise.resolve({ messages: answer.messages ?? [{ role: "assistant", content: answer.text ?? "a summary" }] })
            : Promise.reject(answer.error),
        } as never
      },
    }),
  }
  return { session, prompts }
}

test("when a provider sends several assistant messages, the last one is the summary", async () => {
  const made = recordingSession([{ messages: [{ role: "assistant", content: "first" }, { role: "assistant", content: "last" }] }])
  const result = await handlerWith(made.session).summarize(ctx, [textMessage("system", "sys"), textMessage("user", "ask")], runOptions())
  assert.equal(result.rawSummary.text, "last")
})


test("a prompt over the byte ceiling is first given a smaller character budget", async () => {
  const wide = "你".repeat(3_300_000)
  const made = recordingSession([{ text: "summary" }])
  await handlerWith(made.session, { maxPromptChars: 3_200_000 }).summarize(ctx, [textMessage("system", "sys"), textMessage("user", wide)], runOptions())
  const sent = String(made.prompts[0]?.messages[1]?.content ?? "")
  assert.equal(sent.length < 3_000_000, true)
})

test("a truncated prompt names what was dropped", async () => {
  const made = recordingSession([{ text: "summary" }])
  const messages = [textMessage("system", "sys"), ...Array.from({ length: 200 }, (_value, index) => textMessage(index % 2 === 0 ? "user" : "assistant", "a".repeat(2_000))), textMessage("user", "now")]
  await handlerWith(made.session, { maxPromptChars: 20_000 }).summarize(ctx, messages, runOptions())
  const sent = String(made.prompts[0]?.messages[1]?.content ?? "")
  assert.match(sent, /omitted due to size limits/)
})

test("a later attempt keeps the prompt budget above what a prompt needs", async () => {
  const made = recordingSession([
    { error: new InputTokenLimitError("too big") },
    { error: new InputTokenLimitError("still too big") },
    { text: "summary" },
  ])
  const long = "a".repeat(120_000)
  await handlerWith(made.session, { enableReduceInputsRetry: true }).summarize(ctx, [textMessage("system", "sys"), textMessage("user", long)], runOptions())
  const third = String(made.prompts[2]?.messages[1]?.content ?? "")
  assert.equal(third.length > 40_000, true)
})

test("a control character the provider cannot read is stripped on the final input-limit retry", async () => {
  const made = recordingSession([
    { error: new InputTokenLimitError("too big") },
    { error: new InputTokenLimitError("still too big") },
    { text: "summary" },
  ])
  const withControl = "ask " + String.fromCharCode(1) + " once"
  await handlerWith(made.session, { enableReduceInputsRetry: true }).summarize(ctx, [textMessage("system", "sys"), textMessage("user", withControl)], runOptions())
  const third = String(made.prompts[2]?.messages[1]?.content ?? "")
  assert.equal(third.includes(String.fromCharCode(1)), false)
})

test("an attempt is retried, and the last attempt is the last one", async () => {
  const made = recordingSession([{ error: new Error("broken") }, { text: "second time" }])
  const result = await handlerWith(made.session).summarize(ctx, [textMessage("system", "sys"), textMessage("user", "ask")], runOptions())
  assert.equal(result.rawSummary.text, "second time")
  assert.equal(made.prompts.length, 2)
})

test("an output limit asks the next attempt for a shorter answer", async () => {
  const made = recordingSession([{ error: new OutputTokensLimitExceededError("too long") }, { text: "shorter" }])
  const result = await handlerWith(made.session).summarize(ctx, [textMessage("system", "sys"), textMessage("user", "ask")], runOptions())
  assert.equal(result.rawSummary.text, "shorter")
  const second = String(made.prompts[1]?.messages[1]?.content ?? "")
  assert.match(second, /Additional instruction: Write a shorter summary/)
})

test("an input limit sends the next attempt a smaller prompt", async () => {
  const made = recordingSession([{ error: new InputTokenLimitError("too big") }, { text: "fits" }])
  const long = "a".repeat(80_000)
  await handlerWith(made.session, { enableReduceInputsRetry: true }).summarize(ctx, [textMessage("system", "sys"), textMessage("user", long)], runOptions())
  const first = String(made.prompts[0]?.messages[1]?.content ?? "")
  const second = String(made.prompts[1]?.messages[1]?.content ?? "")
  assert.equal(second.length < first.length, true)
})

test("a carrier summary is not a user message when the split is decided", () => {
  const session = promptSession([{ text: "summary" }])
  const handler = handlerWith(session.session)
  const carrier = message("user", "[Previous conversation summary]: earlier", { isSummary: true })
  const parts = handler.partitionMessages([textMessage("system", "sys"), textMessage("user", "old"), carrier, textMessage("assistant", "after")], runOptions())
  assert.equal(parts.preservedTailMessages.length, 1)
  const tailContent = parts.preservedTailMessages[0]?.content
  assert.equal(isRedactedString(tailContent) ? tailContent.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED) : tailContent, "old")
})

test("an image in the preserved tail is not carried into the summary a second time", () => {
  const session = promptSession([{ text: "summary" }])
  const handler = handlerWith(session.session, { preserveLatestImage: true })
  const image = { type: "image", data: new Uint8Array([9]), mimeType: "image/png" }
  const withImage = message("user", [{ type: "text", text: "shot" }, image])
  const summarizedImage = message("user", [{ type: "text", text: "older shot" }, image])
  const parts = {
    systemMessage: textMessage("system", "sys"),
    userInfoMessage: undefined,
    messagesToSummarize: [textMessage("user", "old"), summarizedImage],
    preservedTailMessages: [withImage],
    skillBlocks: [],
  }
  const built = handler.buildSummaryMessage({ text: "summary", inputTokens: 1, outputTokens: 1, hadError: false }, parts as never, { skillBlocks: [], todoContent: undefined, currentPlan: undefined, modePrompt: undefined, projectRootPrompt: undefined, automationTriggerContext: undefined, agentTranscriptsFolder: undefined, conversationId: undefined })
  assert.equal(Array.isArray(built.message.content), false)
})

test("the deterministic fallback honors the window ratio it was given", async () => {
  const long = "x".repeat(150_000)
  const messages = [textMessage("system", "sys"), textMessage("user", long), textMessage("assistant", long)]
  const failing = [{ error: new Error("broken") }, { error: new Error("broken") }, { error: new Error("broken") }]
  const small = recordingSession(failing)
  const smallResult = await handlerWith(small.session, { enableDeterministicFallback: true, deterministicFallbackWindowRatio: 0.0001 }).summarize(ctx, messages, runOptions({ contextWindowTokens: 1_000_000 }))
  const normal = recordingSession(failing)
  const normalResult = await handlerWith(normal.session, { enableDeterministicFallback: true }).summarize(ctx, messages, runOptions({ contextWindowTokens: 1_000_000 }))
  assert.equal(smallResult.rawSummary.text.length < normalResult.rawSummary.text.length, true)
})
