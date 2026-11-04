export type SlateBackgroundTaskKind = "shell" | "subagent" | "unknown";
export type SlateBackgroundTaskStatus = "success" | "error" | "aborted" | "unknown";

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
}
