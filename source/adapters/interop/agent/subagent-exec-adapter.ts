/** Converts the remote subagent executor envelope to Slate's run request and outcome contract. */

import { SubagentBackgroundReason } from "../proto/generated/agent/v1/agent_pb.ts"
import {
  SubagentArgs,
  SubagentError,
  SubagentResult,
  SubagentSuccess,
} from "../proto/generated/agent/v1/subagent_exec_pb.ts"
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts"
import {
  ExecutorResource,
  type Executor,
  type RemoteExecManager,
} from "../../../packages/agent-exec/executor-resources.ts"
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts"
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts"
import {
  createSubagentExecutor,
  type SubagentBackgroundReason as SlateSubagentBackgroundReason,
  type SubagentExecutionArgs,
  type SubagentExecutionResult,
  type SubagentRunOutcome,
} from "../../../packages/agent-exec/subagent.ts"
import type { SubagentAdapterArgs } from "../../../host/runner/subagent-session-coordinator.ts"
import type { Context } from "../../../packages/context/context.ts"
import { fromInteropTaskSelectedContext } from "./task-subagent-preparation-protocol-adapter.ts"

interface WireSubagentHostAdapter {
  createOrResumeSession(context: Context, args: SubagentAdapterArgs): Promise<string>
  runSession(
    context: Context,
    agentId: string,
    args: SubagentAdapterArgs,
    settings: { readonly execId?: string },
  ): Promise<
    | { readonly status: "success"; readonly finalMessage?: string; readonly toolCallCount?: number }
    | { readonly status: "error"; readonly error: string }
    | { readonly status: "aborted"; readonly error?: string }
    | {
        readonly status: "background"
        readonly backgroundReason: SubagentBackgroundReason
        readonly finalMessage?: string
        readonly toolCallCount?: number
        readonly transcriptPath?: string
      }
  >
  releaseSession?(agentId: string): void
}

const reasonFromWire: Readonly<Record<SubagentBackgroundReason, SlateSubagentBackgroundReason>> = {
  [SubagentBackgroundReason.UNSPECIFIED]: "unspecified",
  [SubagentBackgroundReason.AGENT_REQUEST]: "agent_request",
  [SubagentBackgroundReason.USER_REQUEST]: "user_request",
  [SubagentBackgroundReason.QUEUED_FOLLOW_UP]: "queued_follow_up",
}

const reasonToWire: Readonly<Record<SlateSubagentBackgroundReason, SubagentBackgroundReason>> = {
  unspecified: SubagentBackgroundReason.UNSPECIFIED,
  agent_request: SubagentBackgroundReason.AGENT_REQUEST,
  user_request: SubagentBackgroundReason.USER_REQUEST,
  queued_follow_up: SubagentBackgroundReason.QUEUED_FOLLOW_UP,
}

function argsFromWire(args: SubagentArgs): SubagentExecutionArgs {
  const selectedContext = args.selectedContext === undefined
    ? undefined
    : fromInteropTaskSelectedContext(args.selectedContext)
  return {
    toolCallId: args.toolCallId,
    subagentType: args.subagentType,
    prompt: args.prompt,
    readonly: args.readonly,
    ...(args.parentConversationId === undefined ? {} : { parentConversationId: args.parentConversationId }),
    ...(args.resumeAgentId === undefined ? {} : { resumeAgentId: args.resumeAgentId }),
    ...(args.forkAgentId === undefined ? {} : { forkAgentId: args.forkAgentId }),
    ...(selectedContext === undefined ? {} : { selectedContext }),
  }
}

function argsForHost(args: SubagentExecutionArgs): SubagentAdapterArgs {
  return {
    toolCallId: args.toolCallId ?? "",
    subagentType: args.subagentType ?? "",
    prompt: args.prompt ?? "",
    ...(args.resumeAgentId === undefined ? {} : { resumeAgentId: args.resumeAgentId }),
    ...(args.readonly === undefined ? {} : { readonly: args.readonly }),
    ...(args.selectedContext === undefined ? {} : { selectedContext: args.selectedContext }),
  }
}

function outcomeFromWire(outcome: Awaited<ReturnType<WireSubagentHostAdapter["runSession"]>>): SubagentRunOutcome {
  if (outcome.status !== "background") return outcome
  return {
    ...outcome,
    backgroundReason: reasonFromWire[outcome.backgroundReason] ?? "unspecified",
  }
}

function resultToWire(result: SubagentExecutionResult): SubagentResult {
  if (result.status === "error") {
    return new SubagentResult({
      result: {
        case: "error",
        value: new SubagentError({ ...(result.agentId === undefined ? {} : { agentId: result.agentId }), error: result.error }),
      },
    })
  }
  return new SubagentResult({
    result: {
      case: "success",
      value: new SubagentSuccess({
        agentId: result.agentId,
        ...(result.finalMessage === undefined ? {} : { finalMessage: result.finalMessage }),
        toolCallCount: result.toolCallCount,
        ...(result.backgroundReason === undefined ? {} : {
          backgroundReason: reasonToWire[result.backgroundReason],
          ...(result.transcriptPath === undefined ? {} : { transcriptPath: result.transcriptPath }),
        }),
      }),
    },
  })
}

/** Binds the Slate subagent lifecycle to the generated executor contract. */
export function createInteropSubagentExecutor(
  hostAdapter: WireSubagentHostAdapter,
): Executor<SubagentArgs, SubagentResult> {
  const executor = createSubagentExecutor({
    createOrResumeSession: (context, args) => hostAdapter.createOrResumeSession(context, argsForHost(args)),
    runSession: async (context, agentId, args, settings) =>
      outcomeFromWire(await hostAdapter.runSession(context, agentId, argsForHost(args), settings)),
    ...(hostAdapter.releaseSession === undefined ? {} : { releaseSession: (agentId: string) => hostAdapter.releaseSession?.(agentId) }),
  })
  return {
    execute(context, args, settings) {
      return executor.execute(context, argsFromWire(args), settings).then(resultToWire)
    },
  }
}

export const subagentExecutorResource = createResource<
  Executor<SubagentArgs, SubagentResult>,
  RemoteExecManager,
  ControlledExecManager
>(
  executionManager => new ExecutorResource(
    executionManager,
    createServerSerializer("subagentArgs"),
    createClientDeserializer("subagentResult"),
  ),
  (executorImplementation, controlledManager) => controlledManager.register(
    new SimpleControlledExecHandler(
      executorImplementation,
      createServerDeserializer("subagentArgs"),
      createClientSerializer("subagentResult"),
    ),
  ),
)
