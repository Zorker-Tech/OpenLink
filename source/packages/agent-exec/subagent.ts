/**
 * The operation that runs a subagent, and the errors a caller can be told about while one is running.
 *
 * A subagent is started by an exec call and reports back through the same channel, so this module is both the operation's name and the place the two running-state failures are worded: a follow-up sent to a subagent that is still working, and the hint that interrupting it is a deliberate act. Those messages are here rather than at the call site because both the caller and the subagent's own tool need to say the same thing.
 */

import type { Context } from "../context/context.ts";
import type { SubagentBackgroundReason } from "../proto/generated/agent/v1/agent_pb.ts";
import {
  SubagentError,
  SubagentResult,
  SubagentSuccess,
  type SubagentArgs,
} from "../proto/generated/agent/v1/subagent_exec_pb.ts";
import { SimpleControlledExecHandler } from "./controlled-exec.ts";
import { ExecutorResource, type Executor, type ExecutorOptions, type RemoteExecManager } from "./executor-resources.ts";
import { createResource, type ControlledExecManager } from "./resource-provider.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-serialization.ts";

export const RUNNING_SUBAGENT_FOLLOWUP_ERROR =
  "Sub-agent is currently running. You may send the follow-up message when it has completed.";
export const RUNNING_SUBAGENT_INTERRUPT_RETRY_HINT =
  "If you intended to interrupt this agent, you may retry with `interrupt` set to true";

class SubagentHostFailure extends Error {
  readonly agentId: string | undefined;
  override readonly cause: unknown;

  constructor(message: string, settings?: { agentId?: string | undefined; cause?: unknown }) {
    super(message);
    this.name = "SubagentHostError";
    this.agentId = settings?.agentId;
    this.cause = settings?.cause;
  }
}

interface SubagentRunOutcome {
  status: "success" | "error" | "aborted" | "background";
  error?: string | undefined;
  finalMessage?: string | undefined;
  toolCallCount?: number | undefined;
  backgroundReason?: SubagentBackgroundReason | undefined;
  transcriptPath?: string | undefined;
}

interface SubagentHostAdapter {
  createOrResumeSession(runContext: Context, args: SubagentArgs): Promise<string>;
  runSession(
    runContext: Context,
    agentId: string,
    args: SubagentArgs,
    settings: { execId?: string | undefined },
  ): Promise<SubagentRunOutcome>;
  releaseSession?(agentId: string): void;
}

function extractAgentIdFromError(failure: unknown): string | undefined {
  if (failure instanceof SubagentHostFailure && failure.agentId) {
    return failure.agentId;
  }
  if (!failure || typeof failure !== "object") {
    return undefined;
  }
  const errorEntry = failure as { agentId?: unknown };
  if (typeof errorEntry.agentId === "string") {
    return errorEntry.agentId;
  }
  return undefined;
}

function getInFlightKey(args: SubagentArgs): string | undefined {
  if (!args.toolCallId || !args.parentConversationId) {
    return undefined;
  }
  return [
    args.parentConversationId,
    args.toolCallId,
    args.resumeAgentId ?? "",
    args.forkAgentId ?? "",
  ].join("\0");
}

const MAX_COMPLETED_TOOL_CALL_RESULTS = 1_000;

export function createSubagentExecutor(
  hostAdapter: SubagentHostAdapter,
): Executor<SubagentArgs, SubagentResult> {
  const inFlightRuns = new Map<string, Promise<SubagentResult>>();
  const completedRuns = new Map<string, SubagentResult>();

  async function executeSubagentRun(
    runContext: Context,
    args: SubagentArgs,
    settings?: ExecutorOptions,
  ): Promise<SubagentResult> {
    let agentId: string | undefined;
    try {
      agentId = await hostAdapter.createOrResumeSession(runContext, args);
      const runOutcome = await hostAdapter.runSession(runContext, agentId, args, {
        execId: settings?.execId,
      });
      if (runOutcome.status === "error") {
        return new SubagentResult({
          result: {
            case: "error",
            value: new SubagentError({
              agentId,
              error: runOutcome.error!,
            }),
          },
        });
      }
      if (runOutcome.status === "aborted") {
        return new SubagentResult({
          result: {
            case: "error",
            value: new SubagentError({
              agentId,
              error: runOutcome.error ?? "Subagent was aborted by the user",
            }),
          },
        });
      }
      if (runOutcome.status === "background") {
        return new SubagentResult({
          result: {
            case: "success",
            value: new SubagentSuccess({
              agentId,
              finalMessage: runOutcome.finalMessage!,
              toolCallCount: runOutcome.toolCallCount ?? 0,
              backgroundReason: runOutcome.backgroundReason!,
              transcriptPath: runOutcome.transcriptPath!,
            }),
          },
        });
      }
      return new SubagentResult({
        result: {
          case: "success",
          value: new SubagentSuccess({
            agentId,
            finalMessage: runOutcome.finalMessage!,
            toolCallCount: runOutcome.toolCallCount ?? 0,
          }),
        },
      });
    } catch (failure) {
      if (agentId && hostAdapter.releaseSession) {
        hostAdapter.releaseSession(agentId);
      }
      const failureMessage = failure instanceof Error ? failure.message : String(failure);
      const failureAgentId = agentId ?? extractAgentIdFromError(failure) ?? args.resumeAgentId;
      return new SubagentResult({
        result: {
          case: "error",
          value: new SubagentError({
            ...(failureAgentId ? { agentId: failureAgentId } : {}),
            error: failureMessage,
          }),
        },
      });
    }
  }

  return {
    execute(runContext, args, settings) {
      const inFlightKey = getInFlightKey(args);
      if (inFlightKey === undefined) {
        return executeSubagentRun(runContext, args, settings);
      }
      const cachedResult = completedRuns.get(inFlightKey);
      if (cachedResult !== undefined) {
        return Promise.resolve(cachedResult);
      }
      const runningRun = inFlightRuns.get(inFlightKey);
      if (runningRun !== undefined) {
        return runningRun;
      }
      const runPromise = executeSubagentRun(runContext, args, settings)
        .then((runResult) => {
          if (runResult.result.case === "success") {
            completedRuns.set(inFlightKey, runResult);
            if (completedRuns.size > MAX_COMPLETED_TOOL_CALL_RESULTS) {
              completedRuns.delete(completedRuns.keys().next().value!);
            }
          }
          return runResult;
        })
        .finally(() => {
          inFlightRuns.delete(inFlightKey);
        });
      inFlightRuns.set(inFlightKey, runPromise);
      return runPromise;
    },
  };
}

export const subagentExecutorResource = createResource<
  Executor<SubagentArgs, SubagentResult>,
  RemoteExecManager,
  ControlledExecManager
>(
  (executionManager) =>
    new ExecutorResource(
      executionManager,
      createServerSerializer("subagentArgs"),
      createClientDeserializer("subagentResult"),
    ),
  (executorImplementation, controlledManager) =>
    controlledManager.register(
      new SimpleControlledExecHandler(
        executorImplementation,
        createServerDeserializer("subagentArgs"),
        createClientSerializer("subagentResult"),
      ),
    ),
);
