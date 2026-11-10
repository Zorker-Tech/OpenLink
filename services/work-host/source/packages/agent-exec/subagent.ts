/** Slate's subagent run lifecycle and its observable outcome, independent of the executor wire envelope. */

import type { Context } from "../context/context.ts"
import type { Executor, ExecutorOptions } from "./executor-resources.ts"
import type { RemoteExecManager } from "./executor-resources.ts"
import type { ControlledExecManager, Resource } from "./resource-provider.ts"
import type { SlateTaskAttachmentSelection } from "../agent/tools/task-attachment-contracts.ts"
import type { TaskEnvironment } from "../agent/tools/task-runtime-types.ts"

export const RUNNING_SUBAGENT_FOLLOWUP_ERROR =
  "Sub-agent is currently running. You may send the follow-up message when it has completed."
export const RUNNING_SUBAGENT_INTERRUPT_RETRY_HINT =
  "If you intended to interrupt this agent, you may retry with `interrupt` set to true"

export const SlateSubagentBackgroundReason = {
  UNSPECIFIED: "unspecified",
  AGENT_REQUEST: "agent-request",
  USER_REQUEST: "user-request",
  QUEUED_FOLLOW_UP: "queued-follow-up",
  UNKNOWN: "unknown",
} as const

export type KnownSubagentBackgroundReason =
  (typeof SlateSubagentBackgroundReason)[keyof typeof SlateSubagentBackgroundReason]

/** Exact legacy enum data stays in an explicit migration field, outside Slate's business vocabulary. */
export interface UnrecognizedSubagentBackgroundReason {
  readonly kind: "unrecognized"
  readonly compatibility: {
    readonly legacyCode: number
  }
}

export type SubagentBackgroundReason = KnownSubagentBackgroundReason | UnrecognizedSubagentBackgroundReason

function isInt32(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647
}

export function createUnrecognizedSubagentBackgroundReason(legacyCode: number): UnrecognizedSubagentBackgroundReason {
  if (!isInt32(legacyCode)) throw new TypeError("Legacy subagent background reason code must be a signed 32-bit integer")
  return { kind: "unrecognized", compatibility: { legacyCode } }
}

export function isSubagentBackgroundReason(value: unknown): value is SubagentBackgroundReason {
  if (typeof value === "string") {
    return Object.values(SlateSubagentBackgroundReason).includes(value as KnownSubagentBackgroundReason)
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const reason = value as Record<string, unknown>
  if (Object.keys(reason).some(key => key !== "kind" && key !== "compatibility") || reason.kind !== "unrecognized") return false
  const compatibility = reason.compatibility
  if (compatibility === null || typeof compatibility !== "object" || Array.isArray(compatibility)) return false
  const fields = compatibility as Record<string, unknown>
  return Object.keys(fields).length === 1 && Object.prototype.hasOwnProperty.call(fields, "legacyCode") && isInt32(fields.legacyCode)
}

export interface SubagentContinuationConfig {
  readonly idleThreshold: number
  readonly maxLoops: number
  readonly nudgeMessage: string
  readonly escapeMessageTemplate: string
  readonly collectBackgroundChildren: boolean
  readonly childrenCompletedMessageTemplate: string
}

export interface SubagentModelParameter {
  readonly id: string
  readonly value: string
}

/** The identifiers that make two concurrent requests the same run. */
export interface SubagentExecutionArgs {
  readonly toolCallId?: string
  readonly parentConversationId?: string
  readonly rootParentConversationId?: string
  readonly resumeAgentId?: string
  readonly forkAgentId?: string
  readonly subagentType?: string
  readonly modelId?: string
  readonly prompt?: string
  readonly readonly?: boolean
  readonly interrupt?: boolean
  readonly runInBackground?: boolean
  readonly continuationConfig?: SubagentContinuationConfig
  readonly selectedContext?: SlateTaskAttachmentSelection
  readonly environment?: TaskEnvironment
  readonly cloudBaseBranch?: string
  readonly modelParameters?: readonly SubagentModelParameter[]
}

export type SubagentRunOutcome =
  | { readonly status: "success"; readonly finalMessage?: string; readonly toolCallCount?: number }
  | { readonly status: "error"; readonly error: string }
  | { readonly status: "aborted"; readonly error?: string }
  | {
      readonly status: "background"
      readonly finalMessage?: string
      readonly toolCallCount?: number
      readonly backgroundReason: SubagentBackgroundReason
      readonly transcriptPath?: string
    }

export type SubagentExecutionResult =
  | { readonly status: "error"; readonly agentId?: string; readonly error: string }
  | {
      readonly status: "success"
      readonly agentId: string
      readonly finalMessage?: string
      readonly toolCallCount: number
      readonly backgroundReason?: SubagentBackgroundReason
      readonly transcriptPath?: string
    }

export interface SubagentHostAdapter {
  createOrResumeSession(runContext: Context, args: SubagentExecutionArgs): Promise<string>
  runSession(
    runContext: Context,
    agentId: string,
    args: SubagentExecutionArgs,
    settings: { readonly execId?: string },
  ): Promise<SubagentRunOutcome>
  releaseSession?(agentId: string): void
}

function agentIdFromFailure(failure: unknown): string | undefined {
  if (typeof failure !== "object" || failure === null || !("agentId" in failure)) return undefined
  return typeof failure.agentId === "string" ? failure.agentId : undefined
}

function inFlightKeyOf(args: SubagentExecutionArgs): string | undefined {
  const { toolCallId, parentConversationId } = args
  if (toolCallId == null || toolCallId.length === 0 || parentConversationId == null || parentConversationId.length === 0) {
    return undefined
  }
  return [parentConversationId, toolCallId, args.resumeAgentId ?? "", args.forkAgentId ?? ""].join("\0")
}

function normalizeSubagentBackgroundReason(value: unknown): SubagentBackgroundReason {
  if (typeof value === "string" && isSubagentBackgroundReason(value)) return value
  if (isSubagentBackgroundReason(value) && typeof value !== "string") {
    return createUnrecognizedSubagentBackgroundReason(value.compatibility.legacyCode)
  }
  switch (value) {
    case "agent_request": return SlateSubagentBackgroundReason.AGENT_REQUEST
    case "user_request": return SlateSubagentBackgroundReason.USER_REQUEST
    case "queued_follow_up": return SlateSubagentBackgroundReason.QUEUED_FOLLOW_UP
  }
  if (typeof value === "string") {
    const match = /^unknown-(-?\d+)$/.exec(value)
    if (match !== null) {
      const code = Number(match[1])
      if (isInt32(code)) return createUnrecognizedSubagentBackgroundReason(code)
    }
  }
  return SlateSubagentBackgroundReason.UNKNOWN
}

const MAX_COMPLETED_TOOL_CALL_RESULTS = 1_000

/** Runs, coalesces and caches successful subagent calls by their parent and tool-call identity. */
export function createSubagentExecutor(
  hostAdapter: SubagentHostAdapter,
): Executor<SubagentExecutionArgs, SubagentExecutionResult> {
  const inFlightRuns = new Map<string, Promise<SubagentExecutionResult>>()
  const completedRuns = new Map<string, SubagentExecutionResult>()

  async function executeRun(
    context: Context,
    args: SubagentExecutionArgs,
    settings?: ExecutorOptions,
  ): Promise<SubagentExecutionResult> {
    let agentId: string | undefined
    try {
      agentId = await hostAdapter.createOrResumeSession(context, args)
      const outcome = await hostAdapter.runSession(context, agentId, args, {
        ...(settings?.execId === undefined ? {} : { execId: settings.execId }),
      })
      if (outcome.status === "error") {
        return { status: "error", agentId, error: outcome.error }
      }
      if (outcome.status === "aborted") {
        return { status: "error", agentId, error: outcome.error ?? "Subagent was aborted by the user" }
      }
      return {
        status: "success",
        agentId,
        ...(outcome.finalMessage === undefined ? {} : { finalMessage: outcome.finalMessage }),
        toolCallCount: outcome.toolCallCount ?? 0,
        ...(outcome.status === "background" ? {
          backgroundReason: normalizeSubagentBackgroundReason(outcome.backgroundReason),
          ...(outcome.transcriptPath === undefined ? {} : { transcriptPath: outcome.transcriptPath }),
        } : {}),
      }
    } catch (failure) {
      if (agentId !== undefined) hostAdapter.releaseSession?.(agentId)
      const error = failure instanceof Error ? failure.message : String(failure)
      return {
        status: "error",
        ...(agentId ?? agentIdFromFailure(failure) ?? args.resumeAgentId
          ? { agentId: agentId ?? agentIdFromFailure(failure) ?? args.resumeAgentId }
          : {}),
        error,
      }
    }
  }

  return {
    execute(context, args, settings) {
      const key = inFlightKeyOf(args)
      if (key === undefined) return executeRun(context, args, settings)

      const cached = completedRuns.get(key)
      if (cached !== undefined) return Promise.resolve(cached)

      const running = inFlightRuns.get(key)
      if (running !== undefined) return running

      const run = executeRun(context, args, settings)
        .then(result => {
          if (result.status === "success") {
            completedRuns.set(key, result)
            if (completedRuns.size > MAX_COMPLETED_TOOL_CALL_RESULTS) {
              const oldest = completedRuns.keys().next().value
              if (oldest !== undefined) completedRuns.delete(oldest)
            }
          }
          return result
        })
        .finally(() => inFlightRuns.delete(key))
      inFlightRuns.set(key, run)
      return run
    },
  }
}

/** A turn-local resource; a missing local binding is a composition error, never a wire fallback. */
export const slateSubagentExecutorResource: Resource<
  Executor<SubagentExecutionArgs, SubagentExecutionResult>,
  RemoteExecManager,
  ControlledExecManager
> = Object.freeze({
  symbol: Symbol("slate.exec.resource.local-subagent"),
  remoteImplementation: (_manager: RemoteExecManager) => ({
    async execute(): Promise<SubagentExecutionResult> {
      throw new Error("The Slate subagent executor is only available in its owning turn")
    },
  }),
  registerControlledImplementation: () => {
    throw new Error("The Slate subagent executor is only registered in its owning turn")
  },
})
