/**
 * Running a turn's hooks where the hooks actually live.
 *
 * Hooks are not part of this process: they belong to the workspace, so they run there and this side
 * only sends the question and reads the answer. That makes every hook call a boundary crossing, and
 * the rules of this file follow from it.
 *
 * A hook is only asked if it is configured and the environment allows it, so a workspace with no hooks
 * pays nothing. Each call is measured and tracked — step, outcome, whether it timed out — because a
 * hook that is slow or failing is invisible otherwise. A hook that denies an action raises a distinct
 * error so the denial can be told apart from a tool that failed, and one that fails is treated the way
 * its configuration says: fail-closed hooks block the action, fail-open ones let it through. The
 * context a hook adds is attached to the conversation; a hook that returns more than the carrier
 * allows loses that context rather than the call.
 */

import { Struct } from "@bufbuild/protobuf"

import { hookExecutorResource } from "../../agent-exec/hook-executor.ts"
import { createLogger } from "../../context/logging.ts"
import {
  appendHookAdditionalContexts,
  createHookAdditionalContexts,
  HookAdditionalContextTooLargeError,
} from "../../hooks-carriers/index.ts"
import { HookStep } from "../../hooks/hook-step.ts"
import { createCounter, createHistogram } from "../../metrics/index.ts"
import {
  AfterAgentThoughtRequestQuery,
  PostToolUseFailureRequestQuery,
  PostToolUseRequestQuery,
  PreToolUseRequestQuery,
  RequestedModel_ModelParameterValue,
  SubagentStartRequestQuery,
  SubagentStopRequestQuery,
} from "../../proto/generated/agent/v1/agent_pb.ts"
import { ExecuteHookArgs, ExecuteHookRequest } from "../../proto/generated/agent/v1/exec_pb.ts"
import type { Context } from "../../context/context.ts"
import { getAgentEventTracker } from "../utils/event-tracking.ts"
import { isHookStepConfigured } from "../utils/common-helpers.ts"
import { getConversationId, getRequestId } from "../utils/request-scope.ts"
import { ToolTimeoutError } from "./tool-errors.ts"

const logger = createLogger("agent/tools/remote-hooks")

type AnyRecord = Record<string, any>

const remoteHookDuration = createHistogram("remote_hook.duration_ms", {
  description: "Duration of remote hook execution in milliseconds",
  labelNames: ["hook_type", "outcome"],
})
const remoteHookCount = createCounter("remote_hook.count", {
  description: "Count of remote hook executions",
  labelNames: ["hook_type", "outcome"],
})

function recordRemoteHookMetrics(ctx: Context, durationMs: number, hookType: string, outcome: string): void {
  remoteHookDuration.histogram(ctx, durationMs, { hook_type: hookType, outcome })
  remoteHookCount.increment(ctx, 1, { hook_type: hookType, outcome })
}

function isHookExecutionTimeout(error: unknown): boolean {
  return error instanceof Error &&
    (error.message.toLowerCase().includes("timed out") || error.message.toLowerCase().includes("timeout"))
}

/** The model a hook is told about: the call's own choice when it made one, the session's otherwise. */
function toRemoteHookModelFields(requestContext: AnyRecord, options: AnyRecord): AnyRecord {
  const modelId = requestContext.modelId ?? options.modelId
  const modelParams = requestContext.modelParams ?? options.modelParams
  return {
    ...(modelId !== undefined && { modelId }),
    ...(modelParams !== undefined && modelParams.length > 0
      ? { modelParams: modelParams.map((parameter: AnyRecord) => new RequestedModel_ModelParameterValue(parameter)) }
      : {}),
  }
}

/** A hook refused the action. Distinct from a failure, because refusing is the hook working. */
export class RemoteHookBlockedError extends Error {
  readonly reason: string

  constructor(message: string, reason: string) {
    super(message)
    this.reason = reason
    this.name = "RemoteHookBlockedError"
  }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof ToolTimeoutError || (error instanceof Error && error.name === "TimeoutError")
}

/** A struct carries JSON, and a value that is not JSON cannot be sent: this is where that is decided. */
function sanitizeToolInputForStruct(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value))
}

function getRemoteHookExecutor(options: AnyRecord, hookStep: string): AnyRecord | undefined {
  if (!options.enableExecuteHookExec || !isHookStepConfigured(options.configuredSteps, hookStep)) return undefined
  return options.resourceAccessor.get(hookExecutorResource)
}

/** A hook is told which conversation and which request it is answering, even when the call is bare. */
function buildRequestIds(ctx: Context, requestContext: AnyRecord): { conversationId: string; generationId: string } {
  return {
    conversationId: requestContext.conversationId ?? getConversationId(ctx) ?? requestContext.toolCallId,
    generationId: requestContext.generationId ?? getRequestId(ctx) ?? requestContext.toolCallId,
  }
}

function checkRemotePreToolUsePermission(toolName: string, result: AnyRecord): AnyRecord {
  if (result.permission === "deny") {
    const reason = result.userMessage
      ? `${toolName} blocked by preToolUse hook: ${result.userMessage}`
      : `${toolName} blocked by preToolUse hook`
    throw new RemoteHookBlockedError(reason, reason)
  }
  if (result.permission === "ask") {
    const reason = "The 'ask' permission for preToolUse hooks is not yet implemented. Use 'allow' or 'deny' instead."
    throw new RemoteHookBlockedError(reason, reason)
  }
  return result
}

function track(ctx: Context, event: AnyRecord): void {
  getAgentEventTracker(ctx).trackHookExecuted(ctx, event)
}

/** Context a hook returned, or nothing if it returned more than a carrier may hold. */
function safeBuildRemoteHookContexts(
  ctx: Context,
  toolName: string,
  toolCallId: string,
  hookEventName: string,
  additionalContext: string | undefined,
): any[] {
  try {
    return createHookAdditionalContexts({ hookEventName, additionalContext })
  } catch (error) {
    if (error instanceof HookAdditionalContextTooLargeError) {
      logger.warn(ctx, `${hookEventName} additional_context exceeded max size; dropping carrier`, {
        toolName,
        toolCallId,
        hookEventName,
        actualLength: error.actualLength,
        maxLength: error.maxLength,
      })
      return []
    }
    throw error
  }
}

/** A thought is observed, not decided: the hook runs and nothing depends on what it says. */
export async function executeRemoteAfterAgentThoughtHook(args: AnyRecord): Promise<void> {
  const { ctx, text, durationMs: thoughtDurationMs, requestContext, options } = args
  const executor = getRemoteHookExecutor(options, "afterAgentThought")
  if (!executor) return
  const { conversationId, generationId } = buildRequestIds(ctx, requestContext)
  const startTime = performance.now()
  try {
    const hookArgs = new ExecuteHookArgs({
      request: new ExecuteHookRequest({
        request: {
          case: "afterAgentThought",
          value: new AfterAgentThoughtRequestQuery({
            text,
            ...(thoughtDurationMs !== undefined ? { durationMs: BigInt(thoughtDurationMs) } : {}),
            conversationId,
            generationId,
            model: requestContext.model ?? options.model,
            ...toRemoteHookModelFields(requestContext, options),
          }),
        },
      }),
    })
    await executor.execute(ctx, hookArgs)
    const durationMs = Math.round(performance.now() - startTime)
    recordRemoteHookMetrics(ctx, durationMs, "afterAgentThought", "success")
    track(ctx, {
      hookStep: "afterAgentThought",
      hookSource: "remote",
      hookType: "afterAgentThought",
      status: "success",
      latencyMs: durationMs,
      failClosed: false,
    })
  } catch (error) {
    const durationMs = Math.round(performance.now() - startTime)
    const timedOut = isHookExecutionTimeout(error)
    recordRemoteHookMetrics(ctx, durationMs, "afterAgentThought", "failure")
    track(ctx, {
      hookStep: "afterAgentThought",
      hookSource: "remote",
      hookType: "afterAgentThought",
      status: timedOut ? "timeout" : "failed",
      latencyMs: durationMs,
      failClosed: false,
      timedOut,
    })
    logger.warn(ctx, "afterAgentThought hook execution failed", {
      toolCallId: requestContext.toolCallId,
      error: error instanceof Error ? error.message : String(error),
      durationMs,
    })
  }
}

export async function executeRemoteSubagentStartHook(args: AnyRecord): Promise<AnyRecord> {
  const {
    ctx,
    subagentId,
    subagentType,
    task,
    parentConversationId: providedParentConversationId,
    subagentModel,
    isParallelWorker,
    gitBranch,
    requestContext,
    options,
  } = args
  const executor = getRemoteHookExecutor(options, "subagentStart")
  if (!executor) return {}
  const { conversationId, generationId } = buildRequestIds(ctx, requestContext)
  const parentConversationId = providedParentConversationId ?? conversationId
  logger.info(ctx, "subagentStart hook firing", { subagentId, subagentType, toolCallId: requestContext.toolCallId })
  const startTime = performance.now()
  try {
    const hookArgs = new ExecuteHookArgs({
      request: new ExecuteHookRequest({
        request: {
          case: "subagentStart",
          value: new SubagentStartRequestQuery({
            subagentId,
            subagentType,
            task,
            parentConversationId,
            toolCallId: requestContext.toolCallId,
            subagentModel,
            isParallelWorker,
            gitBranch,
            conversationId,
            generationId,
            model: requestContext.model ?? options.model,
            ...toRemoteHookModelFields(requestContext, options),
          }),
        },
      }),
    })
    const result = await executor.execute(ctx, hookArgs)
    const durationMs = Math.round(performance.now() - startTime)
    if (result.response?.response.case !== "subagentStart") {
      logger.warn(ctx, "subagentStart hook returned unexpected response", {
        subagentId,
        subagentType,
        toolCallId: requestContext.toolCallId,
        responseCase: result.response?.response.case,
        durationMs,
      })
      recordRemoteHookMetrics(ctx, durationMs, "subagentStart", "failure")
      track(ctx, {
        hookStep: "subagentStart",
        hookSource: "remote",
        hookType: "subagentStart",
        status: "failed",
        latencyMs: durationMs,
        failClosed: false,
      })
      return {}
    }
    const response = result.response.response.value
    const blocked = response.permission === "deny" || response.permission === "ask"
    recordRemoteHookMetrics(ctx, durationMs, "subagentStart", "success")
    track(ctx, {
      hookStep: "subagentStart",
      hookSource: "remote",
      hookType: "subagentStart",
      status: blocked ? "blocked" : "success",
      latencyMs: durationMs,
      failClosed: false,
    })
    logger.info(ctx, "subagentStart hook completed", {
      subagentId,
      subagentType,
      toolCallId: requestContext.toolCallId,
      permission: response.permission ?? "none",
      durationMs,
    })
    return { permission: response.permission, userMessage: response.userMessage }
  } catch (error) {
    const durationMs = Math.round(performance.now() - startTime)
    const timedOut = isHookExecutionTimeout(error)
    recordRemoteHookMetrics(ctx, durationMs, "subagentStart", "failure")
    track(ctx, {
      hookStep: "subagentStart",
      hookSource: "remote",
      hookType: "subagentStart",
      status: timedOut ? "timeout" : "failed",
      latencyMs: durationMs,
      failClosed: false,
      timedOut,
    })
    throw error
  }
}

export async function executeRemoteSubagentStopHook(args: AnyRecord): Promise<AnyRecord> {
  const {
    ctx,
    subagentId,
    subagentType,
    status,
    durationMs: subagentDurationMs,
    summary,
    parentConversationId: suppliedParent,
    messageCount,
    toolCallCount,
    errorMessage,
    modifiedFiles,
    gitBranch,
    loopCount,
    task,
    description,
    requestContext,
    options,
  } = args
  const executor = getRemoteHookExecutor(options, "subagentStop")
  if (!executor) return {}
  const { conversationId, generationId } = buildRequestIds(ctx, requestContext)
  const parentConversationId = suppliedParent ?? conversationId
  logger.info(ctx, "subagentStop hook firing", {
    subagentId,
    subagentType,
    toolCallId: requestContext.toolCallId,
    status,
  })
  const startTime = performance.now()
  try {
    const hookArgs = new ExecuteHookArgs({
      request: new ExecuteHookRequest({
        request: {
          case: "subagentStop",
          value: new SubagentStopRequestQuery({
            subagentId,
            subagentType,
            status,
            durationMs: BigInt(Math.round(subagentDurationMs)),
            summary,
            parentConversationId,
            messageCount,
            toolCallCount,
            errorMessage,
            modifiedFiles,
            gitBranch,
            conversationId,
            generationId,
            model: requestContext.model ?? options.model,
            ...toRemoteHookModelFields(requestContext, options),
            loopCount,
            task,
            description,
          }),
        },
      }),
    })
    const result = await executor.execute(ctx, hookArgs)
    const durationMs = Math.round(performance.now() - startTime)
    if (result.response?.response.case !== "subagentStop") {
      logger.warn(ctx, "subagentStop hook returned unexpected response", {
        subagentId,
        subagentType,
        toolCallId: requestContext.toolCallId,
        responseCase: result.response?.response.case,
        durationMs,
      })
      recordRemoteHookMetrics(ctx, durationMs, "subagentStop", "failure")
      track(ctx, {
        hookStep: "subagentStop",
        hookSource: "remote",
        hookType: "subagentStop",
        status: "failed",
        latencyMs: durationMs,
        failClosed: false,
      })
      return {}
    }
    const response = result.response.response.value
    recordRemoteHookMetrics(ctx, durationMs, "subagentStop", "success")
    track(ctx, {
      hookStep: "subagentStop",
      hookSource: "remote",
      hookType: "subagentStop",
      status: "success",
      latencyMs: durationMs,
      failClosed: false,
    })
    logger.info(ctx, "subagentStop hook completed", {
      subagentId,
      subagentType,
      toolCallId: requestContext.toolCallId,
      status,
      durationMs,
      hasFollowupMessage: !!response.followupMessage,
    })
    return { followupMessage: response.followupMessage?.trim() }
  } catch (error) {
    const durationMs = Math.round(performance.now() - startTime)
    const timedOut = isHookExecutionTimeout(error)
    recordRemoteHookMetrics(ctx, durationMs, "subagentStop", "failure")
    track(ctx, {
      hookStep: "subagentStop",
      hookSource: "remote",
      hookType: "subagentStop",
      status: timedOut ? "timeout" : "failed",
      latencyMs: durationMs,
      failClosed: false,
      timedOut,
    })
    throw error
  }
}

/** The variant a tool call uses: a refusal is raised, not returned, because the call must not happen. */
export async function executeRemotePreToolUseHookWithPermissionCheck(args: AnyRecord): Promise<AnyRecord> {
  return checkRemotePreToolUsePermission(args.toolName, await executeRemotePreToolUseHook(args))
}

async function executeRemotePreToolUseHook(args: AnyRecord): Promise<AnyRecord> {
  const { ctx, toolName, toolInput, requestContext, options } = args
  const executor = getRemoteHookExecutor(options, "preToolUse")
  if (!executor) return {}
  const { conversationId, generationId } = buildRequestIds(ctx, requestContext)
  logger.info(ctx, "preToolUse hook firing", { toolName, toolCallId: requestContext.toolCallId })
  const startTime = performance.now()
  try {
    const hookArgs = new ExecuteHookArgs({
      request: new ExecuteHookRequest({
        request: {
          case: "preToolUse",
          value: new PreToolUseRequestQuery({
            toolName,
            toolInput: Struct.fromJson(sanitizeToolInputForStruct(toolInput) as any),
            toolUseId: requestContext.toolCallId,
            conversationId,
            generationId,
            model: requestContext.model ?? options.model,
            ...toRemoteHookModelFields(requestContext, options),
          }),
        },
      }),
    })
    const result = await executor.execute(ctx, hookArgs)
    const durationMs = Math.round(performance.now() - startTime)
    if (result.response?.response.case === "preToolUse") {
      const response = result.response.response.value
      let updatedInput: unknown
      if (response.updatedInput) {
        try {
          updatedInput = JSON.parse(response.updatedInput)
        } catch {
          logger.warn(ctx, "Failed to parse preToolUse updatedInput", { toolName, toolCallId: requestContext.toolCallId })
        }
      }
      const contexts = safeBuildRemoteHookContexts(ctx, toolName, requestContext.toolCallId, HookStep.preToolUse, response.additionalContext)
      appendHookAdditionalContexts(options.hookContextCollector, contexts)
      recordRemoteHookMetrics(ctx, durationMs, "preToolUse", "success")
      track(ctx, {
        hookStep: "preToolUse",
        hookSource: "remote",
        hookType: "preToolUse",
        status: response.permission === "deny" || response.permission === "ask" ? "blocked" : "success",
        latencyMs: durationMs,
        failClosed: false,
        toolName,
      })
      logger.info(ctx, "preToolUse hook completed", {
        toolName,
        toolCallId: requestContext.toolCallId,
        permission: response.permission ?? "none",
        durationMs,
        hasUpdatedInput: !!updatedInput,
      })
      return {
        permission: response.permission,
        userMessage: response.userMessage,
        agentMessage: response.agentMessage,
        updatedInput,
        hookAdditionalContexts: contexts,
      }
    }
    recordRemoteHookMetrics(ctx, durationMs, "preToolUse", "success")
    track(ctx, {
      hookStep: "preToolUse",
      hookSource: "remote",
      hookType: "preToolUse",
      status: "success",
      latencyMs: durationMs,
      failClosed: false,
      toolName,
    })
    logger.info(ctx, "preToolUse hook completed with no response", { toolName, toolCallId: requestContext.toolCallId, durationMs })
  } catch (error) {
    const durationMs = Math.round(performance.now() - startTime)
    const timedOut = isHookExecutionTimeout(error)
    recordRemoteHookMetrics(ctx, durationMs, "preToolUse", "failure")
    // A hook that cannot be evaluated blocks when it is configured to fail closed, and only then.
    const failClosed = executor.hasFailClosedHooksForStep?.("preToolUse", toolName) ?? false
    if (failClosed) {
      const detail = error instanceof Error ? error.message : "preToolUse hook error"
      const userMessage = `Tool blocked because this hook is configured to fail closed (block when it fails). preToolUse hook failed: ${detail}`
      logger.warn(ctx, "preToolUse hook failed (fail-closed)", {
        toolName,
        toolCallId: requestContext.toolCallId,
        error: error instanceof Error ? error.message : String(error),
        durationMs,
      })
      track(ctx, {
        hookStep: "preToolUse",
        hookSource: "remote",
        hookType: "preToolUse",
        status: timedOut ? "timeout" : "blocked",
        latencyMs: durationMs,
        failClosed: true,
        timedOut,
        toolName,
      })
      return { permission: "deny", userMessage }
    }
    logger.warn(ctx, "preToolUse hook execution failed (fail-open)", {
      toolName,
      toolCallId: requestContext.toolCallId,
      error: error instanceof Error ? error.message : String(error),
      durationMs,
    })
    track(ctx, {
      hookStep: "preToolUse",
      hookSource: "remote",
      hookType: "preToolUse",
      status: timedOut ? "timeout" : "failed",
      latencyMs: durationMs,
      failClosed: false,
      timedOut,
      toolName,
    })
  }
  return {}
}

/** After a call there is nothing to decide: the hook's only effect is the context it adds. */
export async function executeRemotePostToolUseHook(args: AnyRecord): Promise<any[]> {
  const { ctx, toolName, toolInput, toolOutput, durationMs: toolDurationMs, requestContext, options } = args
  const executor = getRemoteHookExecutor(options, "postToolUse")
  if (!executor) return []
  const { conversationId, generationId } = buildRequestIds(ctx, requestContext)
  const startTime = performance.now()
  logger.info(ctx, "postToolUse hook firing", { toolName, toolCallId: requestContext.toolCallId })
  const hookArgs = new ExecuteHookArgs({
    request: new ExecuteHookRequest({
      request: {
        case: "postToolUse",
        value: new PostToolUseRequestQuery({
          toolName,
          toolInput: Struct.fromJson(sanitizeToolInputForStruct(toolInput) as any),
          toolOutput,
          durationMs: BigInt(Math.round(toolDurationMs)),
          toolUseId: requestContext.toolCallId,
          conversationId,
          generationId,
          model: requestContext.model ?? options.model,
          ...toRemoteHookModelFields(requestContext, options),
        }),
      },
    }),
  })
  try {
    const result = await executor.execute(ctx, hookArgs)
    const durationMs = Math.round(performance.now() - startTime)
    const contexts = result.response?.response.case === "postToolUse"
      ? safeBuildRemoteHookContexts(ctx, toolName, requestContext.toolCallId, HookStep.postToolUse, result.response.response.value.additionalContext)
      : []
    appendHookAdditionalContexts(options.hookContextCollector, contexts)
    recordRemoteHookMetrics(ctx, durationMs, "postToolUse", "success")
    track(ctx, {
      hookStep: "postToolUse",
      hookSource: "remote",
      hookType: "postToolUse",
      status: "success",
      latencyMs: durationMs,
      failClosed: false,
      toolName,
    })
    logger.info(ctx, "postToolUse hook completed", { toolName, toolCallId: requestContext.toolCallId, durationMs })
    return contexts
  } catch (error) {
    const durationMs = Math.round(performance.now() - startTime)
    const timedOut = isHookExecutionTimeout(error)
    const failClosed = executor.hasFailClosedHooksForStep?.("postToolUse", toolName) ?? false
    recordRemoteHookMetrics(ctx, durationMs, "postToolUse", "failure")
    track(ctx, {
      hookStep: "postToolUse",
      hookSource: "remote",
      hookType: "postToolUse",
      status: timedOut ? "timeout" : failClosed ? "blocked" : "failed",
      latencyMs: durationMs,
      failClosed,
      timedOut,
      toolName,
    })
    logger.warn(ctx, "postToolUse hook execution failed", {
      toolName,
      toolCallId: requestContext.toolCallId,
      error: error instanceof Error ? error.message : String(error),
      durationMs,
    })
    return []
  }
}

export async function executeRemotePostToolUseFailureHook(args: AnyRecord): Promise<any[]> {
  const {
    ctx,
    toolName,
    toolInput,
    errorMessage,
    failureType,
    durationMs: toolDurationMs,
    isInterrupt = false,
    requestContext,
    options,
  } = args
  const executor = getRemoteHookExecutor(options, "postToolUseFailure")
  if (!executor) return []
  const { conversationId, generationId } = buildRequestIds(ctx, requestContext)
  const startTime = performance.now()
  logger.info(ctx, "postToolUseFailure hook firing", { toolName, toolCallId: requestContext.toolCallId, failureType })
  const hookArgs = new ExecuteHookArgs({
    request: new ExecuteHookRequest({
      request: {
        case: "postToolUseFailure",
        value: new PostToolUseFailureRequestQuery({
          toolName,
          toolInput: Struct.fromJson(sanitizeToolInputForStruct(toolInput) as any),
          errorMessage,
          failureType,
          durationMs: BigInt(Math.round(toolDurationMs)),
          toolUseId: requestContext.toolCallId,
          isInterrupt,
          conversationId,
          generationId,
          model: requestContext.model ?? options.model,
          ...toRemoteHookModelFields(requestContext, options),
        }),
      },
    }),
  })
  try {
    const result = await executor.execute(ctx, hookArgs)
    const durationMs = Math.round(performance.now() - startTime)
    const contexts = result.response?.response.case === "postToolUseFailure"
      ? safeBuildRemoteHookContexts(ctx, toolName, requestContext.toolCallId, HookStep.postToolUseFailure, result.response.response.value.additionalContext)
      : []
    appendHookAdditionalContexts(options.hookContextCollector, contexts)
    recordRemoteHookMetrics(ctx, durationMs, "postToolUseFailure", "success")
    track(ctx, {
      hookStep: "postToolUseFailure",
      hookSource: "remote",
      hookType: "postToolUseFailure",
      status: "success",
      latencyMs: durationMs,
      failClosed: false,
      toolName,
      failureType,
    })
    logger.info(ctx, "postToolUseFailure hook completed", { toolName, toolCallId: requestContext.toolCallId, durationMs })
    return contexts
  } catch (error) {
    const durationMs = Math.round(performance.now() - startTime)
    const timedOut = isHookExecutionTimeout(error)
    const failClosed = executor.hasFailClosedHooksForStep?.("postToolUseFailure", toolName) ?? false
    recordRemoteHookMetrics(ctx, durationMs, "postToolUseFailure", "failure")
    track(ctx, {
      hookStep: "postToolUseFailure",
      hookSource: "remote",
      hookType: "postToolUseFailure",
      status: timedOut ? "timeout" : failClosed ? "blocked" : "failed",
      latencyMs: durationMs,
      failClosed,
      timedOut,
      toolName,
      failureType,
    })
    logger.warn(ctx, "postToolUseFailure hook execution failed", {
      toolName,
      toolCallId: requestContext.toolCallId,
      error: error instanceof Error ? error.message : String(error),
      durationMs,
    })
    return []
  }
}

/**
 * Wrapping a tool's execution in the hooks around it: the pre-call decision, the arguments a hook may
 * rewrite, and the post-call report — including the failure report when the tool threw, which is sent
 * before the error is rethrown so the hook sees the call that failed.
 */
export function withRemoteHooks(args: AnyRecord): (ctx: Context, toolArgs: AnyRecord) => Promise<unknown> {
  const { executeFn, config, requestContext, options } = args
  return async (ctx, toolArgs) => {
    const startTime = performance.now()
    const toolInput = config.createToolInput(toolArgs)
    const hookResult = await executeRemotePreToolUseHook({ ctx, toolName: config.toolName, toolInput, requestContext, options })
    if (hookResult.permission === "deny") {
      return config.createRejectedResult(toolArgs, hookResult.userMessage ?? `${config.toolName} denied by hook`)
    }
    if (hookResult.permission === "ask") {
      return config.createRejectedResult(toolArgs, "The 'ask' permission for preToolUse hooks is not yet implemented")
    }
    let actualToolInput = toolInput
    if (hookResult.updatedInput && config.applyUpdatedInput) {
      config.applyUpdatedInput(toolArgs, hookResult.updatedInput)
      actualToolInput = config.createToolInput(toolArgs)
    }
    let result: unknown
    try {
      result = await executeFn(ctx, toolArgs)
    } catch (error) {
      const errorObject = error instanceof Error ? error : new Error(String(error))
      try {
        await executeRemotePostToolUseFailureHook({
          ctx,
          toolName: config.toolName,
          toolInput: actualToolInput,
          errorMessage: errorObject.message,
          failureType: isTimeoutError(error) ? "timeout" : "error",
          durationMs: performance.now() - startTime,
          isInterrupt: false,
          requestContext,
          options,
        })
      } catch (hookError) {
        logger.warn(ctx, "postToolUseFailure hook execution failed", {
          toolName: config.toolName,
          toolCallId: requestContext.toolCallId,
          error: hookError instanceof Error ? hookError.message : String(hookError),
        })
      }
      throw error
    }
    const durationMs = performance.now() - startTime
    // A tool may report a failure in its result rather than by throwing; the hook is told either way.
    const failureInfo = config.getFailureInfo?.(result)
    if (failureInfo) {
      await executeRemotePostToolUseFailureHook({
        ctx,
        toolName: config.toolName,
        toolInput: actualToolInput,
        errorMessage: failureInfo.errorMessage,
        failureType: failureInfo.failureType,
        durationMs,
        isInterrupt: false,
        requestContext,
        options,
      })
    } else {
      await executeRemotePostToolUseHook({
        ctx,
        toolName: config.toolName,
        toolInput: actualToolInput,
        toolOutput: JSON.stringify(config.createSuccessOutput(toolArgs, result)),
        durationMs,
        requestContext,
        options,
      })
    }
    return result
  }
}
