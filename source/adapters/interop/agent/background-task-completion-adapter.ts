/** Decodes stored background-completion messages into the task data used by Slate's follow-up policy. */

import {
  AgentMode,
  BackgroundTaskCompletion,
  BackgroundTaskCompletionReason,
  BackgroundTaskKind,
  BackgroundTaskNotificationContext,
  BackgroundTaskStatus,
  SimulatedMsgReason,
  UserMessage,
} from "../proto/generated/agent/v1/agent_pb.ts";
import { SelectedContext } from "../proto/generated/agent/v1/selected_context_pb.ts";
import {
  fromRedactedBackgroundTaskCompletionAction,
  toRedactedInteractionUpdate,
} from "../redacted-protos/generated/agent/v1/agent_redacted.ts";
import { fromRedactedRepositoryIndexingInfo } from "../redacted-protos/generated/agent/v1/repo_redacted.ts";
import { fromRedactedRequestContext } from "../redacted-protos/generated/agent/v1/request_context_exec_redacted.ts";
import { fromRedactedSelectedContext } from "../redacted-protos/generated/agent/v1/selected_context_redacted.ts";
import { Updates } from "../../../packages/agent-core/interaction-updates.ts";
import { PrivacyCapability as RuntimePrivacyCapability } from "../../../packages/redaction/classification.ts";
import type { PrivacyMode } from "../../../packages/redaction/privacy-mode.ts";
import type {
  SlateBackgroundTaskCompletion,
  SlateBackgroundTaskKind,
  SlateBackgroundTaskStatus,
} from "../../../packages/agent/actions/background-task-completion-contracts.ts";
import type { SlateMode } from "../../../packages/agent/mode-processing.ts";
import { toInteropAgentMode } from "./mode-processing-adapter.ts";

export type StoredBackgroundCompletionAction = Parameters<typeof fromRedactedBackgroundTaskCompletionAction>[0];

function taskKind(kind: BackgroundTaskKind): SlateBackgroundTaskKind {
  switch (kind) {
    case BackgroundTaskKind.SHELL: return "shell";
    case BackgroundTaskKind.SUBAGENT: return "subagent";
    default: return "unknown";
  }
}

function taskStatus(status: BackgroundTaskStatus): SlateBackgroundTaskStatus {
  switch (status) {
    case BackgroundTaskStatus.SUCCESS: return "success";
    case BackgroundTaskStatus.ERROR: return "error";
    case BackgroundTaskStatus.ABORTED: return "aborted";
    default: return "unknown";
  }
}

export function fromInteropBackgroundTaskCompletion(
  completion: BackgroundTaskCompletion,
): SlateBackgroundTaskCompletion {
  return {
    kind: taskKind(completion.kind),
    status: taskStatus(completion.status),
    taskId: completion.taskId,
    title: completion.title,
    ...(completion.toolCallId === undefined || completion.toolCallId.length === 0 ? {} : { toolCallId: completion.toolCallId }),
    ...(completion.subagentId === undefined || completion.subagentId.length === 0 ? {} : { subagentId: completion.subagentId }),
    ...(completion.detail === undefined || completion.detail.length === 0 ? {} : { detail: completion.detail }),
    ...(completion.outputPath === undefined || completion.outputPath.length === 0 ? {} : { outputPath: completion.outputPath }),
    ...(completion.reason === BackgroundTaskCompletionReason.TASK_PROGRESS
      ? { reason: "task-progress" as const }
      : completion.reason === BackgroundTaskCompletionReason.WORKER_REPARENTED
        ? { reason: "worker-reparented" as const }
        : {}),
    ...(completion.threadId === undefined || completion.threadId.length === 0 ? {} : { threadId: completion.threadId }),
    ...(completion.notificationContext === BackgroundTaskNotificationContext.USER_DRIVEN_INTERACTIVE_CHILD
      ? { notificationContext: "user-driven-interactive-child" as const }
      : { notificationContext: "other" as const }),
  };
}

export function decodeStoredBackgroundTaskCompletionAction(
  action: StoredBackgroundCompletionAction,
): {
  readonly storedCompletions: readonly BackgroundTaskCompletion[];
  readonly completions: readonly SlateBackgroundTaskCompletion[];
} {
  const decoded = fromRedactedBackgroundTaskCompletionAction(
    action,
    RuntimePrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
    undefined,
  );
  return {
    storedCompletions: decoded.completions,
    completions: decoded.completions.map(fromInteropBackgroundTaskCompletion),
  };
}

export interface BackgroundCompletionRequestContextView {
  readonly promptContext: unknown;
  readonly tools: unknown;
  readonly repositoryInfos: readonly unknown[];
  readonly timeZone?: string | undefined;
}

export function projectBackgroundCompletionRequestContext(
  redactedContext: unknown,
): BackgroundCompletionRequestContextView {
  const storedContext = redactedContext as Parameters<typeof fromRedactedRequestContext>[0];
  const context = fromRedactedRequestContext(
    storedContext,
    RuntimePrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
    undefined,
  );
  const tools = (redactedContext as { readonly tools?: unknown }).tools;
  return {
    promptContext: context,
    tools,
    repositoryInfos: context.repositoryInfo.map(repository =>
      fromRedactedRepositoryIndexingInfo(
        repository as Parameters<typeof fromRedactedRepositoryIndexingInfo>[0],
        RuntimePrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
        undefined,
      )
    ),
    ...(context.env?.timeZone === undefined ? {} : { timeZone: context.env.timeZone }),
  };
}

export function createBackgroundCompletionUserMessage(input: {
  readonly text: string;
  readonly messageId: string;
  readonly sourceMessage?: unknown;
  readonly mode?: SlateMode | undefined;
  readonly metadata?: unknown;
  readonly threadId?: string | undefined;
  readonly privacyMode: PrivacyMode;
}): { readonly userMessage: UserMessage; readonly listenerUpdate: unknown } {
  const sourceMessage = input.sourceMessage as {
    readonly selectedContext?: Parameters<typeof fromRedactedSelectedContext>[0] | undefined;
    readonly mode?: AgentMode | undefined;
  } | undefined;
  const selectedContext = sourceMessage?.selectedContext === undefined
    ? new SelectedContext()
    : fromRedactedSelectedContext(
        sourceMessage.selectedContext,
        RuntimePrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
        undefined,
      );
  const userMessage = new UserMessage({
    text: input.text,
    messageId: input.messageId,
    selectedContext,
    mode: input.mode === undefined
      ? sourceMessage?.mode ?? AgentMode.AGENT
      : toInteropAgentMode(input.mode),
    isSimulatedMsg: true,
    simulatedMsgReason: SimulatedMsgReason.BACKGROUND_TASK_COMPLETION,
    ...(input.metadata === undefined ? {} : { simulatedMessageMetadata: input.metadata as never }),
  });
  if (input.threadId !== undefined && input.threadId.length > 0) userMessage.threadId = input.threadId;
  return {
    userMessage,
    listenerUpdate: toRedactedInteractionUpdate(
      Updates.userMessageAppended(userMessage),
      input.privacyMode,
    ),
  };
}
