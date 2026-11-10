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
import { fromRedactedBackgroundTaskCompletionAction } from "../redacted-protos/generated/agent/v1/agent_redacted.ts";
import { fromRedactedRepositoryIndexingInfo } from "../redacted-protos/generated/agent/v1/repo_redacted.ts";
import { fromRedactedRequestContext } from "../redacted-protos/generated/agent/v1/request_context_exec_redacted.ts";
import { fromRedactedSelectedContext } from "../redacted-protos/generated/agent/v1/selected_context_redacted.ts";
import { PrivacyCapability as RuntimePrivacyCapability } from "../../../packages/redaction/classification.ts";
import type { PrivacyMode } from "../../../packages/redaction/privacy-mode.ts";
import type {
  SlateBackgroundTaskCompletionActionPayload,
  SlateBackgroundTaskCompletion,
  SlateBackgroundTaskCompletionCompatibility,
  SlateBackgroundTaskKind,
  SlateBackgroundTaskStatus,
} from "../../../packages/agent/actions/background-task-completion-contracts.ts";
import { createSlateBackgroundTaskCompletionActionPayload } from "../../../packages/agent/actions/background-task-completion-contracts.ts";
import type { SlateMode } from "../../../packages/agent/mode-processing.ts";
import type { SlateUserMessage } from "../../../packages/agent/user-message-state.ts";
import { toInteropAgentMode } from "./mode-processing-adapter.ts";
import { fromInteropUserMessage, slateUserMessageAppendedUpdate } from "./user-message-action-protocol-adapter.ts";

export type StoredBackgroundCompletionAction = Parameters<typeof fromRedactedBackgroundTaskCompletionAction>[0];

function taskKind(kind: BackgroundTaskKind): { readonly value: SlateBackgroundTaskKind; readonly legacyCode?: number } {
  switch (kind) {
    case BackgroundTaskKind.UNSPECIFIED: return { value: "unknown" };
    case BackgroundTaskKind.SHELL: return { value: "shell" };
    case BackgroundTaskKind.SUBAGENT: return { value: "subagent" };
    default: return { value: "unknown", legacyCode: kind };
  }
}

function taskStatus(status: BackgroundTaskStatus): { readonly value: SlateBackgroundTaskStatus; readonly legacyCode?: number } {
  switch (status) {
    case BackgroundTaskStatus.UNSPECIFIED: return { value: "unknown" };
    case BackgroundTaskStatus.SUCCESS: return { value: "success" };
    case BackgroundTaskStatus.ERROR: return { value: "error" };
    case BackgroundTaskStatus.ABORTED: return { value: "aborted" };
    default: return { value: "unknown", legacyCode: status };
  }
}

function completionReason(reason: BackgroundTaskCompletionReason): {
  readonly value?: SlateBackgroundTaskCompletion["reason"];
  readonly legacyCode?: number;
} {
  switch (reason) {
    case BackgroundTaskCompletionReason.TASK_PROGRESS: return { value: "task-progress" };
    case BackgroundTaskCompletionReason.WORKER_REPARENTED: return { value: "worker-reparented" };
    case BackgroundTaskCompletionReason.UNSPECIFIED: return {};
    default: return { legacyCode: reason };
  }
}

function notificationContext(context: BackgroundTaskNotificationContext): {
  readonly value: NonNullable<SlateBackgroundTaskCompletion["notificationContext"]>;
  readonly legacyCode?: number;
} {
  switch (context) {
    case BackgroundTaskNotificationContext.UNSPECIFIED: return { value: "other" };
    case BackgroundTaskNotificationContext.USER_DRIVEN_INTERACTIVE_CHILD:
      return { value: "user-driven-interactive-child" };
    default: return { value: "other", legacyCode: context };
  }
}

export function fromInteropBackgroundTaskCompletion(
  completion: BackgroundTaskCompletion,
): SlateBackgroundTaskCompletion {
  const projectedKind = taskKind(completion.kind);
  const projectedStatus = taskStatus(completion.status);
  const projectedReason = completionReason(completion.reason);
  const projectedNotificationContext = notificationContext(completion.notificationContext);
  const compatibility: SlateBackgroundTaskCompletionCompatibility = {
    ...(projectedKind.legacyCode === undefined ? {} : { legacyKindCode: projectedKind.legacyCode }),
    ...(projectedStatus.legacyCode === undefined ? {} : { legacyStatusCode: projectedStatus.legacyCode }),
    ...(projectedReason.legacyCode === undefined ? {} : { legacyReasonCode: projectedReason.legacyCode }),
    ...(projectedNotificationContext.legacyCode === undefined
      ? {}
      : { legacyNotificationContextCode: projectedNotificationContext.legacyCode }),
  };
  return {
    kind: projectedKind.value,
    status: projectedStatus.value,
    taskId: completion.taskId,
    title: completion.title,
    ...(completion.toolCallId === undefined || completion.toolCallId.length === 0 ? {} : { toolCallId: completion.toolCallId }),
    ...(completion.subagentId === undefined || completion.subagentId.length === 0 ? {} : { subagentId: completion.subagentId }),
    ...(completion.detail === undefined || completion.detail.length === 0 ? {} : { detail: completion.detail }),
    ...(completion.outputPath === undefined || completion.outputPath.length === 0 ? {} : { outputPath: completion.outputPath }),
    ...(projectedReason.value === undefined ? {} : { reason: projectedReason.value }),
    ...(completion.threadId === undefined || completion.threadId.length === 0 ? {} : { threadId: completion.threadId }),
    notificationContext: projectedNotificationContext.value,
    ...(Object.keys(compatibility).length === 0 ? {} : { compatibility }),
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

/** Converts a historical action into the Slate route contract while retaining its recovery payload. */
export function slateBackgroundTaskCompletionActionFromRedacted(
  action: StoredBackgroundCompletionAction,
): SlateBackgroundTaskCompletionActionPayload {
  const decoded = decodeStoredBackgroundTaskCompletionAction(action);
  return createSlateBackgroundTaskCompletionActionPayload(decoded.completions, {
    legacyPayload: action as Readonly<Record<string, unknown>>,
  });
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
  readonly sourceMessage?: SlateUserMessage;
  readonly mode?: SlateMode | undefined;
  readonly metadata?: unknown;
  readonly threadId?: string | undefined;
  readonly privacyMode: PrivacyMode;
}): { readonly userMessage: UserMessage; readonly slateUserMessage: SlateUserMessage; readonly listenerUpdate: unknown } {
  const sourceMessage = input.sourceMessage;
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
    mode: input.mode !== undefined
      ? toInteropAgentMode(input.mode)
      : sourceMessage === undefined
        ? AgentMode.AGENT
        : toInteropAgentMode(sourceMessage.mode),
    isSimulatedMsg: true,
    simulatedMsgReason: SimulatedMsgReason.BACKGROUND_TASK_COMPLETION,
    ...(input.metadata === undefined ? {} : { simulatedMessageMetadata: input.metadata as never }),
  });
  if (input.threadId !== undefined && input.threadId.length > 0) userMessage.threadId = input.threadId;
  const slateUserMessage = fromInteropUserMessage(userMessage);
  return {
    userMessage,
    slateUserMessage,
    listenerUpdate: slateUserMessageAppendedUpdate(slateUserMessage, input.privacyMode),
  };
}
