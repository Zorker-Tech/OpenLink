import { test } from "node:test"
import assert from "node:assert/strict"

import { requestPromptSuggestion } from "../../source/packages/agent/prompt-suggestion/prompt-suggestion-handler.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import { toRedactedCoreMessages, type CoreMessageLike } from "../../source/packages/redaction/message-redaction.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { PrivacyCapability } from "../../source/packages/redaction/classification.ts"
import { PROMPT_SUGGESTION_MAX_WORDS } from "../../source/packages/agent/prompts/prompt-suggestion.ts"

// ---------------------------------------------------------------------------------------------
// a conversation executor that answers with whatever the test wants it to
// ---------------------------------------------------------------------------------------------

interface StreamOptions {
  readonly maxTokens: number
}

interface ExecutorHarness {
  readonly log: string[]
  readonly streamCalls: Array<{ invocationId: string; tools: readonly unknown[]; options: StreamOptions }>
  readonly executor: {
    getMessages(): ReturnType<typeof toRedactedCoreMessages>
    clearMessages(): void
    appendMessages(messages: ReturnType<typeof toRedactedCoreMessages>): void
    stream(ctx: Context, invocationId: string, tools: readonly unknown[], options: StreamOptions): {
      response: Promise<unknown>
      fullStream: AsyncIterable<{ type: string; textDelta?: string }>
      extendedUsage: Promise<{ inputTokens: number; cacheReadTokens: number }>
    }
  }
  readonly updates: string[]
}

function harness(options: {
  answer: string
  failWith?: unknown
  usage?: { inputTokens: number; cacheReadTokens: number }
  initialMessages?: ReturnType<typeof toRedactedCoreMessages>
}): ExecutorHarness {
  const log: string[] = []
  const streamCalls: ExecutorHarness["streamCalls"] = []
  const updates: string[] = []
  let messages = options.initialMessages ?? []
  return {
    log,
    streamCalls,
    updates,
    executor: {
      getMessages: () => { log.push("getMessages"); return messages },
      clearMessages: () => { log.push("clearMessages"); messages = [] },
      appendMessages: next => { log.push(`appendMessages:${next.length}`); messages = [...messages, ...next] },
      stream: (_ctx, invocationId, tools, streamOptions) => {
        log.push("stream")
        streamCalls.push({ invocationId, tools, options: streamOptions })
        return {
          response: options.failWith === undefined ? Promise.resolve({}) : Promise.reject(options.failWith),
          fullStream: (async function* () {
            yield { type: "text-delta", textDelta: options.answer }
          })(),
          extendedUsage: Promise.resolve(options.usage ?? { inputTokens: 100, cacheReadTokens: 25 }),
        }
      },
    },
  }
}

const listenerOf = (updates: string[]): { sendUpdate(_ctx: Context, update: unknown): void } => ({
  sendUpdate: (_ctx, update) => {
    const value = (update as { message?: { case?: string; value?: { suggestion?: string } } }).message
    updates.push(value?.value?.suggestion ?? "")
  },
})

async function suggest(
  harnessed: ExecutorHarness,
  options: {
    model?: string
    snapshot?: ReturnType<typeof toRedactedCoreMessages>
    price?: { maxInputTokenCost?: number; getModelInputCostForContext?: (model: string, tokens: number) => number }
    tools?: readonly unknown[]
  } = {},
): Promise<void> {
  await requestPromptSuggestion(
    createContext(),
    "invocation-1",
    options.model ?? "composer-2",
    harnessed.executor,
    listenerOf(harnessed.updates),
    options.tools ?? [],
    options.snapshot,
    options.price,
  )
}

const conversation = (): ReturnType<typeof toRedactedCoreMessages> =>
  toRedactedCoreMessages([{ role: "user", content: "what does this code do?" }], PrivacyMode.NO_STORAGE)

// ---------------------------------------------------------------------------------------------
// what counts as a suggestion
// ---------------------------------------------------------------------------------------------

test("a plain answer is sent as the suggestion", async () => {
  const harnessed = harness({ answer: "explain this function" })
  await suggest(harnessed)
  assert.deepEqual(harnessed.updates, ["explain this function"])
})

test("a quoted answer is sent without its quotes", async () => {
  const harnessed = harness({ answer: '"add a test for this"' })
  await suggest(harnessed)
  assert.deepEqual(harnessed.updates, ["add a test for this"])
})

test("only the first line is a suggestion", async () => {
  const harnessed = harness({ answer: "fix the failing test\n\nHere is why it fails: the mock is wrong." })
  await suggest(harnessed)
  assert.deepEqual(harnessed.updates, ["fix the failing test"])
})

test("an answer that continues the conversation is not a suggestion", async () => {
  const harnessed = harness({ answer: "Human: what does this do?\nAssistant: it parses the file." })
  await suggest(harnessed)
  assert.deepEqual(harnessed.updates, [])
})

test("an answer that thinks out loud is not a suggestion", async () => {
  const harnessed = harness({ answer: "<think>the user probably wants</think> a summary" })
  await suggest(harnessed)
  assert.deepEqual(harnessed.updates, [])
})

test("an answer longer than a suggestion is not sent", async () => {
  const tooLong = Array.from({ length: PROMPT_SUGGESTION_MAX_WORDS + 1 }, (_value, index) => `word${index}`).join(" ")
  const harnessed = harness({ answer: tooLong })
  await suggest(harnessed)
  assert.deepEqual(harnessed.updates, [])
})

test("an answer of exactly the maximum length is sent", async () => {
  const atLimit = Array.from({ length: PROMPT_SUGGESTION_MAX_WORDS }, (_value, index) => `word${index}`).join(" ")
  const harnessed = harness({ answer: atLimit })
  await suggest(harnessed)
  assert.deepEqual(harnessed.updates, [atLimit])
})

test("an empty answer is not sent", async () => {
  const harnessed = harness({ answer: "   " })
  await suggest(harnessed)
  assert.deepEqual(harnessed.updates, [])
})

test("a session's own silence tag means the model deliberately said nothing", async () => {
  const harnessed = harness({ answer: "<silence/>" })
  await suggest(harnessed)
  assert.deepEqual(harnessed.updates, [])
})

test("an answer that is only quotes is not sent", async () => {
  const harnessed = harness({ answer: '""' })
  await suggest(harnessed)
  assert.deepEqual(harnessed.updates, [])
})

// ---------------------------------------------------------------------------------------------
// what the request does to the conversation
// ---------------------------------------------------------------------------------------------

test("the suggestion's own instruction is appended to the conversation and taken back afterwards", async () => {
  const initialMessages = conversation()
  const harnessed = harness({ answer: "explain this function", initialMessages })
  await suggest(harnessed)

  assert.deepEqual(harnessed.log, ["getMessages", "appendMessages:1", "stream", "clearMessages", "appendMessages:1"])
  // The conversation is handed back exactly as it was found.
  assert.deepEqual(harnessed.executor.getMessages(), initialMessages)
})

test("a snapshot replaces what the executor holds before the suggestion is asked for", async () => {
  const harnessed = harness({ answer: "explain this function", initialMessages: conversation() })
  const snapshot = toRedactedCoreMessages([{ role: "user", content: "a different question" }], PrivacyMode.NO_STORAGE)
  await suggest(harnessed, { snapshot })

  assert.deepEqual(harnessed.log, ["clearMessages", "appendMessages:1", "appendMessages:1", "stream", "clearMessages", "appendMessages:1"])
  assert.deepEqual(harnessed.executor.getMessages(), snapshot)
})

test("the conversation is restored even when the call fails", async () => {
  const initialMessages = conversation()
  const harnessed = harness({ answer: "", failWith: new Error("provider refused"), initialMessages })
  await suggest(harnessed)
  assert.deepEqual(harnessed.updates, [])
  assert.deepEqual(harnessed.executor.getMessages(), initialMessages)
})

test("a stream that breaks mid-answer is swallowed like any other failure", async () => {
  const initialMessages = conversation()
  const harnessed = harness({ answer: "explain", initialMessages })
  const brokenExecutor = {
    ...harnessed.executor,
    stream: () => ({
      response: Promise.resolve({}),
      fullStream: (async function* () { throw new Error("the stream broke") })(),
      extendedUsage: Promise.resolve({ inputTokens: 1, cacheReadTokens: 0 }),
    }),
  }
  await requestPromptSuggestion(
    createContext(),
    "invocation-1",
    "composer-2",
    brokenExecutor,
    listenerOf(harnessed.updates),
    [],
    undefined,
    undefined,
  )
  assert.deepEqual(harnessed.updates, [])
  assert.deepEqual(brokenExecutor.getMessages(), initialMessages)
})

// ---------------------------------------------------------------------------------------------
// how much the suggestion is allowed to cost
// ---------------------------------------------------------------------------------------------

test("a model that would cost too much is skipped before anything is asked of it", async () => {
  const harnessed = harness({ answer: "explain this function" })
  await suggest(harnessed, {
    price: { maxInputTokenCost: 0.01, getModelInputCostForContext: () => 0.5 },
  })
  assert.deepEqual(harnessed.updates, [])
  // The conversation is read to estimate it, and then nothing else happens to it.
  assert.deepEqual(harnessed.log, ["getMessages"])
  assert.deepEqual(harnessed.streamCalls, [])
})

test("a model within the cost ceiling is asked, and the estimate covers the instructions too", async () => {
  const seen: Array<{ model: string; tokens: number }> = []
  const harnessed = harness({ answer: "explain this function" })
  await suggest(harnessed, {
    model: "composer-2",
    price: {
      maxInputTokenCost: 1,
      getModelInputCostForContext: (model, tokens) => { seen.push({ model, tokens }); return 0.001 },
    },
  })
  assert.deepEqual(harnessed.updates, ["explain this function"])
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.model, "composer-2")
  // A fixed allowance for the instructions is added to the estimate of the conversation itself.
  assert.equal((seen[0]?.tokens ?? 0) >= 20_000, true)
})

test("a ceiling of nothing means no ceiling", async () => {
  const harnessed = harness({ answer: "explain this function" })
  await suggest(harnessed, { price: { maxInputTokenCost: 0, getModelInputCostForContext: () => 1_000 } })
  assert.deepEqual(harnessed.updates, ["explain this function"])
})

test("a session with no cost function asks without estimating", async () => {
  const harnessed = harness({ answer: "explain this function" })
  await suggest(harnessed, { price: { maxInputTokenCost: 0.01 } })
  assert.deepEqual(harnessed.updates, ["explain this function"])
})

// ---------------------------------------------------------------------------------------------
// what the model is asked
// ---------------------------------------------------------------------------------------------

test("a model that reads more context is allowed a longer suggestion", async () => {
  const plain = harness({ answer: "explain this function" })
  await suggest(plain, { model: "composer-2" })
  assert.equal(plain.streamCalls[0]?.options.maxTokens, 64)

  const largeContext = harness({ answer: "explain this function" })
  await suggest(largeContext, { model: "dsv3-1205" })
  assert.equal(largeContext.streamCalls[0]?.options.maxTokens, 128)
})

test("the tools and the invocation the turn is using are handed to the suggestion", async () => {
  const tools = [{ name: "Read" }]
  const harnessed = harness({ answer: "explain this function" })
  await suggest(harnessed, { tools })
  assert.equal(harnessed.streamCalls[0]?.invocationId, "invocation-1")
  assert.deepEqual(harnessed.streamCalls[0]?.tools, tools)
})

test("a usage report with no input tokens is not a division by zero", async () => {
  const harnessed = harness({ answer: "explain this function", usage: { inputTokens: 0, cacheReadTokens: 0 } })
  await suggest(harnessed)
  assert.deepEqual(harnessed.updates, ["explain this function"])
})

test("the instruction the model is given is the suggestion instruction", async () => {
  const seen: Array<{ role: string; content: unknown }> = []
  const harnessed = harness({ answer: "explain this function" })
  const executor = {
    ...harnessed.executor,
    appendMessages: (messages: ReturnType<typeof toRedactedCoreMessages>) => {
      for (const message of messages) {
        const unwrapped = message as unknown as { unwrap(purpose: PrivacyCapability): CoreMessageLike }
        seen.push({ role: String((message as { role: string }).role), content: unwrapped })
      }
    },
  }
  await requestPromptSuggestion(
    createContext(),
    "invocation-1",
    "composer-2",
    executor,
    listenerOf(harnessed.updates),
    [],
    undefined,
    undefined,
  )
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.role, "user")
})
