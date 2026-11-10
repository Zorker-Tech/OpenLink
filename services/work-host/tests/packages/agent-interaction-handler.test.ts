import { test } from "node:test"
import assert from "node:assert/strict"

import { InteractionHandler } from "../../source/packages/agent/interaction-handler.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import { InputTokenLimitError } from "../../source/packages/chat-inference/prompt-executor.ts"
import { AgentLoopError } from "../../source/adapters/interop/agent/agent-loop-presentation-adapter.ts"
import { ToolCallAbortedError } from "../../source/packages/agent/tools/tool-errors.ts"
import { EditArgs } from "../../source/adapters/interop/proto/generated/agent/v1/edit_tool_pb.ts"
import { ToolCall } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"

// ---------------------------------------------------------------------------------------------
// the handler over a fake interaction provider and recorder
// ---------------------------------------------------------------------------------------------

interface Updates {
  readonly sent: Array<{ kind: string; payload: unknown }>
}

function providerHarness(options: { failOn?: (kind: string) => boolean } = {}): {
  readonly updates: Updates
  readonly provider: {
    sendUpdate(ctx: Context, update: unknown): Promise<void>
    query(ctx: Context, query: unknown): Promise<unknown>
  }
} {
  const sent: Updates["sent"] = []
  return {
    updates: { sent },
    provider: {
      async sendUpdate(_ctx, update) {
        const event = update as { kind?: string; message?: { case?: string; value?: unknown } }
        const message = event.message
        const kind = message?.case ?? event.kind ?? "unknown"
        sent.push({ kind, payload: message?.value ?? event })
        if (options.failOn?.(kind) === true) throw new Error("the consumer is gone")
      },
      async query(_ctx, query) {
        return { answered: query }
      },
    },
  }
}

function recorderHarness(): {
  readonly recorded: Array<{ callId: string; toolCase: string }>
  readonly pending: Array<{ callId: string }>
  readonly recorder: {
    recordToolCall(toolCall: unknown, callId: string): void
    recordPendingToolCall(ctx: Context, toolCall: unknown, callId: string): Promise<void>
  }
} {
  const recorded: Array<{ callId: string; toolCase: string }> = []
  const pending: Array<{ callId: string }> = []
  const toolCaseOf = (toolCall: unknown): string => String((toolCall as { tool?: { case?: string } }).tool?.case ?? "unknown")
  return {
    recorded,
    pending,
    recorder: {
      recordToolCall(toolCall, callId) { recorded.push({ callId, toolCase: toolCaseOf(toolCall) }) },
      async recordPendingToolCall(_ctx, toolCall, callId) { pending.push({ callId }); recorded.push({ callId, toolCase: toolCaseOf(toolCall) }) },
    },
  }
}

function handlerWith(options: {
  enableSingleMessageLoopDetection?: boolean
  overrideSignal?: AbortSignal
  thinkingStyle?: unknown
  onThinkingCompleted?: unknown
  failOn?: (kind: string) => boolean
} = {}): {
  readonly handler: InteractionHandler
  readonly updates: Updates
  readonly recorded: ReturnType<typeof recorderHarness>["recorded"]
  readonly pending: ReturnType<typeof recorderHarness>["pending"]
} {
  const provider = providerHarness({ ...(options.failOn === undefined ? {} : { failOn: options.failOn }) })
  const recorder = recorderHarness()
  return {
    handler: new InteractionHandler(
      provider.provider,
      recorder.recorder,
      "invocation-1",
      options.overrideSignal,
      options.thinkingStyle,
      options.enableSingleMessageLoopDetection ?? false,
      options.onThinkingCompleted,
    ),
    updates: provider.updates,
    recorded: recorder.recorded,
    pending: recorder.pending,
  }
}

const readCall = (): ToolCall => new ToolCall({ tool: { case: "readToolCall", value: { args: { path: "/repo/a.ts" } } as never } })
const editCall = (args?: EditArgs): ToolCall => new ToolCall({ tool: { case: "editToolCall", value: { args } as never } })

// ---------------------------------------------------------------------------------------------
// the stream a turn produces
// ---------------------------------------------------------------------------------------------

interface TextHandlerHarness {
  readonly text: string[]
  readonly thinking: string[]
  readonly thinkingDurations: number[]
  readonly handler: { recordText(ctx: Context, text: string): Promise<void>; recordThinking(ctx: Context, text: string, durationMs?: number): Promise<void> }
}

function textHandler(): TextHandlerHarness {
  const text: string[] = []
  const thinking: string[] = []
  const thinkingDurations: number[] = []
  return {
    text,
    thinking,
    thinkingDurations,
    handler: {
      async recordText(_ctx, value) { text.push(value) },
      async recordThinking(_ctx, value, durationMs) { thinking.push(value); thinkingDurations.push(durationMs ?? 0) },
    },
  }
}

async function* streamOf(chunks: Array<Record<string, unknown>>): AsyncIterable<Record<string, unknown>> {
  for (const chunk of chunks) yield chunk
}

test("text is passed on as it arrives, and recorded", async () => {
  const harness = handlerWith()
  const text = textHandler()
  await harness.handler.consumeStream(createContext(), streamOf([
    { type: "text-delta", textDelta: "hello " },
    { type: "text-delta", textDelta: "world" },
  ]), text.handler)

  assert.deepEqual(text.text, ["hello ", "world"])
  assert.deepEqual(
    harness.updates.sent.filter(update => update.kind === "text-delta").map(update => (update.payload as { text: string }).text),
    ["hello ", "world"],
  )
})

test("thinking is announced, and finished when the answer starts", async () => {
  const harness = handlerWith()
  const text = textHandler()
  await harness.handler.consumeStream(createContext(), streamOf([
    { type: "reasoning", textDelta: "let me think" },
    { type: "text-delta", textDelta: "the answer" },
  ]), text.handler)

  const kinds = harness.updates.sent.map(update => update.kind)
  assert.equal(kinds.includes("thinking-delta"), true)
  assert.equal(kinds.includes("thinking-completed"), true)
  assert.equal(kinds.indexOf("thinking-delta") < kinds.indexOf("thinking-completed"), true)
  assert.deepEqual(text.thinking, ["let me think", ""])
  // The completion is recorded with a duration, which is at least a millisecond.
  assert.equal(text.thinkingDurations[1] !== undefined && text.thinkingDurations[1] >= 1, true)
})

test("a thinking signature ends the thinking rather than adding to it", async () => {
  const harness = handlerWith()
  const text = textHandler()
  await harness.handler.consumeStream(createContext(), streamOf([
    { type: "reasoning", textDelta: "thinking" },
    { type: "reasoning-signature", textDelta: "signature" },
  ]), text.handler)
  assert.deepEqual(text.thinking, ["thinking", ""])
})

test("what the model thought is handed to the caller when it finishes", async () => {
  const completed: Array<{ text: string; durationMs: number }> = []
  const harness = handlerWith({
    onThinkingCompleted: async (_ctx: Context, value: { text: string; durationMs: number }) => { completed.push(value) },
  })
  await harness.handler.consumeStream(createContext(), streamOf([
    { type: "reasoning", textDelta: "a thought" },
    { type: "text-delta", textDelta: "an answer" },
  ]), textHandler().handler)
  assert.equal(completed.length, 1)
  assert.equal(completed[0]?.text, "a thought")
})

test("a callback that fails does not fail the turn", async () => {
  const harness = handlerWith({ onThinkingCompleted: async () => { throw new Error("the hook is broken") } })
  await harness.handler.consumeStream(createContext(), streamOf([
    { type: "reasoning", textDelta: "a thought" },
    { type: "text-delta", textDelta: "an answer" },
  ]), textHandler().handler)
  // The answer still arrived.
  assert.equal(harness.updates.sent.some(update => update.kind === "text-delta"), true)
})

test("tool-call deltas are counted as tokens but not as text", async () => {
  const harness = handlerWith()
  const text = textHandler()
  await harness.handler.consumeStream(createContext(), streamOf([
    { type: "tool-call-delta", argsTextDelta: "some arguments" },
  ]), text.handler)
  assert.deepEqual(text.text, [])
  assert.equal(harness.updates.sent.some(update => update.kind === "token-delta"), true)
})

test("tokens are estimated four characters at a time, carrying the remainder", async () => {
  const harness = handlerWith()
  // Six characters is one token with two left over, then three more characters completes a second token.
  await harness.handler.consumeStream(createContext(), streamOf([
    { type: "text-delta", textDelta: "abcdef" },
    { type: "text-delta", textDelta: "ghi" },
  ]), textHandler().handler)
  const tokenDeltas = harness.updates.sent.filter(update => update.kind === "token-delta").map(update => (update.payload as { tokens: number }).tokens)
  assert.deepEqual(tokenDeltas, [1, 1])
})

test("an input-token-limit failure is a signal to summarize rather than an error", async () => {
  const harness = handlerWith()
  const failing = (async function* () {
    yield { type: "text-delta", textDelta: "partial" }
    throw new InputTokenLimitError("too much input")
  })()
  await harness.handler.consumeStream(createContext(), failing, textHandler().handler)
  // Nothing is thrown: the caller decides what to do about it.
})

test("a failure on the consumer side is passed on rather than swallowed", async () => {
  const harness = handlerWith({ failOn: kind => kind === "text-delta" })
  await assert.rejects(
    () => harness.handler.consumeStream(createContext(), streamOf([{ type: "text-delta", textDelta: "hello" }]), textHandler().handler),
    /the consumer is gone/,
  )
})

test("a model repeating itself inside one message ends the turn with a loop error", async () => {
  const harness = handlerWith({ enableSingleMessageLoopDetection: true })
  await assert.rejects(
    () => harness.handler.consumeStream(createContext(), streamOf([{ type: "text-delta", textDelta: "a".repeat(100) }]), textHandler().handler),
    // The check is by name and shape: this library's connect error does not recognise its own subclasses.
    (error: unknown) =>
      error instanceof Error &&
      error.name === "AgentLoopError" &&
      (error as { loopType?: string }).loopType === "singleMessage" &&
      (error as { repetitions?: number }).repetitions === 100,
  )
})

test("loop detection is only watching when the session asked for it", async () => {
  const harness = handlerWith()
  await harness.handler.consumeStream(createContext(), streamOf([{ type: "text-delta", textDelta: "a".repeat(100) }]), textHandler().handler)
  assert.equal(harness.updates.sent.some(update => update.kind === "text-delta"), true)
})

// ---------------------------------------------------------------------------------------------
// tool calls
// ---------------------------------------------------------------------------------------------

test("a tool call is announced before it runs and completed after", async () => {
  const harness = handlerWith()
  const result = await harness.handler.executeToolCall(
    createContext(),
    readCall(),
    "call-1",
    async () => ({ ok: true }),
    () => readCall(),
  )
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(harness.updates.sent.map(update => update.kind), ["tool-call-update", "tool-call-update"])
  assert.deepEqual(harness.updates.sent.map(update => (update.payload as { phase: string }).phase), ["started", "completed"])
  // The call is recorded under the id the turn uses for it.
  assert.deepEqual(harness.recorded, [{ callId: "call-1", toolCase: "readToolCall" }])
})

test("the call that is announced carries its id and the invocation it belongs to", async () => {
  const harness = handlerWith()
  await harness.handler.executeToolCall(createContext(), readCall(), "call-1", async () => ({ ok: true }), () => readCall())
  const started = harness.updates.sent[0]?.payload as { callId: string; modelCallId: string; toolCall: { toolCallId: string } }
  assert.equal(started.callId, "call-1")
  assert.equal(started.modelCallId, "invocation-1")
  assert.equal(started.toolCall.toolCallId, "call-1")
})

test("a tool call that fails is reported to the caller and not recorded as done", async () => {
  const harness = handlerWith()
  await assert.rejects(
    () => harness.handler.executeToolCall(createContext(), readCall(), "call-1", async () => { throw new Error("the tool broke") }, () => readCall()),
    /the tool broke/,
  )
  assert.deepEqual(harness.recorded, [])
})

test("an aborted turn stops a tool call before it runs", async () => {
  const controller = new AbortController()
  controller.abort()
  const harness = handlerWith({ overrideSignal: controller.signal })
  let ran = false
  await assert.rejects(
    () => harness.handler.executeToolCall(createContext(), readCall(), "call-1", async () => { ran = true; return {} }, () => readCall()),
    ToolCallAbortedError,
  )
  assert.equal(ran, false)
})

test("an abort while a tool call is running rejects the call", async () => {
  const controller = new AbortController()
  const harness = handlerWith({ overrideSignal: controller.signal })
  const pending = harness.handler.executeToolCall(
    createContext(),
    readCall(),
    "call-1",
    () => new Promise(() => {}),
    () => readCall(),
  )
  controller.abort()
  await assert.rejects(() => pending, ToolCallAbortedError)
})

test("the hooks' additional context travels with the completed call", async () => {
  const harness = handlerWith()
  const hookContexts = [{ event: "pre-tool", text: "a hook said something" }]
  await harness.handler.executeToolCall(createContext(), readCall(), "call-1", async () => ({ ok: true }), () => readCall(), hookContexts)
  const completed = harness.updates.sent[1]?.payload as { toolCall: { hookContexts: readonly { event: string; text: string }[] } }
  assert.deepEqual(completed.toolCall.hookContexts, [{ event: "pre-tool", text: "a hook said something" }])
})

test("the arguments that arrived are kept when a call fails", async () => {
  const harness = handlerWith()
  harness.handler.markToolCallForArgPreservation("call-1")
  // A partial call is remembered as it streams.
  harness.handler.rememberToolCallForArgPreservation("call-1", editCall(new EditArgs({ path: "/repo/a.ts" })))

  await harness.handler.emitToolCallError(createContext(), "call-1", editCall(new EditArgs({ path: "" })))
  const completed = harness.updates.sent.at(-1)?.payload as { toolCall: { tool: { value: { args: EditArgs } } } }
  assert.equal(completed.toolCall.tool.value.args.path, "/repo/a.ts")
  // The call is recorded as it failed, with the arguments it had.
  assert.deepEqual(harness.recorded.map(entry => entry.callId), ["call-1"])
})

test("a call's streamed content is applied to the arguments as it arrives", async () => {
  const harness = handlerWith()
  harness.handler.markToolCallForArgPreservation("call-1")
  harness.handler.rememberToolCallForArgPreservation("call-1", editCall(new EditArgs({ path: "/repo/a.ts" })))
  harness.handler.applyDeltaToLatestToolCall("call-1", { delta: { case: "editToolCallDelta", value: { streamContentDelta: "one" } } })
  harness.handler.applyDeltaToLatestToolCall("call-1", { delta: { case: "editToolCallDelta", value: { streamContentDelta: "two" } } })

  await harness.handler.emitToolCallError(createContext(), "call-1", editCall(new EditArgs({ path: "/repo/a.ts" })))
  const completed = harness.updates.sent.at(-1)?.payload as { toolCall: { tool: { value: { args: EditArgs } } } }
  assert.equal(completed.toolCall.tool.value.args.streamContent, "onetwo")
})

test("a partial tool call is announced and recorded as pending", async () => {
  const harness = handlerWith()
  await harness.handler.emitPartialToolCall(createContext(), "call-1", readCall())
  assert.equal(harness.updates.sent[0]?.kind, "tool-call-update")
  assert.equal((harness.updates.sent[0]?.payload as { phase: string }).phase, "partial")

  await harness.handler.recordPendingToolCall(createContext(), "call-1", readCall())
  assert.deepEqual(harness.pending, [{ callId: "call-1" }])
})

test("a tool call delta is announced with the invocation it belongs to", async () => {
  const harness = handlerWith()
  await harness.handler.emitToolCallDelta(createContext(), "call-1", { delta: { case: "editToolCallDelta", value: { streamContentDelta: "x" } } })
  const delta = harness.updates.sent[0]?.payload as {
    kind: string
    callId: string
    modelCallId: string
    delta?: { kind: string; textDelta?: string }
  }
  assert.equal(harness.updates.sent[0]?.kind, "tool-call-delta")
  assert.equal(delta.kind, "tool-call-delta")
  assert.equal(delta.callId, "call-1")
  assert.equal(delta.modelCallId, "invocation-1")
  assert.deepEqual(delta.delta, { kind: "edit-content", textDelta: "x" })
})

test("a question that failed is recorded like any other call, and so is its answer", async () => {
  const harness = handlerWith()
  const questionCall = new ToolCall({ tool: { case: "askQuestionToolCall", value: {} as never } })
  await harness.handler.emitToolCallError(createContext(), "call-1", questionCall)
  assert.deepEqual(harness.recorded.map(entry => entry.toolCase), ["askQuestionToolCall"])
})

test("a heartbeat is sent when the caller asks for one", async () => {
  const harness = handlerWith()
  await harness.handler.sendHeartbeat(createContext())
  assert.equal(harness.updates.sent[0]?.kind, "heartbeat")
})

test("a query goes to the interaction provider", async () => {
  const harness = handlerWith()
  assert.deepEqual(await harness.handler.query(createContext(), { ask: "something" }), { answered: { ask: "something" } })
})

test("the listener is the interaction provider", () => {
  const harness = handlerWith()
  assert.equal(harness.handler.listener, (harness.handler as unknown as { interactionProvider: unknown }).interactionProvider)
})

test("task progress uses the dedicated listener port when the host supports it", async () => {
  const seen: unknown[] = []
  const recorder = recorderHarness()
  const handler = new InteractionHandler({
    async sendUpdate() { assert.fail("task progress should use the dedicated listener port") },
    async sendTaskProgressUpdate(_context: Context, toolCallId: string, modelCallId: string, update: unknown) {
      seen.push([toolCallId, modelCallId, update])
    },
  }, recorder.recorder, "invocation-1")
  const update = { schemaVersion: 1, kind: "assistant-text", text: "child output", serverNotice: false } as const

  assert.equal(await handler.emitTaskProgressUpdate(createContext(), "task-call-1", update), true)
  assert.deepEqual(seen, [["task-call-1", "invocation-1", update]])
})

test("task progress reports when a listener needs the compatibility transport", async () => {
  const harness = handlerWith()
  assert.equal(await harness.handler.emitTaskProgressUpdate(createContext(), "task-call-1", {
    schemaVersion: 1,
    kind: "assistant-text",
    text: "child output",
    serverNotice: false,
  }), false)
})

// ---------------------------------------------------------------------------------------------
// what is counted
// ---------------------------------------------------------------------------------------------

test("a tool result's text is counted and its tokens estimated", async () => {
  const harness = handlerWith()
  await harness.handler.recordToolCallResult(createContext(), { content: [{ type: "text", text: "x".repeat(40) }] }, "Read", undefined)
  const tokenDeltas = harness.updates.sent.filter(update => update.kind === "token-delta").map(update => (update.payload as { tokens: number }).tokens)
  assert.deepEqual(tokenDeltas, [10])
})

test("a tool result with no text counts nothing", async () => {
  const harness = handlerWith()
  await harness.handler.recordToolCallResult(createContext(), { content: [] }, "Read", undefined)
  assert.deepEqual(harness.updates.sent, [])
})

test("a call the model asked for is only preserved when the turn says so", async () => {
  const harness = handlerWith()
  // Without marking, the latest call is not remembered, so an error carries the empty arguments it came with.
  harness.handler.rememberLatestToolCall("call-1", editCall(new EditArgs({ path: "/repo/a.ts" })))
  await harness.handler.emitToolCallError(createContext(), "call-1", editCall(new EditArgs({ path: "" })))
  const completed = harness.updates.sent.at(-1)?.payload as { toolCall: { tool: { value: { args: EditArgs } } } }
  assert.equal(completed.toolCall.tool.value.args.path, "")
})

test("a tool call that is not a generated message is refused", async () => {
  const harness = handlerWith()
  await assert.rejects(
    () => harness.handler.executeToolCall(createContext(), { tool: { case: "readToolCall" } }, "call-1", async () => ({}), () => readCall()),
    /tool call carrier is not agent\.v1\.ToolCall/,
  )
})
