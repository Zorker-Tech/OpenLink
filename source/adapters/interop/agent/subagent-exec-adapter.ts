/** Converts the remote subagent executor envelope to Slate's run request and outcome contract. */

import { SubagentBackgroundReason, SubagentExecutionEnvironment } from "../proto/generated/agent/v1/agent_pb.ts"
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
  type SubagentHostAdapter,
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

function reasonFromWire(value: SubagentBackgroundReason): SlateSubagentBackgroundReason {
  switch (value) {
    case SubagentBackgroundReason.UNSPECIFIED: return "unspecified"
    case SubagentBackgroundReason.AGENT_REQUEST: return "agent-request"
    case SubagentBackgroundReason.USER_REQUEST: return "user-request"
    case SubagentBackgroundReason.QUEUED_FOLLOW_UP: return "queued-follow-up"
    default: return `unknown-${value}`
  }
}

function reasonToWire(value: SlateSubagentBackgroundReason): SubagentBackgroundReason {
  switch (value) {
    case "unspecified": return SubagentBackgroundReason.UNSPECIFIED
    case "agent-request": return SubagentBackgroundReason.AGENT_REQUEST
    case "user-request": return SubagentBackgroundReason.USER_REQUEST
    case "queued-follow-up": return SubagentBackgroundReason.QUEUED_FOLLOW_UP
    default: {
      const unknown = /^unknown-(-?\d+)$/.exec(value)
      return unknown === null ? SubagentBackgroundReason.UNSPECIFIED : Number(unknown[1]) as SubagentBackgroundReason
    }
  }
}

function environmentFromWire(value: SubagentExecutionEnvironment): "local" | "cloud" | undefined {
  if (value === SubagentExecutionEnvironment.LOCAL) return "local"
  if (value === SubagentExecutionEnvironment.CLOUD) return "cloud"
  return undefined
}

function argsFromWire(args: SubagentArgs): SubagentExecutionArgs {
  const selectedContext = args.selectedContext === undefined
    ? undefined
    : fromInteropTaskSelectedContext(args.selectedContext)
  return {
    toolCallId: args.toolCallId,
    subagentType: args.subagentType,
    ...(args.modelId.length === 0 ? {} : { modelId: args.modelId }),
    prompt: args.prompt,
    readonly: args.readonly,
    ...(args.interrupt === undefined ? {} : { interrupt: args.interrupt }),
    ...(args.runInBackground === undefined ? {} : { runInBackground: args.runInBackground }),
    ...(args.continuationConfig === undefined ? {} : { continuationConfig: {
      idleThreshold: args.continuationConfig.idleThreshold,
      maxLoops: args.continuationConfig.maxLoops,
      nudgeMessage: args.continuationConfig.nudgeMessage,
      escapeMessageTemplate: args.continuationConfig.escapeMessageTemplate,
      collectBackgroundChildren: args.continuationConfig.collectBackgroundChildren,
      childrenCompletedMessageTemplate: args.continuationConfig.childrenCompletedMessageTemplate,
    } }),
    ...(args.parentConversationId === undefined ? {} : { parentConversationId: args.parentConversationId }),
    ...(args.rootParentConversationId === undefined ? {} : { rootParentConversationId: args.rootParentConversationId }),
    ...(args.resumeAgentId === undefined ? {} : { resumeAgentId: args.resumeAgentId }),
    ...(args.forkAgentId === undefined ? {} : { forkAgentId: args.forkAgentId }),
    ...(selectedContext === undefined ? {} : { selectedContext }),
    ...(environmentFromWire(args.environment) === undefined ? {} : { environment: environmentFromWire(args.environment) }),
    ...(args.cloudBaseBranch === undefined ? {} : { cloudBaseBranch: args.cloudBaseBranch }),
    ...(args.modelParameters.length === 0 ? {} : {
      modelParameters: args.modelParameters.map(({ id, value }) => ({ id, value })),
    }),
  }
}

function argsForHost(args: SubagentExecutionArgs): SubagentAdapterArgs {
  return {
    toolCallId: args.toolCallId ?? "",
    subagentType: args.subagentType ?? "",
    prompt: args.prompt ?? "",
    ...(args.resumeAgentId === undefined ? {} : { resumeAgentId: args.resumeAgentId }),
    ...(args.readonly === undefined ? {} : { readonly: args.readonly }),
    ...(args.modelId === undefined ? {} : { modelId: args.modelId }),
    ...(args.interrupt === undefined ? {} : { interrupt: args.interrupt }),
    ...(args.runInBackground === undefined ? {} : { runInBackground: args.runInBackground }),
    ...(args.continuationConfig === undefined ? {} : { continuationConfig: args.continuationConfig }),
    ...(args.rootParentConversationId === undefined ? {} : { rootParentConversationId: args.rootParentConversationId }),
    ...(args.environment === undefined ? {} : { environment: args.environment }),
    ...(args.cloudBaseBranch === undefined ? {} : { cloudBaseBranch: args.cloudBaseBranch }),
    ...(args.modelParameters === undefined ? {} : { modelParameters: args.modelParameters }),
    ...(args.selectedContext === undefined ? {} : { selectedContext: args.selectedContext }),
  }
}

function outcomeFromWire(outcome: Awaited<ReturnType<WireSubagentHostAdapter["runSession"]>>): SubagentRunOutcome {
  if (outcome.status !== "background") return outcome
  return {
    ...outcome,
    backgroundReason: reasonFromWire(outcome.backgroundReason),
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
          backgroundReason: reasonToWire(result.backgroundReason),
          ...(result.transcriptPath === undefined ? {} : { transcriptPath: result.transcriptPath }),
        }),
      }),
    },
  })
}

/** Adapts a shared Slate executor to the legacy operation envelope when an old caller still needs it. */
export function createInteropSubagentExecutorFromSlate(
  executor: Executor<SubagentExecutionArgs, SubagentExecutionResult>,
): Executor<SubagentArgs, SubagentResult> {
  return {
    execute(context, args, settings) {
      return executor.execute(context, argsFromWire(args), settings).then(resultToWire)
    },
  }
}

function slateHostAdapterFromWire(hostAdapter: WireSubagentHostAdapter): SubagentHostAdapter {
  return {
    createOrResumeSession: (context, args) => hostAdapter.createOrResumeSession(context, argsForHost(args)),
    runSession: async (context, agentId, args, settings) =>
      outcomeFromWire(await hostAdapter.runSession(context, agentId, argsForHost(args), settings)),
    ...(hostAdapter.releaseSession === undefined ? {} : { releaseSession: (agentId: string) => hostAdapter.releaseSession?.(agentId) }),
  }
}

/** Binds an existing host adapter to the generated executor contract for migration callers. */
export function createInteropSubagentExecutor(
  hostAdapter: WireSubagentHostAdapter,
): Executor<SubagentArgs, SubagentResult> {
  return createInteropSubagentExecutorFromSlate(createSubagentExecutor(slateHostAdapterFromWire(hostAdapter)))
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
