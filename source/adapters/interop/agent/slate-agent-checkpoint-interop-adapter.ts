import {
  AgentMode,
  BackgroundTaskCompletionReason,
  CloudSubagentReference,
  CommunicateUpdateHistoryEntry,
  CommunicateUpdateTurnState,
  ConversationStateStructure,
  ConversationTokenDetails,
  FileStateStructure,
  PromptContextNode,
  PromptContextSourceRef,
  PromptContextUsageTree,
  PromptTokenBreakdownCategory,
  PromptTokenBreakdownSnapshot,
  SelfHostedPoolTarget,
  SelfHostedWorkerLabel,
  SelfHostedWorkerTarget,
  NewCloudVmTarget,
  SameMachineTarget,
  StepTiming,
  SubagentExecutionEnvironment,
  SubagentPersistedState,
  SubagentRunState,
  SubagentRunStatus,
  TargetMachine,
  TrackedGitRepo,
} from "../proto/generated/agent/v1/agent_pb.ts"
import {
  SubagentType,
  SubagentTypeBash,
  SubagentTypeBrowserUse,
  SubagentTypeComputerUse,
  SubagentTypeCursorGuide,
  SubagentTypeCustom,
  SubagentTypeDebug,
  SubagentTypeExplore,
  SubagentTypeMediaReview,
  SubagentTypeShell,
  SubagentTypeUnspecified,
  SubagentTypeVmSetupHelper,
  SubagentTypeWatchVideo,
} from "../proto/generated/agent/v1/subagents_pb.ts"
import type {
  SlateCheckpointCommunicationHistoryEntry,
  SlateCheckpointCommunicationTurn,
  SlateCheckpointGoal,
  SlateCheckpointSubagent,
  SlateCheckpointSubagentRun,
  SlateCheckpointSubagentType,
  SlateCheckpointTargetMachine,
  SlateCheckpointTokenUsage,
  SlateConversationCheckpointV2,
  SlateCheckpointUnknownField,
} from "../../../packages/agent/conversation-checkpoint-state.ts"
import { SlateGoalState } from "../../../packages/agent/goal-state.ts"
import { SlateMode } from "../../../packages/agent/mode-processing.ts"
import { fromInteropAgentMode, toInteropAgentMode } from "./mode-processing-adapter.ts"
import {
  fromInteropGoalState,
  fromInteropPlanRegistryEntry,
  toInteropGoalState,
  toInteropPlanRegistryEntry,
} from "./agent-state-message-serdes-adapter.ts"
import {
  collectSubagentUnknownFieldsInterop,
  restoreSubagentUnknownFieldsInterop,
} from "./subagent-persisted-state-adapter.ts"
import { fromHex, toHex } from "../../../packages/agent-kv/serde.ts"

function sortedRecord<Value>(entries: Iterable<readonly [string, Value]>): Record<string, Value> {
  return Object.fromEntries([...entries].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
}

function environmentFromInterop(value: number): {
  readonly environment: "unspecified" | "local" | "cloud"
  readonly compatibility?: { readonly legacyEnvironmentCode: number }
} {
  switch (value) {
    case SubagentExecutionEnvironment.LOCAL:
      return { environment: "local" }
    case SubagentExecutionEnvironment.CLOUD:
      return { environment: "cloud" }
    case SubagentExecutionEnvironment.UNSPECIFIED:
      return { environment: "unspecified" }
    default:
      return { environment: "unspecified", compatibility: { legacyEnvironmentCode: value } }
  }
}

function environmentToInterop(value: {
  readonly environment: "unspecified" | "local" | "cloud"
  readonly compatibility?: { readonly legacyEnvironmentCode?: number }
}): number {
  if (value.compatibility?.legacyEnvironmentCode !== undefined) return value.compatibility.legacyEnvironmentCode
  switch (value.environment) {
    case "local": return SubagentExecutionEnvironment.LOCAL
    case "cloud": return SubagentExecutionEnvironment.CLOUD
    case "unspecified": return SubagentExecutionEnvironment.UNSPECIFIED
  }
}

function subagentTypeFromInterop(value: SubagentType | undefined): SlateCheckpointSubagentType | undefined {
  if (value === undefined) return undefined
  switch (value.type.case) {
    case "unspecified": return { kind: "general-purpose", compatibility: { legacyDiscriminator: "unspecified" } }
    case "computerUse": return { kind: "computer-use", compatibility: { legacyDiscriminator: "computerUse" } }
    case "custom": return { kind: "custom", customName: value.type.value.name, compatibility: { legacyDiscriminator: "custom" } }
    case "explore": return { kind: "explore", compatibility: { legacyDiscriminator: "explore" } }
    case "mediaReview": return { kind: "video-review", compatibility: { legacyDiscriminator: "mediaReview" } }
    case "bash": return { kind: "shell", compatibility: { legacyDiscriminator: "bash" } }
    case "browserUse": return { kind: "browser-use", compatibility: { legacyDiscriminator: "browserUse" } }
    case "shell": return { kind: "shell", compatibility: { legacyDiscriminator: "shell" } }
    case "vmSetupHelper": return { kind: "environment-setup", compatibility: { legacyDiscriminator: "vmSetupHelper" } }
    case "debug": return { kind: "debug", compatibility: { legacyDiscriminator: "debug" } }
    case "cursorGuide": return { kind: "guide", compatibility: { legacyDiscriminator: "cursorGuide" } }
    case "watchVideo": return { kind: "watch-video", compatibility: { legacyDiscriminator: "watchVideo" } }
    case undefined: return { kind: "unknown", compatibility: { legacyDiscriminator: "" } }
  }
}

function subagentTypeToInterop(value: SlateCheckpointSubagentType | undefined): SubagentType | undefined {
  if (value === undefined) return undefined
  const discriminator = value.compatibility?.legacyDiscriminator
  if (discriminator === "") return new SubagentType()
  switch (discriminator ?? value.kind) {
    case "unspecified":
    case "general-purpose":
      return new SubagentType({ type: { case: "unspecified", value: new SubagentTypeUnspecified() } })
    case "computerUse":
    case "computer-use":
      return new SubagentType({ type: { case: "computerUse", value: new SubagentTypeComputerUse() } })
    case "custom":
      return new SubagentType({
        type: { case: "custom", value: new SubagentTypeCustom({ name: value.customName ?? "" }) },
      })
    case "explore":
      return new SubagentType({ type: { case: "explore", value: new SubagentTypeExplore() } })
    case "mediaReview":
    case "video-review":
      return new SubagentType({ type: { case: "mediaReview", value: new SubagentTypeMediaReview() } })
    case "bash":
      return new SubagentType({ type: { case: "bash", value: new SubagentTypeBash() } })
    case "browserUse":
    case "browser-use":
      return new SubagentType({ type: { case: "browserUse", value: new SubagentTypeBrowserUse() } })
    case "shell":
      return new SubagentType({ type: { case: "shell", value: new SubagentTypeShell() } })
    case "vmSetupHelper":
    case "environment-setup":
      return new SubagentType({ type: { case: "vmSetupHelper", value: new SubagentTypeVmSetupHelper() } })
    case "debug":
      return new SubagentType({ type: { case: "debug", value: new SubagentTypeDebug() } })
    case "cursorGuide":
    case "guide":
      return new SubagentType({ type: { case: "cursorGuide", value: new SubagentTypeCursorGuide() } })
    case "watchVideo":
    case "watch-video":
      return new SubagentType({ type: { case: "watchVideo", value: new SubagentTypeWatchVideo() } })
    default:
      return new SubagentType()
  }
}

function targetMachineFromInterop(value: TargetMachine | undefined): SlateCheckpointTargetMachine | undefined {
  if (value === undefined) return undefined
  switch (value.machine.case) {
    case undefined:
      return { kind: "unspecified" }
    case "sameMachine":
      return { kind: "same-device" }
    case "newCloudVm":
      return {
        kind: "cloud-machine",
        ...(value.machine.value.baseBranch === undefined ? {} : { baseBranch: value.machine.value.baseBranch }),
        ...(value.machine.value.environmentBuildId === undefined
          ? {}
          : { environmentBuildId: value.machine.value.environmentBuildId }),
      }
    case "selfHostedWorker":
      return { kind: "hosted-worker", workerId: value.machine.value.workerId }
    case "selfHostedPool":
      return {
        kind: "worker-pool",
        ...(value.machine.value.pool === undefined ? {} : { pool: value.machine.value.pool }),
        labels: value.machine.value.labels.map(({ key, value: labelValue }) => ({ key, value: labelValue })),
      }
  }
}

function targetMachineToInterop(value: SlateCheckpointTargetMachine | undefined): TargetMachine | undefined {
  if (value === undefined) return undefined
  switch (value.kind) {
    case "unspecified": return new TargetMachine()
    case "same-device": return new TargetMachine({ machine: { case: "sameMachine", value: new SameMachineTarget() } })
    case "cloud-machine":
      return new TargetMachine({
        machine: {
          case: "newCloudVm",
          value: new NewCloudVmTarget({
            ...(value.baseBranch === undefined ? {} : { baseBranch: value.baseBranch }),
            ...(value.environmentBuildId === undefined ? {} : { environmentBuildId: value.environmentBuildId }),
          }),
        },
      })
    case "hosted-worker":
      return new TargetMachine({
        machine: { case: "selfHostedWorker", value: new SelfHostedWorkerTarget({ workerId: value.workerId }) },
      })
    case "worker-pool":
      return new TargetMachine({
        machine: {
          case: "selfHostedPool",
          value: new SelfHostedPoolTarget({
            ...(value.pool === undefined ? {} : { pool: value.pool }),
            labels: value.labels.map(({ key, value: labelValue }) => new SelfHostedWorkerLabel({ key, value: labelValue })),
          }),
        },
      })
  }
}

function subagentFromInterop(value: SubagentPersistedState, preserveUnknownFields = false): SlateCheckpointSubagent {
  const environment = environmentFromInterop(value.environment)
  const subagentType = subagentTypeFromInterop(value.subagentType)
  const targetMachine = targetMachineFromInterop(value.machine)
  const unknownFields = preserveUnknownFields ? collectSubagentUnknownFieldsInterop(value) : []
  const compatibility = {
    ...(environment.compatibility ?? {}),
    ...(unknownFields.length === 0 ? {} : { legacyUnknownFields: unknownFields }),
  }
  return {
    ...(value.conversationState === undefined
      ? {}
      : { conversation: conversationStateFromInterop(value.conversationState) }),
    createdAtMs: value.createdTimestampMs.toString(),
    lastUsedAtMs: value.lastUsedTimestampMs.toString(),
    ...(subagentType === undefined ? {} : { type: subagentType }),
    ...(value.modelId === undefined ? {} : { modelId: value.modelId }),
    ...environment,
    ...(value.cloudSubagent === undefined
      ? {}
      : {
          cloudWorker: {
            workerId: value.cloudSubagent.bcId,
            ...(value.cloudSubagent.transcriptPath === undefined
              ? {}
              : { transcriptPath: value.cloudSubagent.transcriptPath }),
          },
        }),
    ...(value.firstClassBcId === undefined ? {} : { firstClassCloudRunId: value.firstClassBcId }),
    ...(value.cloudRequestedEnvironmentBuildId === undefined
      ? {}
      : { requestedRuntimeBuildId: value.cloudRequestedEnvironmentBuildId }),
    ...(targetMachine === undefined ? {} : { targetMachine }),
    ...(Object.keys(compatibility).length === 0 ? {} : { compatibility }),
  }
}

/** Projects a legacy or referenced persisted subagent into Slate's checkpoint record. */
export function slateCheckpointSubagentFromInterop(value: SubagentPersistedState): SlateCheckpointSubagent {
  return subagentFromInterop(value, true)
}

function subagentToInterop(value: SlateCheckpointSubagent): SubagentPersistedState {
  const environment = environmentToInterop(value)
  const subagentType = subagentTypeToInterop(value.type)
  const machine = targetMachineToInterop(value.targetMachine)
  const interop = new SubagentPersistedState({
    ...(value.conversation === undefined ? {} : { conversationState: conversationStateToInterop(value.conversation) }),
    createdTimestampMs: BigInt(value.createdAtMs),
    lastUsedTimestampMs: BigInt(value.lastUsedAtMs),
    ...(subagentType === undefined ? {} : { subagentType }),
    ...(value.modelId === undefined ? {} : { modelId: value.modelId }),
    environment: environment as SubagentExecutionEnvironment,
    ...(value.cloudWorker === undefined
      ? {}
      : {
          cloudSubagent: new CloudSubagentReference({
            bcId: value.cloudWorker.workerId,
            ...(value.cloudWorker.transcriptPath === undefined ? {} : { transcriptPath: value.cloudWorker.transcriptPath }),
          }),
        }),
    ...(value.firstClassCloudRunId === undefined ? {} : { firstClassBcId: value.firstClassCloudRunId }),
    ...(value.requestedRuntimeBuildId === undefined
      ? {}
      : { cloudRequestedEnvironmentBuildId: value.requestedRuntimeBuildId }),
    ...(machine === undefined ? {} : { machine }),
  })
  return interop
}

function communicationHistoryFromInterop(
  value: CommunicateUpdateHistoryEntry,
): SlateCheckpointCommunicationHistoryEntry {
  return { step: value.step, messageIndex: value.messageIndex }
}

function communicationTurnFromInterop(value: CommunicateUpdateTurnState): SlateCheckpointCommunicationTurn {
  return {
    history: value.history.map(communicationHistoryFromInterop),
    ...(value.finalSummary === undefined ? {} : { finalSummary: value.finalSummary }),
    ...(value.completedSubtitle === undefined ? {} : { completedSubtitle: value.completedSubtitle }),
  }
}

function tokenUsageFromInterop(value: ConversationTokenDetails | undefined): SlateCheckpointTokenUsage | undefined {
  if (value === undefined) return undefined
  return {
    usedTokens: value.usedTokens,
    maximumTokens: value.maxTokens,
    ...(value.breakdown === undefined
      ? {}
      : {
          breakdown: {
            totalUsedTokens: value.breakdown.totalUsedTokens,
            maximumTokens: value.breakdown.maxTokens,
            categories: value.breakdown.categories.map(category => ({
              id: category.id,
              label: category.label,
              estimatedTokens: category.estimatedTokens,
              ...(category.characterCount === undefined ? {} : { characterCount: category.characterCount }),
            })),
          },
        }),
    ...(value.promptContextUsageTree === undefined
      ? {}
      : {
          contextTree: {
            version: value.promptContextUsageTree.schemaVersion,
            nodes: value.promptContextUsageTree.nodes.map(node => ({
              id: node.id,
              ...(node.parentId === undefined ? {} : { parentId: node.parentId }),
              kind: node.kind,
              label: node.label,
              categoryId: node.categoryId,
              estimatedTokens: node.estimatedTokens,
              characterCount: node.characterCount,
              contentAvailable: node.contentAvailable,
              ...(node.source === undefined
                ? {}
                : {
                    source: {
                      kind: node.source.sourceType,
                      messageIndex: node.source.messageIndex,
                      contentPath: node.source.contentPath,
                      startOffset: node.source.startOffset,
                      endOffset: node.source.endOffset,
                    },
                  }),
              ...(node.inlineContent === undefined ? {} : { inlineContent: node.inlineContent }),
            })),
          },
        }),
    ...(value.promptContextUsageSnapshotBlobId === undefined
      ? {}
      : { usageSnapshotBlobId: toHex(value.promptContextUsageSnapshotBlobId) }),
  }
}

function tokenUsageToInterop(value: SlateCheckpointTokenUsage | undefined): ConversationTokenDetails | undefined {
  if (value === undefined) return undefined
  return new ConversationTokenDetails({
    usedTokens: value.usedTokens,
    maxTokens: value.maximumTokens,
    ...(value.breakdown === undefined
      ? {}
      : {
          breakdown: new PromptTokenBreakdownSnapshot({
            totalUsedTokens: value.breakdown.totalUsedTokens,
            maxTokens: value.breakdown.maximumTokens,
            categories: value.breakdown.categories.map(category => new PromptTokenBreakdownCategory({
              id: category.id,
              label: category.label,
              estimatedTokens: category.estimatedTokens,
              ...(category.characterCount === undefined ? {} : { characterCount: category.characterCount }),
            })),
          }),
        }),
    ...(value.contextTree === undefined
      ? {}
      : {
          promptContextUsageTree: new PromptContextUsageTree({
            schemaVersion: value.contextTree.version,
            nodes: value.contextTree.nodes.map(node => new PromptContextNode({
              id: node.id,
              ...(node.parentId === undefined ? {} : { parentId: node.parentId }),
              kind: node.kind,
              label: node.label,
              categoryId: node.categoryId,
              estimatedTokens: node.estimatedTokens,
              characterCount: node.characterCount,
              contentAvailable: node.contentAvailable,
              ...(node.source === undefined
                ? {}
                : {
                    source: new PromptContextSourceRef({
                      sourceType: node.source.kind,
                      messageIndex: node.source.messageIndex,
                      contentPath: node.source.contentPath,
                      startOffset: node.source.startOffset,
                      endOffset: node.source.endOffset,
                    }),
                  }),
              ...(node.inlineContent === undefined ? {} : { inlineContent: node.inlineContent }),
            })),
          }),
        }),
    ...(value.usageSnapshotBlobId === undefined
      ? {}
      : { promptContextUsageSnapshotBlobId: fromHex(value.usageSnapshotBlobId) }),
  })
}

function subagentRunFromInterop(value: SubagentRunState): SlateCheckpointSubagentRun {
  const environment = environmentFromInterop(value.environment)
  const status: { readonly status: SlateCheckpointSubagentRun["status"]; readonly legacyStatusCode?: number } = (() => {
    switch (value.status) {
      case SubagentRunStatus.UNSPECIFIED: return { status: "unspecified" as const }
      case SubagentRunStatus.RUNNING: return { status: "running" as const }
      case SubagentRunStatus.BACKGROUNDED: return { status: "backgrounded" as const }
      case SubagentRunStatus.SUCCESS: return { status: "success" as const }
      case SubagentRunStatus.ERROR: return { status: "error" as const }
      case SubagentRunStatus.ABORTED: return { status: "aborted" as const }
      default: return { status: "unspecified" as const, legacyStatusCode: value.status }
    }
  })()
  const completionReason: {
    readonly completionReason?: SlateCheckpointSubagentRun["completionReason"]
    readonly legacyCompletionReasonCode?: number
  } = (() => {
    if (value.completionReason === undefined) return {}
    switch (value.completionReason) {
      case BackgroundTaskCompletionReason.TASK_PROGRESS: return { completionReason: "task-progress" }
      case BackgroundTaskCompletionReason.WORKER_REPARENTED: return { completionReason: "worker-reparented" }
      default: return { legacyCompletionReasonCode: value.completionReason }
    }
  })()
  const compatibility = {
    ...(environment.compatibility?.legacyEnvironmentCode === undefined
      ? {}
      : { legacyEnvironmentCode: environment.compatibility.legacyEnvironmentCode }),
    ...(status.legacyStatusCode === undefined ? {} : { legacyStatusCode: status.legacyStatusCode }),
    ...(completionReason.legacyCompletionReasonCode === undefined
      ? {}
      : { legacyCompletionReasonCode: completionReason.legacyCompletionReasonCode }),
  }
  return {
    parentCallId: value.parentToolCallId,
    ...(value.subagentId === undefined ? {} : { subagentId: value.subagentId }),
    environment: environment.environment,
    status: status.status,
    ...(value.title === undefined ? {} : { title: value.title }),
    ...(value.detail === undefined ? {} : { detail: value.detail }),
    ...(value.transcriptPath === undefined ? {} : { transcriptPath: value.transcriptPath }),
    ...(value.outputPath === undefined ? {} : { outputPath: value.outputPath }),
    ...(value.completedTimestampMs === undefined ? {} : { completedAtMs: value.completedTimestampMs.toString() }),
    ...(completionReason.completionReason === undefined ? {} : { completionReason: completionReason.completionReason }),
    ...(Object.keys(compatibility).length === 0 ? {} : { compatibility }),
  }
}

function subagentRunToInterop(value: SlateCheckpointSubagentRun): SubagentRunState {
  const status = value.compatibility?.legacyStatusCode ?? (() => {
    switch (value.status) {
      case "unspecified": return SubagentRunStatus.UNSPECIFIED
      case "running": return SubagentRunStatus.RUNNING
      case "backgrounded": return SubagentRunStatus.BACKGROUNDED
      case "success": return SubagentRunStatus.SUCCESS
      case "error": return SubagentRunStatus.ERROR
      case "aborted": return SubagentRunStatus.ABORTED
    }
  })()
  const reason = value.compatibility?.legacyCompletionReasonCode ?? (value.completionReason === undefined
    ? undefined
    : value.completionReason === "task-progress"
      ? BackgroundTaskCompletionReason.TASK_PROGRESS
      : BackgroundTaskCompletionReason.WORKER_REPARENTED)
  return new SubagentRunState({
    parentToolCallId: value.parentCallId,
    ...(value.subagentId === undefined ? {} : { subagentId: value.subagentId }),
    environment: environmentToInterop({
      environment: value.environment,
      ...(value.compatibility?.legacyEnvironmentCode === undefined
        ? {}
        : { compatibility: { legacyEnvironmentCode: value.compatibility.legacyEnvironmentCode } }),
    }) as SubagentExecutionEnvironment,
    status: status as SubagentRunStatus,
    ...(value.title === undefined ? {} : { title: value.title }),
    ...(value.detail === undefined ? {} : { detail: value.detail }),
    ...(value.transcriptPath === undefined ? {} : { transcriptPath: value.transcriptPath }),
    ...(value.outputPath === undefined ? {} : { outputPath: value.outputPath }),
    ...(value.completedAtMs === undefined ? {} : { completedTimestampMs: BigInt(value.completedAtMs) }),
    ...(reason === undefined ? {} : { completionReason: reason as BackgroundTaskCompletionReason }),
  })
}

function goalFromInterop(value: ConversationStateStructure["goalState"]): SlateCheckpointGoal | undefined {
  if (value === undefined) return undefined
  const goal = fromInteropGoalState(value)
  return {
    conversationId: goal.conversationId,
    goalId: goal.goalId,
    objective: goal.objective,
    status: goal.status,
    ...(goal.unknownStatusCode === undefined ? {} : { compatibility: { legacyStatusCode: goal.unknownStatusCode } }),
    idleContinuationsWithoutToolCalls: goal.idleContinuationsWithoutToolCalls,
    ...(goal.activeDurationMs === undefined ? {} : { activeDurationMs: goal.activeDurationMs.toString() }),
    ...(goal.lastAccruedAtMs === undefined ? {} : { lastAccruedAtMs: goal.lastAccruedAtMs.toString() }),
    continuationCount: goal.continuationCount,
    ...(goal.agentSessionId === undefined ? {} : { agentSessionId: goal.agentSessionId }),
  }
}

function goalToInterop(value: SlateCheckpointGoal | undefined): ConversationStateStructure["goalState"] {
  if (value === undefined) return undefined
  return toInteropGoalState(new SlateGoalState({
    conversationId: value.conversationId,
    goalId: value.goalId,
    objective: value.objective,
    status: value.status,
    ...(value.compatibility?.legacyStatusCode === undefined
      ? {}
      : { unknownStatusCode: value.compatibility.legacyStatusCode }),
    idleContinuationsWithoutToolCalls: value.idleContinuationsWithoutToolCalls,
    ...(value.activeDurationMs === undefined ? {} : { activeDurationMs: BigInt(value.activeDurationMs) }),
    ...(value.lastAccruedAtMs === undefined ? {} : { lastAccruedAtMs: BigInt(value.lastAccruedAtMs) }),
    continuationCount: value.continuationCount,
    ...(value.agentSessionId === undefined ? {} : { agentSessionId: value.agentSessionId }),
  }))
}

function conversationStateFromInterop(value: ConversationStateStructure): SlateConversationCheckpointV2 {
  const mode = value.mode === undefined ? undefined : fromInteropAgentMode(value.mode) ?? SlateMode.UNSPECIFIED
  const tokenUsage = tokenUsageFromInterop(value.tokenDetails)
  const goal = goalFromInterop(value.goalState)
  const unknownModeCode = value.mode === undefined || toInteropAgentMode(mode!) === value.mode
    ? undefined
    : value.mode
  const subagentStates = sortedRecord(Object.entries(value.subagentStates).map(([id, state]) => [id, subagentFromInterop(state)] as const))
  const plans = sortedRecord(Object.entries(value.plans).map(([id, plan]) => {
    const projected = fromInteropPlanRegistryEntry(plan)
    return [id, { planId: projected.id, path: projected.path }] as const
  }))
  const runs = sortedRecord(Object.entries(value.subagentRunsByParentToolCallId).map(([callId, run]) => [callId, subagentRunFromInterop(run)] as const))
  const communications = sortedRecord(Object.entries(value.communicateUpdateStatesByParentToolCallId).map(([callId, turn]) => [callId, communicationTurnFromInterop(turn)] as const))
  return {
    promptMessageBlobIds: value.rootPromptMessagesJson.map(toHex),
    todoBlobIds: value.todos.map(toHex),
    pendingOperationIds: [...value.pendingToolCalls],
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
    ...(value.summary === undefined ? {} : { summaryBlobId: toHex(value.summary) }),
    ...(value.plan === undefined ? {} : { activePlanBlobId: toHex(value.plan) }),
    turnBlobIds: value.turns.map(toHex),
    workspaceUris: [...value.previousWorkspaceUris],
    ...(mode === undefined ? {} : { mode }),
    ...(value.summaryArchive === undefined ? {} : { summaryArchiveBlobId: toHex(value.summaryArchive) }),
    legacyFileContentBlobIds: sortedRecord(Object.entries(value.fileStates).map(([path, blobId]) => [path, toHex(blobId)] as const)),
    summaryArchiveBlobIds: value.summaryArchives.map(toHex),
    turnTimings: value.turnTimings.map(timing => ({
      durationMs: timing.durationMs.toString(),
      recordedAtMs: timing.timestampMs.toString(),
    })),
    fileContentBlobIds: sortedRecord(Object.entries(value.fileStatesV2).map(([path, fileState]) => [path, {
      ...(fileState.content === undefined ? {} : { contentBlobId: toHex(fileState.content) }),
      ...(fileState.initialContent === undefined ? {} : { initialContentBlobId: toHex(fileState.initialContent) }),
    }] as const)),
    subagents: subagentStates,
    selfSummaryCount: value.selfSummaryCount,
    readPaths: [...value.readPaths],
    ...(value.activeBranchName === undefined ? {} : { activeBranchName: value.activeBranchName }),
    planRegistry: plans,
    trackedRepositories: value.trackedGitRepoBranches.map(repository => ({
      rootPath: repository.repoPath,
      branchName: repository.branchName,
    })),
    ...(value.agentType === undefined ? {} : { agentKind: value.agentType }),
    communicationHistory: value.communicateUpdateHistory.map(communicationHistoryFromInterop),
    subagentThreads: sortedRecord(Object.entries(value.subagentThreads)),
    ...(value.communicateUpdateFinalSummary === undefined ? {} : { communicationFinalSummary: value.communicateUpdateFinalSummary }),
    ...(value.conversationStartedTimestampMs === undefined ? {} : { conversationStartedAtMs: value.conversationStartedTimestampMs.toString() }),
    ...(value.conversationStartedTimeZone === undefined ? {} : { conversationTimeZone: value.conversationStartedTimeZone }),
    ...(value.communicateUpdateCompletedSubtitle === undefined ? {} : { communicationCompletedSubtitle: value.communicateUpdateCompletedSubtitle }),
    communicationTurnsByCallId: communications,
    subagentRunsByCallId: runs,
    subagentStateBlobIds: sortedRecord(Object.entries(value.subagentStateRefs).map(([id, blobId]) => [id, toHex(blobId)] as const)),
    ...(goal === undefined ? {} : { goal }),
    ...(value.isRootProjectConversation === undefined ? {} : { isRootConversation: value.isRootProjectConversation }),
    completedQuestionCallIds: [...value.completedAskQuestionToolCallIds],
    ...(unknownModeCode === undefined ? {} : { compatibility: { legacyModeCode: unknownModeCode } }),
  }
}

export function slateConversationCheckpointFromInterop(
  value: ConversationStateStructure,
  legacyUnknownFields: readonly SlateCheckpointUnknownField[],
): SlateConversationCheckpointV2 {
  const snapshot = conversationStateFromInterop(value)
  const orderedUnknownFields = [...legacyUnknownFields].sort((left, right) => {
    const leftPath = JSON.stringify(left.path)
    const rightPath = JSON.stringify(right.path)
    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0
  })
  const legacyModeCode = snapshot.compatibility?.legacyModeCode
  return orderedUnknownFields.length === 0
    ? snapshot
    : {
        ...snapshot,
        compatibility: {
          ...(legacyModeCode === undefined ? {} : { legacyModeCode }),
          legacyUnknownFields: orderedUnknownFields,
        },
      }
}

function communicationHistoryToInterop(value: SlateCheckpointCommunicationHistoryEntry): CommunicateUpdateHistoryEntry {
  return new CommunicateUpdateHistoryEntry({ step: value.step, messageIndex: value.messageIndex })
}

function communicationTurnToInterop(value: SlateCheckpointCommunicationTurn): CommunicateUpdateTurnState {
  return new CommunicateUpdateTurnState({
    history: value.history.map(communicationHistoryToInterop),
    ...(value.finalSummary === undefined ? {} : { finalSummary: value.finalSummary }),
    ...(value.completedSubtitle === undefined ? {} : { completedSubtitle: value.completedSubtitle }),
  })
}

function conversationStateToInterop(value: SlateConversationCheckpointV2): ConversationStateStructure {
  const mode = value.compatibility?.legacyModeCode ?? (value.mode === undefined ? undefined : toInteropAgentMode(value.mode))
  const tokenDetails = tokenUsageToInterop(value.tokenUsage)
  const goalState = goalToInterop(value.goal)
  const subagentStates = Object.fromEntries(Object.entries(value.subagents).map(([id, state]) => [id, subagentToInterop(state)]))
  const plans = Object.fromEntries(Object.entries(value.planRegistry).map(([id, plan]) => [id,
    toInteropPlanRegistryEntry({ id: plan.planId, path: plan.path }),
  ]))
  const runs = Object.fromEntries(Object.entries(value.subagentRunsByCallId).map(([id, run]) => [id, subagentRunToInterop(run)]))
  const communicationTurns = Object.fromEntries(Object.entries(value.communicationTurnsByCallId).map(([id, turn]) => [id, communicationTurnToInterop(turn)]))
  return new ConversationStateStructure({
    rootPromptMessagesJson: value.promptMessageBlobIds.map(fromHex),
    todos: value.todoBlobIds.map(fromHex),
    pendingToolCalls: [...value.pendingOperationIds],
    ...(tokenDetails === undefined ? {} : { tokenDetails }),
    ...(value.summaryBlobId === undefined ? {} : { summary: fromHex(value.summaryBlobId) }),
    ...(value.activePlanBlobId === undefined ? {} : { plan: fromHex(value.activePlanBlobId) }),
    turns: value.turnBlobIds.map(fromHex),
    previousWorkspaceUris: [...value.workspaceUris],
    ...(mode === undefined ? {} : { mode: mode as AgentMode }),
    ...(value.summaryArchiveBlobId === undefined ? {} : { summaryArchive: fromHex(value.summaryArchiveBlobId) }),
    fileStates: Object.fromEntries(Object.entries(value.legacyFileContentBlobIds).map(([path, id]) => [path, fromHex(id)])),
    summaryArchives: value.summaryArchiveBlobIds.map(fromHex),
    turnTimings: value.turnTimings.map(timing => new StepTiming({
      durationMs: BigInt(timing.durationMs),
      timestampMs: BigInt(timing.recordedAtMs),
    })),
    fileStatesV2: Object.fromEntries(Object.entries(value.fileContentBlobIds).map(([path, fileState]) => [path, new FileStateStructure({
      ...(fileState.contentBlobId === undefined ? {} : { content: fromHex(fileState.contentBlobId) }),
      ...(fileState.initialContentBlobId === undefined ? {} : { initialContent: fromHex(fileState.initialContentBlobId) }),
    })])),
    subagentStates,
    selfSummaryCount: value.selfSummaryCount,
    readPaths: [...value.readPaths],
    ...(value.activeBranchName === undefined ? {} : { activeBranchName: value.activeBranchName }),
    plans,
    trackedGitRepoBranches: value.trackedRepositories.map(repository => new TrackedGitRepo({
      repoPath: repository.rootPath,
      branchName: repository.branchName,
    })),
    ...(value.agentKind === undefined ? {} : { agentType: value.agentKind }),
    communicateUpdateHistory: value.communicationHistory.map(communicationHistoryToInterop),
    subagentThreads: { ...value.subagentThreads },
    ...(value.communicationFinalSummary === undefined ? {} : { communicateUpdateFinalSummary: value.communicationFinalSummary }),
    ...(value.conversationStartedAtMs === undefined ? {} : { conversationStartedTimestampMs: BigInt(value.conversationStartedAtMs) }),
    ...(value.conversationTimeZone === undefined ? {} : { conversationStartedTimeZone: value.conversationTimeZone }),
    ...(value.communicationCompletedSubtitle === undefined ? {} : { communicateUpdateCompletedSubtitle: value.communicationCompletedSubtitle }),
    communicateUpdateStatesByParentToolCallId: communicationTurns,
    subagentRunsByParentToolCallId: runs,
    subagentStateRefs: Object.fromEntries(Object.entries(value.subagentStateBlobIds).map(([id, blobId]) => [id, fromHex(blobId)])),
    ...(goalState === undefined ? {} : { goalState }),
    ...(value.isRootConversation === undefined ? {} : { isRootProjectConversation: value.isRootConversation }),
    completedAskQuestionToolCallIds: [...value.completedQuestionCallIds],
  })
}

export function interopConversationCheckpointFromSlate(
  value: SlateConversationCheckpointV2,
): ConversationStateStructure {
  const interop = conversationStateToInterop(value)
  for (const [subagentId, subagent] of Object.entries(value.subagents)) {
    const fields = subagent.compatibility?.legacyUnknownFields
    const target = interop.subagentStates[subagentId]
    if (fields !== undefined && target !== undefined) {
      restoreSubagentUnknownFieldsInterop(target, fields)
    }
  }
  return interop
}
