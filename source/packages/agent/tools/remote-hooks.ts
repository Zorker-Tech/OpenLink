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

type HookWire = Record<string, any>

const hookDurationMetric = createHistogram("remote_hook.duration_ms", {
  description: "Duration of remote hook execution in milliseconds",
  labelNames: ["hook_type", "outcome"],
})
const hookCountMetric = createCounter("remote_hook.count", {
  description: "Count of remote hook executions",
  labelNames: ["hook_type", "outcome"],
})

function recordHookMetrics(ctx: Context, durationMs: number, hookType: string, outcome: string): void {
  hookDurationMetric.histogram(ctx, durationMs, { hook_type: hookType, outcome })
  hookCountMetric.increment(ctx, 1, { hook_type: hookType, outcome })
}

function didHookTimeOut(error: unknown): boolean {
  return error instanceof Error &&
    (error.message.toLowerCase().includes("timed out") || error.message.toLowerCase().includes("timeout"))
}

/** The model a hook is told about: the call's own choice when it made one, the session's otherwise. */
function hookModelFields(requestContext: HookWire, options: HookWire): HookWire {
  const modelId = requestContext.modelId ?? options.modelId
  const modelParams = requestContext.modelParams ?? options.modelParams
  return {
    ...(modelId !== undefined && { modelId }),
    ...(modelParams !== undefined && modelParams.length > 0
      ? { modelParams: modelParams.map((parameter: HookWire) => new RequestedModel_ModelParameterValue(parameter)) }
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

function isToolTimeout(error: unknown): boolean {
  return error instanceof ToolTimeoutError || (error instanceof Error && error.name === "TimeoutError")
}

/** A struct carries JSON, and a value that is not JSON cannot be sent: this is where that is decided. */
function structJsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value))
}

function hookExecutorFor(options: HookWire, hookStep: string): HookWire | undefined {
  if (!options.enableExecuteHookExec || !isHookStepConfigured(options.configuredSteps, hookStep)) return undefined
  return options.resourceAccessor.get(hookExecutorResource)
}

/** A hook is told which conversation and which request it is answering, even when the call is bare. */
function requestIdsFor(ctx: Context, requestContext: HookWire): { conversationId: string; generationId: string } {
  return {
    conversationId: requestContext.conversationId ?? getConversationId(ctx) ?? requestContext.toolCallId,
    generationId: requestContext.generationId ?? getRequestId(ctx) ?? requestContext.toolCallId,
  }
}

function requirePreToolPermission(toolName: string, hookAnswer: HookWire): HookWire {
  if (hookAnswer.permission === "deny") {
    const reason = hookAnswer.userMessage
      ? `${toolName} blocked by preToolUse hook: ${hookAnswer.userMessage}`
      : `${toolName} blocked by preToolUse hook`
    throw new RemoteHookBlockedError(reason, reason)
  }
  if (hookAnswer.permission === "ask") {
    const reason = "The 'ask' permission for preToolUse hooks is not yet implemented. Use 'allow' or 'deny' instead."
    throw new RemoteHookBlockedError(reason, reason)
  }
  return hookAnswer
}


/** Milliseconds since a hook call started, rounded the way the durations are reported. */
function elapsedSince(startedAt: number): number {
  return Math.round(performance.now() - startedAt)
}

/** A failed hook call as the reporting needs it: how long it took and whether it timed out. */
function hookCallFailure(startedAt: number, error: unknown): { durationMs: number; timedOut: boolean } {
  return { durationMs: elapsedSince(startedAt), timedOut: didHookTimeOut(error) }
}

/** What one hook call needs before it is made: the executor, and the ids it answers under. */
function prepareHookCall(
  ctx: Context,
  options: HookWire,
  hookStep: string,
  requestContext: HookWire,
): { hookExecutor: HookWire; conversationId: string; generationId: string } | undefined {
  const hookExecutor = hookExecutorFor(options, hookStep)
  if (hookExecutor === undefined) return undefined
  return { hookExecutor, ...requestIdsFor(ctx, requestContext) }
}

function track(ctx: Context, event: HookWire): void {
  getAgentEventTracker(ctx).trackHookExecuted(ctx, event)
}

/** Context a hook returned, or nothing if it returned more than a carrier may hold. */
function hookContextCarriers(
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
export async function executeRemoteAfterAgentThoughtHook(call: HookWire): Promise<void> {
  const { ctx, text, durationMs: thoughtDurationMs, requestContext, options } = call
  const hook = prepareHookCall(ctx, options, "afterAgentThought", requestContext)
  if (hook === undefined) return
  const { hookExecutor, conversationId, generationId } = hook
  const startedAt = performance.now()
  try {
    const hookCall = new ExecuteHookArgs({
      request: new ExecuteHookRequest({
        request: {
          case: "afterAgentThought",
          value: new AfterAgentThoughtRequestQuery({
            text,
            ...(thoughtDurationMs !== undefined ? { durationMs: BigInt(thoughtDurationMs) } : {}),
            conversationId,
            generationId,
            model: requestContext.model ?? options.model,
            ...hookModelFields(requestContext, options),
          }),
        },
      }),
    })
    await hookExecutor.execute(ctx, hookCall)
    const durationMs = elapsedSince(startedAt)
    recordHookMetrics(ctx, durationMs, "afterAgentThought", "success")
    track(ctx, {
      hookStep: "afterAgentThought",
      hookSource: "remote",
      hookType: "afterAgentThought",
      status: "success",
      latencyMs: durationMs,
      failClosed: false,
    })
  } catch (error) {
    const { durationMs, timedOut } = hookCallFailure(startedAt, error)
    recordHookMetrics(ctx, durationMs, "afterAgentThought", "failure")
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

export async function executeRemoteSubagentStartHook(call: HookWire): Promise<HookWire> {
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
  } = call
  const hook = prepareHookCall(ctx, options, "subagentStart", requestContext)
  if (hook === undefined) return {}
  const { hookExecutor, conversationId, generationId } = hook
  const parentConversationId = providedParentConversationId ?? conversationId
  logger.info(ctx, "subagentStart hook firing", { subagentId, subagentType, toolCallId: requestContext.toolCallId })
  const startedAt = performance.now()
  try {
    const hookCall = new ExecuteHookArgs({
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
            ...hookModelFields(requestContext, options),
          }),
        },
      }),
    })
    const hookAnswer = await hookExecutor.execute(ctx, hookCall)
    const durationMs = elapsedSince(startedAt)
    if (hookAnswer.response?.response.case !== "subagentStart") {
      logger.warn(ctx, "subagentStart hook returned unexpected response", {
        subagentId,
        subagentType,
        toolCallId: requestContext.toolCallId,
        responseCase: hookAnswer.response?.response.case,
        durationMs,
      })
      recordHookMetrics(ctx, durationMs, "subagentStart", "failure")
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
    const response = hookAnswer.response.response.value
    const blocked = response.permission === "deny" || response.permission === "ask"
    recordHookMetrics(ctx, durationMs, "subagentStart", "success")
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
    const { durationMs, timedOut } = hookCallFailure(startedAt, error)
    recordHookMetrics(ctx, durationMs, "subagentStart", "failure")
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

export async function executeRemoteSubagentStopHook(call: HookWire): Promise<HookWire> {
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
  } = call
  const hook = prepareHookCall(ctx, options, "subagentStop", requestContext)
  if (hook === undefined) return {}
  const { hookExecutor, conversationId, generationId } = hook
  const parentConversationId = suppliedParent ?? conversationId
  logger.info(ctx, "subagentStop hook firing", {
    subagentId,
    subagentType,
    toolCallId: requestContext.toolCallId,
    status,
  })
  const startedAt = performance.now()
  try {
    const hookCall = new ExecuteHookArgs({
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
            ...hookModelFields(requestContext, options),
            loopCount,
            task,
            description,
          }),
        },
      }),
    })
    const hookAnswer = await hookExecutor.execute(ctx, hookCall)
    const durationMs = elapsedSince(startedAt)
    if (hookAnswer.response?.response.case !== "subagentStop") {
      logger.warn(ctx, "subagentStop hook returned unexpected response", {
        subagentId,
        subagentType,
        toolCallId: requestContext.toolCallId,
        responseCase: hookAnswer.response?.response.case,
        durationMs,
      })
      recordHookMetrics(ctx, durationMs, "subagentStop", "failure")
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
    const response = hookAnswer.response.response.value
    recordHookMetrics(ctx, durationMs, "subagentStop", "success")
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
    const { durationMs, timedOut } = hookCallFailure(startedAt, error)
    recordHookMetrics(ctx, durationMs, "subagentStop", "failure")
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
export async function executeRemotePreToolUseHookWithPermissionCheck(call: HookWire): Promise<HookWire> {
  return requirePreToolPermission(call.toolName, await executeRemotePreToolUseHook(call))
}

async function executeRemotePreToolUseHook(call: HookWire): Promise<HookWire> {
  const { ctx, toolName, toolInput, requestContext, options } = call
  const hook = prepareHookCall(ctx, options, "preToolUse", requestContext)
  if (hook === undefined) return {}
  const { hookExecutor, conversationId, generationId } = hook
  logger.info(ctx, "preToolUse hook firing", { toolName, toolCallId: requestContext.toolCallId })
  const startedAt = performance.now()
  try {
    const hookCall = new ExecuteHookArgs({
      request: new ExecuteHookRequest({
        request: {
          case: "preToolUse",
          value: new PreToolUseRequestQuery({
            toolName,
            toolInput: Struct.fromJson(structJsonValue(toolInput) as any),
            toolUseId: requestContext.toolCallId,
            conversationId,
            generationId,
            model: requestContext.model ?? options.model,
            ...hookModelFields(requestContext, options),
          }),
        },
      }),
    })
    const hookAnswer = await hookExecutor.execute(ctx, hookCall)
    const durationMs = elapsedSince(startedAt)
    if (hookAnswer.response?.response.case === "preToolUse") {
      const response = hookAnswer.response.response.value
      let updatedInput: unknown
      if (response.updatedInput) {
        try {
          updatedInput = JSON.parse(response.updatedInput)
        } catch {
          logger.warn(ctx, "Failed to parse preToolUse updatedInput", { toolName, toolCallId: requestContext.toolCallId })
        }
      }
      const contexts = hookContextCarriers(ctx, toolName, requestContext.toolCallId, HookStep.preToolUse, response.additionalContext)
      appendHookAdditionalContexts(options.hookContextCollector, contexts)
      recordHookMetrics(ctx, durationMs, "preToolUse", "success")
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
    recordHookMetrics(ctx, durationMs, "preToolUse", "success")
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
    const { durationMs, timedOut } = hookCallFailure(startedAt, error)
    recordHookMetrics(ctx, durationMs, "preToolUse", "failure")
    // A hook that cannot be evaluated blocks when it is configured to fail closed, and only then.
    const failClosed = hookExecutor.hasFailClosedHooksForStep?.("preToolUse", toolName) ?? false
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
export async function executeRemotePostToolUseHook(call: HookWire): Promise<any[]> {
  const { ctx, toolName, toolInput, toolOutput, durationMs: toolDurationMs, requestContext, options } = call
  const hook = prepareHookCall(ctx, options, "postToolUse", requestContext)
  if (hook === undefined) return []
  const { hookExecutor, conversationId, generationId } = hook
  const startedAt = performance.now()
  logger.info(ctx, "postToolUse hook firing", { toolName, toolCallId: requestContext.toolCallId })
  const hookCall = new ExecuteHookArgs({
    request: new ExecuteHookRequest({
      request: {
        case: "postToolUse",
        value: new PostToolUseRequestQuery({
          toolName,
          toolInput: Struct.fromJson(structJsonValue(toolInput) as any),
          toolOutput,
          durationMs: BigInt(Math.round(toolDurationMs)),
          toolUseId: requestContext.toolCallId,
          conversationId,
          generationId,
          model: requestContext.model ?? options.model,
          ...hookModelFields(requestContext, options),
        }),
      },
    }),
  })
  try {
    const hookAnswer = await hookExecutor.execute(ctx, hookCall)
    const durationMs = elapsedSince(startedAt)
    const contexts = hookAnswer.response?.response.case === "postToolUse"
      ? hookContextCarriers(ctx, toolName, requestContext.toolCallId, HookStep.postToolUse, hookAnswer.response.response.value.additionalContext)
      : []
    appendHookAdditionalContexts(options.hookContextCollector, contexts)
    recordHookMetrics(ctx, durationMs, "postToolUse", "success")
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
    const { durationMs, timedOut } = hookCallFailure(startedAt, error)
    const failClosed = hookExecutor.hasFailClosedHooksForStep?.("postToolUse", toolName) ?? false
    recordHookMetrics(ctx, durationMs, "postToolUse", "failure")
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

export async function executeRemotePostToolUseFailureHook(call: HookWire): Promise<any[]> {
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
  } = call
  const hook = prepareHookCall(ctx, options, "postToolUseFailure", requestContext)
  if (hook === undefined) return []
  const { hookExecutor, conversationId, generationId } = hook
  const startedAt = performance.now()
  logger.info(ctx, "postToolUseFailure hook firing", { toolName, toolCallId: requestContext.toolCallId, failureType })
  const hookCall = new ExecuteHookArgs({
    request: new ExecuteHookRequest({
      request: {
        case: "postToolUseFailure",
        value: new PostToolUseFailureRequestQuery({
          toolName,
          toolInput: Struct.fromJson(structJsonValue(toolInput) as any),
          errorMessage,
          failureType,
          durationMs: BigInt(Math.round(toolDurationMs)),
          toolUseId: requestContext.toolCallId,
          isInterrupt,
          conversationId,
          generationId,
          model: requestContext.model ?? options.model,
          ...hookModelFields(requestContext, options),
        }),
      },
    }),
  })
  try {
    const hookAnswer = await hookExecutor.execute(ctx, hookCall)
    const durationMs = elapsedSince(startedAt)
    const contexts = hookAnswer.response?.response.case === "postToolUseFailure"
      ? hookContextCarriers(ctx, toolName, requestContext.toolCallId, HookStep.postToolUseFailure, hookAnswer.response.response.value.additionalContext)
      : []
    appendHookAdditionalContexts(options.hookContextCollector, contexts)
    recordHookMetrics(ctx, durationMs, "postToolUseFailure", "success")
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
    const { durationMs, timedOut } = hookCallFailure(startedAt, error)
    const failClosed = hookExecutor.hasFailClosedHooksForStep?.("postToolUseFailure", toolName) ?? false
    recordHookMetrics(ctx, durationMs, "postToolUseFailure", "failure")
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
export function withRemoteHooks(call: HookWire): (ctx: Context, rawToolArgs: HookWire) => Promise<unknown> {
  const { executeFn: executeTool, config: toolConfig, requestContext, options } = call
  return async (ctx, rawToolArgs) => {
    const startedAt = performance.now()
    const toolInput = toolConfig.createToolInput(rawToolArgs)
    const preCallDecision = await executeRemotePreToolUseHook({ ctx, toolName: toolConfig.toolName, toolInput, requestContext, options })
    if (preCallDecision.permission === "deny") {
      return toolConfig.createRejectedResult(rawToolArgs, preCallDecision.userMessage ?? `${toolConfig.toolName} denied by hook`)
    }
    if (preCallDecision.permission === "ask") {
      return toolConfig.createRejectedResult(rawToolArgs, "The 'ask' permission for preToolUse hooks is not yet implemented")
    }
    let effectiveToolInput = toolInput
    if (preCallDecision.updatedInput && toolConfig.applyUpdatedInput) {
      toolConfig.applyUpdatedInput(rawToolArgs, preCallDecision.updatedInput)
      effectiveToolInput = toolConfig.createToolInput(rawToolArgs)
    }
    let hookAnswer: unknown
    try {
      hookAnswer = await executeTool(ctx, rawToolArgs)
    } catch (error) {
      const toolError = error instanceof Error ? error : new Error(String(error))
      try {
        await executeRemotePostToolUseFailureHook({
          ctx,
          toolName: toolConfig.toolName,
          toolInput: effectiveToolInput,
          errorMessage: toolError.message,
          failureType: isToolTimeout(error) ? "timeout" : "error",
          durationMs: performance.now() - startedAt,
          isInterrupt: false,
          requestContext,
          options,
        })
      } catch (hookError) {
        logger.warn(ctx, "postToolUseFailure hook execution failed", {
          toolName: toolConfig.toolName,
          toolCallId: requestContext.toolCallId,
          error: hookError instanceof Error ? hookError.message : String(hookError),
        })
      }
      throw error
    }
    const durationMs = performance.now() - startedAt
    // A tool may report a failure in its hookAnswer rather than by throwing; the hook is told either way.
    const reportedFailure = toolConfig.getFailureInfo?.(hookAnswer)
    if (reportedFailure) {
      await executeRemotePostToolUseFailureHook({
        ctx,
        toolName: toolConfig.toolName,
        toolInput: effectiveToolInput,
        errorMessage: reportedFailure.errorMessage,
        failureType: reportedFailure.failureType,
        durationMs,
        isInterrupt: false,
        requestContext,
        options,
      })
    } else {
      await executeRemotePostToolUseHook({
        ctx,
        toolName: toolConfig.toolName,
        toolInput: effectiveToolInput,
        toolOutput: JSON.stringify(toolConfig.createSuccessOutput(rawToolArgs, hookAnswer)),
        durationMs,
        requestContext,
        options,
      })
    }
    return hookAnswer
  }
}
