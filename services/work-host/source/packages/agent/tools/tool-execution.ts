/**
 * Running a tool call, and making sense of what came out of it.
 *
 * A call is executed under its own span with the tool and the call stamped onto it, and its outcome
 * is normalized before anyone else sees it: a failure that crossed the execution boundary is
 * classified, the tool is asked to render it for each audience, and the client is told — unless the
 * failure is one the model has to handle itself.
 *
 * Three failures are deliberately let through unchanged rather than normalized: a deferred interaction
 * response, which is not a failure but a turn waiting on a person; a retryable orchestration error when
 * the conversation asks for those to bubble; and a stream that never started, which becomes a distinct
 * turn error telling the user to reload. A guard timeout that arrives as an abort is rewritten into the
 * tool timeout it actually was, so the tool's own timeout is what the user sees.
 *
 * This file also owns the tool set: which tools exist, which of them the model may see, which are
 * executable without being visible, and what a tool is told about the others when it writes its own
 * description.
 */

import { DeferredInteractionResponseError } from "../../agent-core/interaction-queries.ts"
import { HOOK_DENIAL_AGENT_NOTE } from "../../hooks-exec/hook-errors.ts"
import { withLogAttributes } from "../../context/logging.ts"
import { createSpan } from "../../context/telemetry.ts"
import type { Context } from "../../context/context.ts"
import { getShouldBubbleRetryableTaskErrorsFromContext } from "../utils/request-scope.ts"
import { maybeCreateAgentStreamStartTimeoutTurnError, maybeNormalizeExecBoundaryError } from "./connect-errors.ts"
import { RemoteHookBlockedError } from "./remote-hooks.ts"
import { isFusedStepGuardTimeoutReason } from "./tool-execution-timeout.ts"
import { createToolCallExecutionTimeoutError } from "./tool-support.ts"
import {
  CustomToolCallError,
  RetryableToolOrchestrationError,
  ToolCallAbortedError,
  ToolCallArgParseError,
  ToolCallRejectedError,
  ToolCallUnexpectedEnvironmentError,
  ToolErrorClassification,
  ToolTimeoutError,
} from "./tool-errors.ts"

type AnyTool = Record<string, any>

export function getRequiredToolName(allTools: Record<string, { name: string }>, toolId: string): string {
  const tool = allTools[toolId]
  if (!tool) throw new Error(`Required tool ${toolId} not found in allTools`)
  return tool.name
}

export function isPromptVisibleDescription(settings: { promptVisible?: boolean } | undefined): boolean {
  return settings?.promptVisible !== false
}

export function isForcedStaticContext(contextKind: { type?: string } | undefined): boolean {
  return contextKind?.type === "static"
}

/** A dynamic context may still carry a short version for prompts that have no room for the long one. */
export function getConciseStaticContext(
  contextKind: { type?: string; conciseStaticContext?: string } | undefined,
): string | undefined {
  if (contextKind?.type !== "dynamic") return undefined
  return contextKind.conciseStaticContext?.trim() || undefined
}

/** Which tool a call is really for: a meta tool may report a different one for the call it wraps. */
export function resolveToolCallIdentity({ tool, args, isDirectDynamicTool = false }: {
  tool: AnyTool
  args: unknown
  isDirectDynamicTool?: boolean
}): {
  readonly toolIdentifier: string
  readonly isDynamic: boolean
  readonly [key: string]: unknown
} {
  const resolvedIdentity = tool.resolveToolCallTelemetry?.(args) ?? { toolIdentifier: tool.toolIdentifier, isDynamic: false }
  return {
    ...resolvedIdentity,
    toolIdentifier: resolvedIdentity.toolIdentifier as string,
    isDynamic: resolvedIdentity.isDynamic === true || isDirectDynamicTool,
  }
}

export interface ToolExecutionSet {
  modelVisibleTools: AnyTool[]
  additionalExecutableTools: AnyTool[]
}

/** A tool that is executable but not shown to the model still has to be runnable by the runtime. */
export function getExecutableTools(executionSet: ToolExecutionSet): AnyTool[] {
  return executionSet.additionalExecutableTools.length === 0
    ? executionSet.modelVisibleTools
    : [...executionSet.modelVisibleTools, ...executionSet.additionalExecutableTools]
}

export function getDirectDynamicToolNames(executionSet: ToolExecutionSet): Set<string> {
  return new Set(executionSet.additionalExecutableTools.map(tool => tool.name))
}

/** MCP tools arrive in whatever order the servers answered; sorting them keeps prompts cacheable. */
function sortMcpTools(toolList: AnyTool[]): AnyTool[] {
  const nonMcp: AnyTool[] = []
  const mcp: AnyTool[] = []
  for (const tool of toolList) (tool.toolIdentifier === "MCP" ? mcp : nonMcp).push(tool)
  if (mcp.length === 0) return toolList
  mcp.sort((a, b) => a.name.localeCompare(b.name))
  return [...nonMcp, ...mcp]
}

export class ToolSetHandle {
  constructor(
    private allToolsByIdentifier: Map<string, AnyTool[]>,
    private staticTools: AnyTool[],
    private dynamicTools: AnyTool[] = [],
    private readonly dynamicToolRegistry?: { replaceTools(value: { dynamicTools: AnyTool[]; allTools: AnyTool[] }): void },
    private generatorProps: Record<string, unknown> = { allTools: {} },
  ) {}

  hasTool(toolIdentifier: string): boolean {
    return this.getTool(toolIdentifier) !== undefined
  }

  getTool(toolIdentifier: string): AnyTool | undefined {
    return this.allToolsByIdentifier.get(toolIdentifier)?.at(0)
  }

  resolveToolCallIdentity({ toolName, args }: { toolName: string; args: unknown }): ReturnType<typeof resolveToolCallIdentity> | undefined {
    const staticTool = this.staticTools.find(tool => tool.name === toolName)
    if (staticTool !== undefined) return resolveToolCallIdentity({ tool: staticTool, args })
    const dynamicTool = this.dynamicTools.find(tool => tool.name === toolName)
    return dynamicTool === undefined
      ? undefined
      : resolveToolCallIdentity({ tool: dynamicTool, args, isDirectDynamicTool: true })
  }

  getTools(toolIdentifier: string): AnyTool[] | undefined {
    return this.allToolsByIdentifier.get(toolIdentifier)
  }

  hasStaticTool(toolIdentifier: string): boolean {
    return this.getStaticTool(toolIdentifier) !== undefined
  }

  getStaticTool(toolIdentifier: string): AnyTool | undefined {
    return this.staticTools.find(tool => tool.toolIdentifier === toolIdentifier)
  }

  getStaticTools(): AnyTool[] {
    return this.staticTools
  }

  getAllTools(): AnyTool[] {
    return [...this.staticTools, ...this.dynamicTools]
  }

  getDynamicTools(): AnyTool[] {
    return this.dynamicTools
  }

  /**
   * The tools to execute for a call: dynamic tools are only executable when the model was given a meta
   * tool that can invoke them, and never twice under the same name as a tool it can already see.
   */
  getToolExecutionSet(modelVisibleTools = this.staticTools): ToolExecutionSet {
    if (this.dynamicTools.length === 0) return { modelVisibleTools, additionalExecutableTools: [] }
    if (!modelVisibleTools.some(tool => tool.dynamicToolMetaRole === "invocation")) {
      return { modelVisibleTools, additionalExecutableTools: [] }
    }
    const modelToolNames = new Set(modelVisibleTools.map(tool => tool.name))
    return {
      modelVisibleTools,
      additionalExecutableTools: this.dynamicTools.filter(tool => !modelToolNames.has(tool.name)),
    }
  }

  getDynamicToolRegistry(): typeof this.dynamicToolRegistry {
    return this.dynamicToolRegistry
  }

  getDescriptionProps(): Record<string, unknown> {
    return this.generatorProps
  }

  /** Rewrites the set in place, keeping each tool on the side of the line it was already on. */
  transformToolsInPlace(transformTools: (toolList: AnyTool[]) => AnyTool[]): this {
    const transformed = transformTools(this.getAllTools())
    const dynamicToolSet = new Set(this.dynamicTools)
    const dynamicTools = transformed.filter(tool => dynamicToolSet.has(tool))
    const staticTools = transformed.filter(tool => !dynamicToolSet.has(tool))
    const builtHandle = this.dynamicToolRegistry === undefined
      ? ToolSetHandle.fromTools(staticTools)
      : ToolSetHandle.fromTools({ staticTools, dynamicTools, dynamicToolRegistry: this.dynamicToolRegistry })
    this.allToolsByIdentifier = builtHandle.allToolsByIdentifier
    this.staticTools = builtHandle.staticTools
    this.dynamicTools = builtHandle.dynamicTools
    this.generatorProps = builtHandle.generatorProps
    return this
  }

  /**
   * Dynamic tools are only kept on the dynamic side when the set contains both meta tools — one that
   * discovers them and one that invokes them — and a registry to publish them through. Otherwise they
   * are ordinary tools, because nothing would be able to reach them.
   */
  static fromTools(
    callInput: AnyTool[] | {
      staticTools: AnyTool[]
      dynamicTools?: AnyTool[]
      dynamicToolRegistry?: { replaceTools(value: { dynamicTools: AnyTool[]; allTools: AnyTool[] }): void }
    },
  ): ToolSetHandle {
    const { staticTools: toolList, dynamicTools = [], dynamicToolRegistry } = Array.isArray(callInput)
      ? { staticTools: callInput }
      : callInput
    const hasDynamicMetaTools = toolList.some(tool => tool.dynamicToolMetaRole === "discovery") &&
      toolList.some(tool => tool.dynamicToolMetaRole === "invocation")
    const canExposeDynamicTools = dynamicToolRegistry !== undefined && hasDynamicMetaTools
    const effectiveDynamicTools = canExposeDynamicTools ? dynamicTools : []
    const effectiveStaticTools = canExposeDynamicTools ? toolList : [...toolList, ...dynamicTools]
    const generatorProps = buildDescriptionGeneratorProps([...effectiveStaticTools, ...effectiveDynamicTools])
    dynamicToolRegistry?.replaceTools({
      dynamicTools: effectiveDynamicTools,
      allTools: [...effectiveStaticTools, ...effectiveDynamicTools],
    })
    const allToolsByIdentifier = new Map<string, AnyTool[]>()
    const sortedStaticTools = sortMcpTools(effectiveStaticTools)
    for (const tool of [...sortedStaticTools, ...effectiveDynamicTools]) {
      const existing = allToolsByIdentifier.get(tool.toolIdentifier)
      if (existing) existing.push(tool)
      else allToolsByIdentifier.set(tool.toolIdentifier, [tool])
    }
    return new ToolSetHandle(allToolsByIdentifier, sortedStaticTools, effectiveDynamicTools, dynamicToolRegistry, generatorProps)
  }

  /**
   * Two sets can be merged only when they do not both own a dynamic registry: the merged set would have
   * to publish through one of them, and a tool published through the wrong registry is a tool nobody
   * can invoke. When one side owns a registry the merge happens through it.
   */
  merge(otherHandle: ToolSetHandle): ToolSetHandle {
    const otherRegistry = otherHandle.getDynamicToolRegistry()
    if (this.dynamicToolRegistry !== undefined && otherRegistry !== undefined && this.dynamicToolRegistry !== otherRegistry) {
      throw new Error("Cannot merge toolsets with distinct dynamic registries")
    }
    if (this.dynamicToolRegistry !== undefined && this.dynamicToolRegistry === otherRegistry) {
      throw new Error("Cannot merge toolsets sharing a dynamic registry")
    }
    if (this.dynamicToolRegistry !== undefined) return this.transformToolsInPlace(toolList => [...toolList, ...otherHandle.getAllTools()])
    if (otherRegistry !== undefined) return otherHandle.transformToolsInPlace(toolList => [...this.getAllTools(), ...toolList])
    return ToolSetHandle.fromTools([...this.getAllTools(), ...otherHandle.getAllTools()])
  }
}

/**
 * Runs the call and returns either its result or the failure the caller can render. A failure the model
 * has to handle is rethrown instead, and a deferred interaction is passed straight through: it is the
 * turn waiting, not the tool failing.
 */
export async function executeToolResultOrError(
  tool: AnyTool,
  outerContext: Context,
  interactionHandler: AnyTool,
  argsStream: AsyncIterable<string>,
  callMeta: AnyTool,
): Promise<AnyTool> {
  using callSpanContext = createSpan(outerContext.withName("executeToolResultOrError"))
  const callContext = withLogAttributes(callSpanContext.ctx, { toolName: tool.toolIdentifier, toolId: callMeta.toolCallId })
  callSpanContext.span.setAttribute("toolName", tool.toolIdentifier)
  callSpanContext.span.setAttribute("toolId", callMeta.toolCallId)
  // Some callers keep the raw arguments around to re-issue the call; they are told before it runs.
  if (callMeta.enableToolArgPreservation === true && "customToolFormat" in tool && tool.customToolFormat !== undefined) {
    interactionHandler.markToolCallForArgPreservation(callMeta.toolCallId)
  }
  try {
    return { result: await tool.execute(callContext, interactionHandler, argsStream, callMeta) }
  } catch (failure) {
    if (failure instanceof DeferredInteractionResponseError) throw failure
    const bubbleRetryable = getShouldBubbleRetryableTaskErrorsFromContext(callContext)
    if (failure instanceof RetryableToolOrchestrationError && bubbleRetryable) throw failure
    const startTimeoutError = maybeCreateAgentStreamStartTimeoutTurnError(failure)
    if (startTimeoutError !== undefined) throw startTimeoutError
    const abortSignal = interactionHandler.getAbortSignal?.(callContext)
    const classifiableFailure = rewriteGuardAbort(
      maybeNormalizeExecBoundaryError(failure),
      abortSignal !== undefined ? [abortSignal, callContext.signal] : [callContext.signal],
      tool.name,
    )
    if (classifiableFailure instanceof DeferredInteractionResponseError) throw classifiableFailure
    if (classifiableFailure instanceof RetryableToolOrchestrationError && bubbleRetryable) throw classifiableFailure
    const errorClassification = classifyError(classifiableFailure)
    const callOutput = tool.serializeError(classifiableFailure)
    if (!hidesClientError(classifiableFailure)) {
      await interactionHandler.emitToolCallError(callContext, callMeta.toolCallId, callOutput)
    }
    return { result: callOutput.tool.value?.result, error: classifiableFailure, errorClassification }
  }
}

function hidesClientError(failure: unknown): boolean {
  return failure instanceof CustomToolCallError && "hideFromClientToolCall" in failure && failure.hideFromClientToolCall === true
}

function looksAborted(failure: unknown): boolean {
  return failure instanceof ToolCallAbortedError || (failure instanceof Error && failure.name === "AbortError")
}

/** An abort whose reason is the fused step guard is a timeout that was reported as a cancellation. */
function rewriteGuardAbort(failure: unknown, abortSignals: AbortSignal[], toolName: string): unknown {
  if (!looksAborted(failure)) return failure
  const reason = guardTimeoutReason(abortSignals, failure)
  if (reason === undefined) return failure
  const timeoutError = createToolCallExecutionTimeoutError({ toolName, executionTimeoutMs: reason.fuseGuardMs })
  timeoutError.cause = failure
  return timeoutError
}

function guardTimeoutReason(abortSignals: AbortSignal[], failure: unknown): { fuseGuardMs: number } | undefined {
  for (const signal of abortSignals) {
    if (signal.aborted && isFusedStepGuardTimeoutReason(signal.reason)) return signal.reason
  }
  if (isFusedStepGuardTimeoutReason(failure)) return failure
  return failure instanceof Error && isFusedStepGuardTimeoutReason(failure.cause) ? failure.cause : undefined
}

/** What went wrong, in the vocabulary retry policy and metrics use. */
export function classifyError(failure: unknown): ToolErrorClassification {
  if (failure instanceof RetryableToolOrchestrationError) return failure.classification ?? ToolErrorClassification.OTHER_ERROR
  if (failure instanceof CustomToolCallError) return failure.classification
  if (failure instanceof ToolCallArgParseError) return ToolErrorClassification.INVALID_ARGS
  if (looksAborted(failure)) return ToolErrorClassification.ABORTED
  if (failure instanceof ToolCallRejectedError) {
    return failure.message.includes(HOOK_DENIAL_AGENT_NOTE) ? ToolErrorClassification.HOOK_DENIED : ToolErrorClassification.USER_REJECTED
  }
  if (failure instanceof ToolCallUnexpectedEnvironmentError) return ToolErrorClassification.UNEXPECTED_ENVIRONMENT
  if (failure instanceof ToolTimeoutError || (failure instanceof Error && failure.name === "TimeoutError") || axiosTimeout(failure)) {
    return ToolErrorClassification.TIMEOUT
  }
  if (badDeviceState(failure)) return ToolErrorClassification.BAD_USER_DEVICE_STATE
  if (missingEnvironmentPath(failure)) return ToolErrorClassification.UNEXPECTED_ENVIRONMENT
  if (failure instanceof RemoteHookBlockedError) return ToolErrorClassification.HOOK_DENIED
  if (failure instanceof Error && failure.message.includes(HOOK_DENIAL_AGENT_NOTE)) return ToolErrorClassification.HOOK_DENIED
  return ToolErrorClassification.OTHER_ERROR
}

function errnoOf(failure: Error): unknown {
  return (failure as Error & { code?: unknown }).code
}

function axiosTimeout(failure: unknown): boolean {
  if (!(failure instanceof Error)) return false
  const code = errnoOf(failure)
  return code === "ETIMEDOUT" || (code === "ECONNABORTED" && failure.message.toLowerCase().includes("timeout"))
}

/** The machine ran out of something the work needed; retrying the same call on the same machine is futile. */
function badDeviceState(failure: unknown): boolean {
  if (!(failure instanceof Error)) return false
  const code = errnoOf(failure)
  if (["ENOSPC", "ENOMEM", "EMFILE", "ENFILE", "EAGAIN", "EBADF"].includes(String(code))) return true
  const message = failure.message.toLowerCase()
  return message.includes("no space left on device") ||
    message.includes("out of memory") ||
    message.includes("cannot allocate memory") ||
    message.includes("too many open files") ||
    message.includes("bad file descriptor")
}

/** The environment is not what the call assumed: a path that is not there, or not what it claimed to be. */
function missingEnvironmentPath(failure: unknown): boolean {
  if (!(failure instanceof Error)) return false
  const code = errnoOf(failure)
  if (code === "ENOENT" || code === "ENOTDIR") return true
  const message = failure.message.toLowerCase()
  return message.includes("no such file or directory") || message.includes("not a directory")
}

/** Rendering a result and a failure is the same call, told apart by a flag the renderer sets. */
export async function renderToolResultOrError(callContext: unknown, tool: AnyTool, callOutput: AnyTool, descriptionInput: unknown): Promise<AnyTool> {
  const rendered = await tool.render(callContext, callOutput.result, descriptionInput)
  return "error" in callOutput ? { ...rendered, isError: true } : rendered
}

export function extractToolMetadataMap(toolList: AnyTool[]): Record<string, unknown> {
  const metadataByTool: Record<string, unknown> = {}
  for (const tool of toolList) {
    metadataByTool[tool.toolIdentifier] = { name: tool.name, toolIdentifier: tool.toolIdentifier, parameters: tool.parameters }
  }
  return metadataByTool
}

/** What a tool is told about its siblings when it writes its own description. */
export function buildDescriptionGeneratorProps(toolList: AnyTool[]): Record<string, unknown> {
  const allTools: Record<string, unknown> = {}
  for (const tool of toolList) {
    allTools[tool.toolIdentifier] = { name: tool.name, toolIdentifier: tool.toolIdentifier, parameters: tool.parameters }
  }
  return { allTools }
}

/** The tools as the model sees them: a generated description where the tool has one, its own otherwise. */
export function toAgentTools(toolList: AnyTool[], descriptionInput?: Record<string, unknown>): AnyTool[] {
  const generatorProps = descriptionInput ?? buildDescriptionGeneratorProps(toolList)
  return toolList.map(tool => "descriptionGenerator" in tool
    ? {
      name: tool.name,
      description: tool.descriptionGenerator(generatorProps),
      parameters: tool.parameters,
      customToolFormat: tool.customToolFormat,
      render: tool.render,
    }
    : { name: tool.name, description: tool.description, parameters: tool.parameters, render: tool.render })
}
