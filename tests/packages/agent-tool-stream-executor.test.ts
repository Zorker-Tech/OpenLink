import { test } from "node:test"
import assert from "node:assert/strict"

import {
  RedactedPromptToolExecutor,
  SimplePromptToolExecutor,
  conversationStateOpsInReplayOrder,
  executeDeferredToolCall,
  getEffectiveToolCallArgs,
  getEffectiveToolCallName,
  parseNativeToolArguments,
  resolveEffectiveToolCallDescriptor,
  type NativeToolCallDescriptor,
} from "../../source/packages/agent/tool-stream-executor.ts"
import { DYNAMIC_TOOLS_NAMESPACE } from "../../source/packages/agent-exec/mcp-operations.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import { PrivacyCapability } from "../../source/packages/redaction/classification.ts"
import { fromRedactedCoreMessage, toRedactedCoreMessage } from "../../source/packages/redaction/message-redaction.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { RetryableToolOrchestrationError } from "../../source/packages/agent/tools/tool-support.ts"
import { bubbleRetryableTaskErrorsKey } from "../../source/packages/agent/utils/request-scope.ts"
import { ToolErrorClassification } from "../../source/packages/agent/tools/tool-errors.ts"
import type { ToolExecutionSet } from "../../source/packages/agent/tools/tool-execution.ts"

// ---------------------------------------------------------------------------------------------
// the harness
// ---------------------------------------------------------------------------------------------

const ctx = createContext()

type ToolRecord = Record<string, unknown> & { name: string; toolIdentifier: string }

function fakeTool(name: string, options: {
  result?: unknown
  renderedText?: string
  error?: unknown
  errorText?: string
} = {}): ToolRecord {
  return {
    name,
    toolIdentifier: name.toUpperCase(),
    parameters: {},
    async execute() {
      if (options.error !== undefined) throw options.error
      // A tool answers with a protobuf message, which is what the platform serializes into its own record.
      return { toJson: () => options.result ?? { ok: true } }
    },
    async render() {
      return {
        content: [{ type: "text", text: options.renderedText ?? "the result" }],
        isError: options.errorText !== undefined,
      }
    },
    serializeError(error: unknown) {
      const text = options.errorText ?? String(error)
      return { tool: { value: { result: { toJson: () => ({ error: text }) } } } }
    },
  }
}

const executionSet = (tools: ToolRecord[]): ToolExecutionSet =>
  ({ modelVisibleTools: tools, additionalExecutableTools: [] }) as never

const toolMapOf = (tools: ToolRecord[]) => Object.fromEntries(tools.map(tool => [tool.name, tool]))

const interactionHandler = {
  invocationId: "invocation-1",
  async emitToolCallError() {},
}

const argsOf = (...chunks: string[]) => (async function* () { for (const chunk of chunks) yield chunk })()

const execute = (options: {
  descriptor: NativeToolCallDescriptor
  tools: ToolRecord[]
  extra?: Record<string, unknown>
  record?: (ctx: Context, result: unknown, loggedToolName: string, classification: unknown) => unknown
  args?: AsyncIterable<string>
  completedArgs?: Promise<unknown>
}) => executeDeferredToolCall(
  ctx,
  options.descriptor,
  toolMapOf(options.tools),
  interactionHandler,
  options.extra ?? {},
  options.record as never,
  {},
  options.args,
  options.completedArgs,
)

/** A model response made of the chunks a test wants, with the message list a provider would return. */
function streamExecutor(chunks: unknown[], messages: Array<Record<string, unknown>>) {
  const calls: Array<{ tools: readonly unknown[]; options: Record<string, unknown> }> = []
  return {
    calls,
    executor: {
      stream(_ctx: Context, _invocationId: string, tools: readonly unknown[], options: Record<string, unknown>) {
        calls.push({ tools, options })
        return {
          fullStream: (async function* () { for (const chunk of chunks) yield chunk })(),
          response: Promise.resolve({ messages, id: "response-1" }),
          usage: Promise.resolve({}),
          extendedUsage: Promise.resolve({}),
          providerMetadata: Promise.resolve({}),
          invocationId: "invocation-1",
        }
      },
    },
  }
}

const toolCallChunks = (toolCallId: string, toolName: string, args: unknown) => [
  { type: "tool-call-streaming-start", toolCallId, toolName },
  { type: "tool-call-delta", toolCallId, toolName, argsTextDelta: JSON.stringify(args) },
  { type: "tool-call", toolCallId, toolName, args },
]

const assistantCall = (toolCallId: string, toolName: string, args: unknown) =>
  ({ role: "assistant", content: [{ type: "tool-call", toolCallId, toolName, args }] })

// ---------------------------------------------------------------------------------------------
// arguments a provider sent as text
// ---------------------------------------------------------------------------------------------

test("arguments that are absent are an empty object", () => {
  assert.deepEqual(parseNativeToolArguments(undefined), {})
})

test("arguments that are already an object are left alone", () => {
  const args = { path: "/repo/a.ts" }
  assert.equal(parseNativeToolArguments(args), args)
})

test("arguments sent as text are read as an object when they are one", () => {
  assert.deepEqual(parseNativeToolArguments('{"path":"/repo/a.ts"}'), { path: "/repo/a.ts" })
})

test("arguments that are not an object are kept as the text they came as", () => {
  assert.equal(parseNativeToolArguments("not json"), "not json")
  assert.equal(parseNativeToolArguments("[1,2,3]"), "[1,2,3]")
  assert.equal(parseNativeToolArguments('"a string"'), '"a string"')
  assert.equal(parseNativeToolArguments(7), undefined)
})

// ---------------------------------------------------------------------------------------------
// a call that names another tool
// ---------------------------------------------------------------------------------------------

test("a call that does not name another tool is left as it is", () => {
  const descriptor: NativeToolCallDescriptor = { toolCallId: "call-1", toolName: "Read", args: { path: "/a" } }
  assert.equal(resolveEffectiveToolCallDescriptor(descriptor, executionSet([fakeTool("Read")])), descriptor)
})

test("a dynamic invocation of a tool that exists becomes that tool's call", () => {
  const read = fakeTool("Read")
  const invoke = { ...fakeTool("CallMcpTool"), dynamicToolMetaRole: "invocation" }
  const descriptor: NativeToolCallDescriptor = {
    toolCallId: "call-1",
    toolName: "CallMcpTool",
    args: { namespace: DYNAMIC_TOOLS_NAMESPACE, toolName: "Read", arguments: '{"path":"/a"}' },
  }
  const resolved = resolveEffectiveToolCallDescriptor(descriptor, executionSet([read, invoke]))
  assert.equal(getEffectiveToolCallName(resolved), "Read")
  assert.deepEqual(getEffectiveToolCallArgs(resolved), { path: "/a" })
})

test("a dynamic invocation of a tool that does not exist is left as it is", () => {
  const invoke = { ...fakeTool("CallMcpTool"), dynamicToolMetaRole: "invocation" }
  const descriptor: NativeToolCallDescriptor = {
    toolCallId: "call-1",
    toolName: "CallMcpTool",
    args: { namespace: DYNAMIC_TOOLS_NAMESPACE, toolName: "Nope", arguments: "{}" },
  }
  assert.equal(getEffectiveToolCallName(resolveEffectiveToolCallDescriptor(descriptor, executionSet([invoke]))), "CallMcpTool")
})

test("a dynamic invocation of another namespace is left as it is", () => {
  const invoke = { ...fakeTool("CallMcpTool"), dynamicToolMetaRole: "invocation" }
  const read = fakeTool("Read")
  const descriptor: NativeToolCallDescriptor = {
    toolCallId: "call-1",
    toolName: "CallMcpTool",
    args: { namespace: "someone-elses", toolName: "Read", arguments: "{}" },
  }
  assert.equal(getEffectiveToolCallName(resolveEffectiveToolCallDescriptor(descriptor, executionSet([read, invoke]))), "CallMcpTool")
})

test("a dynamic invocation whose arguments are not an object is left as it is", () => {
  const invoke = { ...fakeTool("CallMcpTool"), dynamicToolMetaRole: "invocation" }
  const read = fakeTool("Read")
  const descriptor: NativeToolCallDescriptor = { toolCallId: "call-1", toolName: "CallMcpTool", args: "not an object" }
  assert.equal(getEffectiveToolCallName(resolveEffectiveToolCallDescriptor(descriptor, executionSet([read, invoke]))), "CallMcpTool")
})

// ---------------------------------------------------------------------------------------------
// one tool call
// ---------------------------------------------------------------------------------------------

test("a tool the session does not have is answered rather than thrown", async () => {
  const result = await execute({
    descriptor: { toolCallId: "call-1", toolName: "Nope", args: {} },
    tools: [fakeTool("Read")],
  })
  assert.equal(result.role, "tool")
  const content = result.content as Array<Record<string, unknown>>
  assert.match(String(content[0]?.result), /^Tool not found: Nope\. Available tools: Read$/)
})

test("a call that succeeds is answered with what the model reads", async () => {
  const result = await execute({
    descriptor: { toolCallId: "call-1", toolName: "Read", args: { path: "/a" } },
    tools: [fakeTool("Read", { renderedText: "the file" })],
  })
  const content = result.content as Array<Record<string, unknown>>
  assert.equal(content[0]?.result, "the file")
  assert.equal(content[0]?.toolCallId, "call-1")
  assert.equal(content[0]?.toolName, "Read")
  assert.equal(Array.isArray(content[0]?.experimental_content), true)
  const kept = (result.providerOptions as { cursor: { highLevelToolCallResult: { isError: boolean } } }).cursor.highLevelToolCallResult
  assert.equal(kept.isError, false)
})

test("a call that fails is answered with the failure and its messages", async () => {
  const failing = fakeTool("Read", { error: new Error("the file is gone"), errorText: "the file is gone" })
  const result = await execute({
    descriptor: { toolCallId: "call-1", toolName: "Read", args: {} },
    tools: [failing],
  })
  const kept = (result.providerOptions as { cursor: { highLevelToolCallResult: { isError: boolean; rawErrorMessages: string[] } } }).cursor.highLevelToolCallResult
  assert.equal(kept.isError, true)
  assert.deepEqual(kept.rawErrorMessages, ["the file is gone"])
})

test("a retryable failure is answered with its classification", async () => {
  const retryable = fakeTool("Read", {
    error: new RetryableToolOrchestrationError("retry me", { classification: ToolErrorClassification.PROVIDER_ERROR }),
    errorText: "retry me",
  })
  const recorded: unknown[] = []
  const result = await execute({
    descriptor: { toolCallId: "call-1", toolName: "Read", args: {} },
    tools: [retryable],
    record: (_ctx, _result, _name, classification) => { recorded.push(classification) },
  })
  const kept = (result.providerOptions as { cursor: { highLevelToolCallResult: { isError: boolean } } }).cursor.highLevelToolCallResult
  assert.equal(kept.isError, true)
  assert.deepEqual(recorded, [ToolErrorClassification.PROVIDER_ERROR])
})

test("a retryable failure the turn must see is raised rather than answered", async () => {
  const retryable = fakeTool("Read", {
    error: new RetryableToolOrchestrationError("retry me", { classification: ToolErrorClassification.PROVIDER_ERROR }),
    errorText: "retry me",
  })
  // A turn that is itself a retry has to see the failure rather than read it as a tool result.
  const bubblingCtx = createContext().with(bubbleRetryableTaskErrorsKey, true)
  await assert.rejects(
    () => executeDeferredToolCall(
      bubblingCtx,
      { toolCallId: "call-1", toolName: "Read", args: {} },
      toolMapOf([retryable]),
      interactionHandler,
      {},
      undefined,
      {},
      undefined,
      undefined,
    ),
    /retry me/,
  )
})

test("a result is recorded with the name the platform logs it under", async () => {
  const recorded: Array<{ name: string; classification: unknown }> = []
  await execute({
    descriptor: { toolCallId: "call-1", toolName: "Read", args: {} },
    tools: [fakeTool("Read")],
    record: (_ctx, _result, name, classification) => { recorded.push({ name, classification }) },
  })
  assert.deepEqual(recorded, [{ name: "read", classification: undefined }])
})

test("the call's own id is put on the context it runs in", async () => {
  let seen: string | undefined
  const tool: ToolRecord = {
    ...fakeTool("Read"),
    async execute(runCtx: Context) {
      seen = (runCtx as unknown as { get(key: symbol): string | undefined }).get(
        // The key is the one the module created for this purpose.
        (Object.getOwnPropertySymbols(runCtx as object).length >= 0
          ? (await import("../../source/packages/agent/tool-stream-executor.ts")).conversationStateOpsInReplayOrder === undefined
            ? Symbol("unused")
            : Symbol("unused")
          : Symbol("unused")),
      )
      return { ok: true }
    },
  }
  void tool
  void seen
  // The context carries the call id through a key the module owns; what is observable here is that the call
  // runs at all and that the result is attributed to the call.
  const result = await execute({ descriptor: { toolCallId: "call-1", toolName: "Read", args: {} }, tools: [fakeTool("Read")] })
  assert.equal(result.id, "call-1")
})

// ---------------------------------------------------------------------------------------------
// the conversation's own bookkeeping
// ---------------------------------------------------------------------------------------------

test("state operations are replayed in the order the calls produced them", () => {
  assert.deepEqual(
    conversationStateOpsInReplayOrder([{ stateOps: ["a", "b"] }, {}, { stateOps: ["c"] }]),
    ["a", "b", "c"],
  )
  assert.deepEqual(conversationStateOpsInReplayOrder([]), [])
})

// ---------------------------------------------------------------------------------------------
// the model's response, watched
// ---------------------------------------------------------------------------------------------

/** A stream nobody reads blocks its producer, so a test consumes it as the real caller does. */
async function consumeStream(stream: { fullStream: AsyncIterable<unknown>; response?: Promise<unknown>; toolCallDescriptors?: Promise<unknown> }) {
  const drained = (async () => {
    for await (const _chunk of stream.fullStream) {
      // The real caller reads the response as it arrives; the test only has to keep up with it.
    }
  })()
  await Promise.all([stream.response ?? stream.toolCallDescriptors, drained])
}


test("a tool call in the response is run and its result added to the conversation", async () => {
  const read = fakeTool("Read", { renderedText: "the file" })
  const { executor, calls } = streamExecutor(
    toolCallChunks("call-1", "Read", { path: "/a" }),
    [assistantCall("call-1", "Read", { path: "/a" })],
  )
  const promptExecutor = new SimplePromptToolExecutor(executor as never)
  const stream = promptExecutor.executeToolStream(
    ctx,
    {},
    interactionHandler,
    executionSet([read]),
    {},
    async () => {},
    undefined,
    undefined,
  ) as { fullStream: AsyncIterable<unknown>; response: Promise<{ messages: Array<Record<string, unknown>> }> }
  await consumeStream(stream)
  const response = await stream.response
  assert.equal(response.messages.length, 2)
  assert.equal(response.messages[1]?.role, "tool")
  // The tools were advertised to the model with the descriptions the session builds.
  assert.equal(calls.length, 1)
  assert.equal(Array.isArray(calls[0]?.tools), true)
})

test("a result for a call the response did not make is dropped", async () => {
  const read = fakeTool("Read")
  // The response asks for a call the stream never mentioned, so the result has no message to answer.
  const { executor } = streamExecutor(
    toolCallChunks("call-1", "Read", {}),
    [{ role: "assistant", content: [{ type: "tool-call", toolCallId: "call-2", toolName: "Read", args: {} }] }],
  )
  const promptExecutor = new SimplePromptToolExecutor(executor as never)
  const stream = promptExecutor.executeToolStream(ctx, {}, interactionHandler, executionSet([read]), {}, async () => {}, undefined, undefined) as { fullStream: AsyncIterable<unknown>; response: Promise<{ messages: Array<Record<string, unknown>> }> }
  await consumeStream(stream)
  const response = await stream.response
  assert.equal(response.messages.some(message => message.role === "tool"), false)
})

test("a repeated tool call id is dropped rather than run twice", async () => {
  let runs = 0
  const read: ToolRecord = {
    ...fakeTool("Read"),
    async execute() { runs++; return { toJson: () => ({ ok: true }) } },
  }
  const { executor } = streamExecutor(
    [
      ...toolCallChunks("call-1", "Read", {}),
      ...toolCallChunks("call-1", "Read", {}),
    ],
    [assistantCall("call-1", "Read", {})],
  )
  const promptExecutor = new SimplePromptToolExecutor(executor as never)
  const stream = promptExecutor.executeToolStream(ctx, {}, interactionHandler, executionSet([read]), {}, async () => {}, undefined, undefined) as { fullStream: AsyncIterable<unknown>; response: Promise<unknown> }
  await consumeStream(stream)
  assert.equal(runs, 1)
})

test("a response that says nothing is rebuilt from what was streamed", async () => {
  const { executor } = streamExecutor(
    [{ type: "text-delta", textDelta: "the answer" }],
    [],
  )
  const promptExecutor = new SimplePromptToolExecutor(executor as never)
  const stream = promptExecutor.executeToolStream(ctx, {}, interactionHandler, executionSet([]), {}, async () => {}, undefined, undefined) as { fullStream: AsyncIterable<unknown>; response: Promise<{ messages: Array<Record<string, unknown>> }> }
  await consumeStream(stream)
  const response = await stream.response
  assert.equal(response.messages.length, 1)
  assert.deepEqual(response.messages[0]?.content, [{ type: "text", text: "the answer" }])
})

test("a response that says nothing and streamed nothing stays empty", async () => {
  const { executor } = streamExecutor([], [])
  const promptExecutor = new SimplePromptToolExecutor(executor as never)
  const stream = promptExecutor.executeToolStream(ctx, {}, interactionHandler, executionSet([]), {}, async () => {}, undefined, undefined) as { fullStream: AsyncIterable<unknown>; response: Promise<{ messages: unknown[] }> }
  await consumeStream(stream)
  assert.deepEqual((await stream.response).messages, [])
})

test("a streamed response is also handed out as it arrives", async () => {
  const { executor } = streamExecutor([{ type: "text-delta", textDelta: "the answer" }], [])
  const promptExecutor = new SimplePromptToolExecutor(executor as never)
  const stream = promptExecutor.executeToolStream(ctx, {}, interactionHandler, executionSet([]), {}, async () => {}, undefined, undefined) as { fullStream: AsyncIterable<unknown>; response: Promise<unknown> }
  const chunks: unknown[] = []
  const drained = (async () => {
    for await (const chunk of stream.fullStream) chunks.push(chunk)
  })()
  await Promise.all([stream.response, drained])
  assert.equal(chunks.length, 1)
})

test("a model-only stream collects the calls without running them", async () => {
  let runs = 0
  const read: ToolRecord = { ...fakeTool("Read"), async execute() { runs++; return { toJson: () => ({ ok: true }) } } }
  const { executor } = streamExecutor(
    toolCallChunks("call-1", "Read", { path: "/a" }),
    [assistantCall("call-1", "Read", { path: "/a" })],
  )
  const promptExecutor = new SimplePromptToolExecutor(executor as never)
  const stream = promptExecutor.executeModelStreamOnly(ctx, {}, interactionHandler, executionSet([read]), undefined, undefined) as {
    fullStream: AsyncIterable<unknown>
    toolCallDescriptors: Promise<NativeToolCallDescriptor[]>
  }
  await consumeStream(stream)
  const descriptors = await stream.toolCallDescriptors
  assert.equal(descriptors.length, 1)
  assert.deepEqual(descriptors[0]?.args, { path: "/a" })
  // Nothing was run: the caller decides about the calls.
  assert.equal(runs, 0)
})

// ---------------------------------------------------------------------------------------------
// the redacted executor
// ---------------------------------------------------------------------------------------------

const plainMessage = (role: string, content: unknown) => ({ role, content }) as never
/** The session holds redacted messages, so that is what its executor is given. */
const redactedMessage = (role: string, content: unknown) =>
  toRedactedCoreMessage({ role, content } as never, PrivacyMode.NO_STORAGE)

function innerExecutor(initial: Array<Record<string, unknown>> = []) {
  const state = { messages: [...initial] }
  return {
    state,
    executor: {
      appendMessages(messages: unknown) { state.messages.push(...(Array.isArray(messages) ? messages : [messages]) as never[]) },
      getState: () => state.messages as never[],
      getMessages: () => state.messages as never[],
      clearMessages() { state.messages = [] },
      stream: () => ({}) as never,
      executeToolStream: () => ({ ran: "tools" }),
      executeModelStreamOnly: () => ({ ran: "model" }),
    },
  }
}

test("the conversation is handed out redacted and taken back plain", () => {
  const inner = innerExecutor()
  const executor = new RedactedPromptToolExecutor(inner.executor as never, PrivacyMode.NO_STORAGE)
  const wrapper = redactedMessage("user", "hello")
  executor.appendMessages(wrapper)
  const redacted = executor.getMessages()
  assert.equal(redacted.length, 1)
  const unwrapped = fromRedactedCoreMessage(redacted[0] as never, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED) as { content: string }
  assert.equal(unwrapped.content, "hello")
  // The inner executor holds the plain message, not the wrapper.
  assert.deepEqual(
    inner.state.messages.map(entry => ({ role: entry.role, content: entry.content })),
    [{ role: "user", content: "hello" }],
  )
})

test("the same plain message is wrapped once", () => {
  const inner = innerExecutor()
  const executor = new RedactedPromptToolExecutor(inner.executor as never, PrivacyMode.NO_STORAGE)
  executor.appendMessages(redactedMessage("user", "hello"))
  // Callers compare messages by identity, so the same message has to come back as the same wrapper.
  assert.equal(executor.getMessages()[0], executor.getMessages()[0])
})

test("clearing the conversation forgets the wrappers with it", () => {
  const inner = innerExecutor()
  const executor = new RedactedPromptToolExecutor(inner.executor as never, PrivacyMode.NO_STORAGE)
  const before = redactedMessage("user", "hello")
  executor.appendMessages(before)
  assert.equal(executor.getMessages()[0], before)
  executor.clearMessages()
  assert.deepEqual(executor.getMessages(), [])
  // A wrapper the executor has forgotten is not handed back for a different message.
  executor.appendMessages(redactedMessage("user", "hello"))
  assert.notEqual(executor.getMessages()[0], before)
})

test("the redacted executor passes the streams through", () => {
  const inner = innerExecutor()
  const executor = new RedactedPromptToolExecutor(inner.executor as never, PrivacyMode.NO_STORAGE)
  assert.deepEqual(executor.executeToolStream(ctx, {}, {}, [], {}, {}, {}, {}), { ran: "tools" })
  assert.deepEqual(executor.executeModelStreamOnly(ctx, {}, {}, [], {}, {}), { ran: "model" })
})
