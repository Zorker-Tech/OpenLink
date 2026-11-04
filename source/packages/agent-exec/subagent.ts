/** Slate's subagent run lifecycle and its observable outcome, independent of the executor wire envelope. */

import type { Context } from "../context/context.ts"
import type { Executor, ExecutorOptions } from "./executor-resources.ts"

export const RUNNING_SUBAGENT_FOLLOWUP_ERROR =
  "Sub-agent is currently running. You may send the follow-up message when it has completed."
export const RUNNING_SUBAGENT_INTERRUPT_RETRY_HINT =
  "If you intended to interrupt this agent, you may retry with `interrupt` set to true"

export type SubagentBackgroundReason =
  | "unspecified"
  | "agent_request"
  | "user_request"
  | "queued_follow_up"

/** The identifiers that make two concurrent requests the same run. */
export interface SubagentExecutionArgs {
  readonly toolCallId?: string
  readonly parentConversationId?: string
  readonly resumeAgentId?: string
  readonly forkAgentId?: string
  readonly subagentType?: string
  readonly prompt?: string
  readonly readonly?: boolean
  readonly selectedContext?: { readonly selectedVideos?: readonly unknown[] }
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
          backgroundReason: outcome.backgroundReason,
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
