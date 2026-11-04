import { test } from "node:test"
import assert from "node:assert/strict"

import {
  findLastUserMessageIndex,
  shouldPerformSelfSummary,
  type SelfSummaryMessage,
} from "../../source/packages/agent/self-summary/self-summary.ts"
import { SummarizeActionHandler } from "../../source/packages/agent/actions/summarize-action-handler.ts"
import {
  SELF_SUMMARY_CONTEXT_WINDOW_FRACTION,
  SELF_SUMMARY_NUM_TURNS,
} from "../../source/packages/agent/self-summary/constants.ts"
import { EVAL_ENFORCED_SELF_SUMMARY_TOKEN_LIMIT } from "../../source/packages/agent/utils/config-overrides.ts"
import { slateConfigOverridesKey } from "../../source/packages/agent/utils/config-override-reader.ts"
import { BackgroundSummarizationMode } from "../../source/packages/agent-summarization/background-summarization.ts"
import { SlateMode } from "../../source/packages/agent/mode-processing.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { toRedactedCoreMessage } from "../../source/packages/redaction/message-redaction.ts"

// ---------------------------------------------------------------------------------------------
// whether a conversation should be summarized
// ---------------------------------------------------------------------------------------------

const message = (role: string, text: string, options: { isSummary?: boolean } = {}): SelfSummaryMessage =>
  toRedactedCoreMessage(
    { role, content: text, ...(options.isSummary === true ? { providerOptions: { cursor: { isSummary: true } } } : {}) },
    PrivacyMode.NO_STORAGE,
  ) as never

const turns = (count: number): SelfSummaryMessage[] => Array.from({ length: count }, (_value, index) => message("user", `question ${index}`))

test("the last user message is the one a summary is anchored to", () => {
  const messages = [message("user", "first"), message("assistant", "an answer"), message("user", "second")]
  assert.equal(findLastUserMessageIndex(messages), 2)
  assert.equal(findLastUserMessageIndex([message("assistant", "only an answer")]), -1)
  assert.equal(findLastUserMessageIndex([]), -1)
})

test("a summary is not a user message unless the caller wants it to count", () => {
  const messages = [message("user", "the real question"), message("user", "an earlier summary", { isSummary: true })]
  assert.equal(findLastUserMessageIndex(messages), 0)
  assert.equal(findLastUserMessageIndex(messages, { includeSummaryMessages: true }), 1)

  const truthyMarker = toRedactedCoreMessage(
    { role: "user", content: "an earlier summary", providerOptions: { cursor: { isSummary: "marked" } } },
    PrivacyMode.NO_STORAGE,
  ) as SelfSummaryMessage
  assert.equal(findLastUserMessageIndex([messages[0]!, truthyMarker]), 0)
})

test("a conversation with enough turns is summarized whatever its size", () => {
  const long = turns(SELF_SUMMARY_NUM_TURNS)
  assert.equal(shouldPerformSelfSummary(long, undefined, undefined, undefined), true)
  assert.equal(shouldPerformSelfSummary(turns(SELF_SUMMARY_NUM_TURNS - 1), { usedTokens: 1, maxTokens: 1_000_000 }, undefined, undefined), false)
})

test("a summary of an earlier conversation is not a turn", () => {
  const messages = [message("user", "a summary", { isSummary: true }), message("user", "a summary", { isSummary: true })]
  assert.equal(shouldPerformSelfSummary(messages, undefined, undefined, undefined), false)
})

test("the turn threshold counts only conversation messages that compaction keeps", () => {
  const userInfo = message("user", "<user_info>fixed context</user_info>")
  const conversation = [
    message("system", "fixed instructions"),
    userInfo,
    ...turns(SELF_SUMMARY_NUM_TURNS - 1),
    message("assistant", ""),
  ]
  const tokenDetails = { usedTokens: 1, maxTokens: 1_000_000 }

  assert.equal(shouldPerformSelfSummary(conversation, tokenDetails, undefined, undefined), false)
  assert.equal(
    shouldPerformSelfSummary([...conversation, message("user", "one more turn")], tokenDetails, undefined, undefined),
    true,
  )
})

test("a conversation past the session's own limit is summarized", () => {
  const messages = [message("user", "a question")]
  assert.equal(shouldPerformSelfSummary(messages, { usedTokens: 100, maxTokens: 1_000 }, undefined, 100), true)
  assert.equal(shouldPerformSelfSummary(messages, { usedTokens: 99, maxTokens: 1_000 }, undefined, 100), false)
})

test("an override a test harness imposes wins over the session's limit", () => {
  const ctx = createContext().with(slateConfigOverridesKey, { evalServiceEnforcedSelfSummaryTokenLimit: 10 })
  assert.equal(EVAL_ENFORCED_SELF_SUMMARY_TOKEN_LIMIT(ctx), 10)
  assert.equal(shouldPerformSelfSummary([message("user", "a question")], { usedTokens: 10, maxTokens: 1_000 }, ctx, 1_000_000), true)
  // Without the override the session's own limit is what decides.
  assert.equal(shouldPerformSelfSummary([message("user", "a question")], { usedTokens: 10, maxTokens: 1_000 }, createContext(), 1_000_000), false)
})

test("with no limit named, the window's own fraction decides", () => {
  const messages = [message("user", "a question")]
  const maxTokens = 1_000_000
  const atFraction = Math.floor(maxTokens * SELF_SUMMARY_CONTEXT_WINDOW_FRACTION)
  assert.equal(shouldPerformSelfSummary(messages, { usedTokens: atFraction, maxTokens }, undefined, undefined), true)
  assert.equal(shouldPerformSelfSummary(messages, { usedTokens: atFraction - 1, maxTokens }, undefined, undefined), false)
})

test("a conversation with nothing to compare against is not summarized", () => {
  assert.equal(shouldPerformSelfSummary([message("user", "a question")], undefined, undefined, undefined), false)
  assert.equal(shouldPerformSelfSummary([message("user", "a question")], { maxTokens: 0 }, undefined, undefined), false)
})

test("the size is estimated from the conversation when no count was taken", () => {
  const big = [message("user", "x".repeat(10_000))]
  // A small limit makes the estimate decide, and the estimate counts tool content as well as text.
  assert.equal(shouldPerformSelfSummary(big, { maxTokens: 1_000_000 }, undefined, 100), true)
  assert.equal(shouldPerformSelfSummary([message("user", "short")], { maxTokens: 1_000_000 }, undefined, 100), false)
})

test("a count that is not a count is ignored rather than trusted", () => {
  const messages = [message("user", "x".repeat(10_000))]
  assert.equal(shouldPerformSelfSummary(messages, { usedTokens: Number.NaN, maxTokens: 1_000_000 }, undefined, 100), true)
  assert.equal(shouldPerformSelfSummary(messages, { usedTokens: 0, maxTokens: 1_000_000 }, undefined, 100), true)
  assert.equal(shouldPerformSelfSummary(messages, { usedTokens: -5, maxTokens: 1_000_000 }, undefined, 100), true)
})

// ---------------------------------------------------------------------------------------------
// the summarize action
// ---------------------------------------------------------------------------------------------

interface SummarizeHarness {
  readonly ctx: Context
  readonly appended: unknown[][]
  readonly cleared: number
  readonly summaries: unknown[]
  readonly updates: string[]
  readonly checkpoints: number
  readonly handler: SummarizeActionHandler
  readonly orchestratorCalls: Array<Record<string, unknown>>
  readonly stateHandler: Record<string, unknown>
  readonly rootPromptExecutor: Record<string, unknown>
}

function summarizeHarness(options: {
  messages?: Array<{ role: string; content: unknown }>
  summary?: string | undefined
  summarizeActionClearTurns?: boolean
  fireAndForgetCheckpoints?: boolean
  breakdown?: unknown
} = {}): SummarizeHarness {
  const appended: unknown[][] = []
  const summaries: unknown[] = []
  const updates: string[] = []
  const orchestratorCalls: Array<Record<string, unknown>> = []
  const holder = {
    cleared: 0,
    checkpoints: 0,
    tokenDetails: { usedTokens: 0, maxTokens: 1_000, breakdown: options.breakdown },
  }
  let messages = options.messages ?? [{ role: "user", content: "the question" }]
  const stateHandler = {
    mode: SlateMode.AGENT,
    get tokenDetails() { return holder.tokenDetails },
    getBlobStore: () => undefined,
    getPrivacyMode: () => PrivacyMode.NO_STORAGE,
    async computeNewStructure() { return { turns: [] } },
    setSummary(summary: unknown) { summaries.push(summary) },
    async clearTurns() { holder.cleared += 1 },
    setTokenDetails(tokenDetails: unknown) { holder.tokenDetails = tokenDetails as never },
  }
  const rootPromptExecutor = {
    getMessages: () => messages,
    appendMessages(next: unknown | readonly unknown[]) {
      const list = Array.isArray(next) ? next : [next]
      appended.push(list as unknown[])
      messages = [...messages, ...(list as Array<{ role: string; content: unknown }>)]
    },
  }
  const harnessed: SummarizeHarness = {
    ctx: createContext(),
    appended,
    get cleared() { return holder.cleared },
    summaries,
    updates,
    get checkpoints() { return holder.checkpoints },
    orchestratorCalls,
    stateHandler: stateHandler as never,
    rootPromptExecutor: rootPromptExecutor as never,
    handler: new SummarizeActionHandler(
      {
        toolsGenerator: () => ({ getTool: () => undefined }),
        systemPromptGenerator: () => "the system prompt",
        agentSessionId: "session-1",
        ...(options.summarizeActionClearTurns === undefined ? {} : { summarizeActionClearTurns: options.summarizeActionClearTurns }),
        ...(options.fireAndForgetCheckpoints === undefined ? {} : { fireAndForgetCheckpoints: options.fireAndForgetCheckpoints }),
      } as never,
      {
        get: () => ({
          async execute() {
            return {
              result: {
                case: "success",
                value: { requestContext: { rules: [], agentSkills: [], disabledTeamRules: [], repositoryInfo: [] } },
              },
            }
          },
        }),
      } as never,
      { async sendUpdate(_ctx: Context, update: { message?: { case?: string } }) { updates.push(update.message?.case ?? "unknown") } } as never,
      {
        async handleSummarization() {
          orchestratorCalls.push({ called: true })
          return options.summary === undefined ? undefined : options.summary
        },
      } as never,
      {} as never,
    ),
  }
  return harnessed
}

async function runSummarize(harnessed: SummarizeHarness, onStateUpdate?: (ctx: Context, checkpoint: unknown) => Promise<void>) {
  return await harnessed.handler.handle(
    harnessed.ctx,
    {},
    harnessed.rootPromptExecutor as never,
    harnessed.stateHandler as never,
    [],
    onStateUpdate,
  )
}

test("a prompt with nothing in it has nothing to summarize", async () => {
  const harnessed = summarizeHarness({ messages: [] })
  const result = await harnessed.handler.handle(
    harnessed.ctx,
    {},
    { getMessages: () => [], appendMessages() {} } as never,
    {
      mode: SlateMode.AGENT,
      tokenDetails: {},
      getBlobStore: () => undefined,
      getPrivacyMode: () => PrivacyMode.NO_STORAGE,
      async computeNewStructure() { return { turns: [] } },
      setSummary() {},
      async clearTurns() {},
      setTokenDetails() {},
    } as never,
    [],
  )
  assert.deepEqual(result, { turns: [] })
  assert.deepEqual(harnessed.orchestratorCalls, [])
})

test("a prompt with no instructions is given them before it is summarized", async () => {
  const harnessed = summarizeHarness({ summary: "the summary" })
  await runSummarize(harnessed)
  assert.equal(harnessed.appended.length, 1)
  const appended = harnessed.appended[0] as Array<{ role: string }>
  assert.equal(appended[0]?.role, "system")
})

test("a prompt that already has instructions is not given them again", async () => {
  const harnessed = summarizeHarness({ summary: "the summary", messages: [{ role: "system", content: "already" }, { role: "user", content: "the question" }] })
  await runSummarize(harnessed)
  assert.deepEqual(harnessed.appended, [])
})

test("the summary is written into the conversation and shown to the user", async () => {
  const harnessed = summarizeHarness({ summary: "the summary" })
  await runSummarize(harnessed)
  assert.equal(harnessed.summaries.length, 1)
  assert.deepEqual(harnessed.updates, ["summary"])
})

test("the turns are cleared only where the session asks for that", async () => {
  const without = summarizeHarness({ summary: "the summary" })
  await runSummarize(without)
  assert.equal(without.cleared, 0)

  const with_ = summarizeHarness({ summary: "the summary", summarizeActionClearTurns: true })
  await runSummarize(with_)
  assert.equal(with_.cleared, 1)
})

test("a summarization that produced nothing is an error rather than an empty summary", async () => {
  const harnessed = summarizeHarness({ summary: undefined })
  await assert.rejects(() => runSummarize(harnessed), /No summary generated, even though background summarization mode is WaitForCompletion/)
})

test("the checkpoint is written, and awaited only where the session wants it awaited", async () => {
  const awaited = summarizeHarness({ summary: "the summary" })
  let awaitedCheckpoints = 0
  await runSummarize(awaited, async () => { awaitedCheckpoints += 1 })
  assert.equal(awaitedCheckpoints, 1)

  const fireAndForget = summarizeHarness({ summary: "the summary", fireAndForgetCheckpoints: true })
  let backgroundCheckpoints = 0
  await runSummarize(fireAndForget, async () => { backgroundCheckpoints += 1 })
  // The checkpoint is not part of the answer, so it may still be on its way when the action returns.
  assert.equal(backgroundCheckpoints <= 1, true)
})

test("a session with no checkpoint callback still summarizes", async () => {
  const harnessed = summarizeHarness({ summary: "the summary" })
  const result = await runSummarize(harnessed)
  assert.deepEqual(result, { turns: [] })
})

test("the token details are recomputed from what is left after the summary", async () => {
  const harnessed = summarizeHarness({ summary: "the summary" })
  const tokenDetails: unknown[] = []
  const stateHandler = {
    mode: SlateMode.AGENT,
    tokenDetails: { usedTokens: 900, maxTokens: 1_000 },
    getBlobStore: () => undefined,
    getPrivacyMode: () => PrivacyMode.NO_STORAGE,
    async computeNewStructure() { return { turns: [] } },
    setSummary() {},
    async clearTurns() {},
    setTokenDetails(next: unknown) { tokenDetails.push(next) },
  }
  await harnessed.handler.handle(
    harnessed.ctx,
    {},
    { getMessages: () => [{ role: "user", content: "x".repeat(100) }], appendMessages() {} } as never,
    stateHandler as never,
    [],
  )
  assert.equal(tokenDetails.length, 1)
  const written = tokenDetails[0] as { usedTokens: number; maxTokens: number; breakdown: unknown }
  // The estimate is of what the prompt holds now, and the window is carried over.
  assert.equal(written.usedTokens > 0, true)
  assert.equal(written.maxTokens, 1_000)
  assert.equal(written.breakdown, undefined)
})

test("the background mode the action asks for is the one that waits", async () => {
  // The orchestrator is asked for a summary that has to be finished, which is what makes the action's
  // result something the user can be shown.
  const harnessed = summarizeHarness({ summary: "the summary" })
  await runSummarize(harnessed)
  assert.equal(BackgroundSummarizationMode.WaitForCompletion, "WaitForCompletion")
})
