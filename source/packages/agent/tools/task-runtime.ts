/**
 * The parts of a task call that are decided before the subagent starts, and the parts read back after it
 * finishes.
 *
 * Three decisions live here. Which model the subagent runs on, which is not simply the parent's: the
 * parent's model may be blocked, may be a placeholder like "auto" that means nothing to a subagent, may be
 * covered by a credential that pins one model, or may be one the subagent should not inherit at all. The
 * order the candidates are tried in is the whole of this decision, and each attempt is logged with the
 * reason it was taken or skipped so a surprising model can be explained rather than guessed at. Where the
 * subagent runs, which is a placement that arrives either as a machine object or as the older pair of
 * environment fields, and which is converted between those shapes and the protocol's own. And how the
 * conversation it was given should be read back: the turns and steps are stored as blobs, so the last
 * assistant message and the tool-call count are found by walking them rather than by keeping a copy.
 *
 * A placement that cannot be honoured is refused here rather than downgraded: a machine object together
 * with the legacy fields it replaced, a cloud-only field without the cloud environment, or a self-hosted
 * machine asked of a client-executed subagent that has no way to reach one.
 */

import {
  CloudSubagentReference,
  AgentMode,
  ConversationStep,
  ConversationStateStructure,
  ConversationTurnStructure,
  ConversationAction,
  UserMessage,
  UserMessageAction,
  NewCloudVmTarget,
  SameMachineTarget,
  SelfHostedPoolTarget,
  SelfHostedWorkerLabel,
  SelfHostedWorkerTarget,
  SubagentExecutionEnvironment,
  SubagentPersistedState,
  TargetMachine,
} from "../../proto/generated/agent/v1/agent_pb.ts"
import type { SelectedContext } from "../../proto/generated/agent/v1/selected_context_pb.ts"
import type { Context } from "../../context/context.ts"
import { CustomSubagentPermissionMode } from "../../proto/generated/agent/v1/subagents_pb.ts"
import { ToolCallArgParseError } from "./tool-errors.ts"
import {
  canonicalSubagentComposerSlug,
  isComposerSubagentDefaultId,
  orderedExploreSubagentComposerIds,
  resolveTaskArgToSubagentComposerSlug,
} from "./composer-subagent-resolution.ts"
import { tryResolveForcedSubagentModel } from "./subagent-forced-model-resolution.ts"
import { SubagentModelForcePolicy } from "./subagent-model-policy.ts"
import { getSubagentTypeName } from "./core/subagent/subagent-config.ts"
import type { SubagentModels } from "./core/subagent/models.ts"

/** How a task asked for its placement, before it is turned into a machine or into the protocol's enum. */
export type TaskEnvironment = "cloud" | "local" | undefined

export type TaskTargetMachine =
  | { readonly type: "same_machine" }
  | {
      readonly type: "new_cloud_vm"
      readonly base_branch?: string
      readonly environment_build_id?: string
    }
  | { readonly type: "self_hosted_worker"; readonly worker_id: string }
  | {
      readonly type: "self_hosted_pool"
      readonly pool?: string
      readonly labels?: Readonly<Record<string, string>>
    }

export type LegacyTaskTargetArgs = {
  readonly environment?: TaskEnvironment | undefined
  readonly cloud_base_branch?: string | undefined
  readonly cloud_requested_environment_build_id?: string | undefined
}

export type TaskTargetValidationArgs = LegacyTaskTargetArgs & {
  readonly machine?: TaskTargetMachine
}

export interface TaskSubagentConfigRuntime {
  readonly permissionMode: number
  readonly computeAllowedWritePaths?: unknown
  readonly systemReminder?: (() => string) | undefined
  readonly resumeModeOverride?: "DEFAULT" | "LAST_AGENT" | "LAST_AGENT_SAME_TYPE" | undefined
  readonly subagentSource?: string | undefined
  readonly plugin?: string | undefined
  readonly marketplace?: string | undefined
  readonly pluginId?: string | undefined
  readonly marketplaceId?: string | undefined
  readonly resultSuffix?: string | undefined
  readonly userRequestedModelId?: string | undefined
  readonly forceDefaultModel?: boolean | undefined
  readonly inheritParentModel?: boolean | undefined
  readonly defaultModelIds?: readonly string[] | undefined
  readonly isBackground?: boolean | undefined
  readonly conversationStateMapper?: ((callerState: ConversationStateStructure) => ConversationStateStructure) | undefined
}

export interface TaskSubagentModelConfig extends TaskSubagentConfigRuntime {
  readonly userRequestedModelId?: string
  readonly forceDefaultModel?: boolean
  readonly subagent_type: Parameters<typeof getSubagentTypeName>[0]
  readonly defaultModelIds?: readonly string[]
  readonly inheritParentModel?: boolean
}

export interface ResolveSubagentModelArgs {
  readonly subagentConfig: TaskSubagentModelConfig
  readonly requestedModel?: string | undefined
  readonly parentModelId: string
  readonly enableExploreParentModelInheritance?: boolean | undefined
  readonly forceModelId?: string | undefined
  readonly subagentModelForcePolicy: (typeof SubagentModelForcePolicy)[keyof typeof SubagentModelForcePolicy]
  readonly parentMaxMode: boolean
  readonly subagentModels: SubagentModels
  readonly isModelBlocked: (modelId: string) => boolean
  readonly isModelValid?: ((modelId: string) => boolean) | undefined
  readonly compareModelCosts: (candidateModelId: string, parentModelId: string) => number
  readonly requiresMaxMode?: ((modelId: string) => Promise<boolean>) | undefined
}

/**
 * Which model the subagent runs on.
 *
 * The candidates are tried in order and the first usable one wins: a model the request pinned, a model
 * the user named (when it is a real model of the right family and the session is not overriding it), the
 * parent's own model when the subagent is meant to inherit it, the user's configured default, then the
 * configured defaults for the type — cheapest first for an explore subagent, which is the one type where
 * the tier matters more than the choice. Only when none of them is usable is the call refused, because a
 * subagent running on a model nobody chose is worse than a call the model has to re-issue.
 */
export async function resolveSubagentModel(
  input: ResolveSubagentModelArgs,
): Promise<string> {
  const {
    subagentConfig: config,
    requestedModel: requested,
    parentModelId: parentId,
    enableExploreParentModelInheritance = false,
    forceModelId: forcedId,
    subagentModelForcePolicy: forcePolicy,
    parentMaxMode: parentMax,
    subagentModels: catalogue,
    isModelBlocked: blocked,
    isModelValid: valid = () => true,
    compareModelCosts: compareCosts,
    requiresMaxMode: requiresMax,
  } = input
  const userModelId = config.userRequestedModelId
  const defaultsForced = config.forceDefaultModel === true
  const exploring = getSubagentTypeName(config.subagent_type) === "explore"
  const slugs = [...catalogue.modelsBySlug.keys()].sort()
  const slugList =
    slugs.length > 0 ? slugs.map((slug) => `- ${slug}`).join("\n") : "- (none)"
  const badModelError = (requestedModelValue: string, reason?: string) =>
    `Invalid model selection "${requestedModelValue}". ${reason ?? "Model could not be resolved to a valid subagent model."}\nAllowed model slugs:\n${slugList}\n\nThe \`model\` parameter is optional. If omitted, the subagent uses the same model as the parent agent.`
  const noModelError = () =>
    `No usable model is available for this subagent. The parent model "${parentId}" is blocked or unavailable, and no configured subagent default can be used.\nAllowed model slugs:\n${slugList}\n\nChoose a supported model with the \`model\` parameter or omit this subagent call.`
  const genericParent = parentId.toLowerCase().startsWith("genericbase-")
  const autoParent = ["default", "premium", "auto-low", "auto-medium", "auto-high"].includes(parentId.toLowerCase())
  const configuredDefaults = new Set((config.defaultModelIds ?? []).map(canonicalSubagentComposerSlug))
  const maxCompatible = async (modelId: string) =>
    requiresMax === undefined || parentMax || !(await requiresMax(modelId))
  // Whether the parent's model can be used at all is asked more than once, and its answer cannot change.
  let parentUsable: Promise<boolean> | undefined
  const isParentUsable = () =>
    (parentUsable ??= (async () => !blocked(parentId) && await maxCompatible(parentId))())
  const asLogged = (candidateModelId: string): string => {
    const canonicalCandidateModelId = canonicalSubagentComposerSlug(candidateModelId)
    // A placeholder parent model cannot be handed to a subagent, so a default of the same family keeps it.
    const keepPlaceholder = genericParent &&
      (isComposerSubagentDefaultId(canonicalCandidateModelId) || configuredDefaults.has(canonicalCandidateModelId))
    return keepPlaceholder ? parentId : candidateModelId
  }
  // An "auto" parent with nothing requested means the subagent simply runs on what the parent runs on.
  if (autoParent && userModelId === undefined && requested === undefined &&
      (config.defaultModelIds?.length ?? 0) === 0 && await isParentUsable()) {
    return parentId
  }
  const forcedModelId = await tryResolveForcedSubagentModel({
    subagentModelForcePolicy: forcePolicy,
    forceModelId: forcedId,
    userRequestedModelId: userModelId,
    isModelBlocked: blocked,
    isModelValid: valid,
    isMaxModeCompatible: maxCompatible,
    logForcedModel: ({ candidateModelId }) => asLogged(candidateModelId),
  })
  if (forcedModelId !== undefined) return forcedModelId
  // A pinned model that is not usableRequested cannot be worked around: there is nothing else to run on.
  if (forcePolicy === SubagentModelForcePolicy.ParentPin && forcedId !== undefined) {
    throw new ToolCallArgParseError(noModelError())
  }
  const wantsInherit = requested?.trim().toLowerCase() === "inherit"
  let resolvedRequested: string | undefined
  if (requested !== undefined && !wantsInherit) {
    const trimmedRequested = requested.trim()
    if (trimmedRequested.length === 0) {
      throw new ToolCallArgParseError(badModelError(requested, "Model must be a non-empty string when provided."))
    }
    // Naming the parent's model is always allowed, even when it is not in the catalogue.
    const namesParent = !autoParent && trimmedRequested === parentId
    const candidateId = namesParent ? parentId : resolveTaskArgToSubagentComposerSlug(trimmedRequested, catalogue.modelsBySlug)
    const usableRequested = candidateId !== undefined && (namesParent || valid(candidateId)) && !blocked(candidateId) && await maxCompatible(candidateId)
    // "fast" is the one alias that is tolerated even when it resolves to nothing usable.
    if (!usableRequested && trimmedRequested.toLowerCase() !== "fast") {
      throw new ToolCallArgParseError(badModelError(trimmedRequested))
    }
    if (usableRequested) resolvedRequested = candidateId
  }
  if (requested !== undefined && resolvedRequested !== undefined && !defaultsForced) {
    return asLogged(resolvedRequested)
  }
  if (config.inheritParentModel === true && await isParentUsable()) return parentId
  if (userModelId !== undefined && !blocked(userModelId) && await maxCompatible(userModelId)) {
    if (valid(userModelId)) return asLogged(userModelId)
    // A user default that is not a real model still beats nothing: the parent's model is the fallback.
    if (await isParentUsable()) return parentId
  }
  // An explore subagent is the one place where inheriting the parent's model is preferred over the
  // catalogue's default, because exploring is meant to be cheap and the parent is already loaded.
  if (enableExploreParentModelInheritance && exploring && !isComposerSubagentDefaultId(parentId) &&
      catalogue.modelsBySlug.has(parentId) && !blocked(parentId) && valid(parentId) && await maxCompatible(parentId)) {
    return parentId
  }
  if (config.defaultModelIds !== undefined && config.defaultModelIds.length > 0) {
    const candidates = exploring && config.defaultModelIds.length > 1
      ? orderedExploreSubagentComposerIds([...config.defaultModelIds], parentId, compareCosts)
      : config.defaultModelIds
    for (const modelId of candidates) {
      // Exploring on a model that costs more than the parent's defeats the point of delegating it.
      if (exploring && compareCosts(modelId, parentId) > 0) continue
      if (valid(modelId) && !blocked(modelId) && await maxCompatible(modelId)) return asLogged(modelId)
    }
  }
  if (await isParentUsable()) return parentId
  throw new ToolCallArgParseError(noModelError())
}

export function getEffectiveReadonlyForSubagent(
  subagentConfig: TaskSubagentConfigRuntime,
): boolean {
  return subagentConfig.permissionMode === CustomSubagentPermissionMode.READONLY
}

/** A subagent that cannot write anywhere has nothing to do in agent mode, so it runs in ask mode. */
export function shouldUseAskModeForSubagent(
  effectiveReadonly: boolean,
  subagentConfig: TaskSubagentConfigRuntime,
): boolean {
  return effectiveReadonly && !subagentConfig.computeAllowedWritePaths
}

export function createUserMessageAction(
  subagentConfig: TaskSubagentConfigRuntime,
  prompt: string,
  messageId: string,
  useAskMode: boolean,
  selectedContext: SelectedContext | undefined,
): ConversationAction {
  const reminder = subagentConfig.systemReminder
  // A reminder that never varies is written once rather than generated for every message.
  const staticReminder =
    reminder !== undefined && reminder.length === 0
      ? reminder()
      : undefined
  const userMessage = new UserMessage({
    text: prompt,
    messageId,
    mode: useAskMode ? AgentMode.ASK : AgentMode.AGENT,
    ...(selectedContext !== undefined ? { selectedContext } : {}),
    ...(staticReminder !== undefined && staticReminder !== ""
      ? { subagentSystemReminder: staticReminder }
      : {}),
  })
  return new ConversationAction({
    action: {
      case: "userMessageAction",
      value: new UserMessageAction({ userMessage }),
    },
  })
}

/** The part of a blob store this needs: turns and steps are read back by the id they were stored under. */
export interface ConversationBlobStore {
  getBlob(ctx: Context, blobId: Uint8Array): Promise<Uint8Array | undefined>
}

/** The last thing the subagent said, found by walking its turns backwards. */
export async function extractLastAssistantMessage(
  ctx: Context,
  turnIds: readonly Uint8Array[],
  blobStore: ConversationBlobStore,
): Promise<string | undefined> {
  for (let index = turnIds.length - 1; index >= 0; index -= 1) {
    const turnBytes = await blobStore.getBlob(ctx, turnIds[index]!)
    if (turnBytes === undefined) {
      continue
    }
    const turnValue = ConversationTurnStructure.fromBinary(turnBytes)
    if (turnValue.turn.case !== "agentConversationTurn") {
      continue
    }
    const steps = await collectConversationStepsFromStepBlobIds({
      ctx,
      stepBlobIds: turnValue.turn.value.steps,
      blobStore,
    })
    for (let position = steps.length - 1; position >= 0; position -= 1) {
      const stepValue = steps[position]!
      if (stepValue.message.case === "assistantMessage") {
        return stepValue.message.value.text
      }
    }
  }
  return undefined
}

/** A stepValue whose blob is gone is left out rather than treated as an empty stepValue. */
export async function collectConversationStepsFromStepBlobIds(input: {
  readonly ctx: Context
  readonly stepBlobIds: readonly Uint8Array[]
  readonly blobStore: ConversationBlobStore
}): Promise<ConversationStep[]> {
  const stepBlobs = await Promise.all(
    input.stepBlobIds.map((stepBlobId) => input.blobStore.getBlob(input.ctx, stepBlobId)),
  )
  return stepBlobs
    .filter((stepBlob): stepBlob is Uint8Array => stepBlob !== undefined)
    .map((stepBlob) => ConversationStep.fromBinary(stepBlob))
}

export async function collectConversationTurnStructures(input: {
  readonly ctx: Context
  readonly turns: readonly Uint8Array[]
  readonly blobStore: ConversationBlobStore
}): Promise<Array<ConversationTurnStructure | undefined>> {
  const turnBytes = await Promise.all(
    input.turns.map((turnBlobId) => input.blobStore.getBlob(input.ctx, turnBlobId)),
  )
  return turnBytes.map((turnBytes) =>
    turnBytes === undefined ? undefined : ConversationTurnStructure.fromBinary(turnBytes),
  )
}

export async function collectConversationStepsWithToolCallCount(
  ctx: Context,
  turns: readonly Uint8Array[],
  blobStore: ConversationBlobStore,
): Promise<{ readonly conversationSteps: ConversationStep[]; readonly toolCallCount: number }> {
  const turnStructures = await collectConversationTurnStructures({ ctx, turns, blobStore })
  const stepsByTurn = await Promise.all(
    turnStructures.map((turnValue) =>
      turnValue?.turn.case === "agentConversationTurn"
        ? collectConversationStepsFromStepBlobIds({
            ctx,
            stepBlobIds: turnValue.turn.value.steps,
            blobStore,
          })
        : [],
    ),
  )
  const conversationSteps = stepsByTurn.flat()
  return {
    conversationSteps,
    toolCallCount: conversationSteps.filter((stepValue) => stepValue.message.case === "toolCall").length,
  }
}

export async function countToolCallsFromTurns(
  ctx: Context,
  turns: readonly Uint8Array[],
  blobStore: ConversationBlobStore,
): Promise<number> {
  const result = await collectConversationStepsWithToolCallCount(ctx, turns, blobStore)
  return result.toolCallCount
}

export function taskEnvironmentToProto(
  environment: TaskEnvironment,
): SubagentExecutionEnvironment {
  switch (environment) {
    case "cloud":
      return SubagentExecutionEnvironment.CLOUD
    case "local":
      return SubagentExecutionEnvironment.LOCAL
    default:
      return SubagentExecutionEnvironment.UNSPECIFIED
  }
}

/** Where a placement runs, as the protocol spells it: only this machine is local. */
export function targetMachineToEnvironment(
  placement: TaskTargetMachine,
): SubagentExecutionEnvironment {
  return placement.type === "same_machine"
    ? SubagentExecutionEnvironment.LOCAL
    : SubagentExecutionEnvironment.CLOUD
}

export type ClientSubagentPlacement = {
  readonly environment: SubagentExecutionEnvironment
  readonly cloudBaseBranch: string | undefined
}

export function toClientSubagentPlacement(
  placement: TaskTargetMachine,
): ClientSubagentPlacement {
  switch (placement.type) {
    case "same_machine":
      return {
        environment: SubagentExecutionEnvironment.LOCAL,
        cloudBaseBranch: undefined,
      }
    case "new_cloud_vm":
      return {
        environment: SubagentExecutionEnvironment.CLOUD,
        cloudBaseBranch: placement.base_branch,
      }
    case "self_hosted_worker":
    case "self_hosted_pool":
      // A client-executed subagent runs where the client is, so it has no way to reach a worker.
      throw new ToolCallArgParseError(
        "Invalid arguments:\nSelf-hosted machine placement requires server-side first-class subagent execution and is not supported by a fresh client-executed Task.",
      )
  }
}

/** The older pair of environment fields, read into the placement they describe. */
export function targetMachineFromLegacyArgs(
  input: LegacyTaskTargetArgs,
): TaskTargetMachine {
  if (input.environment !== "cloud") {
    return { type: "same_machine" }
  }
  const baseBranch = input.cloud_base_branch?.trim()
  const buildId = input.cloud_requested_environment_build_id?.trim()
  return {
    type: "new_cloud_vm",
    ...(baseBranch !== undefined && baseBranch.length > 0
      ? { base_branch: baseBranch }
      : {}),
    ...(buildId !== undefined && buildId.length > 0
      ? { environment_build_id: buildId }
      : {}),
  }
}

export function targetMachineToProto(placement: TaskTargetMachine): TargetMachine {
  switch (placement.type) {
    case "same_machine":
      return new TargetMachine({
        machine: {
          case: "sameMachine",
          value: new SameMachineTarget(),
        },
      })
    case "new_cloud_vm":
      return new TargetMachine({
        machine: {
          case: "newCloudVm",
          value: new NewCloudVmTarget({
            ...(placement.environment_build_id !== undefined
              ? { environmentBuildId: placement.environment_build_id }
              : {}),
            ...(placement.base_branch !== undefined
              ? { baseBranch: placement.base_branch }
              : {}),
          }),
        },
      })
    case "self_hosted_worker":
      return new TargetMachine({
        machine: {
          case: "selfHostedWorker",
          value: new SelfHostedWorkerTarget({ workerId: placement.worker_id }),
        },
      })
    case "self_hosted_pool":
      return new TargetMachine({
        machine: {
          case: "selfHostedPool",
          value: new SelfHostedPoolTarget({
            ...(placement.pool !== undefined ? { pool: placement.pool } : {}),
            labels: Object.entries(placement.labels ?? {}).map(
              ([key, value]) => new SelfHostedWorkerLabel({ key, value }),
            ),
          }),
        },
      })
  }
}

export function targetMachineFromProto(
  wire: TargetMachine | undefined,
): TaskTargetMachine | undefined {
  switch (wire?.machine.case) {
    case "sameMachine":
      return { type: "same_machine" }
    case "newCloudVm":
      return {
        type: "new_cloud_vm",
        ...(wire.machine.value.environmentBuildId !== undefined
          ? { environment_build_id: wire.machine.value.environmentBuildId }
          : {}),
        ...(wire.machine.value.baseBranch !== undefined
          ? { base_branch: wire.machine.value.baseBranch }
          : {}),
      }
    case "selfHostedWorker":
      return {
        type: "self_hosted_worker",
        worker_id: wire.machine.value.workerId,
      }
    case "selfHostedPool":
      return {
        type: "self_hosted_pool",
        ...(wire.machine.value.pool !== undefined
          ? { pool: wire.machine.value.pool }
          : {}),
        // Labels are a map here and a list on the wire, and an empty list is no map at all.
        ...(wire.machine.value.labels.length > 0
          ? {
              labels: Object.fromEntries(
                wire.machine.value.labels.map((label) => [label.key, label.value]),
              ),
            }
          : {}),
      }
    default:
      return undefined
  }
}

export type CloudSubagentPersistedStateArgs = {
  readonly bcId: string
  readonly transcriptPath?: string
  readonly modelId?: string
  readonly machine: TaskTargetMachine
}

/** What a cloud subagent's state has to carry for it to be found and resumed later. */
export function buildCloudSubagentPersistedState(
  input: CloudSubagentPersistedStateArgs,
): SubagentPersistedState {
  return new SubagentPersistedState({
    environment: SubagentExecutionEnvironment.CLOUD,
    cloudSubagent: new CloudSubagentReference({
      bcId: input.bcId,
      ...(input.transcriptPath !== undefined
        ? { transcriptPath: input.transcriptPath }
        : {}),
    }),
    ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
    machine: targetMachineToProto(input.machine),
  })
}

/** A placement given both ways is ambiguous, and guessing which one was meant would place work wrongly. */
export function assertMachineAndLegacyArgsNotBothSet(
  input: TaskTargetValidationArgs,
): void {
  if (input.machine === undefined) {
    return
  }
  const conflictKeys: readonly (keyof LegacyTaskTargetArgs)[] = [
    "environment",
    "cloud_base_branch",
    "cloud_requested_environment_build_id",
  ]
  const conflicts = conflictKeys.filter((key) => input[key] !== undefined)
  if (conflicts.length > 0) {
    throw new ToolCallArgParseError(
      `Invalid arguments:\nmachine replaces ${conflicts.join(", ")}; specify machine alone.`,
    )
  }
}

export function assertCloudOnlyTaskArgsAllowed(
  input: LegacyTaskTargetArgs,
): void {
  const branchGiven =
    input.cloud_base_branch !== undefined && input.cloud_base_branch.trim().length > 0
  if (branchGiven && input.environment !== "cloud") {
    throw new ToolCallArgParseError(
      "Invalid arguments:\ncloud_base_branch may only be specified when environment equals cloud.",
    )
  }
  const buildGiven =
    input.cloud_requested_environment_build_id !== undefined &&
    input.cloud_requested_environment_build_id.trim().length > 0
  if (buildGiven && input.environment !== "cloud") {
    throw new ToolCallArgParseError(
      "Invalid arguments:\ncloud_requested_environment_build_id may only be specified when environment equals cloud.",
    )
  }
}
