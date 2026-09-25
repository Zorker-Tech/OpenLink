/**
 * What happens when a subagent stops.
 *
 * A subagent finishes in one of three ways and each has to leave the platform in a state it can trust: it
 * succeeded, its run stream failed, or its execution failed outright. In every case the subagent's own
 * stop hook runs first — that hook is the only place a caller can react to a subagent ending, and it may
 * answer with a follow-up message, which turns the completion into another turn rather than the end of
 * the task. Only a successful stop may ask for that follow-up: a failure is reported as a failure rather
 * than continued, and a hook that itself fails is swallowed, because a hook that cannot run must not be
 * the reason a finished subagent looks unfinished.
 *
 * The result a successful subagent produces is assembled from its own conversation, which is stored as
 * blobs: the steps it took are collected and handed back so the parent can show them, the tool calls are
 * counted, and how long it ran is measured from when it was started. The subagent is also dropped from the
 * registry here, so nothing keeps a handle on a run that is over, and the post-tool-use hook runs last
 * with the outcome as its input.
 */

import {
  AgentMode,
  ConversationAction,
  SubagentPersistedState,
  TaskResult,
  TaskSuccess,
  UserMessage,
  UserMessageAction,
  type ConversationStateStructure,
} from "../../proto/generated/agent/v1/agent_pb.ts"
import type { SelectedContext } from "../../proto/generated/agent/v1/selected_context_pb.ts"
import type { Context } from "../../context/context.ts"
import {
  collectConversationStepsWithToolCallCount,
  countToolCallsFromTurns,
  extractLastAssistantMessage,
  type ConversationBlobStore,
} from "./task-runtime.ts"
import { generateSeededUuid } from "./tool-support.ts"
import { executeRemotePostToolUseHook, executeRemoteSubagentStopHook } from "./remote-hooks.ts"
import type { SubagentType } from "../../proto/generated/agent/v1/subagents_pb.ts"

export interface TaskSubagentIterationState {
  loopCount: number
  runStreamCompleted: boolean
  subagentStopCalled: boolean
}

export interface TaskSubagentCompletionContext {
  readonly subagentId: string
  readonly subagentRequestId: string
  readonly toolCallId: string
  readonly typeName: string
  readonly analyticsSubagentType: string
  readonly overriddenModelId: string
  readonly effectiveReadonly: boolean
  readonly useAskModeForSubagent: boolean
  readonly initialTurnsCount: number
  readonly executionStartTime: number
  readonly isParallel: boolean
  readonly parentModelName: string
  readonly resultSuffix?: string
  readonly selectedContext?: SelectedContext
  readonly plugin?: string
  readonly marketplace?: string
  readonly pluginId?: string
  readonly marketplaceId?: string
  readonly rawArgsPrompt: string
  readonly rawArgsDescription: string
}

export type TaskHookContext = Record<string, unknown>

export interface TaskSubagentCompletionDependencies {
  readonly ctx: Context
  readonly blobStore: ConversationBlobStore
  readonly registry: { cleanup(subagentId: string): void }
  readonly hookContext: TaskHookContext
  readonly enableTaskToolHooksExec: boolean
  readonly configuredSteps: readonly unknown[]
  readonly toolName: string
  readonly postToolUseHookInput: unknown
}

export interface TaskSubagentIterationResult {
  readonly shouldContinue: boolean
  readonly nextAction?: ConversationAction
  readonly finalResult?: TaskResult
}

/** The subagent's own stop hook, which may answer with something for it to do next. */
export async function executeSubagentStopHook(args: TaskHookContext & {
  readonly status: "completed" | "error"
  readonly durationMs: number
  readonly messageCount: number
  readonly toolCallCount: number
  readonly summary?: string
  readonly errorMessage?: string
  readonly loopCount: number
  readonly task: string
  readonly description: string
}): Promise<string | undefined> {
  try {
    const result = await executeRemoteSubagentStopHook({
      ...args,
      requestContext: {
        toolCallId: args.toolCallId,
        model: args.overriddenModelId,
      },
      options: {
        resourceAccessor: args.resourceAccessor,
        enableExecuteHookExec: args.enableExecuteHookExec,
        configuredSteps: args.configuredSteps,
      },
    })
    const followupMessage = result.followupMessage
    // A hook that runs after a failure has nothing to continue, so only a completed stop may follow up.
    return args.status === "completed" && typeof followupMessage === "string"
      ? followupMessage
      : undefined
  } catch {
    return undefined
  }
}

export function buildFollowupAction(args: {
  readonly followupMessage: string
  readonly toolCallId: string
  readonly loopCount: number
  readonly useAskMode: boolean
  readonly selectedContext?: SelectedContext
}): ConversationAction {
  return new ConversationAction({
    action: {
      case: "userMessageAction",
      value: new UserMessageAction({
        userMessage: new UserMessage({
          text: args.followupMessage,
          // The id is derived from the call and the turn it belongs to, so a retry produces the same one.
          messageId: generateSeededUuid(`${args.toolCallId}-followup-${args.loopCount}`),
          mode: args.useAskMode ? AgentMode.ASK : AgentMode.AGENT,
          ...(args.selectedContext !== undefined
            ? { selectedContext: args.selectedContext }
            : {}),
        }),
      }),
    },
  })
}

async function buildFinalResult(
  currentState: ConversationStateStructure,
  completionCtx: TaskSubagentCompletionContext,
  deps: TaskSubagentCompletionDependencies,
): Promise<TaskSubagentIterationResult> {
  const allNewTurns = currentState.turns.slice(completionCtx.initialTurnsCount)
  const { conversationSteps: allConversationSteps, toolCallCount: finalToolCallCount } =
    await collectConversationStepsWithToolCallCount(deps.ctx, allNewTurns, deps.blobStore)
  const finalDurationMs = Date.now() - completionCtx.executionStartTime
  deps.registry.cleanup(completionCtx.subagentId)
  if (deps.enableTaskToolHooksExec) {
    try {
      await executeRemotePostToolUseHook({
        ctx: deps.ctx,
        toolName: deps.toolName,
        toolInput: deps.postToolUseHookInput,
        toolOutput: JSON.stringify({
          status: "success",
          agentId: completionCtx.subagentId,
          durationMs: finalDurationMs,
          messageCount: allNewTurns.length,
          toolCallCount: finalToolCallCount,
        }),
        durationMs: finalDurationMs,
        requestContext: {
          toolCallId: completionCtx.toolCallId,
          model: completionCtx.overriddenModelId,
        },
        options: {
          resourceAccessor: deps.hookContext.resourceAccessor,
          enableExecuteHookExec: deps.enableTaskToolHooksExec,
          configuredSteps: deps.configuredSteps,
        },
      })
    } catch {
      // This hook observes the call; a hook that cannot run does not make the call fail.
    }
  }
  return {
    shouldContinue: false,
    finalResult: new TaskResult({
      result: {
        case: "success",
        value: new TaskSuccess({
          conversationSteps: allConversationSteps,
          agentId: completionCtx.subagentId,
          durationMs: BigInt(finalDurationMs),
          ...(completionCtx.resultSuffix !== undefined
            ? { resultSuffix: completionCtx.resultSuffix }
            : {}),
        }),
      },
    }),
  }
}

/**
 * One turn of a subagent came back. Its state is saved before anything else, because a subagent that
 * cannot be resumed is worse than one whose stop hook failed.
 */
export async function processSubagentIterationSuccess(
  currentState: ConversationStateStructure,
  turnsAtStartOfIteration: number,
  iterState: TaskSubagentIterationState,
  completionCtx: TaskSubagentCompletionContext,
  deps: TaskSubagentCompletionDependencies,
  persistState: (
    ctx: Context,
    subagentId: string,
    subagentType: SubagentType,
    persistedState: SubagentPersistedState,
  ) => void,
  subagentType: SubagentType,
): Promise<TaskSubagentIterationResult> {
  persistState(
    deps.ctx,
    completionCtx.subagentId,
    subagentType,
    new SubagentPersistedState({
      conversationState: currentState,
      modelId: completionCtx.overriddenModelId,
    }),
  )
  const newTurns = currentState.turns.slice(turnsAtStartOfIteration)
  const lastAssistant = await extractLastAssistantMessage(
    deps.ctx,
    newTurns,
    deps.blobStore,
  )
  const toolCallCount = await countToolCallsFromTurns(deps.ctx, newTurns, deps.blobStore)
  const followupMessage = await executeSubagentStopHook({
    ...deps.hookContext,
    status: "completed",
    durationMs: Date.now() - completionCtx.executionStartTime,
    messageCount: currentState.turns.length,
    toolCallCount,
    ...(lastAssistant !== undefined ? { summary: lastAssistant } : {}),
    loopCount: iterState.loopCount,
    task: completionCtx.rawArgsPrompt,
    description: completionCtx.rawArgsDescription,
  })
  iterState.subagentStopCalled = true
  if (followupMessage !== undefined && followupMessage.length > 0) {
    iterState.loopCount += 1
    return {
      shouldContinue: true,
      nextAction: buildFollowupAction({
        followupMessage,
        toolCallId: completionCtx.toolCallId,
        loopCount: iterState.loopCount,
        useAskMode: completionCtx.useAskModeForSubagent,
        ...(completionCtx.selectedContext !== undefined
          ? { selectedContext: completionCtx.selectedContext }
          : {}),
      }),
    }
  }
  return buildFinalResult(currentState, completionCtx, deps)
}

/** The run stream failed: the subagent is told it stopped, and the failure is passed on unchanged. */
export async function handleSubagentRunStreamError(
  runStreamError: unknown,
  currentState: ConversationStateStructure,
  iterState: TaskSubagentIterationState,
  completionCtx: TaskSubagentCompletionContext,
  deps: TaskSubagentCompletionDependencies,
  _subagentCtxCanceled: boolean,
  _abortOptions: unknown,
): Promise<never> {
  await executeSubagentStopHook({
    ...deps.hookContext,
    status: "error",
    durationMs: Date.now() - completionCtx.executionStartTime,
    messageCount: currentState.turns.length,
    toolCallCount: 0,
    errorMessage: runStreamError instanceof Error ? runStreamError.message : String(runStreamError),
    loopCount: iterState.loopCount,
    task: completionCtx.rawArgsPrompt,
    description: completionCtx.rawArgsDescription,
  })
  iterState.subagentStopCalled = true
  throw runStreamError
}

/** Execution failed before there was a state to report, so the hook only runs when there is one. */
export async function handleSubagentExecutionError(
  error: unknown,
  state: ConversationStateStructure | undefined,
  _iterState: TaskSubagentIterationState,
  completionCtx: TaskSubagentCompletionContext,
  deps: TaskSubagentCompletionDependencies,
  _subagentCtxCanceled: boolean,
  _abortOptions: unknown,
): Promise<never> {
  deps.registry.cleanup(completionCtx.subagentId)
  if (state !== undefined) {
    await executeSubagentStopHook({
      ...deps.hookContext,
      status: "error",
      durationMs: Date.now() - completionCtx.executionStartTime,
      messageCount: state.turns.length,
      toolCallCount: 0,
      errorMessage: error instanceof Error ? error.message : String(error),
      loopCount: _iterState.loopCount,
      task: completionCtx.rawArgsPrompt,
      description: completionCtx.rawArgsDescription,
    })
  }
  throw error
}
