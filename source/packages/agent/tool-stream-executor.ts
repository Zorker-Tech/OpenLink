/**
 * Running the tools a model asks for, while it is still asking for them.
 *
 * A model writes a tool call as a stream of text, and the platform does three things with that stream at
 * once. It shows the call to the user as it is written, so the arguments can be watched arriving; it runs
 * the call as soon as the arguments are complete, without waiting for the rest of the response; and it
 * records the call in the conversation in the shape the next request needs, which is the model's own text
 * rather than a parsed object. Those three are why this is a stream rather than a function: the arguments
 * arrive in pieces, and each piece is forwarded, accumulated and handed on as it comes.
 *
 * What comes back from a call is a result the model reads and a result the platform keeps. The model reads
 * text; the platform keeps the rendered result, the error classification, the raw error messages and
 * whatever context a hook attached to the call, since those are what the next turn, the transcript and the
 * platform's own accounting need. A tool that is not there is answered rather than thrown: the model is told
 * what the tools are, which is usually enough for it to repair the call.
 *
 * Two shapes of failure are treated differently from the rest. A call that was aborted on purpose — the user
 * stopped the turn — is logged as an abort rather than an error, since nothing went wrong. And when the
 * execution backend itself is unavailable, the circuit opens: the calls already in flight are allowed to
 * finish, the ones after them are skipped with an answer that says why, and their arguments are still
 * drained so the model's own output does not stall the stream.
 *
 * A response whose messages carry nothing is rebuilt from the stream that was watched, because a provider
 * that streamed the answer without putting it in the message list has still said something. What was
 * reasoned before a summary, and then re-sent as a summary, is rewritten into the redacted form the provider
 * expects rather than replayed as text.
 */

import { DYNAMIC_TOOLS_NAMESPACE } from "../agent-exec/mcp-operations.ts"
import { AGENT_STORE_CONFLICT_HOOK_EVENT_NAME } from "../agent-store-sync/agent-store-sync-contracts.ts"
import { InteractionListenerStreamClosedError } from "../agent-core/interaction-listener.ts"
import { createKey, type Context } from "../context/context.ts"
import { createLogger } from "../context/logging.ts"
import { appendHookContextRemindersToToolOutput } from "../hooks-carriers/hook-context-rendering.ts"
import { isMcpToolNotFoundError } from "../mcp-agent-exec/mcp-tool-not-found-error.ts"
import { createCounter, createHistogram } from "../metrics/index.ts"
import { PrivacyCapability } from "../redaction/classification.ts"
import {
  fromRedactedCoreMessages,
  toRedactedCoreMessages,
  type CoreMessageLike,
} from "../redaction/message-redaction.ts"
import type { PrivacyMode } from "../redaction/privacy-mode.ts"
import {
  createWritableIterable,
  type WritableIterable,
  WriteIterableClosedError,
} from "../utils/writable-iterable.ts"
import {
  buildDescriptionGeneratorProps,
  executeToolResultOrError,
  extractToolMetadataMap,
  getDirectDynamicToolNames,
  getExecutableTools,
  renderToolResultOrError,
  resolveToolCallIdentity,
  toAgentTools,
  type ToolExecutionSet,
} from "./tools/tool-execution.ts"
import { ToolErrorClassification } from "./tools/tool-errors.ts"
import { getInteropToolFamily as getToolFamily } from "../../adapters/interop/agent/tool-family-adapter.ts"
import { RetryableToolOrchestrationError, truncateOutput } from "./tools/tool-support.ts"
import { isAgentStreamStartTimeoutRecoveryTurnError } from "./tools/connect-errors.ts"
import { getAgentEventTracker } from "./utils/event-tracking.ts"
import {
  getClientOsMetricTagFromContext,
  getClientRemoteTypeMetricTagFromContext,
  getClientVersionMetricTagsFromContext,
  getIsDevFromContext,
  getIsSubagentFromContext,
  getIsUserApiKeyFromContext,
} from "./utils/request-scope.ts"

type RuntimeTool = Record<string, unknown> & {
  readonly name: string
  readonly toolIdentifier: string
  readonly dynamicToolMetaRole?: string
  readonly customToolFormat?: unknown
}

type ReplayProviderOptions = {
  readonly cursor?: {
    readonly isAlreadySummarizedThinking?: boolean
    readonly modelName?: string
  }
}

type ResponseStreamChunk =
  | { readonly type: "text-delta"; readonly textDelta: string }
  | { readonly type: "reasoning"; readonly textDelta: string; readonly providerOptions?: ReplayProviderOptions }
  | { readonly type: "redacted-reasoning"; readonly data: string; readonly providerOptions?: ReplayProviderOptions }
  | { readonly type: "reasoning-signature"; readonly signature: string }
  | { readonly type: "tool-call-streaming-start"; readonly toolCallId: string; readonly toolName: string }
  | { readonly type: "tool-call-delta"; readonly toolCallId: string; readonly toolName: string; readonly argsTextDelta: string }
  | { readonly type: "tool-call"; readonly toolCallId: string; readonly toolName: string; readonly args: unknown }

type ResponseContentPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string; signature?: string; providerOptions?: ReplayProviderOptions }
  | { type: "redacted-reasoning"; data: string; providerOptions?: ReplayProviderOptions }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }
  | { type: "file"; [key: string]: unknown }

interface StreamedResponse {
  readonly messages: Array<Record<string, unknown> & {
    readonly role: string
    readonly content: string | ResponseContentPart[]
  }>
  readonly id: string
  readonly [key: string]: unknown
}

interface ModelStream {
  readonly fullStream: AsyncIterable<ResponseStreamChunk>
  readonly response: Promise<StreamedResponse>
  readonly usage: Promise<unknown>
  readonly extendedUsage: Promise<unknown>
  readonly providerMetadata: Promise<unknown>
  readonly invocationId: unknown
}

interface PromptStreamExecutor {
  stream(
    ctx: Context,
    invocationId: string,
    tools: readonly unknown[],
    options: Record<string, unknown>,
  ): ModelStream
}

const callLog = createLogger("chat-inference/tool-call")
const TOOL_CALL_ID_CONTEXT_KEY = createKey<string | undefined>(
  Symbol("agent.toolCallId"),
  undefined,
)
const SEMANTIC_SEARCH_TOOL_NAME = "semantic_search"
const RAW_ERROR_MESSAGE_CHARACTER_BUDGET = 20_000

interface HookCarrier {
  readonly hookEventName: string
  readonly content: string
}

export function conversationStateOpsInReplayOrder(
  toolCallResults: readonly { readonly stateOps?: readonly unknown[] }[],
): unknown[] {
  return toolCallResults.flatMap(result => result.stateOps ?? [])
}

/** Every message an error carries, including the ones it wraps, bounded so one error cannot fill a prompt. */
function collectRawErrorMessages(error: unknown): string[] {
  const messages: string[] = []
  const queue: unknown[] = [error]
  const seen = new Set<unknown>()
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined || seen.has(current)) {
      continue
    }
    seen.add(current)
    if (current instanceof Error) {
      if (current.message.length > 0) {
        messages.push(
          truncateOutput(current.message, RAW_ERROR_MESSAGE_CHARACTER_BUDGET, true).output,
        )
      }
      const cause = current.cause
      if (cause !== undefined) {
        queue.push(cause)
      }
    }
  }
  return Array.from(new Set(messages))
}

/** A collector that keeps only the conflict notices, which is all the caller wants from it. */
function createConflictNoticeOnlyCollector(): HookCarrier[] {
  const collector: HookCarrier[] = []
  const push = collector.push.bind(collector)
  collector.push = (...items: HookCarrier[]) => push(
    ...items.filter(item => item.hookEventName === AGENT_STORE_CONFLICT_HOOK_EVENT_NAME),
  )
  return collector
}

function getMcpVersionLabel(toolName: string): string {
  if (toolName !== "mcp") {
    return ""
  }
  return "snapshots"
}

const toolCallDuration = createHistogram("tool_call.duration_ms", {
  description: "Duration of tool call execution in milliseconds",
  labelNames: [
    "toolName",
    "outcome",
    "team",
    "mcp_version",
    "clientversion",
    "clienttype",
    "remoteType",
    "isdynamic",
    "user.is_dev",
  ],
})
const toolCallResult = createCounter("tool_call.result", {
  description: "Result status of tool call execution",
  labelNames: [
    "toolName",
    "outcome",
    "team",
    "mcp_version",
    "clientversion",
    "clienttype",
    "remoteType",
    "os",
    "issubagent",
    "isuserapikey",
    "isdynamic",
    "user.is_dev",
  ],
})
const rawToolCallInputTokens = createHistogram("agent.tool_call.input_tokens", {
  description:
    "Approximate number of tokens in raw model-produced tool call arguments (argsText.length / 4)",
  labelNames: ["tool_name"],
})
const duplicateInboundToolCallId = createCounter("agent.duplicate_inbound_tool_call_id", {
  description:
    "Tool-call stream chunks whose id collided with an already-handled or in-flight tool call in the same model response",
  labelNames: ["chunkType", "disposition"],
})

export interface NativeToolCallDescriptor {
  readonly toolCallId: string
  readonly toolName: string
  readonly args: unknown
  readonly effectiveNativeToolCall?: {
    readonly toolName: string
    readonly args: unknown
  }
}

interface BasePromptExecutor {
  appendMessages(messages: any): unknown
  getState(): readonly any[]
  getMessages(): readonly any[]
  clearMessages(): unknown
  stream(ctx: Context, invocationId: string, tools: readonly unknown[], options: Record<string, unknown>): any
}

interface ExecutingPromptExecutor extends BasePromptExecutor {
  executeToolStream(...args: unknown[]): unknown
  executeModelStreamOnly(...args: unknown[]): unknown
}

interface InvocationHandler {
  readonly invocationId: string
}

interface ToolCallWatchEvent {
  readonly toolCallId: string
  readonly toolName: string
  readonly argsStream: AsyncIterable<string>
  readonly completedArgs: Promise<unknown>
  readonly completedArgsText: Promise<string>
}

interface CollectionOptions {
  readonly emitToolCallEvents?: boolean
  readonly executionToolMap?: Record<string, RuntimeTool>
  readonly acceptedUnadvertisedToolNames?: readonly string[]
}

/** A tool the session does not have is logged as "other", since its name is not a name we publish. */
function toolNameForLogging(toolName: string, toolMap: Record<string, RuntimeTool>): string {
  if (!(toolName in toolMap)) {
    return "other"
  }
  return toolMap[toolName]!.toolIdentifier
}

function resolveToolCallTelemetry(
  tool: RuntimeTool,
  args: unknown,
  isDirectDynamicTool = false,
): Record<string, unknown> & { toolIdentifier: string; loggedToolName: string } {
  const identity = resolveToolCallIdentity({ tool, args, isDirectDynamicTool })
  const toolIdentifier = typeof identity.toolIdentifier === "string"
    ? identity.toolIdentifier
    : "unknown"
  return {
    ...identity,
    toolIdentifier,
    loggedToolName: toolIdentifier === "unknown" ? "other" : toolIdentifier.toLowerCase(),
  }
}

function approximateTokenCountFromRawArgs(rawArgs: string): number {
  if (rawArgs.length === 0) {
    return 0
  }
  return Math.floor(rawArgs.length / 4)
}

/** One stream, two readers: the tool call collector and whoever is watching the response. */
function duplicateStream<T>(stream: AsyncIterable<T>): [WritableIterable<T>, WritableIterable<T>] {
  const stream1 = createWritableIterable<T>()
  const stream2 = createWritableIterable<T>()
  async function run(): Promise<void> {
    try {
      for await (const chunk of stream) {
        await stream1.write(chunk)
        await stream2.write(chunk)
      }
    } catch (error) {
      stream1.throw(error)
      stream2.throw(error)
    } finally {
      stream1.close()
      stream2.close()
    }
  }
  void run().catch(error => {
    throw error
  })
  return [stream1, stream2]
}

/**
 * The arguments of one tool call as they arrive: what has been written, what the user is watching, and the
 * two promises the runtime waits on when it needs the whole call rather than its pieces.
 */
class ToolCallStream {
  readonly toolCallId: string
  toolName: string
  readonly inner: WritableIterable<string> | undefined
  written: string
  private resolveCompletedArgs: (args: unknown) => void
  private resolveCompletedArgsText: (argsText: string) => void
  readonly completedArgs: Promise<unknown>
  readonly completedArgsText: Promise<string>

  constructor(
    toolCallId: string,
    toolName: string,
    inner: WritableIterable<string> | undefined,
  ) {
    this.toolCallId = toolCallId
    this.toolName = toolName
    this.inner = inner
    this.written = ""
    this.resolveCompletedArgs = () => {}
    this.resolveCompletedArgsText = () => {}
    this.completedArgs = new Promise(resolve => {
      this.resolveCompletedArgs = resolve
    })
    this.completedArgsText = new Promise(resolve => {
      this.resolveCompletedArgsText = resolve
    })
  }

  async write(ctx: Context, chunk: string): Promise<void> {
    this.written += chunk
    if (this.inner === undefined) {
      return
    }
    // A watcher that has gone away is not a failure of the call itself.
    void this.inner.write(chunk).catch(error => {
      if (error instanceof WriteIterableClosedError) {
        return
      }
      callLog.error(ctx, "Error writing to tool call stream", error)
    })
  }

  /** A provider that sends the whole call at once still has to be shown as if it had streamed it. */
  async complete(ctx: Context, fullValue: string): Promise<void> {
    const rest = fullValue.slice(this.written.length)
    if (rest.length > 0) {
      this.written += rest
      if (this.inner === undefined) {
        return
      }
      try {
        await this.inner.write(rest)
      } catch (error) {
        if (error instanceof WriteIterableClosedError) {
          return
        }
        callLog.error(ctx, "Error writing to tool call stream", error)
      }
    }
  }

  resolveArgs(args: unknown): void {
    this.resolveCompletedArgs(args)
  }

  resolveArgsText(argsText: string): void {
    this.resolveCompletedArgsText(argsText)
  }

  async close(): Promise<void> {
    this.inner?.close()
  }
}

function createOneShotArgsIterable(args: unknown): AsyncIterable<string> {
  return createOneShotStringIterable(typeof args === "string" ? args : JSON.stringify(args) as string)
}

function createOneShotStringIterable(value: string): AsyncIterable<string> {
  return (async function* () {
    yield value
  })()
}

function createToolMap(tools: readonly RuntimeTool[]): Record<string, RuntimeTool> {
  const toolMap: Record<string, RuntimeTool> = {}
  for (const tool of tools) {
    toolMap[tool.name] = tool
  }
  return toolMap
}

/** Arguments a provider sent as text are read as an object when they are one, and left as text when not. */
export function parseNativeToolArguments(value: unknown): unknown {
  if (value === undefined) {
    return {}
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value
  }
  if (typeof value !== "string") {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed
    }
  } catch {
    // Preserve the raw string for custom-format and malformed native calls.
  }
  return value
}

function getDynamicInvocationToolNames(modelVisibleTools: readonly RuntimeTool[]): Set<string> {
  return new Set(
    modelVisibleTools
      .filter(tool => tool.dynamicToolMetaRole === "invocation")
      .map(tool => tool.name),
  )
}

/**
 * A dynamic invocation is one tool call that names another: the platform's own namespace and a tool inside
 * it. What the model actually asked for is the inner call, so the descriptor is resolved into it — but only
 * when the namespace is ours and the tool exists, since otherwise the outer call is what was meant.
 */
export function resolveEffectiveToolCallDescriptor(
  descriptor: NativeToolCallDescriptor,
  toolExecutionSet: ToolExecutionSet,
): NativeToolCallDescriptor {
  const modelVisibleTools = toolExecutionSet.modelVisibleTools as RuntimeTool[]
  const dynamicInvocationToolNames = getDynamicInvocationToolNames(modelVisibleTools)
  if (!dynamicInvocationToolNames.has(descriptor.toolName)) {
    return descriptor
  }
  const executableToolNames = new Set(
    getExecutableTools(toolExecutionSet).map(tool => tool.name as string),
  )
  if (
    descriptor.args === null ||
    typeof descriptor.args !== "object" ||
    Array.isArray(descriptor.args)
  ) {
    return descriptor
  }
  const args = descriptor.args as Record<string, unknown>
  const namespace = args.namespace
  const toolName = args.toolName
  if (
    namespace !== DYNAMIC_TOOLS_NAMESPACE ||
    typeof toolName !== "string" ||
    !executableToolNames.has(toolName)
  ) {
    return descriptor
  }
  const effectiveArgs = parseNativeToolArguments(args.arguments)
  if (effectiveArgs === undefined) {
    return descriptor
  }
  return {
    ...descriptor,
    effectiveNativeToolCall: { toolName, args: effectiveArgs },
  }
}

export function getEffectiveToolCallName(descriptor: NativeToolCallDescriptor): string {
  return descriptor.effectiveNativeToolCall?.toolName ?? descriptor.toolName
}

export function getEffectiveToolCallArgs(descriptor: NativeToolCallDescriptor): unknown {
  return descriptor.effectiveNativeToolCall?.args ?? descriptor.args
}

async function drainArgsStream(argsStream: AsyncIterable<string>): Promise<void> {
  for await (const _chunk of argsStream) {
    // Drain the model's outer dynamic-tool payload before switching to native arguments.
  }
}

type ResultRecorder = (
  ctx: Context,
  result: unknown,
  loggedToolName: string,
  errorClassification: ToolErrorClassification | string | undefined,
) => unknown | Promise<unknown>

interface ExecutionExtras extends Record<string, unknown> {
  readonly enableHookAdditionalContext?: boolean
  readonly enableAgentStoreConflictNoticeCollector?: boolean
  readonly enableAgentStoreConflictNotices?: boolean
  readonly stateHandler?: {
    readonly getBlobStore?: () => unknown
  }
}

/**
 * One tool call, from the arguments to the result the conversation keeps.
 *
 * The telemetry is refined while the call runs: what the tool is and whether it is a dynamic invocation can
 * depend on the arguments, and the arguments may still be arriving, so the start is logged once the call's
 * own output or its completed arguments have decided it — whichever comes first, since a tool that answers
 * immediately must not wait for a promise nobody will resolve.
 */
export async function executeDeferredToolCall(
  ctx: Context,
  call: NativeToolCallDescriptor,
  toolsByName: Record<string, RuntimeTool>,
  invocation: unknown,
  extras: ExecutionExtras,
  recordResult: ResultRecorder | undefined,
  renderContext: Record<string, unknown>,
  argsWatcher: AsyncIterable<string> | undefined,
  completedArgumentPromise: Promise<unknown> | undefined,
  directDynamicNames = new Set<string>(),
): Promise<Record<string, unknown>> {
  const resolvedName = getEffectiveToolCallName(call)
  const resolvedArgs = getEffectiveToolCallArgs(call)
  const tool = toolsByName[resolvedName]
  // A tool that is not there is answered rather than thrown, since the model can usually repair the call.
  if (tool === undefined) {
    callLog.warn(ctx, "nal.tool_call.failure", {
      toolCallId: call.toolCallId,
      toolName: "other",
      toolNameFromModel: resolvedName,
      errorClassification: "tool_not_found",
      team: getToolFamily("unknown"),
    })
    toolCallResult.increment(ctx, 1, {
      toolName: "other",
      outcome: "tool_not_found",
      team: getToolFamily("unknown"),
      mcp_version: "",
      ...getClientVersionMetricTagsFromContext(ctx),
      ...getClientRemoteTypeMetricTagFromContext(ctx),
      ...getClientOsMetricTagFromContext(ctx),
      issubagent: getIsSubagentFromContext(ctx) ? "true" : "false",
      isuserapikey: getIsUserApiKeyFromContext(ctx) ? "true" : "false",
      isdynamic: "false",
      "user.is_dev": getIsDevFromContext(ctx) ? "true" : "false",
    } as Record<string, string>)
    getAgentEventTracker(ctx).trackToolCallResult(ctx, {
      toolName: "other",
      toolCallId: call.toolCallId,
      outcome: "tool_not_found",
    })
    return {
      role: "tool",
      id: call.toolCallId,
      content: [{
        type: "tool-result",
        toolName: call.toolName,
        toolCallId: call.toolCallId,
        result: `Tool not found: ${resolvedName}. Available tools: ${Object.keys(toolsByName).join(", ")}`,
      }],
    }
  }
  const startedAtMs = Date.now()
  const argumentStream = argsWatcher ?? createOneShotArgsIterable(resolvedArgs)
  const dynamicSurface = call.effectiveNativeToolCall !== undefined ||
    directDynamicNames.has(resolvedName)
  let instrumentation = resolveToolCallTelemetry(tool, resolvedArgs, dynamicSurface)
  let instrumentationFields: Record<string, unknown> = instrumentation.isDynamic
    ? { isDynamicToolCall: true }
    : {}
  let loggedStart = false
  const noteCallStart = (): void => {
    loggedStart = true
    callLog.info(ctx, "nal.tool_call.start", {
      toolCallId: call.toolCallId,
      toolName: instrumentation.loggedToolName,
      team: getToolFamily(instrumentation.toolIdentifier),
      ...instrumentationFields,
    })
    getAgentEventTracker(ctx).trackToolCallStarted(ctx, {
      toolName: instrumentation.loggedToolName,
      toolCallId: call.toolCallId,
    })
  }
  const allHookCarriers = extras.enableHookAdditionalContext === true
  const noticesOnly =
    extras.enableAgentStoreConflictNoticeCollector === true ||
    extras.enableAgentStoreConflictNotices === true
  const carrierCollector = allHookCarriers
    ? []
    : noticesOnly
      ? createConflictNoticeOnlyCollector()
      : undefined
  const callContext = ctx.with(TOOL_CALL_ID_CONTEXT_KEY, call.toolCallId)
  try {
    // The tool is a record here and a typed tool there; the runtime shape is the same one.
    const runTool = () => executeToolResultOrError(
      tool as unknown as Parameters<typeof executeToolResultOrError>[0],
      callContext,
      invocation as Parameters<typeof executeToolResultOrError>[2],
      argumentStream,
      {
        ...extras,
        toolCallId: call.toolCallId,
        carrierCollector,
      },
    )
    // The output is captured rather than awaited here, so the instrumentation race below can see it settle.
    const outputSettled = runTool().then(
      result => ({ ok: true as const, result }),
      error => ({ ok: false as const, error }),
    )
    if (tool.resolveToolCallTelemetry !== undefined && completedArgumentPromise !== undefined) {
      try {
        const raceResult = await Promise.race([
          completedArgumentPromise.then(args => ({ source: "completedArgs" as const, args })),
          outputSettled.then(result => ({ source: "toolOutput" as const, result })),
        ])
        if (raceResult.source === "completedArgs") {
          instrumentation = resolveToolCallTelemetry(
            tool,
            raceResult.args,
            dynamicSurface,
          )
          instrumentationFields = instrumentation.isDynamic ? { isDynamicToolCall: true } : {}
        }
      } catch {
        // Telemetry refinement must never affect execution.
      }
    }
    noteCallStart()
    const settledOutput = await outputSettled
    if (!settledOutput.ok) {
      throw settledOutput.error
    }
    const rawOutput = settledOutput.result
    const blobs = extras.stateHandler?.getBlobStore?.()
    const renderContextWithBlobs = { ...renderContext, blobs }
    const rendered = await renderToolResultOrError(
      ctx,
      tool as unknown as Parameters<typeof executeToolResultOrError>[0],
      rawOutput,
      renderContextWithBlobs,
    )
    // What the platform keeps about the call: the rendered result, whether it failed, and the messages the
    // failure carried.
    const keptResult: Record<string, unknown> = {
      output: rawOutput.result.toJson(),
      isError: rendered.isError,
    }
    const durationMs = Date.now() - startedAtMs
    let mainText: string | undefined
    const textChunks: string[] = []
    for (const piece of rendered.content as Array<Record<string, unknown>>) {
      if (piece.type === "text") {
        textChunks.push(piece.text as string)
      }
    }
    if (textChunks.length > 0) {
      mainText = textChunks.join("\n")
    }
    let errorClassification: ToolErrorClassification | string | undefined
    if (rendered.isError === true && "error" in rawOutput) {
      errorClassification = rawOutput.errorClassification
      const rawFailures = collectRawErrorMessages(rawOutput.error)
      if (rawFailures.length > 0) {
        keptResult.rawErrorMessages = rawFailures
      }
      const abortReasonValue = ctx.reason as {
        readonly intentional?: unknown
        readonly reason?: unknown
      } | undefined
      // A call the user stopped on purpose is an abort, not a failure of the tool.
      const intentionalStop = ctx.canceled && abortReasonValue?.intentional === true
      const failureFields = {
        toolCallId: call.toolCallId,
        toolName: instrumentation.loggedToolName,
        durationMs,
        errorClassification,
        toolError: true,
        intentionalAbort: intentionalStop,
        abortReason: abortReasonValue?.reason,
        team: getToolFamily(instrumentation.toolIdentifier),
        errorMessage: typeof mainText === "string" ? mainText : undefined,
        mcp_version: getMcpVersionLabel(instrumentation.loggedToolName),
        ...instrumentationFields,
      }
      if (intentionalStop) {
        callLog.info(ctx, "nal.tool_call.aborted", failureFields)
      } else {
        callLog.error(ctx, "nal.tool_call.failure", rawOutput.error, failureFields)
      }
    } else {
      callLog.info(ctx, "nal.tool_call.success", {
        toolCallId: call.toolCallId,
        toolName: instrumentation.loggedToolName,
        durationMs,
        team: getToolFamily(instrumentation.toolIdentifier),
        mcp_version: getMcpVersionLabel(instrumentation.loggedToolName),
        ...instrumentationFields,
      })
    }
    if (recordResult !== undefined) {
      await recordResult(
        ctx,
        rendered,
        instrumentation.loggedToolName,
        errorClassification,
      )
    }
    const outcome = errorClassification === undefined
      ? "success"
      : errorClassification.toString()
    getAgentEventTracker(ctx).trackToolCallResult(ctx, {
      toolName: instrumentation.loggedToolName,
      toolCallId: call.toolCallId,
      outcome,
    })
    const team = getToolFamily(instrumentation.toolIdentifier)
    const mcpVersion = getMcpVersionLabel(instrumentation.loggedToolName)
    toolCallResult.increment(ctx, 1, {
      toolName: instrumentation.loggedToolName,
      outcome,
      team,
      mcp_version: mcpVersion,
      ...getClientVersionMetricTagsFromContext(ctx),
      ...getClientRemoteTypeMetricTagFromContext(ctx),
      ...getClientOsMetricTagFromContext(ctx),
      issubagent: getIsSubagentFromContext(ctx) ? "true" : "false",
      isuserapikey: getIsUserApiKeyFromContext(ctx) ? "true" : "false",
      isdynamic: instrumentation.isDynamic ? "true" : "false",
      "user.is_dev": getIsDevFromContext(ctx) ? "true" : "false",
    } as Record<string, string>)
    if (instrumentation.loggedToolName === SEMANTIC_SEARCH_TOOL_NAME) {
      callLog.info(ctx, "semantic search usage detected")
    }
    toolCallDuration.histogram(ctx, durationMs, {
      toolName: instrumentation.loggedToolName,
      outcome,
      team,
      mcp_version: mcpVersion,
      ...getClientVersionMetricTagsFromContext(ctx),
      ...getClientRemoteTypeMetricTagFromContext(ctx),
      isdynamic: instrumentation.isDynamic ? "true" : "false",
      "user.is_dev": getIsDevFromContext(ctx) ? "true" : "false",
    } as Record<string, string>)
    const resultContent = [...rendered.content] as Array<Record<string, unknown>>
    // Only the conflict notices are appended when that is all the caller asked to collect.
    const carriers = allHookCarriers || carrierCollector === undefined
      ? carrierCollector ?? []
      : carrierCollector.filter(
        carrier => carrier.hookEventName === AGENT_STORE_CONFLICT_HOOK_EVENT_NAME,
      )
    appendHookContextRemindersToToolOutput(
      textChunks,
      resultContent as Array<{ type: "text"; text: string }>,
      carriers as never[],
    )
    mainText = textChunks.length > 0 ? textChunks.join("\n") : mainText
    return {
      role: "tool",
      id: call.toolCallId,
      content: [{
        type: "tool-result",
        toolName: call.toolName,
        toolCallId: call.toolCallId,
        result: mainText,
        experimental_content: resultContent,
      }],
      providerOptions: {
        cursor: {
          highLevelToolCallResult: keptResult ?? {},
        },
      },
    }
  } catch (error) {
    // A call that failed before its start was logged is logged now, so every call has a start and an end.
    if (!loggedStart) {
      noteCallStart()
    }
    const durationMs = Date.now() - startedAtMs
    const errorName = error instanceof Error ? error.name : typeof error
    const errorMessage = error instanceof Error ? error.message : undefined
    const errorClassification = isMcpToolNotFoundError(error)
      ? "tool_not_found"
      : error instanceof RetryableToolOrchestrationError
        ? error.classification
        : undefined
    let outcome = errorClassification !== undefined ? errorClassification : "error"
    const abortReason = ctx.reason as {
      readonly intentional?: unknown
      readonly reason?: unknown
    } | undefined
    const isIntentionalAbort = ctx.canceled && abortReason?.intentional === true
    if (error instanceof InteractionListenerStreamClosedError || isIntentionalAbort) {
      // A listener that went away is a warning; a user who stopped the turn is not even that.
      const logLevel = isIntentionalAbort ? "info" : "warn"
      callLog[logLevel](ctx, "nal.tool_call.aborted", {
        error,
        toolCallId: call.toolCallId,
        toolName: instrumentation.loggedToolName,
        durationMs,
        errorName,
        errorMessage,
        errorClassification,
        intentionalAbort: isIntentionalAbort,
        abortReason: abortReason?.reason,
        team: getToolFamily(instrumentation.toolIdentifier),
        mcp_version: getMcpVersionLabel(instrumentation.loggedToolName),
        ...instrumentationFields,
      })
      outcome = "aborted"
    } else {
      callLog.error(ctx, "nal.tool_call.unexpected_error_not_user_visible", error, {
        toolCallId: call.toolCallId,
        toolName: instrumentation.loggedToolName,
        durationMs,
        errorName,
        errorMessage,
        errorClassification,
        team: getToolFamily(instrumentation.toolIdentifier),
        mcp_version: getMcpVersionLabel(instrumentation.loggedToolName),
        ...instrumentationFields,
      })
    }
    const finalFamily = getToolFamily(instrumentation.toolIdentifier)
    const finalMcpTag = getMcpVersionLabel(instrumentation.loggedToolName)
    toolCallDuration.histogram(ctx, durationMs, {
      toolName: instrumentation.loggedToolName,
      outcome,
      team: finalFamily,
      mcp_version: finalMcpTag,
      ...getClientVersionMetricTagsFromContext(ctx),
      ...getClientRemoteTypeMetricTagFromContext(ctx),
      isdynamic: instrumentation.isDynamic ? "true" : "false",
      "user.is_dev": getIsDevFromContext(ctx) ? "true" : "false",
    } as Record<string, string>)
    toolCallResult.increment(ctx, 1, {
      toolName: instrumentation.loggedToolName,
      outcome,
      team: finalFamily,
      mcp_version: finalMcpTag,
      ...getClientVersionMetricTagsFromContext(ctx),
      ...getClientRemoteTypeMetricTagFromContext(ctx),
      ...getClientOsMetricTagFromContext(ctx),
      issubagent: getIsSubagentFromContext(ctx) ? "true" : "false",
      isuserapikey: getIsUserApiKeyFromContext(ctx) ? "true" : "false",
      isdynamic: instrumentation.isDynamic ? "true" : "false",
      "user.is_dev": getIsDevFromContext(ctx) ? "true" : "false",
    } as Record<string, string>)
    if (instrumentation.loggedToolName === SEMANTIC_SEARCH_TOOL_NAME) {
      callLog.info(ctx, "semantic search usage detected")
    }
    getAgentEventTracker(ctx).trackToolCallResult(ctx, {
      toolName: instrumentation.loggedToolName,
      toolCallId: call.toolCallId,
      outcome,
    })
    throw error
  }
}

function hasMeaningfulContentPart(part: ResponseContentPart): boolean {
  if (part.type === "text") {
    return part.text.trim().length > 0
  }
  if (part.type === "reasoning") {
    return part.text.trim().length > 0
  }
  return part.type === "tool-call" || part.type === "file"
}

/** A call or a file counts as something to say; reasoning on its own does not. */
function shouldSynthesizeResponseFromStreamContent(part: ResponseContentPart): boolean {
  if (part.type === "text") {
    return part.text.trim().length > 0
  }
  return part.type === "tool-call" || part.type === "file"
}

/**
 * Reasoning that was already summarized once, and is being sent back, is not text the provider will accept:
 * it goes back as the redacted form it came from, or it is dropped when even that is not known.
 */
function sanitizeContentBufferForReplay(buffer: readonly ResponseContentPart[]): ResponseContentPart[] {
  return buffer.flatMap<ResponseContentPart>(part => {
    if (part.type !== "reasoning") {
      return [part]
    }
    const isSummary = part.providerOptions?.cursor?.isAlreadySummarizedThinking === true
    if (!isSummary) {
      return [part]
    }
    if (part.signature !== undefined && part.signature.length > 0) {
      const modelName = part.providerOptions?.cursor?.modelName
      if (modelName === undefined) {
        return []
      }
      return [{
        type: "redacted-reasoning" as const,
        data: part.signature,
        providerOptions: { cursor: { modelName } },
      }]
    }
    return []
  })
}

function hasMeaningfulResponseMessageContent(messages: StreamedResponse["messages"]): boolean {
  return messages.some(message => {
    if (message.role !== "assistant") {
      return false
    }
    if (typeof message.content === "string") {
      return message.content.trim().length > 0
    }
    return message.content.some(hasMeaningfulContentPart)
  })
}

/**
 * The model's response, watched as it arrives.
 *
 * Three streams come out of one: the tool calls as descriptors, the same calls as events with their argument
 * streams for whoever runs them, and the response itself. The content is also accumulated as it streams,
 * because a provider that streamed an answer without putting it in the message list has still answered, and
 * the message list is rebuilt from what was watched in that case.
 *
 * A tool call is finished when its arguments are complete or when the next call starts, and a call whose id
 * has already been handled is dropped rather than run twice — providers do repeat ids, and running a call
 * twice is worse than losing a duplicate. The iterables are closed only once every write has settled, since
 * a consumer that is still reading must not see the stream end under it.
 */
function streamModelAndCollectToolCalls(
  ctx: Context,
  executor: PromptStreamExecutor,
  interactionHandler: InvocationHandler,
  visibleTools: readonly RuntimeTool[],
  descriptionInputs: Record<string, unknown> | undefined,
  onFirstToolCall: ((messagesForError: string[]) => unknown | Promise<unknown>) | undefined,
  collection?: CollectionOptions,
) {
  const emitEvents = collection?.emitToolCallEvents ?? true
  let toolsByName = collection?.executionToolMap
  if (toolsByName === undefined) {
    const visibleToolMap: Record<string, RuntimeTool> = {}
    for (const tool of visibleTools) {
      visibleToolMap[tool.name] = tool
    }
    toolsByName = visibleToolMap
  }
  const visibleToolList = visibleTools as RuntimeTool[]
  const definitions = toAgentTools(
    visibleToolList,
    descriptionInputs ?? buildDescriptionGeneratorProps(visibleToolList),
  )
  const acceptedUnadvertisedNames = collection?.acceptedUnadvertisedToolNames ?? []
  const result = executor.stream(
    ctx,
    interactionHandler.invocationId,
    definitions,
    { acceptedUnadvertisedToolNames: acceptedUnadvertisedNames },
  )
  // The response is settled into a value rather than awaited, so a rejection can be reported after the
  // stream has been drained rather than thrown past it.
  const settledModelResponse = result.response.then(
    response => ({ didReject: false as const, response }),
    error => ({ didReject: true as const, error }),
  )
  const [watchedStream, forwardedStream] = duplicateStream(result.fullStream)
  const callsIterable = createWritableIterable<NativeToolCallDescriptor>()
  const eventsIterable = createWritableIterable<ToolCallWatchEvent>()
  const responseWork = (async (): Promise<StreamedResponse> => {
    let openStream: ToolCallStream | undefined
    let openCallId: string | undefined
    let startedCalls = false
    const handledCalls = new Set<string>()
    const contentAccumulator: ResponseContentPart[] = []
    const messagesOut: StreamedResponse["messages"] = []
    let response: StreamedResponse
    let iterablesClosed = false
    let readyToCloseIterables = false
    const pendingCallWrites = new Set<Promise<void>>()
    const pendingEventWrites = new Set<Promise<void>>()
    const closeIterablesWhenIdle = (): void => {
      if (iterablesClosed || !readyToCloseIterables) {
        return
      }
      const pendingWrites = emitEvents ? pendingEventWrites : pendingCallWrites
      if (pendingWrites.size > 0) {
        return
      }
      iterablesClosed = true
      callsIterable.close()
      eventsIterable.close()
    }
    const finishOpenStream = (): void => {
      if (openStream === undefined) {
        return
      }
      const stream = openStream
      stream.close().catch(error => {
        if (error instanceof Error && error.message.includes("WritableIterable is closed")) {
          return
        }
        callLog.error(ctx, "Error closing tool call stream", error)
      })
      handledCalls.add(stream.toolCallId)
      const tool = toolsByName[stream.toolName]
      // A tool that parses its own arguments is handed the raw text, since its format is not JSON.
      const customFormatTool = tool !== undefined &&
        "customToolFormat" in tool &&
        tool.customToolFormat !== undefined
      let argumentParseFailure: unknown
      const args: unknown = (() => {
        if (stream.written.length === 0) {
          return {}
        }
        if (customFormatTool) {
          return stream.written
        }
        try {
          return JSON.parse(stream.written) as unknown
        } catch (error) {
          argumentParseFailure = error
          return stream.written
        }
      })()
      contentAccumulator.push({
        type: "tool-call",
        toolCallId: stream.toolCallId,
        toolName: stream.toolName,
        args,
      })
      stream.resolveArgs(args)
      stream.resolveArgsText(stream.written)
      const descriptor: NativeToolCallDescriptor = {
        toolCallId: stream.toolCallId,
        toolName: stream.toolName,
        args,
      }
      const telemetry = tool === undefined ? undefined : resolveToolCallTelemetry(tool, args)
      const instrumentedName = telemetry === undefined || telemetry.toolIdentifier === "unknown"
        ? "other"
        : telemetry.toolIdentifier
      // Malformed arguments are still handed over: the tool decides what to say about them, and the model
      // reads that rather than a parser error.
      if (argumentParseFailure !== undefined) {
        callLog.warn(ctx, "nal.tool_call.args_parse_failure", {
          toolCallId: stream.toolCallId,
          toolName: instrumentedName,
          toolNameFromModel: stream.toolName,
          errorClassification: "invalid_args",
          errorMessage: argumentParseFailure instanceof Error
            ? argumentParseFailure.message
            : String(argumentParseFailure),
          writtenByteLength: Buffer.byteLength(stream.written, "utf8"),
          team: getToolFamily(telemetry?.toolIdentifier ?? "unknown"),
        })
      }
      const approxInputTokens = approximateTokenCountFromRawArgs(stream.written)
      if (approxInputTokens > 0) {
        rawToolCallInputTokens.histogram(ctx, approxInputTokens, {
          tool_name: instrumentedName,
        })
      }
      const pending = callsIterable.write(descriptor).catch(() => {})
      pendingCallWrites.add(pending)
      void pending.finally(() => {
        pendingCallWrites.delete(pending)
        closeIterablesWhenIdle()
      })
    }
    const finishIterables = (): void => {
      readyToCloseIterables = true
      closeIterablesWhenIdle()
    }
    const publishCallEvent = (stream: ToolCallStream): void => {
      if (stream.inner === undefined) {
        return
      }
      const pending = eventsIterable.write({
        toolCallId: stream.toolCallId,
        toolName: stream.toolName,
        argsStream: stream.inner,
        completedArgs: stream.completedArgs,
        completedArgsText: stream.completedArgsText,
      }).catch(() => {})
      pendingEventWrites.add(pending)
      void pending.finally(() => {
        pendingEventWrites.delete(pending)
        closeIterablesWhenIdle()
      })
    }
    const noteDuplicate = (
      chunk: Extract<ResponseStreamChunk, { toolCallId: string }>,
      disposition: "dropped" | "merged",
    ): void => {
      callLog.warn(ctx, "nal.tool_call.duplicate_inbound_id", {
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
        chunkType: chunk.type,
        disposition,
      })
      duplicateInboundToolCallId.increment(ctx, 1, {
        chunkType: chunk.type,
        disposition,
      })
    }
    try {
      for await (const chunk of watchedStream) {
        if (chunk.type === "text-delta") {
          if (chunk.textDelta.length === 0) {
            continue
          }
          // Adjacent text is one part, so the message reads as it was written rather than as it arrived.
          const previousContent = contentAccumulator.at(-1)
          if (previousContent !== undefined && previousContent.type === "text") {
            previousContent.text += chunk.textDelta
          } else {
            contentAccumulator.push({ type: "text", text: chunk.textDelta })
          }
        } else if (chunk.type === "reasoning") {
          const incomingOptions = chunk.providerOptions
          const previous = contentAccumulator.at(-1)
          if (previous !== undefined && previous.type === "reasoning" && previous.signature === undefined) {
            previous.text += chunk.textDelta
            const incomingCursor = incomingOptions?.cursor
            if (
              incomingCursor?.isAlreadySummarizedThinking === true ||
              incomingCursor?.modelName !== undefined
            ) {
              previous.providerOptions = {
                ...(previous.providerOptions ?? {}),
                cursor: {
                  ...(previous.providerOptions?.cursor ?? {}),
                  ...(incomingCursor.isAlreadySummarizedThinking === true
                    ? { isAlreadySummarizedThinking: true }
                    : {}),
                  ...(incomingCursor.modelName !== undefined
                    ? { modelName: incomingCursor.modelName }
                    : {}),
                },
              }
            }
          } else {
            contentAccumulator.push({
              type: "reasoning",
              text: chunk.textDelta,
              ...(incomingOptions !== undefined
                ? { providerOptions: incomingOptions }
                : {}),
            })
          }
        } else if (chunk.type === "redacted-reasoning") {
          const incomingOptions = chunk.providerOptions
          const previous = contentAccumulator.at(-1)
          if (previous !== undefined && previous.type === "redacted-reasoning") {
            previous.data += chunk.data
            if (incomingOptions?.cursor?.modelName !== undefined) {
              previous.providerOptions = {
                ...(previous.providerOptions ?? {}),
                cursor: {
                  ...(previous.providerOptions?.cursor ?? {}),
                  modelName: incomingOptions.cursor.modelName,
                },
              }
            }
          } else {
            contentAccumulator.push({
              type: "redacted-reasoning",
              data: chunk.data,
              ...(incomingOptions !== undefined
                ? { providerOptions: incomingOptions }
                : {}),
            })
          }
        } else if (chunk.type === "reasoning-signature") {
          // A signature belongs to the reasoning it signed; a second one starts a part of its own.
          const previous = contentAccumulator.at(-1)
          if (previous !== undefined && previous.type === "reasoning") {
            if (previous.signature === undefined) {
              previous.signature = chunk.signature
            } else {
              contentAccumulator.push({ type: "reasoning", text: "", signature: chunk.signature })
            }
          }
        } else if (chunk.type === "tool-call-streaming-start") {
          const sameCallAsOpen = chunk.toolCallId === openCallId
          if (!startedCalls) {
            startedCalls = true
          }
          if (handledCalls.has(chunk.toolCallId)) {
            noteDuplicate(chunk, "dropped")
            continue
          }
          if (!sameCallAsOpen) {
            finishOpenStream()
            openStream = new ToolCallStream(
              chunk.toolCallId,
              chunk.toolName,
              emitEvents ? createWritableIterable<string>() : undefined,
            )
            openCallId = chunk.toolCallId
            publishCallEvent(openStream)
          } else if (openStream !== undefined) {
            // A repeated start for the same call names it if the first one did not, and is otherwise noise.
            if (openStream.toolName === "") {
              openStream.toolName = chunk.toolName
            } else {
              noteDuplicate(chunk, "merged")
            }
          }
        } else if (chunk.type === "tool-call-delta" || chunk.type === "tool-call") {
          if (!startedCalls) {
            startedCalls = true
          }
          if (handledCalls.has(chunk.toolCallId)) {
            noteDuplicate(chunk, "dropped")
            continue
          }
          if (chunk.toolCallId !== openCallId) {
            finishOpenStream()
            openStream = new ToolCallStream(
              chunk.toolCallId,
              chunk.toolName,
              emitEvents ? createWritableIterable<string>() : undefined,
            )
            openCallId = chunk.toolCallId
            publishCallEvent(openStream)
            if (chunk.type === "tool-call-delta") {
              await openStream.write(ctx, chunk.argsTextDelta)
            } else {
              const argumentText = typeof chunk.args === "string"
                ? chunk.args
                : JSON.stringify(chunk.args) as string
              await openStream.complete(ctx, argumentText)
              finishOpenStream()
              openStream = undefined
              openCallId = undefined
            }
          } else {
            if (openStream === undefined) {
              throw new Error("No current stream found")
            }
            if (chunk.type === "tool-call-delta") {
              await openStream.write(ctx, chunk.argsTextDelta)
            } else {
              const argumentText = typeof chunk.args === "string"
                ? chunk.args
                : JSON.stringify(chunk.args) as string
              await openStream.complete(ctx, argumentText)
              finishOpenStream()
              openStream = undefined
              openCallId = undefined
            }
          }
        }
      }
      finishOpenStream()
      finishIterables()
      const settledResponseValue = await settledModelResponse
      if (settledResponseValue.didReject) {
        throw settledResponseValue.error
      }
      response = settledResponseValue.response
      // A response that says nothing is rebuilt from what was streamed, if anything was.
      if (hasMeaningfulResponseMessageContent(response.messages)) {
        messagesOut.push(...response.messages)
      } else if (contentAccumulator.some(shouldSynthesizeResponseFromStreamContent)) {
        messagesOut.push({
          role: "assistant",
          content: sanitizeContentBufferForReplay(contentAccumulator),
          id: response.id,
        })
      } else {
        messagesOut.push(...response.messages)
      }
    } catch (error) {
      finishOpenStream()
      finishIterables()
      // The response promise is still awaited so its rejection cannot go unhandled.
      await settledModelResponse
      const failureMessages: StreamedResponse["messages"] = [{
        role: "assistant",
        content: sanitizeContentBufferForReplay(contentAccumulator),
        id: "1",
      }]
      response = {
        error: error instanceof Error ? error : new Error("Unknown error"),
        messages: failureMessages,
        id: "1",
        timestamp: new Date(),
        modelId: "1",
        headers: {},
      }
      messagesOut.push(...failureMessages)
    }
    if (onFirstToolCall !== undefined) {
      await onFirstToolCall(messagesOut.map(message => JSON.stringify(message)))
    }
    return { ...response, messages: messagesOut }
  })()
  return {
    fullStream: forwardedStream,
    toolCalls: callsIterable,
    toolCallEvents: eventsIterable,
    response: responseWork,
    // Usage is accounting rather than the answer, so a provider that does not report it reports zeros.
    usage: result.usage.catch(() => ({
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
    })),
    extendedUsage: result.extendedUsage.catch(() => ({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      maxTokens: 0,
    })),
    providerMetadata: result.providerMetadata.catch(() => undefined),
    invocationId: result.invocationId,
  }
}

/** The tools are accepted either as one list or as the two lists the runtime distinguishes. */
function normalizeToolExecutionInput(
  tools: readonly RuntimeTool[] | ToolExecutionSet,
): ToolExecutionSet {
  if (Array.isArray(tools)) {
    return {
      modelVisibleTools: tools as RuntimeTool[],
      additionalExecutableTools: [],
    }
  }
  return tools as ToolExecutionSet
}

/**
 * A stream of the model's answer with its tool calls run as they complete.
 *
 * The calls are consumed while the response is still being written, which is the point: a tool that takes
 * minutes starts as soon as its arguments are done rather than after the model has finished talking. When
 * the execution backend goes down mid-response, the calls already running are allowed to finish and the
 * rest are skipped with an answer that says so — and their arguments are drained, because a stream nobody
 * reads would stall the provider.
 */
function executeToolStream(
  ctx: Context,
  executor: PromptStreamExecutor,
  interactionHandler: InvocationHandler,
  inputTools: readonly RuntimeTool[] | ToolExecutionSet,
  extras: ExecutionExtras,
  recordResult: ResultRecorder,
  descriptionInputs: Record<string, unknown> | undefined,
  onFirstToolCall: ((messages: string[]) => unknown | Promise<unknown>) | undefined,
) {
  const executableSet = normalizeToolExecutionInput(inputTools)
  const { modelVisibleTools: visibleTools } = executableSet
  const runnableTools = getExecutableTools(executableSet) as RuntimeTool[]
  const directDynamicNames = getDirectDynamicToolNames(executableSet)
  const toolsByName = createToolMap(runnableTools)
  const dynamicInvocationNames = getDynamicInvocationToolNames(
    visibleTools as RuntimeTool[],
  )
  const renderContext = { allTools: extractToolMetadataMap(runnableTools) }
  const modelStream = streamModelAndCollectToolCalls(
    ctx,
    executor,
    interactionHandler,
    visibleTools as RuntimeTool[],
    descriptionInputs,
    onFirstToolCall,
    {
      executionToolMap: toolsByName,
      acceptedUnadvertisedToolNames: [...directDynamicNames],
    },
  )
  const responseWork = (async (): Promise<StreamedResponse> => {
    const callResults: Array<Promise<Record<string, unknown>>> = []
    let backendDown = false
    // The circuit opens on the first result that says the backend is gone, and the calls after it are
    // skipped rather than attempted.
    const noteSkippedResult: ResultRecorder = async (
      resultCtx,
      result,
      loggedToolName,
      errorClassification,
    ) => {
      if (errorClassification === ToolErrorClassification.EXEC_BACKEND_UNAVAILABLE) {
        backendDown = true
      }
      await recordResult(
        resultCtx,
        result,
        loggedToolName,
        errorClassification,
      )
    }
    const consumeWatches = (async (): Promise<void> => {
      for await (const event of modelStream.toolCallEvents) {
        if (backendDown) {
          void (async () => {
            try {
              for await (const _chunk of event.argsStream) {
                // Drain subsequent model output after the backend circuit opens.
              }
            } catch {
              // The skipped result is authoritative once the backend is down.
            }
          })()
          const skippedResultForRecord = {
            content: [{
              type: "text",
              text: "Execution backend unavailable. Tool execution skipped.",
            }],
            isError: true,
          }
          const instrumentedName = toolNameForLogging(event.toolName, toolsByName)
          await noteSkippedResult(
            ctx,
            skippedResultForRecord,
            instrumentedName,
            ToolErrorClassification.EXEC_BACKEND_UNAVAILABLE,
          )
          const skippedMessage: Record<string, unknown> = {
            role: "tool",
            id: event.toolCallId,
            content: [{
              type: "tool-result",
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              result: "Execution backend unavailable. Tool execution skipped.",
            }],
          }
          callResults.push(Promise.resolve(skippedMessage))
          callLog.warn(ctx, "nal.tool_call.skipped_exec_backend_down", {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          })
          continue
        }
        if (dynamicInvocationNames.has(event.toolName)) {
          // The outer call's own arguments are drained and then replaced by the inner call's.
          const drainedOuterArgs = drainArgsStream(event.argsStream).catch(() => {})
          const [outerArguments, outerArgumentsText] = await Promise.all([
            event.completedArgs,
            event.completedArgsText,
          ])
          await drainedOuterArgs
          const outerCall: NativeToolCallDescriptor = {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: outerArguments,
          }
          const call = resolveEffectiveToolCallDescriptor(
            outerCall,
            executableSet,
          )
          const { effectiveNativeToolCall } = call
          const argumentStream = effectiveNativeToolCall === undefined
            ? createOneShotStringIterable(outerArgumentsText)
            : createOneShotArgsIterable(effectiveNativeToolCall.args)
          callResults.push(executeDeferredToolCall(
            ctx,
            call,
            toolsByName,
            interactionHandler,
            extras,
            noteSkippedResult,
            renderContext,
            argumentStream,
            undefined,
            directDynamicNames,
          ))
          continue
        }
        const call: NativeToolCallDescriptor = {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: {},
        }
        callResults.push(executeDeferredToolCall(
          ctx,
          call,
          toolsByName,
          interactionHandler,
          extras,
          noteSkippedResult,
          renderContext,
          event.argsStream,
          event.completedArgs,
          directDynamicNames,
        ))
      }
    })()
    const [modelResponse] = await Promise.all([
      modelStream.response,
      consumeWatches,
    ])
    // A result is kept only for a call the modelResponse actually asked for, since a result for a call nobody
    // made would be a message the provider rejects.
    const keptResultForCall = (toolId: unknown): boolean => modelResponse.messages.some(
      message => message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some(
          content => content.type === "tool-call" && content.toolCallId === toolId,
        ),
    )
    let resultMessages: Array<Record<string, unknown>>
    try {
      resultMessages = await Promise.all(callResults)
    } catch (error) {
      // A stream that timed out at its start is reported on the modelResponse rather than thrown, since the
      // turn can still be recovered from what was streamed.
      if (!isAgentStreamStartTimeoutRecoveryTurnError(error)) {
        throw error
      }
      return {
        ...modelResponse,
        error: error instanceof Error ? error : new Error("Unknown tool error"),
      }
    }
    const messagesOut: StreamedResponse["messages"] = [
      ...modelResponse.messages,
      ...resultMessages.filter(result => keptResultForCall(result.id)) as StreamedResponse["messages"],
    ]
    return { ...modelResponse, messages: messagesOut }
  })()
  return {
    fullStream: modelStream.fullStream,
    response: responseWork,
    providerMetadata: modelStream.providerMetadata,
    usage: modelStream.usage,
    extendedUsage: modelStream.extendedUsage,
    invocationId: modelStream.invocationId,
  }
}

/**
 * The model's answer without running anything: the calls are collected and handed back, which is what a
 * caller that wants to decide about them itself — a different runtime, a test, a planner — asks for.
 */
function executeModelStreamOnly(
  ctx: Context,
  executor: PromptStreamExecutor,
  interactionHandler: InvocationHandler,
  tools: readonly RuntimeTool[] | ToolExecutionSet,
  descriptionProps: Record<string, unknown> | undefined,
  firstToolCallHook: ((messages: string[]) => unknown | Promise<unknown>) | undefined,
) {
  const toolExecutionSet = normalizeToolExecutionInput(tools)
  const { modelVisibleTools } = toolExecutionSet
  const directDynamicToolNames = getDirectDynamicToolNames(toolExecutionSet)
  const streamResult = streamModelAndCollectToolCalls(
    ctx,
    executor,
    interactionHandler,
    modelVisibleTools as RuntimeTool[],
    descriptionProps,
    firstToolCallHook,
    {
      emitToolCallEvents: false,
      acceptedUnadvertisedToolNames: [...directDynamicToolNames],
    },
  )
  const toolCallDescriptors = (async (): Promise<NativeToolCallDescriptor[]> => {
    const descriptors: NativeToolCallDescriptor[] = []
    for await (const descriptor of streamResult.toolCalls) {
      descriptors.push(resolveEffectiveToolCallDescriptor(descriptor, toolExecutionSet))
    }
    return descriptors
  })()
  return {
    fullStream: streamResult.fullStream,
    response: streamResult.response,
    providerMetadata: streamResult.providerMetadata,
    usage: streamResult.usage,
    extendedUsage: streamResult.extendedUsage,
    invocationId: streamResult.invocationId,
    toolCallDescriptors,
  }
}

/** An executor that passes everything through, for a caller that has no redaction to add. */
export class SimplePromptToolExecutor {
  readonly innerExecutor: BasePromptExecutor

  constructor(innerExecutor: BasePromptExecutor) {
    this.innerExecutor = innerExecutor
  }

  appendMessages(messages: readonly unknown[]): this {
    this.innerExecutor.appendMessages(messages)
    return this
  }

  getState(): readonly any[] {
    return this.innerExecutor.getState()
  }

  getMessages(): readonly any[] {
    return this.innerExecutor.getMessages()
  }

  clearMessages(): void {
    this.innerExecutor.clearMessages()
  }

  executeToolStream(
    ctx: unknown,
    _state: unknown,
    interactionHandler: unknown,
    tools: unknown,
    extraT: unknown,
    recordToolCallResult: unknown,
    descriptionProps: unknown,
    firstToolCallHook: unknown,
  ): unknown {
    return executeToolStream(
      ctx as Context,
      this.innerExecutor,
      interactionHandler as InvocationHandler,
      tools as readonly RuntimeTool[] | ToolExecutionSet,
      extraT as ExecutionExtras,
      recordToolCallResult as ResultRecorder,
      descriptionProps as Record<string, unknown> | undefined,
      firstToolCallHook as ((messages: string[]) => unknown | Promise<unknown>) | undefined,
    )
  }

  executeModelStreamOnly(
    ctx: unknown,
    _state: unknown,
    interactionHandler: unknown,
    tools: unknown,
    descriptionProps: unknown,
    firstToolCallHook: unknown,
  ): unknown {
    return executeModelStreamOnly(
      ctx as Context,
      this.innerExecutor,
      interactionHandler as InvocationHandler,
      tools as readonly RuntimeTool[] | ToolExecutionSet,
      descriptionProps as Record<string, unknown> | undefined,
      firstToolCallHook as ((messages: string[]) => unknown | Promise<unknown>) | undefined,
    )
  }

  stream(ctx: unknown, invocationId: unknown, tools: unknown, options: unknown): unknown {
    return this.innerExecutor.stream(
      ctx as Context,
      invocationId as string,
      tools as readonly unknown[],
      options as Record<string, unknown>,
    )
  }
}

/**
 * An executor that hands the conversation out redacted and takes it back plain.
 *
 * The session stores redacted messages, but the executor it wraps works on plain ones, so every read is
 * wrapped and every write is unwrapped. Wrapping is memoized per plain message: the same message read twice
 * has to come back as the same redacted object, because callers compare messages by identity to tell which
 * ones are still in the conversation. Appending records the wrapper it was given, so a message that goes out
 * and comes back is recognized rather than wrapped again.
 */
export class RedactedPromptToolExecutor {
  readonly innerToolExecutor: ExecutingPromptExecutor
  readonly privacyMode: PrivacyMode
  private redactedWrapperMemo: WeakMap<CoreMessageLike, unknown>

  constructor(
    innerToolExecutor: ExecutingPromptExecutor,
    privacyMode: PrivacyMode,
  ) {
    this.innerToolExecutor = innerToolExecutor
    this.privacyMode = privacyMode
    this.redactedWrapperMemo = new WeakMap<CoreMessageLike, unknown>()
  }

  private wrapStablePlainMessages(plainMessages: readonly CoreMessageLike[]): unknown[] {
    return plainMessages.map(plainMessage => {
      const memoized = this.redactedWrapperMemo.get(plainMessage)
      if (memoized !== undefined) {
        return memoized
      }
      const [wrapped] = toRedactedCoreMessages([plainMessage], this.privacyMode)
      this.redactedWrapperMemo.set(plainMessage, wrapped)
      return wrapped
    })
  }

  appendMessages(messages: unknown | readonly unknown[]): this {
    const arr = Array.isArray(messages) ? messages : [messages]
    const plain = fromRedactedCoreMessages(
      arr,
      PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
    )
    // What was appended is remembered as the wrapper of what it unwrapped to, so it is not wrapped twice.
    for (let index = 0; index < plain.length; index++) {
      const wrapper = arr[index]
      const plainMessage = plain[index]
      if (wrapper !== undefined && plainMessage !== undefined) {
        this.redactedWrapperMemo.set(plainMessage, wrapper)
      }
    }
    this.innerToolExecutor.appendMessages(plain)
    return this
  }

  getState(): unknown[] {
    return this.wrapStablePlainMessages(this.innerToolExecutor.getState())
  }

  getMessages(): unknown[] {
    return this.wrapStablePlainMessages(this.innerToolExecutor.getMessages())
  }

  clearMessages(): void {
    this.innerToolExecutor.clearMessages()
    // The wrappers belonged to the messages that are gone, so the memo goes with them.
    this.redactedWrapperMemo = new WeakMap<CoreMessageLike, unknown>()
  }

  executeToolStream(
    ctx: unknown,
    state: unknown,
    interactionHandler: unknown,
    tools: unknown,
    extraT: unknown,
    recordToolCallResult: unknown,
    descriptionProps: unknown,
    firstToolCallHook: unknown,
  ): unknown {
    return this.innerToolExecutor.executeToolStream(
      ctx,
      state,
      interactionHandler,
      tools,
      extraT,
      recordToolCallResult,
      descriptionProps,
      firstToolCallHook,
    )
  }

  executeModelStreamOnly(
    ctx: unknown,
    state: unknown,
    interactionHandler: unknown,
    tools: unknown,
    descriptionProps: unknown,
    firstToolCallHook: unknown,
  ): unknown {
    return this.innerToolExecutor.executeModelStreamOnly(
      ctx,
      state,
      interactionHandler,
      tools,
      descriptionProps,
      firstToolCallHook,
    )
  }

  stream(ctx: unknown, invocationId: unknown, tools: unknown, options: unknown): unknown {
    return this.innerToolExecutor.stream(
      ctx as Context,
      invocationId as string,
      tools as readonly unknown[],
      options as Record<string, unknown>,
    )
  }
}
