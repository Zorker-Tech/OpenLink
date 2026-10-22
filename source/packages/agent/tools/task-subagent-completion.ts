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

/** How far into its run a subagent has got: its turns so far, whether the stream is done, whether it was told to stop. */
export interface TaskSubagentIterationState {
  loopCount: number
  runStreamCompleted: boolean
  subagentStopCalled: boolean
}

/** What is known about a subagent when it finishes, gathered while it ran. */
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

/** What a hook is handed by the runner. */
export type TaskHookContext = Record<string, unknown>

/** What finishing a subagent needs from the runner. */
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

/** What one turn of a subagent answers with: carry on with an action, or stop with a result. */
export interface TaskSubagentIterationResult {
  readonly shouldContinue: boolean
  readonly nextAction?: ConversationAction
  readonly finalResult?: TaskResult
}

/** How long the subagent has been running, measured from the moment it was started. */
function elapsedMs(completion: TaskSubagentCompletionContext): number {
  return Date.now() - completion.executionStartTime
}

/** The text of an error the subagent run raised, whatever shape it came in. */
function errorTextOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The request a stop hook is called with, from what the caller already had. */
function subagentStopRequest(args: TaskHookContext & {
  readonly status: "completed" | "error"
  readonly durationMs: number
  readonly messageCount: number
  readonly toolCallCount: number
  readonly summary?: string
  readonly errorMessage?: string
  readonly loopCount: number
  readonly task: string
  readonly description: string
}): Parameters<typeof executeRemoteSubagentStopHook>[0] {
  return {
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
  } as Parameters<typeof executeRemoteSubagentStopHook>[0]
}

/** The stop hook's answer when it may be followed up on, and nothing otherwise. */
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
    const result = await executeRemoteSubagentStopHook(subagentStopRequest(args))
    const followupMessage = result.followupMessage
    // A hook that runs after a failure has nothing to continue, so only a completed stop may follow up.
    return args.status === "completed" && typeof followupMessage === "string" ? followupMessage : undefined
  } catch {
    return undefined
  }
}

/** The action that turns a follow-up message into another turn of the same subagent. */
export function buildFollowupAction(request: {
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
          text: request.followupMessage,
          // The id is derived from the call and the turn it belongs to, so a retry produces the same one.
          messageId: generateSeededUuid(`${request.toolCallId}-followup-${request.loopCount}`),
          mode: request.useAskMode ? AgentMode.ASK : AgentMode.AGENT,
          ...(request.selectedContext !== undefined ? { selectedContext: request.selectedContext } : {}),
        }),
      }),
    },
  })
}

/** The request the post-tool-use hook is called with after a successful run. */
function postToolUseRequest(
  completion: TaskSubagentCompletionContext,
  dependencies: TaskSubagentCompletionDependencies,
  durationMs: number,
  messageCount: number,
  toolCallCount: number,
): Parameters<typeof executeRemotePostToolUseHook>[0] {
  return {
    ctx: dependencies.ctx,
    toolName: dependencies.toolName,
    toolInput: dependencies.postToolUseHookInput,
    toolOutput: JSON.stringify({
      status: "success",
      agentId: completion.subagentId,
      durationMs,
      messageCount,
      toolCallCount,
    }),
    durationMs,
    requestContext: {
      toolCallId: completion.toolCallId,
      model: completion.overriddenModelId,
    },
    options: {
      resourceAccessor: dependencies.hookContext.resourceAccessor,
      enableExecuteHookExec: dependencies.enableTaskToolHooksExec,
      configuredSteps: dependencies.configuredSteps,
    },
  } as Parameters<typeof executeRemotePostToolUseHook>[0]
}

/** The success result a completed subagent produces from the turns it added. */
function successResult(
  completion: TaskSubagentCompletionContext,
  conversationSteps: TaskSuccess["conversationSteps"],
  durationMs: number,
): TaskResult {
  return new TaskResult({
    result: {
      case: "success",
      value: new TaskSuccess({
        conversationSteps,
        agentId: completion.subagentId,
        durationMs: BigInt(durationMs),
        ...(completion.resultSuffix !== undefined ? { resultSuffix: completion.resultSuffix } : {}),
      }),
    },
  })
}

/** Finishes a subagent that ended successfully: collects its work, cleans it up, reports it and answers with the result. */
async function buildFinalResult(
  currentState: ConversationStateStructure,
  completion: TaskSubagentCompletionContext,
  dependencies: TaskSubagentCompletionDependencies,
): Promise<TaskSubagentIterationResult> {
  const allNewTurns = currentState.turns.slice(completion.initialTurnsCount)
  const { conversationSteps: allConversationSteps, toolCallCount: finalToolCallCount } =
    await collectConversationStepsWithToolCallCount(dependencies.ctx, allNewTurns, dependencies.blobStore)
  const finalDurationMs = elapsedMs(completion)
  dependencies.registry.cleanup(completion.subagentId)
  if (dependencies.enableTaskToolHooksExec) {
    try {
      await executeRemotePostToolUseHook(
        postToolUseRequest(completion, dependencies, finalDurationMs, allNewTurns.length, finalToolCallCount),
      )
    } catch {
      // This hook observes the call; a hook that cannot run does not make the call fail.
    }
  }
  return {
    shouldContinue: false,
    finalResult: successResult(completion, allConversationSteps, finalDurationMs),
  }
}

/**
 * One turn of a subagent came back. Its state is saved before anything else, because a subagent that
 * cannot be resumed is worse than one whose stop hook failed.
 */
export async function processSubagentIterationSuccess(
  currentState: ConversationStateStructure,
  turnsAtStartOfIteration: number,
  iteration: TaskSubagentIterationState,
  completion: TaskSubagentCompletionContext,
  dependencies: TaskSubagentCompletionDependencies,
  persistState: (
    ctx: Context,
    subagentId: string,
    subagentType: SubagentType,
    persistedState: SubagentPersistedState,
  ) => void,
  subagentType: SubagentType,
): Promise<TaskSubagentIterationResult> {
  persistState(
    dependencies.ctx,
    completion.subagentId,
    subagentType,
    new SubagentPersistedState({
      conversationState: currentState,
      modelId: completion.overriddenModelId,
    }),
  )
  const newTurns = currentState.turns.slice(turnsAtStartOfIteration)
  const lastAssistant = await extractLastAssistantMessage(dependencies.ctx, newTurns, dependencies.blobStore)
  const toolCallCount = await countToolCallsFromTurns(dependencies.ctx, newTurns, dependencies.blobStore)
  const followupMessage = await executeSubagentStopHook({
    ...dependencies.hookContext,
    status: "completed",
    durationMs: elapsedMs(completion),
    messageCount: currentState.turns.length,
    toolCallCount,
    ...(lastAssistant !== undefined ? { summary: lastAssistant } : {}),
    loopCount: iteration.loopCount,
    task: completion.rawArgsPrompt,
    description: completion.rawArgsDescription,
  })
  iteration.subagentStopCalled = true
  if (followupMessage !== undefined && followupMessage.length > 0) {
    iteration.loopCount += 1
    return {
      shouldContinue: true,
      nextAction: buildFollowupAction({
        followupMessage,
        toolCallId: completion.toolCallId,
        loopCount: iteration.loopCount,
        useAskMode: completion.useAskModeForSubagent,
        ...(completion.selectedContext !== undefined ? { selectedContext: completion.selectedContext } : {}),
      }),
    }
  }
  return buildFinalResult(currentState, completion, dependencies)
}

/** The run stream failed: the subagent is told it stopped, and the failure is passed on unchanged. */
export async function handleSubagentRunStreamError(
  runStreamError: unknown,
  currentState: ConversationStateStructure,
  iteration: TaskSubagentIterationState,
  completion: TaskSubagentCompletionContext,
  dependencies: TaskSubagentCompletionDependencies,
  _subagentCtxCanceled: boolean,
  _abortOptions: unknown,
): Promise<never> {
  await executeSubagentStopHook({
    ...dependencies.hookContext,
    status: "error",
    durationMs: elapsedMs(completion),
    messageCount: currentState.turns.length,
    toolCallCount: 0,
    errorMessage: errorTextOf(runStreamError),
    loopCount: iteration.loopCount,
    task: completion.rawArgsPrompt,
    description: completion.rawArgsDescription,
  })
  iteration.subagentStopCalled = true
  throw runStreamError
}

/** Execution failed before there was a state to report, so the hook only runs when there is one. */
export async function handleSubagentExecutionError(
  error: unknown,
  state: ConversationStateStructure | undefined,
  iteration: TaskSubagentIterationState,
  completion: TaskSubagentCompletionContext,
  dependencies: TaskSubagentCompletionDependencies,
  _subagentCtxCanceled: boolean,
  _abortOptions: unknown,
): Promise<never> {
  dependencies.registry.cleanup(completion.subagentId)
  if (state !== undefined) {
    await executeSubagentStopHook({
      ...dependencies.hookContext,
      status: "error",
      durationMs: elapsedMs(completion),
      messageCount: state.turns.length,
      toolCallCount: 0,
      errorMessage: errorTextOf(error),
      loopCount: iteration.loopCount,
      task: completion.rawArgsPrompt,
      description: completion.rawArgsDescription,
    })
  }
  throw error
}
