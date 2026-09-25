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
import { InteractionListenerStreamClosedError } from "../agent-core/interaction-listener.ts"
import { createKey, type Context } from "../context/context.ts"
import { createLogger } from "../context/logging.ts"
import { appendHookContextRemindersToCoreToolResult } from "../hooks-carriers/hook-context-rendering.ts"
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
import { getToolFamily } from "./tools/tool-families.ts"
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

type ToolLike = Record<string, unknown> & {
  readonly name: string
  readonly toolIdentifier: string
  readonly dynamicToolMetaRole?: string
  readonly customToolFormat?: unknown
}

type ProviderOptions = {
  readonly cursor?: {
    readonly isAlreadySummarizedThinking?: boolean
    readonly modelName?: string
  }
}

type StreamChunk =
  | { readonly type: "text-delta"; readonly textDelta: string }
  | { readonly type: "reasoning"; readonly textDelta: string; readonly providerOptions?: ProviderOptions }
  | { readonly type: "redacted-reasoning"; readonly data: string; readonly providerOptions?: ProviderOptions }
  | { readonly type: "reasoning-signature"; readonly signature: string }
  | { readonly type: "tool-call-streaming-start"; readonly toolCallId: string; readonly toolName: string }
  | { readonly type: "tool-call-delta"; readonly toolCallId: string; readonly toolName: string; readonly argsTextDelta: string }
  | { readonly type: "tool-call"; readonly toolCallId: string; readonly toolName: string; readonly args: unknown }

type AssistantContentPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string; signature?: string; providerOptions?: ProviderOptions }
  | { type: "redacted-reasoning"; data: string; providerOptions?: ProviderOptions }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }
  | { type: "file"; [key: string]: unknown }

interface ModelResponse {
  readonly messages: Array<Record<string, unknown> & {
    readonly role: string
    readonly content: string | AssistantContentPart[]
  }>
  readonly id: string
  readonly [key: string]: unknown
}

interface ModelStreamResult {
  readonly fullStream: AsyncIterable<StreamChunk>
  readonly response: Promise<ModelResponse>
  readonly usage: Promise<unknown>
  readonly extendedUsage: Promise<unknown>
  readonly providerMetadata: Promise<unknown>
  readonly invocationId: unknown
}

interface StreamingPromptExecutor {
  stream(
    ctx: Context,
    invocationId: string,
    tools: readonly unknown[],
    options: Record<string, unknown>,
  ): ModelStreamResult
}

const logger = createLogger("chat-inference/tool-call")
const TOOL_CALL_ID_CONTEXT_KEY = createKey<string | undefined>(
  Symbol("agent.toolCallId"),
  undefined,
)
const SEMANTIC_SEARCH_TOOL_NAME = "semantic_search"
const AGENT_STORE_CONFLICT_HOOK_EVENT_NAME = "agentStoreConflict"
const RAW_ERROR_MESSAGE_CHARACTER_BUDGET = 20_000

interface HookContextCarrier {
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
function createConflictNoticeOnlyCollector(): HookContextCarrier[] {
  const collector: HookContextCarrier[] = []
  const push = collector.push.bind(collector)
  collector.push = (...items: HookContextCarrier[]) => push(
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

interface BasePromptExecutorLike {
  appendMessages(messages: any): unknown
  getState(): readonly any[]
  getMessages(): readonly any[]
  clearMessages(): unknown
  stream(ctx: Context, invocationId: string, tools: readonly unknown[], options: Record<string, unknown>): any
}

interface PromptExecutorLike extends BasePromptExecutorLike {
  executeToolStream(...args: unknown[]): unknown
  executeModelStreamOnly(...args: unknown[]): unknown
}

interface InteractionHandlerLike {
  readonly invocationId: string
}

interface ToolCallEvent {
  readonly toolCallId: string
  readonly toolName: string
  readonly argsStream: AsyncIterable<string>
  readonly completedArgs: Promise<unknown>
  readonly completedArgsText: Promise<string>
}

interface StreamCollectionOptions {
  readonly emitToolCallEvents?: boolean
  readonly executionToolMap?: Record<string, ToolLike>
  readonly acceptedUnadvertisedToolNames?: readonly string[]
}

/** A tool the session does not have is logged as "other", since its name is not a name we publish. */
function toolNameForLogging(toolName: string, toolMap: Record<string, ToolLike>): string {
  if (!(toolName in toolMap)) {
    return "other"
  }
  return toolMap[toolName]!.toolIdentifier
}

function resolveToolCallTelemetry(
  tool: ToolLike,
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
      logger.error(ctx, "Error writing to tool call stream", error)
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
        logger.error(ctx, "Error writing to tool call stream", error)
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

function createToolMap(tools: readonly ToolLike[]): Record<string, ToolLike> {
  const toolMap: Record<string, ToolLike> = {}
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

function getDynamicInvocationToolNames(modelVisibleTools: readonly ToolLike[]): Set<string> {
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
  const modelVisibleTools = toolExecutionSet.modelVisibleTools as ToolLike[]
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

type RecordToolCallResult = (
  ctx: Context,
  result: unknown,
  loggedToolName: string,
  errorClassification: ToolErrorClassification | string | undefined,
) => unknown | Promise<unknown>

interface ToolExecutionExtra extends Record<string, unknown> {
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
  descriptor: NativeToolCallDescriptor,
  toolMap: Record<string, ToolLike>,
  interactionHandler: unknown,
  extraT: ToolExecutionExtra,
  recordToolCallResult: RecordToolCallResult | undefined,
  renderProps: Record<string, unknown>,
  streamingArgsIterable: AsyncIterable<string> | undefined,
  completedArgs: Promise<unknown> | undefined,
  directDynamicToolNames = new Set<string>(),
): Promise<Record<string, unknown>> {
  const effectiveToolName = getEffectiveToolCallName(descriptor)
  const effectiveArgs = getEffectiveToolCallArgs(descriptor)
  const tool = toolMap[effectiveToolName]
  // A tool that is not there is answered rather than thrown, since the model can usually repair the call.
  if (tool === undefined) {
    logger.warn(ctx, "nal.tool_call.failure", {
      toolCallId: descriptor.toolCallId,
      toolName: "other",
      toolNameFromModel: effectiveToolName,
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
      toolCallId: descriptor.toolCallId,
      outcome: "tool_not_found",
    })
    return {
      role: "tool",
      id: descriptor.toolCallId,
      content: [{
        type: "tool-result",
        toolName: descriptor.toolName,
        toolCallId: descriptor.toolCallId,
        result: `Tool not found: ${effectiveToolName}. Available tools: ${Object.keys(toolMap).join(", ")}`,
      }],
    }
  }
  const startTimeMs = Date.now()
  const argsIterable = streamingArgsIterable ?? createOneShotArgsIterable(effectiveArgs)
  const usedDynamicInvocationSurface = descriptor.effectiveNativeToolCall !== undefined ||
    directDynamicToolNames.has(effectiveToolName)
  let telemetry = resolveToolCallTelemetry(tool, effectiveArgs, usedDynamicInvocationSurface)
  let telemetryLogFields: Record<string, unknown> = telemetry.isDynamic
    ? { isDynamicToolCall: true }
    : {}
  let didLogStart = false
  const logToolCallStart = (): void => {
    didLogStart = true
    logger.info(ctx, "nal.tool_call.start", {
      toolCallId: descriptor.toolCallId,
      toolName: telemetry.loggedToolName,
      team: getToolFamily(telemetry.toolIdentifier),
      ...telemetryLogFields,
    })
    getAgentEventTracker(ctx).trackToolCallStarted(ctx, {
      toolName: telemetry.loggedToolName,
      toolCallId: descriptor.toolCallId,
    })
  }
  const generalHookCarriersEnabled = extraT.enableHookAdditionalContext === true
  const conflictNoticeCollectorEnabled =
    extraT.enableAgentStoreConflictNoticeCollector === true ||
    extraT.enableAgentStoreConflictNotices === true
  const hookContextCollector = generalHookCarriersEnabled
    ? []
    : conflictNoticeCollectorEnabled
      ? createConflictNoticeOnlyCollector()
      : undefined
  const toolCallCtx = ctx.with(TOOL_CALL_ID_CONTEXT_KEY, descriptor.toolCallId)
  try {
    // The tool is a record here and a typed tool there; the runtime shape is the same one.
    const executeTool = () => executeToolResultOrError(
      tool as unknown as Parameters<typeof executeToolResultOrError>[0],
      toolCallCtx,
      interactionHandler as Parameters<typeof executeToolResultOrError>[2],
      argsIterable,
      {
        ...extraT,
        toolCallId: descriptor.toolCallId,
        hookContextCollector,
      },
    )
    // The output is captured rather than awaited here, so the telemetry race below can see it settle.
    const toolOutputPromise = executeTool().then(
      result => ({ ok: true as const, result }),
      error => ({ ok: false as const, error }),
    )
    if (tool.resolveToolCallTelemetry !== undefined && completedArgs !== undefined) {
      try {
        const telemetryRaceResult = await Promise.race([
          completedArgs.then(args => ({ source: "completedArgs" as const, args })),
          toolOutputPromise.then(result => ({ source: "toolOutput" as const, result })),
        ])
        if (telemetryRaceResult.source === "completedArgs") {
          telemetry = resolveToolCallTelemetry(
            tool,
            telemetryRaceResult.args,
            usedDynamicInvocationSurface,
          )
          telemetryLogFields = telemetry.isDynamic ? { isDynamicToolCall: true } : {}
        }
      } catch {
        // Telemetry refinement must never affect execution.
      }
    }
    logToolCallStart()
    const settledToolOutput = await toolOutputPromise
    if (!settledToolOutput.ok) {
      throw settledToolOutput.error
    }
    const toolOutputRaw = settledToolOutput.result
    const blobStore = extraT.stateHandler?.getBlobStore?.()
    const renderPropsWithBlobStore = { ...renderProps, blobStore }
    const toolOutput = await renderToolResultOrError(
      ctx,
      tool as unknown as Parameters<typeof executeToolResultOrError>[0],
      toolOutputRaw,
      renderPropsWithBlobStore,
    )
    // What the platform keeps about the call: the rendered result, whether it failed, and the messages the
    // failure carried.
    const highLevelToolCallResult: Record<string, unknown> = {
      output: toolOutputRaw.result.toJson(),
      isError: toolOutput.isError,
    }
    const durationMs = Date.now() - startTimeMs
    let primaryContent: string | undefined
    const textParts: string[] = []
    for (const part of toolOutput.content as Array<Record<string, unknown>>) {
      if (part.type === "text") {
        textParts.push(part.text as string)
      }
    }
    if (textParts.length > 0) {
      primaryContent = textParts.join("\n")
    }
    let errorClassification: ToolErrorClassification | string | undefined
    if (toolOutput.isError === true && "error" in toolOutputRaw) {
      errorClassification = toolOutputRaw.errorClassification
      const rawErrorMessages = collectRawErrorMessages(toolOutputRaw.error)
      if (rawErrorMessages.length > 0) {
        highLevelToolCallResult.rawErrorMessages = rawErrorMessages
      }
      const toolAbortReason = ctx.reason as {
        readonly intentional?: unknown
        readonly reason?: unknown
      } | undefined
      // A call the user stopped on purpose is an abort, not a failure of the tool.
      const isToolIntentionalAbort = ctx.canceled && toolAbortReason?.intentional === true
      const logData = {
        toolCallId: descriptor.toolCallId,
        toolName: telemetry.loggedToolName,
        durationMs,
        errorClassification,
        toolError: true,
        intentionalAbort: isToolIntentionalAbort,
        abortReason: toolAbortReason?.reason,
        team: getToolFamily(telemetry.toolIdentifier),
        errorMessage: typeof primaryContent === "string" ? primaryContent : undefined,
        mcp_version: getMcpVersionLabel(telemetry.loggedToolName),
        ...telemetryLogFields,
      }
      if (isToolIntentionalAbort) {
        logger.info(ctx, "nal.tool_call.aborted", logData)
      } else {
        logger.error(ctx, "nal.tool_call.failure", toolOutputRaw.error, logData)
      }
    } else {
      logger.info(ctx, "nal.tool_call.success", {
        toolCallId: descriptor.toolCallId,
        toolName: telemetry.loggedToolName,
        durationMs,
        team: getToolFamily(telemetry.toolIdentifier),
        mcp_version: getMcpVersionLabel(telemetry.loggedToolName),
        ...telemetryLogFields,
      })
    }
    if (recordToolCallResult !== undefined) {
      await recordToolCallResult(
        ctx,
        toolOutput,
        telemetry.loggedToolName,
        errorClassification,
      )
    }
    const outcome = errorClassification === undefined
      ? "success"
      : errorClassification.toString()
    getAgentEventTracker(ctx).trackToolCallResult(ctx, {
      toolName: telemetry.loggedToolName,
      toolCallId: descriptor.toolCallId,
      outcome,
    })
    const team = getToolFamily(telemetry.toolIdentifier)
    const mcpVersion = getMcpVersionLabel(telemetry.loggedToolName)
    toolCallResult.increment(ctx, 1, {
      toolName: telemetry.loggedToolName,
      outcome,
      team,
      mcp_version: mcpVersion,
      ...getClientVersionMetricTagsFromContext(ctx),
      ...getClientRemoteTypeMetricTagFromContext(ctx),
      ...getClientOsMetricTagFromContext(ctx),
      issubagent: getIsSubagentFromContext(ctx) ? "true" : "false",
      isuserapikey: getIsUserApiKeyFromContext(ctx) ? "true" : "false",
      isdynamic: telemetry.isDynamic ? "true" : "false",
      "user.is_dev": getIsDevFromContext(ctx) ? "true" : "false",
    } as Record<string, string>)
    if (telemetry.loggedToolName === SEMANTIC_SEARCH_TOOL_NAME) {
      logger.info(ctx, "semantic search usage detected")
    }
    toolCallDuration.histogram(ctx, durationMs, {
      toolName: telemetry.loggedToolName,
      outcome,
      team,
      mcp_version: mcpVersion,
      ...getClientVersionMetricTagsFromContext(ctx),
      ...getClientRemoteTypeMetricTagFromContext(ctx),
      isdynamic: telemetry.isDynamic ? "true" : "false",
      "user.is_dev": getIsDevFromContext(ctx) ? "true" : "false",
    } as Record<string, string>)
    const toolResultContent = [...toolOutput.content] as Array<Record<string, unknown>>
    // Only the conflict notices are appended when that is all the caller asked to collect.
    const carriersToRender = generalHookCarriersEnabled || hookContextCollector === undefined
      ? hookContextCollector ?? []
      : hookContextCollector.filter(
        carrier => carrier.hookEventName === AGENT_STORE_CONFLICT_HOOK_EVENT_NAME,
      )
    appendHookContextRemindersToCoreToolResult(
      textParts,
      toolResultContent as Array<{ type: "text"; text: string }>,
      carriersToRender as never[],
    )
    primaryContent = textParts.length > 0 ? textParts.join("\n") : primaryContent
    return {
      role: "tool",
      id: descriptor.toolCallId,
      content: [{
        type: "tool-result",
        toolName: descriptor.toolName,
        toolCallId: descriptor.toolCallId,
        result: primaryContent,
        experimental_content: toolResultContent,
      }],
      providerOptions: {
        cursor: {
          highLevelToolCallResult: highLevelToolCallResult ?? {},
        },
      },
    }
  } catch (error) {
    // A call that failed before its start was logged is logged now, so every call has a start and an end.
    if (!didLogStart) {
      logToolCallStart()
    }
    const durationMs = Date.now() - startTimeMs
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
      logger[logLevel](ctx, "nal.tool_call.aborted", {
        error,
        toolCallId: descriptor.toolCallId,
        toolName: telemetry.loggedToolName,
        durationMs,
        errorName,
        errorMessage,
        errorClassification,
        intentionalAbort: isIntentionalAbort,
        abortReason: abortReason?.reason,
        team: getToolFamily(telemetry.toolIdentifier),
        mcp_version: getMcpVersionLabel(telemetry.loggedToolName),
        ...telemetryLogFields,
      })
      outcome = "aborted"
    } else {
      logger.error(ctx, "nal.tool_call.unexpected_error_not_user_visible", error, {
        toolCallId: descriptor.toolCallId,
        toolName: telemetry.loggedToolName,
        durationMs,
        errorName,
        errorMessage,
        errorClassification,
        team: getToolFamily(telemetry.toolIdentifier),
        mcp_version: getMcpVersionLabel(telemetry.loggedToolName),
        ...telemetryLogFields,
      })
    }
    const catchTeam = getToolFamily(telemetry.toolIdentifier)
    const catchMcpVersion = getMcpVersionLabel(telemetry.loggedToolName)
    toolCallDuration.histogram(ctx, durationMs, {
      toolName: telemetry.loggedToolName,
      outcome,
      team: catchTeam,
      mcp_version: catchMcpVersion,
      ...getClientVersionMetricTagsFromContext(ctx),
      ...getClientRemoteTypeMetricTagFromContext(ctx),
      isdynamic: telemetry.isDynamic ? "true" : "false",
      "user.is_dev": getIsDevFromContext(ctx) ? "true" : "false",
    } as Record<string, string>)
    toolCallResult.increment(ctx, 1, {
      toolName: telemetry.loggedToolName,
      outcome,
      team: catchTeam,
      mcp_version: catchMcpVersion,
      ...getClientVersionMetricTagsFromContext(ctx),
      ...getClientRemoteTypeMetricTagFromContext(ctx),
      ...getClientOsMetricTagFromContext(ctx),
      issubagent: getIsSubagentFromContext(ctx) ? "true" : "false",
      isuserapikey: getIsUserApiKeyFromContext(ctx) ? "true" : "false",
      isdynamic: telemetry.isDynamic ? "true" : "false",
      "user.is_dev": getIsDevFromContext(ctx) ? "true" : "false",
    } as Record<string, string>)
    if (telemetry.loggedToolName === SEMANTIC_SEARCH_TOOL_NAME) {
      logger.info(ctx, "semantic search usage detected")
    }
    getAgentEventTracker(ctx).trackToolCallResult(ctx, {
      toolName: telemetry.loggedToolName,
      toolCallId: descriptor.toolCallId,
      outcome,
    })
    throw error
  }
}

function hasMeaningfulContentPart(part: AssistantContentPart): boolean {
  if (part.type === "text") {
    return part.text.trim().length > 0
  }
  if (part.type === "reasoning") {
    return part.text.trim().length > 0
  }
  return part.type === "tool-call" || part.type === "file"
}

/** A call or a file counts as something to say; reasoning on its own does not. */
function shouldSynthesizeResponseFromStreamContent(part: AssistantContentPart): boolean {
  if (part.type === "text") {
    return part.text.trim().length > 0
  }
  return part.type === "tool-call" || part.type === "file"
}

/**
 * Reasoning that was already summarized once, and is being sent back, is not text the provider will accept:
 * it goes back as the redacted form it came from, or it is dropped when even that is not known.
 */
function sanitizeContentBufferForReplay(buffer: readonly AssistantContentPart[]): AssistantContentPart[] {
  return buffer.flatMap<AssistantContentPart>(part => {
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

function hasMeaningfulResponseMessageContent(messages: ModelResponse["messages"]): boolean {
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
  executor: StreamingPromptExecutor,
  interactionHandler: InteractionHandlerLike,
  modelVisibleTools: readonly ToolLike[],
  descriptionProps: Record<string, unknown> | undefined,
  firstToolCallHook: ((messages: string[]) => unknown | Promise<unknown>) | undefined,
  options?: StreamCollectionOptions,
) {
  const emitToolCallEvents = options?.emitToolCallEvents ?? true
  let toolMap = options?.executionToolMap
  if (toolMap === undefined) {
    const modelVisibleToolMap: Record<string, ToolLike> = {}
    for (const tool of modelVisibleTools) {
      modelVisibleToolMap[tool.name] = tool
    }
    toolMap = modelVisibleToolMap
  }
  const mutableModelVisibleTools = modelVisibleTools as ToolLike[]
  const toolDefinitions = toAgentTools(
    mutableModelVisibleTools,
    descriptionProps ?? buildDescriptionGeneratorProps(mutableModelVisibleTools),
  )
  const acceptedUnadvertisedToolNames = options?.acceptedUnadvertisedToolNames ?? []
  const result = executor.stream(
    ctx,
    interactionHandler.invocationId,
    toolDefinitions,
    { acceptedUnadvertisedToolNames },
  )
  // The response is settled into a value rather than awaited, so a rejection can be reported after the
  // stream has been drained rather than thrown past it.
  const settledResultResponse = result.response.then(
    response => ({ didReject: false as const, response }),
    error => ({ didReject: true as const, error }),
  )
  const [innerStream, fullStream] = duplicateStream(result.fullStream)
  const toolCallsIterable = createWritableIterable<NativeToolCallDescriptor>()
  const toolCallEventsIterable = createWritableIterable<ToolCallEvent>()
  const responsePromise = (async (): Promise<ModelResponse> => {
    let currentStream: ToolCallStream | undefined
    let currentToolCallId: string | undefined
    let hasStartedToolCall = false
    const handledToolCalls = new Set<string>()
    const contentBuffer: AssistantContentPart[] = []
    const newMessages: ModelResponse["messages"] = []
    let response: ModelResponse
    let toolIterablesClosed = false
    let shouldCloseToolIterables = false
    const pendingDescriptorWrites = new Set<Promise<void>>()
    const pendingEventWrites = new Set<Promise<void>>()
    const maybeCloseToolIterables = (): void => {
      if (toolIterablesClosed || !shouldCloseToolIterables) {
        return
      }
      const pendingWrites = emitToolCallEvents ? pendingEventWrites : pendingDescriptorWrites
      if (pendingWrites.size > 0) {
        return
      }
      toolIterablesClosed = true
      toolCallsIterable.close()
      toolCallEventsIterable.close()
    }
    const closeCurrentStream = (): void => {
      if (currentStream === undefined) {
        return
      }
      const stream = currentStream
      stream.close().catch(error => {
        if (error instanceof Error && error.message.includes("WritableIterable is closed")) {
          return
        }
        logger.error(ctx, "Error closing tool call stream", error)
      })
      handledToolCalls.add(stream.toolCallId)
      const tool = toolMap[stream.toolName]
      // A tool that parses its own arguments is handed the raw text, since its format is not JSON.
      const isCustomFormatTool = tool !== undefined &&
        "customToolFormat" in tool &&
        tool.customToolFormat !== undefined
      let argsParseError: unknown
      const args: unknown = (() => {
        if (stream.written.length === 0) {
          return {}
        }
        if (isCustomFormatTool) {
          return stream.written
        }
        try {
          return JSON.parse(stream.written) as unknown
        } catch (error) {
          argsParseError = error
          return stream.written
        }
      })()
      contentBuffer.push({
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
      const loggedToolName = telemetry === undefined || telemetry.toolIdentifier === "unknown"
        ? "other"
        : telemetry.toolIdentifier
      // Malformed arguments are still handed over: the tool decides what to say about them, and the model
      // reads that rather than a parser error.
      if (argsParseError !== undefined) {
        logger.warn(ctx, "nal.tool_call.args_parse_failure", {
          toolCallId: stream.toolCallId,
          toolName: loggedToolName,
          toolNameFromModel: stream.toolName,
          errorClassification: "invalid_args",
          errorMessage: argsParseError instanceof Error
            ? argsParseError.message
            : String(argsParseError),
          writtenByteLength: Buffer.byteLength(stream.written, "utf8"),
          team: getToolFamily(telemetry?.toolIdentifier ?? "unknown"),
        })
      }
      const approximateInputTokens = approximateTokenCountFromRawArgs(stream.written)
      if (approximateInputTokens > 0) {
        rawToolCallInputTokens.histogram(ctx, approximateInputTokens, {
          tool_name: loggedToolName,
        })
      }
      const pendingWrite = toolCallsIterable.write(descriptor).catch(() => {})
      pendingDescriptorWrites.add(pendingWrite)
      void pendingWrite.finally(() => {
        pendingDescriptorWrites.delete(pendingWrite)
        maybeCloseToolIterables()
      })
    }
    const closeToolIterables = (): void => {
      shouldCloseToolIterables = true
      maybeCloseToolIterables()
    }
    const writeToolCallEvent = (stream: ToolCallStream): void => {
      if (stream.inner === undefined) {
        return
      }
      const pendingWrite = toolCallEventsIterable.write({
        toolCallId: stream.toolCallId,
        toolName: stream.toolName,
        argsStream: stream.inner,
        completedArgs: stream.completedArgs,
        completedArgsText: stream.completedArgsText,
      }).catch(() => {})
      pendingEventWrites.add(pendingWrite)
      void pendingWrite.finally(() => {
        pendingEventWrites.delete(pendingWrite)
        maybeCloseToolIterables()
      })
    }
    const logDuplicate = (
      chunk: Extract<StreamChunk, { toolCallId: string }>,
      disposition: "dropped" | "merged",
    ): void => {
      logger.warn(ctx, "nal.tool_call.duplicate_inbound_id", {
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
      for await (const chunk of innerStream) {
        if (chunk.type === "text-delta") {
          if (chunk.textDelta.length === 0) {
            continue
          }
          // Adjacent text is one part, so the message reads as it was written rather than as it arrived.
          const lastContent = contentBuffer.at(-1)
          if (lastContent !== undefined && lastContent.type === "text") {
            lastContent.text += chunk.textDelta
          } else {
            contentBuffer.push({ type: "text", text: chunk.textDelta })
          }
        } else if (chunk.type === "reasoning") {
          const incomingProviderOptions = chunk.providerOptions
          const last = contentBuffer.at(-1)
          if (last !== undefined && last.type === "reasoning" && last.signature === undefined) {
            last.text += chunk.textDelta
            const incomingCursor = incomingProviderOptions?.cursor
            if (
              incomingCursor?.isAlreadySummarizedThinking === true ||
              incomingCursor?.modelName !== undefined
            ) {
              last.providerOptions = {
                ...(last.providerOptions ?? {}),
                cursor: {
                  ...(last.providerOptions?.cursor ?? {}),
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
            contentBuffer.push({
              type: "reasoning",
              text: chunk.textDelta,
              ...(incomingProviderOptions !== undefined
                ? { providerOptions: incomingProviderOptions }
                : {}),
            })
          }
        } else if (chunk.type === "redacted-reasoning") {
          const incomingProviderOptions = chunk.providerOptions
          const last = contentBuffer.at(-1)
          if (last !== undefined && last.type === "redacted-reasoning") {
            last.data += chunk.data
            if (incomingProviderOptions?.cursor?.modelName !== undefined) {
              last.providerOptions = {
                ...(last.providerOptions ?? {}),
                cursor: {
                  ...(last.providerOptions?.cursor ?? {}),
                  modelName: incomingProviderOptions.cursor.modelName,
                },
              }
            }
          } else {
            contentBuffer.push({
              type: "redacted-reasoning",
              data: chunk.data,
              ...(incomingProviderOptions !== undefined
                ? { providerOptions: incomingProviderOptions }
                : {}),
            })
          }
        } else if (chunk.type === "reasoning-signature") {
          // A signature belongs to the reasoning it signed; a second one starts a part of its own.
          const last = contentBuffer.at(-1)
          if (last !== undefined && last.type === "reasoning") {
            if (last.signature === undefined) {
              last.signature = chunk.signature
            } else {
              contentBuffer.push({ type: "reasoning", text: "", signature: chunk.signature })
            }
          }
        } else if (chunk.type === "tool-call-streaming-start") {
          const hasCurrentStreamForChunk = chunk.toolCallId === currentToolCallId
          if (!hasStartedToolCall) {
            hasStartedToolCall = true
          }
          if (handledToolCalls.has(chunk.toolCallId)) {
            logDuplicate(chunk, "dropped")
            continue
          }
          if (!hasCurrentStreamForChunk) {
            closeCurrentStream()
            currentStream = new ToolCallStream(
              chunk.toolCallId,
              chunk.toolName,
              emitToolCallEvents ? createWritableIterable<string>() : undefined,
            )
            currentToolCallId = chunk.toolCallId
            writeToolCallEvent(currentStream)
          } else if (currentStream !== undefined) {
            // A repeated start for the same call names it if the first one did not, and is otherwise noise.
            if (currentStream.toolName === "") {
              currentStream.toolName = chunk.toolName
            } else {
              logDuplicate(chunk, "merged")
            }
          }
        } else if (chunk.type === "tool-call-delta" || chunk.type === "tool-call") {
          if (!hasStartedToolCall) {
            hasStartedToolCall = true
          }
          if (handledToolCalls.has(chunk.toolCallId)) {
            logDuplicate(chunk, "dropped")
            continue
          }
          if (chunk.toolCallId !== currentToolCallId) {
            closeCurrentStream()
            currentStream = new ToolCallStream(
              chunk.toolCallId,
              chunk.toolName,
              emitToolCallEvents ? createWritableIterable<string>() : undefined,
            )
            currentToolCallId = chunk.toolCallId
            writeToolCallEvent(currentStream)
            if (chunk.type === "tool-call-delta") {
              await currentStream.write(ctx, chunk.argsTextDelta)
            } else {
              const argsString = typeof chunk.args === "string"
                ? chunk.args
                : JSON.stringify(chunk.args) as string
              await currentStream.complete(ctx, argsString)
              closeCurrentStream()
              currentStream = undefined
              currentToolCallId = undefined
            }
          } else {
            if (currentStream === undefined) {
              throw new Error("No current stream found")
            }
            if (chunk.type === "tool-call-delta") {
              await currentStream.write(ctx, chunk.argsTextDelta)
            } else {
              const argsString = typeof chunk.args === "string"
                ? chunk.args
                : JSON.stringify(chunk.args) as string
              await currentStream.complete(ctx, argsString)
              closeCurrentStream()
              currentStream = undefined
              currentToolCallId = undefined
            }
          }
        }
      }
      closeCurrentStream()
      closeToolIterables()
      const settledResponse = await settledResultResponse
      if (settledResponse.didReject) {
        throw settledResponse.error
      }
      response = settledResponse.response
      // A response that says nothing is rebuilt from what was streamed, if anything was.
      if (hasMeaningfulResponseMessageContent(response.messages)) {
        newMessages.push(...response.messages)
      } else if (contentBuffer.some(shouldSynthesizeResponseFromStreamContent)) {
        newMessages.push({
          role: "assistant",
          content: sanitizeContentBufferForReplay(contentBuffer),
          id: response.id,
        })
      } else {
        newMessages.push(...response.messages)
      }
    } catch (error) {
      closeCurrentStream()
      closeToolIterables()
      // The response promise is still awaited so its rejection cannot go unhandled.
      await settledResultResponse
      const messages: ModelResponse["messages"] = [{
        role: "assistant",
        content: sanitizeContentBufferForReplay(contentBuffer),
        id: "1",
      }]
      response = {
        error: error instanceof Error ? error : new Error("Unknown error"),
        messages,
        id: "1",
        timestamp: new Date(),
        modelId: "1",
        headers: {},
      }
      newMessages.push(...messages)
    }
    if (firstToolCallHook !== undefined) {
      await firstToolCallHook(newMessages.map(message => JSON.stringify(message)))
    }
    return { ...response, messages: newMessages }
  })()
  return {
    fullStream,
    toolCalls: toolCallsIterable,
    toolCallEvents: toolCallEventsIterable,
    response: responsePromise,
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
  tools: readonly ToolLike[] | ToolExecutionSet,
): ToolExecutionSet {
  if (Array.isArray(tools)) {
    return {
      modelVisibleTools: tools as ToolLike[],
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
  executor: StreamingPromptExecutor,
  interactionHandler: InteractionHandlerLike,
  tools: readonly ToolLike[] | ToolExecutionSet,
  extraT: ToolExecutionExtra,
  recordToolCallResult: RecordToolCallResult,
  descriptionProps: Record<string, unknown> | undefined,
  firstToolCallHook: ((messages: string[]) => unknown | Promise<unknown>) | undefined,
) {
  const toolExecutionSet = normalizeToolExecutionInput(tools)
  const { modelVisibleTools } = toolExecutionSet
  const executableTools = getExecutableTools(toolExecutionSet) as ToolLike[]
  const directDynamicToolNames = getDirectDynamicToolNames(toolExecutionSet)
  const toolMap = createToolMap(executableTools)
  const dynamicInvocationToolNames = getDynamicInvocationToolNames(
    modelVisibleTools as ToolLike[],
  )
  const renderProps = { allTools: extractToolMetadataMap(executableTools) }
  const streamResult = streamModelAndCollectToolCalls(
    ctx,
    executor,
    interactionHandler,
    modelVisibleTools as ToolLike[],
    descriptionProps,
    firstToolCallHook,
    {
      executionToolMap: toolMap,
      acceptedUnadvertisedToolNames: [...directDynamicToolNames],
    },
  )
  const responsePromise = (async (): Promise<ModelResponse> => {
    const toolPromises: Array<Promise<Record<string, unknown>>> = []
    let execBackendDown = false
    // The circuit opens on the first result that says the backend is gone, and the calls after it are
    // skipped rather than attempted.
    const circuitBreakerRecordToolCallResult: RecordToolCallResult = async (
      resultCtx,
      result,
      loggedToolName,
      errorClassification,
    ) => {
      if (errorClassification === ToolErrorClassification.EXEC_BACKEND_UNAVAILABLE) {
        execBackendDown = true
      }
      await recordToolCallResult(
        resultCtx,
        result,
        loggedToolName,
        errorClassification,
      )
    }
    const consumeToolCalls = (async (): Promise<void> => {
      for await (const event of streamResult.toolCallEvents) {
        if (execBackendDown) {
          void (async () => {
            try {
              for await (const _chunk of event.argsStream) {
                // Drain subsequent model output after the backend circuit opens.
              }
            } catch {
              // The skipped result is authoritative once the backend is down.
            }
          })()
          const skippedToolResult = {
            content: [{
              type: "text",
              text: "Execution backend unavailable. Tool execution skipped.",
            }],
            isError: true,
          }
          const loggedName = toolNameForLogging(event.toolName, toolMap)
          await circuitBreakerRecordToolCallResult(
            ctx,
            skippedToolResult,
            loggedName,
            ToolErrorClassification.EXEC_BACKEND_UNAVAILABLE,
          )
          const skippedResult: Record<string, unknown> = {
            role: "tool",
            id: event.toolCallId,
            content: [{
              type: "tool-result",
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              result: "Execution backend unavailable. Tool execution skipped.",
            }],
          }
          toolPromises.push(Promise.resolve(skippedResult))
          logger.warn(ctx, "nal.tool_call.skipped_exec_backend_down", {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          })
          continue
        }
        if (dynamicInvocationToolNames.has(event.toolName)) {
          // The outer call's own arguments are drained and then replaced by the inner call's.
          const drainOuterArgs = drainArgsStream(event.argsStream).catch(() => {})
          const [outerArgs, outerArgsText] = await Promise.all([
            event.completedArgs,
            event.completedArgsText,
          ])
          await drainOuterArgs
          const outerDescriptor: NativeToolCallDescriptor = {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: outerArgs,
          }
          const descriptor = resolveEffectiveToolCallDescriptor(
            outerDescriptor,
            toolExecutionSet,
          )
          const { effectiveNativeToolCall } = descriptor
          const argsIterable = effectiveNativeToolCall === undefined
            ? createOneShotStringIterable(outerArgsText)
            : createOneShotArgsIterable(effectiveNativeToolCall.args)
          toolPromises.push(executeDeferredToolCall(
            ctx,
            descriptor,
            toolMap,
            interactionHandler,
            extraT,
            circuitBreakerRecordToolCallResult,
            renderProps,
            argsIterable,
            undefined,
            directDynamicToolNames,
          ))
          continue
        }
        const descriptor: NativeToolCallDescriptor = {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: {},
        }
        toolPromises.push(executeDeferredToolCall(
          ctx,
          descriptor,
          toolMap,
          interactionHandler,
          extraT,
          circuitBreakerRecordToolCallResult,
          renderProps,
          event.argsStream,
          event.completedArgs,
          directDynamicToolNames,
        ))
      }
    })()
    const [response] = await Promise.all([
      streamResult.response,
      consumeToolCalls,
    ])
    // A result is kept only for a call the response actually asked for, since a result for a call nobody
    // made would be a message the provider rejects.
    const isValidToolResult = (toolId: unknown): boolean => response.messages.some(
      message => message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some(
          content => content.type === "tool-call" && content.toolCallId === toolId,
        ),
    )
    let toolResults: Array<Record<string, unknown>>
    try {
      toolResults = await Promise.all(toolPromises)
    } catch (error) {
      // A stream that timed out at its start is reported on the response rather than thrown, since the
      // turn can still be recovered from what was streamed.
      if (!isAgentStreamStartTimeoutRecoveryTurnError(error)) {
        throw error
      }
      return {
        ...response,
        error: error instanceof Error ? error : new Error("Unknown tool error"),
      }
    }
    const newMessages: ModelResponse["messages"] = [
      ...response.messages,
      ...toolResults.filter(result => isValidToolResult(result.id)) as ModelResponse["messages"],
    ]
    return { ...response, messages: newMessages }
  })()
  return {
    fullStream: streamResult.fullStream,
    response: responsePromise,
    providerMetadata: streamResult.providerMetadata,
    usage: streamResult.usage,
    extendedUsage: streamResult.extendedUsage,
    invocationId: streamResult.invocationId,
  }
}

/**
 * The model's answer without running anything: the calls are collected and handed back, which is what a
 * caller that wants to decide about them itself — a different runtime, a test, a planner — asks for.
 */
function executeModelStreamOnly(
  ctx: Context,
  executor: StreamingPromptExecutor,
  interactionHandler: InteractionHandlerLike,
  tools: readonly ToolLike[] | ToolExecutionSet,
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
    modelVisibleTools as ToolLike[],
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
  readonly innerExecutor: BasePromptExecutorLike

  constructor(innerExecutor: BasePromptExecutorLike) {
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
      interactionHandler as InteractionHandlerLike,
      tools as readonly ToolLike[] | ToolExecutionSet,
      extraT as ToolExecutionExtra,
      recordToolCallResult as RecordToolCallResult,
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
      interactionHandler as InteractionHandlerLike,
      tools as readonly ToolLike[] | ToolExecutionSet,
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
  readonly innerToolExecutor: PromptExecutorLike
  readonly privacyMode: PrivacyMode
  private redactedWrapperMemo: WeakMap<CoreMessageLike, unknown>

  constructor(
    innerToolExecutor: PromptExecutorLike,
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
