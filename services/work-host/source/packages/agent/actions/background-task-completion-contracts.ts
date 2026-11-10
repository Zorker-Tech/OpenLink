export type SlateBackgroundTaskKind = "shell" | "subagent" | "unknown";
export type SlateBackgroundTaskStatus = "success" | "error" | "aborted" | "unknown";

export interface SlateBackgroundTaskCompletionCompatibility {
  readonly legacyKindCode?: number | undefined
  readonly legacyStatusCode?: number | undefined
  readonly legacyReasonCode?: number | undefined
  readonly legacyNotificationContextCode?: number | undefined
}

export interface SlateBackgroundTaskCompletion {
  readonly kind: SlateBackgroundTaskKind;
  readonly status: SlateBackgroundTaskStatus;
  readonly taskId: string;
  readonly title: string;
  readonly toolCallId?: string | undefined;
  readonly subagentId?: string | undefined;
  readonly detail?: string | undefined;
  readonly outputPath?: string | undefined;
  readonly reason?: "task-progress" | "worker-reparented" | undefined;
  readonly threadId?: string | undefined;
  readonly notificationContext?: "user-driven-interactive-child" | "other" | undefined;
  readonly compatibility?: SlateBackgroundTaskCompletionCompatibility | undefined;
}

/** Slate's versioned envelope for completed background work. */
export interface SlateBackgroundTaskCompletionActionPayload {
  readonly schema: "slate.agent-action.background-task-completion"
  readonly version: 1
  readonly completions: readonly SlateBackgroundTaskCompletion[]
  readonly compatibility?: {
    readonly legacyPayload?: Readonly<Record<string, unknown>> | undefined
  } | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string"
}

function optionalInteger(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isInteger(value))
}

export function isSlateBackgroundTaskCompletion(value: unknown): value is SlateBackgroundTaskCompletion {
  if (!isRecord(value) ||
      (value.kind !== "shell" && value.kind !== "subagent" && value.kind !== "unknown") ||
      (value.status !== "success" && value.status !== "error" && value.status !== "aborted" && value.status !== "unknown") ||
      typeof value.taskId !== "string" || typeof value.title !== "string" ||
      !optionalString(value.toolCallId) || !optionalString(value.subagentId) ||
      !optionalString(value.detail) || !optionalString(value.outputPath) || !optionalString(value.threadId) ||
      (value.reason !== undefined && value.reason !== "task-progress" && value.reason !== "worker-reparented") ||
      (value.notificationContext !== undefined && value.notificationContext !== "user-driven-interactive-child" && value.notificationContext !== "other")) {
    return false
  }
  if (value.compatibility === undefined) return true
  return isRecord(value.compatibility) &&
    optionalInteger(value.compatibility.legacyKindCode) &&
    optionalInteger(value.compatibility.legacyStatusCode) &&
    optionalInteger(value.compatibility.legacyReasonCode) &&
    optionalInteger(value.compatibility.legacyNotificationContextCode)
}

export function createSlateBackgroundTaskCompletionActionPayload(
  completions: readonly SlateBackgroundTaskCompletion[],
  compatibility?: SlateBackgroundTaskCompletionActionPayload["compatibility"],
): SlateBackgroundTaskCompletionActionPayload {
  return {
    schema: "slate.agent-action.background-task-completion",
    version: 1,
    completions: [...completions],
    ...(compatibility === undefined ? {} : { compatibility }),
  }
}

export function isSlateBackgroundTaskCompletionActionPayload(
  value: unknown,
): value is SlateBackgroundTaskCompletionActionPayload {
  if (!isRecord(value) || value.schema !== "slate.agent-action.background-task-completion" ||
      value.version !== 1 || !Array.isArray(value.completions) ||
      !value.completions.every(isSlateBackgroundTaskCompletion)) return false
  if (value.compatibility === undefined) return true
  if (!isRecord(value.compatibility)) return false
  return value.compatibility.legacyPayload === undefined || isRecord(value.compatibility.legacyPayload)
}
