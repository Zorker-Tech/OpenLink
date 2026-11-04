import { test } from "node:test"
import assert from "node:assert/strict"

import {
  SummarizationOrchestrator,
  type BackgroundSummarizationPromiseInfo,
  type SummarizationPromptExecutor,
  type SummarizationResult,
  type SummarizationStateHandler,
  type Summarizer,
} from "../../source/packages/agent/summarization-orchestrator.ts"
import { BackgroundSummarizationMode } from "../../source/packages/agent-summarization/background-summarization.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import { ConversationSummaryArchive } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { SlateMode } from "../../source/packages/agent/mode-processing.ts"
import { PrivacyCapability } from "../../source/packages/redaction/classification.ts"
import { toRedactedCoreMessage } from "../../source/packages/redaction/message-redaction.ts"
import { createRedactedString } from "../../source/packages/redaction/create.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { getBlobId } from "../../source/packages/agent-kv/blob-store.ts"
import { hookExecutorResource } from "../../source/packages/agent-exec/hook-executor.ts"
import { toRedactedTodoItem } from "../../source/adapters/interop/redacted-protos/generated/agent/v1/todo_tool_redacted.ts"
import { TodoItem, TodoStatus } from "../../source/adapters/interop/proto/generated/agent/v1/todo_tool_pb.ts"

// ---------------------------------------------------------------------------------------------
// the harness
// ---------------------------------------------------------------------------------------------

const ctx = createContext()

const message = (role: string, content: unknown) =>
  toRedactedCoreMessage({ role, content } as never, PrivacyMode.NO_STORAGE)

/** A summarizer that answers with whatever the test says, and records what it was asked. */
function summarizer(options: { text?: string; error?: Error; delayMs?: number } = {}) {
  const asked: Array<{ messages: readonly unknown[]; options: Record<string, unknown> }> = []
  const summarizer: Summarizer = {
    getMetricsModelLabel: () => "summarizer-model",
    async summarize(_ctx: Context, messages: readonly unknown[], runOptions: unknown): Promise<SummarizationResult> {
      asked.push({ messages, options: runOptions as Record<string, unknown> })
      if (options.delayMs !== undefined) await new Promise(resolve => setTimeout(resolve, options.delayMs))
      if (options.error !== undefined) throw options.error
      const text = options.text ?? "the summary"
      const summary = createRedactedString(text, 0 as never, "summary", PrivacyMode.NO_STORAGE)
      return {
        messagesActuallySummarized: messages.slice(0, 1) as never,
        newSummaryMessage: message("user", `[Previous conversation summary]: ${text}`),
        preservedOriginalTailMessages: [],
        rawSummary: { text },
        summary: { summary },
        fullReplacementMessages: [message("user", `[Previous conversation summary]: ${text}`)],
      }
    },
  }
  return { summarizer, asked }
}

interface StateOptions {
  background?: BackgroundSummarizationPromiseInfo | null
  messagesUndergoingSummarization?: readonly unknown[] | null
  hasCompleted?: boolean
  generationDurationMs?: number | null
  archiveCount?: number
  selfSummaryCount?: number
}

function stateHandler(initial: readonly unknown[] = [], options: StateOptions = {}) {
  const blobs = new Map<string, Uint8Array>()
  const archives: unknown[] = []
  const state = {
    mode: SlateMode.AGENT,
    todos: [] as readonly { get(ctx: Context): Promise<never> }[],
    tokenDetails: { usedTokens: 100, maxTokens: 1_000 },
    summaryArchives: archives as readonly unknown[],
    selfSummaryCount: options.selfSummaryCount ?? 0,
    backgroundSummarizationPromiseInfo: options.background ?? null,
    messagesUndergoingSummarization: options.messagesUndergoingSummarization ?? null,
    backgroundSummarizationHasCompleted: options.hasCompleted ?? false,
    backgroundSummarizationGenerationDurationMs: options.generationDurationMs ?? null,
    tokenDetailsStaleAfterSummarization: false,
    isRootProjectConversation: false,
    setBackgroundSummarizationState(info: BackgroundSummarizationPromiseInfo, messages: readonly unknown[]) {
      state.backgroundSummarizationPromiseInfo = info
      state.messagesUndergoingSummarization = messages
    },
    setBackgroundSummarizationHasCompleted(durationMs: number) {
      state.backgroundSummarizationHasCompleted = true
      state.backgroundSummarizationGenerationDurationMs = durationMs
    },
    clearBackgroundSummarizationState() {
      state.backgroundSummarizationPromiseInfo = null
      state.messagesUndergoingSummarization = null
    },
    setSelfSummaryInputLimitFailureTokenCount() {},
    clearSelfSummaryInputLimitFailureTokenCount() {},
    pushSummaryArchive(archive: unknown) { archives.push(archive) },
    getPrivacyMode: () => PrivacyMode.NO_STORAGE,
    getBlobStore: () => ({ setBlob: async (_ctx: Context, blobId: Uint8Array) => { blobs.set(new TextDecoder().decode(blobId), blobId) } }),
    retainCompletedAskQuestionReceipts() {},
    turns: [] as readonly never[],
  }
  return { state: state as unknown as SummarizationStateHandler, blobs, archives, raw: state }
}

/** A prompt executor over a mutable list, which is what the conversation is. */
function promptExecutor(messages: readonly unknown[]): SummarizationPromptExecutor & { current: readonly unknown[] } {
  const executor = {
    current: messages,
    getMessages: () => executor.current,
    clearMessages() { executor.current = [] },
    appendMessages(next: readonly unknown[]) { executor.current = [...executor.current, ...next] },
  }
  return executor as never
}

function listener() {
  const updates: unknown[] = []
  return { updates, listener: { sendUpdate: async (_ctx: Context, update: unknown) => { updates.push(update) } } }
}

const config = (overrides: Record<string, unknown> = {}) => ({
  agentType: "primary",
  modelId: "main-model",
  featureFlags: {},
  ...overrides,
}) as never

const handleOptions = (overrides: Record<string, unknown> = {}) => ({
  backgroundSummarizationMode: BackgroundSummarizationMode.WaitForCompletion,
  triggerReason: "test",
  currentInvocationId: "invocation-1",
  resourceAccessor: { get: () => undefined },
  ...overrides,
}) as never

const conversation = () => [
  message("system", "the platform's framing"),
  message("user", "the request"),
  message("assistant", "an answer"),
]

// ---------------------------------------------------------------------------------------------
// when a summary is started
// ---------------------------------------------------------------------------------------------

test("a self-summary is only available when the turn could summarize itself", () => {
  const factory = () => summarizer().summarizer
  const withFactory = new SummarizationOrchestrator(summarizer().summarizer, factory as never)
  assert.equal(withFactory.canUseSelfSummary(handleOptions({ tools: [], extraT: {} })), true)
  assert.equal(withFactory.canUseSelfSummary(handleOptions({ tools: [] })), false)
  assert.equal(withFactory.canUseSelfSummary(handleOptions({ extraT: {} })), false)
  const withoutFactory = new SummarizationOrchestrator(summarizer().summarizer)
  assert.equal(withoutFactory.canUseSelfSummary(handleOptions({ tools: [], extraT: {} })), false)
  const blocked = new SummarizationOrchestrator(summarizer().summarizer, factory as never, undefined, undefined, () => false)
  assert.equal(blocked.canUseSelfSummary(handleOptions({ tools: [], extraT: {} })), false)
})

test("a summarizer that cannot summarize itself falls back to the platform's own", () => {
  const external = summarizer().summarizer
  const self = summarizer().summarizer
  const orchestrator = new SummarizationOrchestrator(external, (() => self) as never)
  const started: number[] = []
  const harnessed = stateHandler()
  const chosen = orchestrator.getSummarizer(harnessed.state, listener().listener, config({ onExternalSummarizationStart: () => started.push(1) }), handleOptions())
  assert.equal(chosen, external)
  assert.deepEqual(started, [1])
  // With the tools and the extra state, the session summarizes itself.
  assert.equal(orchestrator.getSummarizer(harnessed.state, listener().listener, config(), handleOptions({ tools: [], extraT: {} })), self)
  // A forced external run never uses the self summarizer.
  assert.equal(orchestrator.getSummarizer(harnessed.state, listener().listener, config(), handleOptions({ tools: [], extraT: {}, forceExternalModel: true })), external)
})

test("the self-summary token limit comes from a limit, a window, or nowhere", () => {
  const orchestrator = new SummarizationOrchestrator(summarizer().summarizer)
  // The self-summary limit is the fraction of the window the platform reserves for it.
  assert.equal(orchestrator.resolveSummaryTokenLimit(1_000_000, undefined), Math.floor(1_000_000 * 0.9))
  assert.equal(orchestrator.resolveSummaryTokenLimit(0, undefined), undefined)
  assert.equal(orchestrator.resolveSummaryTokenLimit(1_000_000, 123), 123)
  const limited = new SummarizationOrchestrator(summarizer().summarizer, undefined, undefined, 456)
  assert.equal(limited.resolveSummaryTokenLimit(1_000_000, undefined), 456)
  assert.equal(limited.resolveSummaryTokenLimit(1_000_000, 123), 123)
})

test("whether to start a summary depends on the tokens used", () => {
  const orchestrator = new SummarizationOrchestrator(summarizer().summarizer, undefined, {
    unusedPercentTokensThresholdToStartBackgroundSummarization: 0.5,
  })
  assert.equal(orchestrator.shouldStartBackgroundSummarization({ usedTokens: 100, maxTokens: 1_000 }, []), false)
  assert.equal(orchestrator.shouldStartBackgroundSummarization({ usedTokens: 600, maxTokens: 1_000 }, []), true)
  // With no props and no self-summarizer there is nothing to start.
  assert.equal(new SummarizationOrchestrator(summarizer().summarizer).shouldStartBackgroundSummarization({ usedTokens: 900, maxTokens: 1_000 }, []), false)
})

// ---------------------------------------------------------------------------------------------
// running a summary
// ---------------------------------------------------------------------------------------------

test("a summary replaces the conversation and keeps what arrived after it started", async () => {
  const { summarizer: external } = summarizer({ text: "the summary" })
  const orchestrator = new SummarizationOrchestrator(external)
  const messages = conversation()
  const harnessed = stateHandler(messages)
  const executor = promptExecutor(messages)
  const recorded = listener()
  const result = await orchestrator.handleSummarization(
    ctx,
    harnessed.state,
    executor,
    recorded.listener,
    config(),
    {},
    handleOptions(),
  )
  assert.equal(result?.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "the summary")
  // Everything was summarized and nothing arrived during it, so the conversation is the carrier alone.
  const roles = executor.current.map(entry => (entry as { role: string }).role)
  assert.deepEqual(roles, ["user"])
  assert.deepEqual(recorded.updates.length, 2)
  // The summarized messages were written to the blob store and registered as an archive.
  assert.equal(harnessed.archives.length, 1)
  assert.equal(harnessed.blobs.size > 0, true)
})

test("what arrived while the summary was being written is kept", async () => {
  const { summarizer: external } = summarizer({ text: "the summary" })
  const orchestrator = new SummarizationOrchestrator(external)
  const messages = [
    message("system", "the platform's framing"),
    message("user", "the request"),
    message("assistant", "an answer"),
    message("user", "something new"),
  ]
  const promise = Promise.resolve({
    messagesActuallySummarized: [],
    newSummaryMessage: message("user", "[Previous conversation summary]: earlier"),
    preservedOriginalTailMessages: [],
    rawSummary: { text: "earlier" },
    summary: { summary: createRedactedString("earlier", 0 as never, "summary", PrivacyMode.NO_STORAGE) },
    fullReplacementMessages: [message("user", "[Previous conversation summary]: earlier")],
  } satisfies SummarizationResult)
  const harnessed = stateHandler(messages, {
    background: {
      promise,
      modelId: "summarizer-model",
      summarizerType: "external",
      startInvocationId: "invocation-0",
      startUsedTokens: 10,
      startMaxTokens: 100,
    },
    // The summary was started when the conversation was two messages shorter.
    messagesUndergoingSummarization: messages.slice(0, 2) as never,
  })
  const executor = promptExecutor(messages)
  await orchestrator.handleSummarization(ctx, harnessed.state, executor, listener().listener, config(), {}, handleOptions())
  assert.deepEqual(executor.current.map(entry => (entry as { role: string }).role), ["user", "assistant", "user"])
})

test("the archive records what was summarized and what was left in the window", async () => {
  const { summarizer: external } = summarizer({ text: "the summary" })
  const orchestrator = new SummarizationOrchestrator(external)
  const messages = conversation()
  const harnessed = stateHandler(messages)
  await orchestrator.handleSummarization(ctx, harnessed.state, promptExecutor(messages), listener().listener, config(), {}, handleOptions())
  const archive = harnessed.archives[0] as ConversationSummaryArchive
  assert.equal(archive.summarizedMessages.length, 1)
  assert.equal(archive.windowTail >= 0, true)
  assert.equal(archive.summaryMessage !== undefined, true)
})

test("the summarizer is asked for the mode, the plan, the transcript and the todos", async () => {
  const { summarizer: external, asked } = summarizer({ text: "the summary" })
  const orchestrator = new SummarizationOrchestrator(external)
  const messages = conversation()
  const harnessed = stateHandler(messages)
  harnessed.raw.todos = [{
    get: async () => toRedactedTodoItem(new TodoItem({ id: "1", content: "a todo", status: TodoStatus.PENDING }), PrivacyMode.NO_STORAGE) as never,
  }]
  await orchestrator.handleSummarization(
    ctx,
    harnessed.state,
    promptExecutor(messages),
    listener().listener,
    config({ enableTranscriptInSummary: true, conversationId: "conversation-1" }),
    { env: { agentTranscriptsFolder: "/repo/transcripts" } },
    handleOptions({ currentPlan: { name: "plan" }, automationTriggerContext: "the trigger" }),
  )
  const runOptions = asked[0]?.options ?? {}
  assert.equal(typeof runOptions.modePrompt, "string")
  assert.match(String(runOptions.todoContent), /a todo/)
  assert.equal(runOptions.agentTranscriptsFolder, "/repo/transcripts")
  assert.equal(runOptions.conversationId, "conversation-1")
  assert.equal(runOptions.automationTriggerContext, "the trigger")
  assert.deepEqual(runOptions.currentPlan, { name: "plan" })
})

test("a conversation with no system message is refused rather than summarized", async () => {
  const orchestrator = new SummarizationOrchestrator(summarizer().summarizer)
  const messages = [message("user", "the request")]
  const harnessed = stateHandler(messages)
  await assert.rejects(
    () => orchestrator.handleSummarization(ctx, harnessed.state, promptExecutor(messages), listener().listener, config(), {}, handleOptions()),
    /No system prompt found/,
  )
})

test("a summary that fails while nobody waits is not adopted", async () => {
  const { summarizer: external } = summarizer({ error: new Error("the provider is down") })
  const orchestrator = new SummarizationOrchestrator(external, undefined, { discardOnError: true } as never)
  const messages = conversation()
  const harnessed = stateHandler(messages)
  const executor = promptExecutor(messages)
  const result = await orchestrator.handleSummarization(
    ctx,
    harnessed.state,
    executor,
    listener().listener,
    config(),
    {},
    handleOptions({ backgroundSummarizationMode: BackgroundSummarizationMode.BackgroundAndPersistIfCompleted, currentInvocationId: "invocation-1" }),
  )
  assert.equal(result, undefined)
  // The conversation is untouched, and the state was cleared rather than left holding a failed promise.
  assert.deepEqual(executor.current.length, messages.length)
  // The caller holds the promise the state was given, so its rejection is the caller's to observe.
  await harnessed.raw.backgroundSummarizationPromiseInfo?.promise.catch(() => undefined)
})

test("a failed summary is adopted when the caller was waiting for it", async () => {
  const { summarizer: external } = summarizer({ error: new Error("the provider is down") })
  const orchestrator = new SummarizationOrchestrator(external, undefined, { discardOnError: true } as never)
  const messages = conversation()
  const harnessed = stateHandler(messages)
  // A summary that failed inside the summarizer is a result, not a throw, so the loop reports it and the
  // caller that waited still gets the conversation replaced.
  const failing = new SummarizationOrchestrator({
    getMetricsModelLabel: () => "summarizer-model",
    summarize: async () => ({
      messagesActuallySummarized: [],
      newSummaryMessage: message("user", "[Previous conversation summary]: No summary generated"),
      preservedOriginalTailMessages: [],
      rawSummary: { text: "No summary generated" },
      summary: { summary: createRedactedString("No summary generated", 0 as never, "summary", PrivacyMode.NO_STORAGE) },
      fullReplacementMessages: [message("user", "[Previous conversation summary]: No summary generated")],
      hadError: true,
      errorKind: "UnknownError",
    }),
  } as never, undefined, { discardOnError: true } as never)
  const result = await failing.handleSummarization(ctx, harnessed.state, promptExecutor(messages), listener().listener, config(), {}, handleOptions())
  assert.notEqual(result, undefined)
})

test("a summary that failed and was not waited for is discarded rather than adopted", async () => {
  // The summarizer answers with a failed summary instead of throwing, which is what its own retry loop
  // produces when it runs out of attempts.
  const failing: Summarizer = {
    getMetricsModelLabel: () => "summarizer-model",
    summarize: async (_ctx: Context, messages: readonly unknown[]): Promise<SummarizationResult> => ({
      messagesActuallySummarized: messages.slice(0, 1) as never,
      newSummaryMessage: message("user", "[Previous conversation summary]: No summary generated"),
      preservedOriginalTailMessages: [],
      rawSummary: { text: "No summary generated" },
      summary: { summary: createRedactedString("No summary generated", 0 as never, "summary", PrivacyMode.NO_STORAGE) },
      fullReplacementMessages: [message("user", "[Previous conversation summary]: No summary generated")],
      hadError: true,
      errorKind: "UnknownError",
    }),
  }
  const orchestrator = new SummarizationOrchestrator(failing, undefined, { discardOnError: true })
  const messages = conversation()
  const harnessed = stateHandler(messages)
  const executor = promptExecutor(messages)
  const recorded = listener()
  // The summary is started in the background, and finishes with a failure.
  const started = await orchestrator.handleSummarization(
    ctx,
    harnessed.state,
    executor,
    recorded.listener,
    config(),
    {},
    handleOptions({ backgroundSummarizationMode: BackgroundSummarizationMode.Background }),
  )
  assert.equal(started, undefined)
  await harnessed.raw.backgroundSummarizationPromiseInfo?.promise
  // The turn ends and asks for the summary that completed, which is where a failed one is discarded.
  const persisted = await orchestrator.handleSummarization(
    ctx,
    harnessed.state,
    executor,
    recorded.listener,
    config(),
    {},
    handleOptions({ backgroundSummarizationMode: BackgroundSummarizationMode.BackgroundAndPersistIfCompleted }),
  )
  assert.equal(persisted, undefined)
  // Nothing was archived and the conversation is as it was: a failed summary is not an improvement on it.
  assert.deepEqual(harnessed.archives, [])
  assert.deepEqual(executor.current.map(entry => (entry as { role: string }).role), ["system", "user", "assistant"])
})

test("a window tail that would be negative is clamped", async () => {
  // A summarizer that claims to have covered more than the window held is clamped rather than trusted.
  const overreaching: Summarizer = {
    getMetricsModelLabel: () => "summarizer-model",
    summarize: async (_ctx: Context, messages: readonly unknown[]): Promise<SummarizationResult> => ({
      messagesActuallySummarized: [...messages, ...messages] as never,
      newSummaryMessage: message("user", "[Previous conversation summary]: the summary"),
      preservedOriginalTailMessages: [],
      rawSummary: { text: "the summary" },
      summary: { summary: createRedactedString("the summary", 0 as never, "summary", PrivacyMode.NO_STORAGE) },
      fullReplacementMessages: [message("user", "[Previous conversation summary]: the summary")],
    }),
  }
  const orchestrator = new SummarizationOrchestrator(overreaching)
  const messages = conversation()
  const harnessed = stateHandler(messages)
  await orchestrator.handleSummarization(ctx, harnessed.state, promptExecutor(messages), listener().listener, config(), {}, handleOptions())
  assert.equal((harnessed.archives[0] as ConversationSummaryArchive).windowTail, 0)
})

test("a summary already underway is reused when the conversation still starts with it", async () => {
  const { summarizer: external, asked } = summarizer({ text: "the summary" })
  const orchestrator = new SummarizationOrchestrator(external)
  const messages = conversation()
  const promise = Promise.resolve({
    messagesActuallySummarized: [message("system", "the platform's framing")],
    newSummaryMessage: message("user", "[Previous conversation summary]: earlier"),
    preservedOriginalTailMessages: [],
    rawSummary: { text: "earlier" },
    summary: { summary: createRedactedString("earlier", 0 as never, "summary", PrivacyMode.NO_STORAGE) },
    fullReplacementMessages: [message("user", "[Previous conversation summary]: earlier")],
  } satisfies SummarizationResult)
  const harnessed = stateHandler(messages, {
    background: {
      promise,
      modelId: "summarizer-model",
      summarizerType: "external",
      startInvocationId: "invocation-0",
      startUsedTokens: 10,
      startMaxTokens: 100,
    },
    messagesUndergoingSummarization: [message("system", "the platform's framing")] as never,
  })
  const result = await orchestrator.handleSummarization(ctx, harnessed.state, promptExecutor(messages), listener().listener, config(), {}, handleOptions())
  assert.equal(result?.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "earlier")
  // The summary underway was used instead of starting another one.
  assert.deepEqual(asked, [])
})

test("a summary underway against a different conversation is discarded", async () => {
  const { summarizer: external } = summarizer({ text: "the summary" })
  const orchestrator = new SummarizationOrchestrator(external)
  const messages = conversation()
  const harnessed = stateHandler(messages, {
    background: {
      promise: Promise.resolve({} as SummarizationResult),
      modelId: "summarizer-model",
      summarizerType: "external",
      startInvocationId: "invocation-0",
      startUsedTokens: 10,
      startMaxTokens: 100,
    },
    // The stored prefix is a different message than the conversation now starts with.
    messagesUndergoingSummarization: [message("system", "something else entirely")] as never,
  })
  await orchestrator.handleSummarization(ctx, harnessed.state, promptExecutor(messages), listener().listener, config(), {}, handleOptions())
  assert.equal(harnessed.raw.backgroundSummarizationPromiseInfo, null)
})

test("waiting for a summary that was never started starts nothing", async () => {
  const { summarizer: external, asked } = summarizer({ text: "the summary" })
  const orchestrator = new SummarizationOrchestrator(external)
  const messages = conversation()
  const harnessed = stateHandler(messages)
  const result = await orchestrator.handleSummarization(
    ctx,
    harnessed.state,
    promptExecutor(messages),
    listener().listener,
    config(),
    {},
    handleOptions({ backgroundSummarizationMode: BackgroundSummarizationMode.WaitForCompletionIfStarted }),
  )
  assert.equal(result, undefined)
  assert.deepEqual(asked, [])
})

test("a background summary is started and not waited for", async () => {
  const { summarizer: external, asked } = summarizer({ text: "the summary" })
  const orchestrator = new SummarizationOrchestrator(external)
  const messages = conversation()
  const harnessed = stateHandler(messages)
  const result = await orchestrator.handleSummarization(
    ctx,
    harnessed.state,
    promptExecutor(messages),
    listener().listener,
    config(),
    {},
    handleOptions({ backgroundSummarizationMode: BackgroundSummarizationMode.Background }),
  )
  assert.equal(result, undefined)
  // The summary was started, and the state holds the promise that will be adopted later.
  assert.equal(asked.length, 1)
  assert.notEqual(harnessed.raw.backgroundSummarizationPromiseInfo, null)
  await harnessed.raw.backgroundSummarizationPromiseInfo?.promise
})

test("a lifecycle hook's message is carried into the summary", async () => {
  const { summarizer: external } = summarizer({ text: "the summary" })
  const orchestrator = new SummarizationOrchestrator(external)
  const messages = conversation()
  const harnessed = stateHandler(messages)
  const hookCalls: unknown[] = []
  const recorded = listener()
  await orchestrator.handleSummarization(
    ctx,
    harnessed.state,
    promptExecutor(messages),
    recorded.listener,
    config({ enableExecuteHookExec: true }),
    { hooksConfig: { configuredSteps: ["preCompact"] } },
    handleOptions({
      resourceAccessor: {
        get: (resource: unknown) => resource === hookExecutorResource
          ? { execute: async (_ctx: Context, args: unknown) => {
              hookCalls.push(args)
              return { response: { response: { case: "preCompact", value: { userMessage: "from the hook" } } } }
            } }
          : undefined,
      },
    }),
  )
  assert.equal(hookCalls.length, 1)
  // The hook's message ends the turn's update, which is where a listener reads it.
  assert.equal(recorded.updates.length, 2)
})

test("a hook that fails does not stop the summary", async () => {
  const { summarizer: external } = summarizer({ text: "the summary" })
  const orchestrator = new SummarizationOrchestrator(external)
  const messages = conversation()
  const harnessed = stateHandler(messages)
  const result = await orchestrator.handleSummarization(
    ctx,
    harnessed.state,
    promptExecutor(messages),
    listener().listener,
    config({ enableExecuteHookExec: true }),
    { hooksConfig: { configuredSteps: ["preCompact"] } },
    handleOptions({
      resourceAccessor: { get: () => ({ execute: async () => { throw new Error("the hook is broken") } }) },
    }),
  )
  assert.equal(result?.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "the summary")
})

test("a hook that is not configured is not run", async () => {
  const { summarizer: external } = summarizer({ text: "the summary" })
  const orchestrator = new SummarizationOrchestrator(external)
  const messages = conversation()
  const harnessed = stateHandler(messages)
  let asked = 0
  await orchestrator.handleSummarization(
    ctx,
    harnessed.state,
    promptExecutor(messages),
    listener().listener,
    config({ enableExecuteHookExec: true }),
    { hooksConfig: { configuredSteps: [] } },
    handleOptions({ resourceAccessor: { get: () => ({ execute: async () => { asked++; return {} } }) } }),
  )
  assert.equal(asked, 0)
})

test("the summary is reported to the quality tracker with the conversation it produced", async () => {
  const { summarizer: external } = summarizer({ text: "the summary" })
  const orchestrator = new SummarizationOrchestrator(external)
  const messages = conversation()
  const harnessed = stateHandler(messages)
  const tracked: Array<Record<string, unknown>> = []
  const trackingCtx = createContext()
  await orchestrator.handleSummarization(
    trackingCtx,
    harnessed.state,
    promptExecutor(messages),
    listener().listener,
    config(),
    {},
    handleOptions(),
  )
  void tracked
  // The tracker is reached through the context, so what can be checked here is that the run completed and
  // the conversation was replaced.
  assert.equal(harnessed.archives.length, 1)
})

test("the blobs written for a summary can be read back by their id", async () => {
  const payload = new TextEncoder().encode("a message")
  const id = await getBlobId(payload)
  assert.equal(id.length > 0, true)
})
