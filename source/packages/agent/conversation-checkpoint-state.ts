import type { SlateMode } from "./mode-processing.ts"
import type { SlateGoalStatus } from "../agent-core/goal-continuation.ts"

export type SlateCheckpointEnvironment = "unspecified" | "local" | "cloud"
export type SlateCheckpointRunStatus = "unspecified" | "running" | "backgrounded" | "success" | "error" | "aborted"
export type SlateCheckpointCompletionReason = "task-progress" | "worker-reparented"

export interface SlateCheckpointTokenCategory {
  readonly id: string
  readonly label: string
  readonly estimatedTokens: number
  readonly characterCount?: number
}

export interface SlateCheckpointPromptSource {
  readonly kind: string
  readonly messageIndex: number
  readonly contentPath: string
  readonly startOffset: number
  readonly endOffset: number
}

export interface SlateCheckpointPromptNode {
  readonly id: string
  readonly parentId?: string
  readonly kind: string
  readonly label: string
  readonly categoryId: string
  readonly estimatedTokens: number
  readonly characterCount: number
  readonly contentAvailable: boolean
  readonly source?: SlateCheckpointPromptSource
  readonly inlineContent?: string
}

export interface SlateCheckpointTokenUsage {
  readonly usedTokens: number
  readonly maximumTokens: number
  readonly breakdown?: {
    readonly totalUsedTokens: number
    readonly maximumTokens: number
    readonly categories: readonly SlateCheckpointTokenCategory[]
  }
  readonly contextTree?: {
    readonly version: number
    readonly nodes: readonly SlateCheckpointPromptNode[]
  }
  readonly usageSnapshotBlobId?: string
}

export interface SlateCheckpointTiming {
  readonly durationMs: string
  readonly recordedAtMs: string
}

export interface SlateCheckpointFileContents {
  readonly contentBlobId?: string
  readonly initialContentBlobId?: string
}

export interface SlateCheckpointPlanEntry {
  readonly planId: string
  readonly path: string
}

export interface SlateCheckpointTrackedRepository {
  readonly rootPath: string
  readonly branchName: string
}

export interface SlateCheckpointCommunicationHistoryEntry {
  readonly step: string
  readonly messageIndex: number
}

export interface SlateCheckpointCommunicationTurn {
  readonly history: readonly SlateCheckpointCommunicationHistoryEntry[]
  readonly finalSummary?: string
  readonly completedSubtitle?: string
}

export type SlateCheckpointSubagentKind =
  | "general-purpose"
  | "computer-use"
  | "custom"
  | "explore"
  | "video-review"
  | "shell"
  | "browser-use"
  | "environment-setup"
  | "debug"
  | "guide"
  | "watch-video"
  | "unknown"

export interface SlateCheckpointSubagentType {
  readonly kind: SlateCheckpointSubagentKind
  readonly customName?: string
  readonly compatibility?: { readonly legacyDiscriminator?: string }
}

export type SlateCheckpointTargetMachine =
  | { readonly kind: "unspecified" }
  | { readonly kind: "same-device" }
  | { readonly kind: "cloud-machine"; readonly baseBranch?: string; readonly environmentBuildId?: string }
  | { readonly kind: "hosted-worker"; readonly workerId: string }
  | { readonly kind: "worker-pool"; readonly pool?: string; readonly labels: readonly { readonly key: string; readonly value: string }[] }

export interface SlateCheckpointSubagent {
  readonly conversation?: SlateConversationCheckpointV2
  readonly createdAtMs: string
  readonly lastUsedAtMs: string
  readonly type?: SlateCheckpointSubagentType
  readonly modelId?: string
  readonly environment: SlateCheckpointEnvironment
  readonly compatibility?: {
    readonly legacyEnvironmentCode?: number
    readonly legacyUnknownFields?: readonly SlateCheckpointUnknownField[]
  }
  readonly cloudWorker?: { readonly workerId: string; readonly transcriptPath?: string }
  readonly firstClassCloudRunId?: string
  readonly requestedRuntimeBuildId?: string
  readonly targetMachine?: SlateCheckpointTargetMachine
}

export interface SlateCheckpointSubagentRun {
  readonly parentCallId: string
  readonly subagentId?: string
  readonly environment: SlateCheckpointEnvironment
  readonly status: SlateCheckpointRunStatus
  readonly title?: string
  readonly detail?: string
  readonly transcriptPath?: string
  readonly outputPath?: string
  readonly completedAtMs?: string
  readonly completionReason?: SlateCheckpointCompletionReason
  readonly compatibility?: {
    readonly legacyEnvironmentCode?: number
    readonly legacyStatusCode?: number
    readonly legacyCompletionReasonCode?: number
  }
}

export interface SlateCheckpointGoal {
  readonly conversationId: string
  readonly goalId: string
  readonly objective: string
  readonly status: SlateGoalStatus
  readonly idleContinuationsWithoutToolCalls: number
  readonly activeDurationMs?: string
  readonly lastAccruedAtMs?: string
  readonly continuationCount: number
  readonly agentSessionId?: string
}

export type SlateCheckpointUnknownFieldPathStep =
  | { readonly field: string }
  | { readonly index: number }
  | { readonly key: string }

export interface SlateCheckpointUnknownField {
  readonly path: readonly SlateCheckpointUnknownFieldPathStep[]
  readonly number: number
  readonly wireType: number
  readonly dataHex: string
}

/** Complete first-party snapshot stored in a Slate versioned conversation root. */
export interface SlateConversationCheckpointV2 {
  readonly promptMessageBlobIds: readonly string[]
  readonly todoBlobIds: readonly string[]
  readonly pendingOperationIds: readonly string[]
  readonly tokenUsage?: SlateCheckpointTokenUsage
  readonly summaryBlobId?: string
  readonly activePlanBlobId?: string
  readonly turnBlobIds: readonly string[]
  readonly workspaceUris: readonly string[]
  readonly mode?: SlateMode
  readonly summaryArchiveBlobId?: string
  readonly legacyFileContentBlobIds: Readonly<Record<string, string>>
  readonly summaryArchiveBlobIds: readonly string[]
  readonly turnTimings: readonly SlateCheckpointTiming[]
  readonly fileContentBlobIds: Readonly<Record<string, SlateCheckpointFileContents>>
  readonly subagents: Readonly<Record<string, SlateCheckpointSubagent>>
  readonly selfSummaryCount: number
  readonly readPaths: readonly string[]
  readonly activeBranchName?: string
  readonly planRegistry: Readonly<Record<string, SlateCheckpointPlanEntry>>
  readonly trackedRepositories: readonly SlateCheckpointTrackedRepository[]
  readonly agentKind?: string
  readonly communicationHistory: readonly SlateCheckpointCommunicationHistoryEntry[]
  readonly subagentThreads: Readonly<Record<string, string>>
  readonly communicationFinalSummary?: string
  readonly conversationStartedAtMs?: string
  readonly conversationTimeZone?: string
  readonly communicationCompletedSubtitle?: string
  readonly communicationTurnsByCallId: Readonly<Record<string, SlateCheckpointCommunicationTurn>>
  readonly subagentRunsByCallId: Readonly<Record<string, SlateCheckpointSubagentRun>>
  readonly subagentStateBlobIds: Readonly<Record<string, string>>
  readonly goal?: SlateCheckpointGoal
  readonly isRootConversation?: boolean
  readonly completedQuestionCallIds: readonly string[]
  readonly compatibility?: {
    readonly legacyModeCode?: number
    readonly legacyUnknownFields?: readonly SlateCheckpointUnknownField[]
  }
}

/** Creates the canonical, valid empty root for Slate's durable conversation store. */
export function createEmptySlateConversationCheckpointV2(): SlateConversationCheckpointV2 {
  return {
    promptMessageBlobIds: [],
    todoBlobIds: [],
    pendingOperationIds: [],
    turnBlobIds: [],
    workspaceUris: [],
    legacyFileContentBlobIds: {},
    summaryArchiveBlobIds: [],
    turnTimings: [],
    fileContentBlobIds: {},
    subagents: {},
    selfSummaryCount: 0,
    readPaths: [],
    planRegistry: {},
    trackedRepositories: [],
    communicationHistory: [],
    subagentThreads: {},
    communicationTurnsByCallId: {},
    subagentRunsByCallId: {},
    subagentStateBlobIds: {},
    completedQuestionCallIds: [],
  }
}

const SLATE_MODES = new Set<string>([
  "agent",
  "chat",
  "plan",
  "debug",
  "triage",
  "project",
  "multitask",
  "custom",
  "unspecified",
])
const GOAL_STATUSES = new Set<string>(["unspecified", "active", "paused", "complete", "cleared"])
const ENVIRONMENTS = new Set<string>(["unspecified", "local", "cloud"])
const RUN_STATUSES = new Set<string>(["unspecified", "running", "backgrounded", "success", "error", "aborted"])
const TARGET_KINDS = new Set<string>(["unspecified", "same-device", "cloud-machine", "hosted-worker", "worker-pool"])
const SUBAGENT_KINDS = new Set<string>([
  "general-purpose", "computer-use", "custom", "explore", "video-review", "shell", "browser-use",
  "environment-setup", "debug", "guide", "watch-video", "unknown",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}

function isText(value: unknown): value is string {
  return typeof value === "string"
}

function isOptionalText(value: unknown): boolean {
  return value === undefined || isText(value)
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value)
}

function isUint32(value: unknown): value is number {
  return isInteger(value) && value >= 0 && value <= 0xffff_ffff
}

function isEnumCode(value: unknown): value is number {
  return isInteger(value) && value >= -0x8000_0000 && value <= 0x7fff_ffff
}

function isDecimal(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)
}

function isHex(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{2})*$/.test(value)
}

function isTextList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isText)
}

function isTextMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(isText)
}

function isDecimalOptional(value: unknown): boolean {
  return value === undefined || isDecimal(value)
}

function isHexOptional(value: unknown): boolean {
  return value === undefined || isHex(value)
}

function isRecordOf(value: unknown, check: (entry: unknown) => boolean): value is Record<string, unknown> {
  return isRecord(value) && Object.values(value).every(check)
}

function isUnknownField(value: unknown): value is SlateCheckpointUnknownField {
  if (!isRecord(value) || !hasOnlyKeys(value, ["path", "number", "wireType", "dataHex"])) return false
  if (!Array.isArray(value.path) || !isInteger(value.number) || value.number < 1 ||
      !isInteger(value.wireType) || value.wireType < 0 || value.wireType > 5 || !isHex(value.dataHex)) return false
  return value.path.every(step => {
    if (!isRecord(step)) return false
    if (hasOnlyKeys(step, ["field"]) && Object.keys(step).length === 1) return isText(step.field)
    if (hasOnlyKeys(step, ["index"]) && Object.keys(step).length === 1) return isInteger(step.index) && step.index >= 0
    if (hasOnlyKeys(step, ["key"]) && Object.keys(step).length === 1) return isText(step.key)
    return false
  })
}

function isTokenCategory(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ["id", "label", "estimatedTokens", "characterCount"]) &&
    isText(value.id) && isText(value.label) && isUint32(value.estimatedTokens) &&
    (value.characterCount === undefined || isUint32(value.characterCount))
}

function isPromptSource(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ["kind", "messageIndex", "contentPath", "startOffset", "endOffset"]) &&
    isText(value.kind) && isUint32(value.messageIndex) && isText(value.contentPath) &&
    isUint32(value.startOffset) && isUint32(value.endOffset)
}

function isPromptNode(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "id", "parentId", "kind", "label", "categoryId", "estimatedTokens", "characterCount",
    "contentAvailable", "source", "inlineContent",
  ])) return false
  return isText(value.id) && isOptionalText(value.parentId) && isText(value.kind) && isText(value.label) &&
    isText(value.categoryId) && isUint32(value.estimatedTokens) && isUint32(value.characterCount) &&
    typeof value.contentAvailable === "boolean" && isOptionalText(value.inlineContent) &&
    (value.source === undefined || isPromptSource(value.source))
}

function isTokenUsage(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ["usedTokens", "maximumTokens", "breakdown", "contextTree", "usageSnapshotBlobId"])) return false
  if (!isUint32(value.usedTokens) || !isUint32(value.maximumTokens) || !isHexOptional(value.usageSnapshotBlobId)) return false
  if (value.breakdown !== undefined) {
    const breakdown = value.breakdown
    if (!isRecord(breakdown) || !hasOnlyKeys(breakdown, ["totalUsedTokens", "maximumTokens", "categories"]) ||
        !isUint32(breakdown.totalUsedTokens) || !isUint32(breakdown.maximumTokens) ||
        !Array.isArray(breakdown.categories) || !breakdown.categories.every(isTokenCategory)) return false
  }
  if (value.contextTree !== undefined) {
    const tree = value.contextTree
    if (!isRecord(tree) || !hasOnlyKeys(tree, ["version", "nodes"]) || !isUint32(tree.version) ||
        !Array.isArray(tree.nodes) || !tree.nodes.every(isPromptNode)) return false
  }
  return true
}

function isTiming(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ["durationMs", "recordedAtMs"]) &&
    isDecimal(value.durationMs) && isDecimal(value.recordedAtMs)
}

function isFileContents(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ["contentBlobId", "initialContentBlobId"]) &&
    isHexOptional(value.contentBlobId) && isHexOptional(value.initialContentBlobId)
}

function isPlanEntry(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ["planId", "path"]) && isText(value.planId) && isText(value.path)
}

function isTrackedRepository(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ["rootPath", "branchName"]) && isText(value.rootPath) && isText(value.branchName)
}

function isCommunicationHistoryEntry(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ["step", "messageIndex"]) &&
    isText(value.step) && isUint32(value.messageIndex)
}

function isCommunicationTurn(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ["history", "finalSummary", "completedSubtitle"]) &&
    Array.isArray(value.history) && value.history.every(isCommunicationHistoryEntry) &&
    isOptionalText(value.finalSummary) && isOptionalText(value.completedSubtitle)
}

function isSubagentType(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ["kind", "customName", "compatibility"]) ||
      !isText(value.kind) || !SUBAGENT_KINDS.has(value.kind) || !isOptionalText(value.customName)) return false
  return value.compatibility === undefined || (
    isRecord(value.compatibility) && hasOnlyKeys(value.compatibility, ["legacyDiscriminator"]) &&
    isOptionalText(value.compatibility.legacyDiscriminator)
  )
}

function isTargetMachine(value: unknown): boolean {
  if (!isRecord(value) || !isText(value.kind) || !TARGET_KINDS.has(value.kind)) return false
  switch (value.kind) {
    case "unspecified":
    case "same-device":
      return hasOnlyKeys(value, ["kind"])
    case "cloud-machine":
      return hasOnlyKeys(value, ["kind", "baseBranch", "environmentBuildId"]) &&
        isOptionalText(value.baseBranch) && isOptionalText(value.environmentBuildId)
    case "hosted-worker":
      return hasOnlyKeys(value, ["kind", "workerId"]) && isText(value.workerId)
    case "worker-pool":
      return hasOnlyKeys(value, ["kind", "pool", "labels"]) && isOptionalText(value.pool) &&
        Array.isArray(value.labels) && value.labels.every(label =>
          isRecord(label) && hasOnlyKeys(label, ["key", "value"]) && isText(label.key) && isText(label.value))
    default:
      return false
  }
}

function isSubagent(value: unknown): value is SlateCheckpointSubagent {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "conversation", "createdAtMs", "lastUsedAtMs", "type", "modelId", "environment",
    "compatibility", "cloudWorker", "firstClassCloudRunId", "requestedRuntimeBuildId", "targetMachine",
  ])) return false
  if (!isDecimal(value.createdAtMs) || !isDecimal(value.lastUsedAtMs) || !isText(value.environment) ||
      !ENVIRONMENTS.has(value.environment) ||
      !isOptionalText(value.modelId) || !isOptionalText(value.firstClassCloudRunId) ||
      !isOptionalText(value.requestedRuntimeBuildId) ||
      (value.type !== undefined && !isSubagentType(value.type)) ||
      (value.targetMachine !== undefined && !isTargetMachine(value.targetMachine))) return false
  if (value.compatibility !== undefined &&
      (!isRecord(value.compatibility) || !hasOnlyKeys(value.compatibility, ["legacyEnvironmentCode", "legacyUnknownFields"]) ||
        (value.compatibility.legacyEnvironmentCode !== undefined &&
          (!isEnumCode(value.compatibility.legacyEnvironmentCode) || value.environment !== "unspecified")) ||
        (value.compatibility.legacyUnknownFields !== undefined &&
          (!Array.isArray(value.compatibility.legacyUnknownFields) || !value.compatibility.legacyUnknownFields.every(isUnknownField))))) return false
  if (value.cloudWorker !== undefined) {
    const worker = value.cloudWorker
    if (!isRecord(worker) || !hasOnlyKeys(worker, ["workerId", "transcriptPath"]) ||
        !isText(worker.workerId) || !isOptionalText(worker.transcriptPath)) return false
  }
  return value.conversation === undefined || isRecord(value.conversation)
}

function isSubagentRun(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "parentCallId", "subagentId", "environment", "status",
    "title", "detail", "transcriptPath", "outputPath", "completedAtMs", "completionReason",
    "compatibility",
  ])) return false
  return isText(value.parentCallId) && isOptionalText(value.subagentId) && isText(value.environment) &&
    ENVIRONMENTS.has(value.environment) && isText(value.status) && RUN_STATUSES.has(value.status) &&
    isOptionalText(value.title) && isOptionalText(value.detail) && isOptionalText(value.transcriptPath) &&
    isOptionalText(value.outputPath) && isDecimalOptional(value.completedAtMs) &&
    (value.completionReason === undefined || value.completionReason === "task-progress" || value.completionReason === "worker-reparented") &&
    (value.compatibility === undefined || (
      isRecord(value.compatibility) && hasOnlyKeys(value.compatibility, [
        "legacyEnvironmentCode", "legacyStatusCode", "legacyCompletionReasonCode",
      ]) &&
      (value.compatibility.legacyEnvironmentCode === undefined ||
        (isEnumCode(value.compatibility.legacyEnvironmentCode) && value.environment === "unspecified")) &&
      (value.compatibility.legacyStatusCode === undefined ||
        (isEnumCode(value.compatibility.legacyStatusCode) && value.status === "unspecified")) &&
      (value.compatibility.legacyCompletionReasonCode === undefined ||
        (isEnumCode(value.compatibility.legacyCompletionReasonCode) && value.completionReason === undefined))
    ))
}

function isGoal(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "conversationId", "goalId", "objective", "status",
    "idleContinuationsWithoutToolCalls", "activeDurationMs", "lastAccruedAtMs", "continuationCount", "agentSessionId",
  ])) return false
  return isText(value.conversationId) && isText(value.goalId) && isText(value.objective) &&
    isText(value.status) && GOAL_STATUSES.has(value.status) &&
    isUint32(value.idleContinuationsWithoutToolCalls) && isDecimalOptional(value.activeDurationMs) &&
    isDecimalOptional(value.lastAccruedAtMs) && isUint32(value.continuationCount) && isOptionalText(value.agentSessionId)
}

function isStateRecord(value: unknown): value is SlateConversationCheckpointV2 {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "promptMessageBlobIds", "todoBlobIds", "pendingOperationIds", "tokenUsage", "summaryBlobId", "activePlanBlobId",
    "turnBlobIds", "workspaceUris", "mode", "unknownModeCode", "summaryArchiveBlobId", "legacyFileContentBlobIds",
    "summaryArchiveBlobIds", "turnTimings", "fileContentBlobIds", "subagents", "selfSummaryCount", "readPaths",
    "activeBranchName", "planRegistry", "trackedRepositories", "agentKind", "communicationHistory", "subagentThreads",
    "communicationFinalSummary", "conversationStartedAtMs", "conversationTimeZone", "communicationCompletedSubtitle",
    "communicationTurnsByCallId", "subagentRunsByCallId", "subagentStateBlobIds", "goal", "isRootConversation",
    "completedQuestionCallIds", "compatibility",
  ])) return false
  if (!isTextList(value.promptMessageBlobIds) || !value.promptMessageBlobIds.every(isHex) ||
      !isTextList(value.todoBlobIds) || !value.todoBlobIds.every(isHex) ||
      !isTextList(value.pendingOperationIds) || !isText(value.summaryBlobId ?? "") || !isHexOptional(value.summaryBlobId) ||
      !isHexOptional(value.activePlanBlobId) || !isTextList(value.turnBlobIds) || !value.turnBlobIds.every(isHex) ||
      !isTextList(value.workspaceUris) || !isTextList(value.summaryArchiveBlobIds) || !value.summaryArchiveBlobIds.every(isHex) ||
      !isHexOptional(value.summaryArchiveBlobId) || !isTextMap(value.legacyFileContentBlobIds) ||
      !Object.values(value.legacyFileContentBlobIds).every(isHex) ||
      !Array.isArray(value.turnTimings) || !value.turnTimings.every(isTiming) ||
      !isRecordOf(value.fileContentBlobIds, isFileContents) ||
      !isRecordOf(value.subagents, isSubagent) || !isUint32(value.selfSummaryCount) ||
      !isTextList(value.readPaths) || !isOptionalText(value.activeBranchName) ||
      !isRecordOf(value.planRegistry, isPlanEntry) ||
      !Array.isArray(value.trackedRepositories) || !value.trackedRepositories.every(isTrackedRepository) ||
      !isOptionalText(value.agentKind) ||
      !Array.isArray(value.communicationHistory) || !value.communicationHistory.every(isCommunicationHistoryEntry) ||
      !isTextMap(value.subagentThreads) || !isOptionalText(value.communicationFinalSummary) ||
      !isDecimalOptional(value.conversationStartedAtMs) || !isOptionalText(value.conversationTimeZone) ||
      !isOptionalText(value.communicationCompletedSubtitle) ||
      !isRecordOf(value.communicationTurnsByCallId, isCommunicationTurn) ||
      !isRecordOf(value.subagentRunsByCallId, isSubagentRun) ||
      !isTextMap(value.subagentStateBlobIds) || !Object.values(value.subagentStateBlobIds).every(isHex) ||
      (value.goal !== undefined && !isGoal(value.goal)) ||
      (value.isRootConversation !== undefined && typeof value.isRootConversation !== "boolean") ||
      !isTextList(value.completedQuestionCallIds)) return false
  if (value.tokenUsage !== undefined && !isTokenUsage(value.tokenUsage)) return false
  if (value.mode !== undefined && (!isText(value.mode) || !SLATE_MODES.has(value.mode))) return false
  if (value.compatibility !== undefined) {
    const compatibility = value.compatibility
    if (!isRecord(compatibility) || !hasOnlyKeys(compatibility, ["legacyModeCode", "legacyUnknownFields"]) ||
        (compatibility.legacyModeCode !== undefined &&
          (!isEnumCode(compatibility.legacyModeCode) || value.mode !== "unspecified")) ||
        (compatibility.legacyUnknownFields !== undefined &&
          (!Array.isArray(compatibility.legacyUnknownFields) || !compatibility.legacyUnknownFields.every(isUnknownField)))) return false
  }
  return true
}

/** Validates the complete Slate checkpoint model, including recursively stored subagent conversations. */
export function isSlateConversationCheckpointV2(value: unknown): value is SlateConversationCheckpointV2 {
  const pending: unknown[] = [value]
  while (pending.length > 0) {
    const current = pending.pop()
    if (!isStateRecord(current)) return false
    for (const subagent of Object.values(current.subagents)) {
      if (subagent.conversation !== undefined) pending.push(subagent.conversation)
    }
  }
  return true
}
