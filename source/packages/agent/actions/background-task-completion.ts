/**
 * What a turn is told when a task it started in the background has finished.
 *
 * A background task — a shell command or a subagent — outlives the turn that started it, so its taskResult
 * arrives as a notification the model has to read as a notification: what finished, how it ended, where its
 * output is, and what to do about it. The last part is the one worth getting right, because the model's
 * instinct is to repeat what the subagent already said. When the user can already see the result, the
 * notification says so and asks for follow-ups rather than a summary; when the result is not visible, it
 * asks for whatever follow-up the taskResult needs. A subagent the user is driving themselves is a third
 * case: the taskResult is recorded for coordination and nothing is said to the user at all.
 *
 * Two shapes of notification are produced from the same taskResults. The ordinary one is a notification
 * section listing each task with its status and output path, which is what a parent agent reads. The
 * meta-parent one wraps each result in its own response element with a reminder above it, because a
 * coordinator reading several children's results needs them told apart rather than listed.
 *
 * What arrives in a completion is data, not markup: a title or a detail that happens to contain a closing
 * tag would otherwise end the section early and turn the rest of the notification into instructions. Those
 * are neutralized on the way in, and the ids are escaped, so nothing a task reports can change the shape of
 * the message it arrives in.
 */

import {
  BackgroundTaskCompletion,
  BackgroundTaskCompletionReason,
  BackgroundTaskKind,
  BackgroundTaskNotificationContext,
  BackgroundTaskStatus,
} from "../../proto/generated/agent/v1/agent_pb.ts"
import { SYSTEM_NOTIFICATION_TAG } from "../../constants/system-notification.ts"
import { META_PARENT_COMPLETION_CLOSE_TAG, META_PARENT_COMPLETION_OPEN_TAG, META_PARENT_COMPLETION_SYSTEM_REMINDER } from "../utils/notification-protocol.ts"
import { escapePromptXmlText } from "../utils/prompt-xml-escape.ts"
import { buildTimestampPrefix } from "../state.ts"
import { jsx, jsxs, type PromptProps, type PromptNode } from "../../prompt-jsx/element.ts"
import { renderContent } from "../../prompt-jsx/render-prompt.ts"

export const SUBAGENT_NOTIFICATION_VISIBLE_SUMMARY_LEAD = "The beginning of the above subagent result is already visible to the user.";
const SUBAGENT_NOTIFICATION_ACKNOWLEDGEMENT_USER_QUERY_WITH_VISIBLE_SUMMARY_BASE = `${SUBAGENT_NOTIFICATION_VISIBLE_SUMMARY_LEAD} Perform any follow-up actions (if needed). DO NOT regurgitate or reiterate its result unless asked. If multiple subagents have now completed and none are still running, briefly summarize the findings and conclusions across all of them. Otherwise, if no follow-ups remain, end your response with a brief third-person confirmation that the subagent has completed.`;
const SUBAGENT_NOTIFICATION_HIDDEN_SUMMARY_LEAD = "Perform any necessary follow-up actions in response to the subagent completion above.";
const SUBAGENT_NOTIFICATION_ACKNOWLEDGEMENT_USER_QUERY_HIDDEN_SUMMARY_BASE = `${SUBAGENT_NOTIFICATION_HIDDEN_SUMMARY_LEAD} If no follow-up work is needed, no further action is required.`;
const SUBAGENT_NOTIFICATION_CHAT_LINK_INSTRUCTION = " If you mention an agent or subagent in your response, link it with the `[label](id)` format using the agent_id or task_id from the notification instead of printing the raw ID.";
const SUBAGENT_NOTIFICATION_NAMED_LINK_INSTRUCTION = " If you mention an agent or subagent in your response, link it with the `[Name](id)` Don't use generic label such as `[agent]`, `[worker]`, or `[subagent]`.";
const SUBAGENT_NOTIFICATION_CLOUD_VIEW_LINK_INSTRUCTION = " For cloud subagents, when the agent has edited code, link to `[Review](bc-id#changes)`, or, if you know the exact added and deleted line counts, `[Review +A −D](bc-id#changes)`, replacing A and D with the actual counts. Never write A or D literally. Use `[Try Live](bc-id#desktop)` only when the agent used computer use.";
const SUBAGENT_NOTIFICATION_ACKNOWLEDGEMENT_USER_QUERY_SUFFIX = " Don't repeat the same confirmation every time.";
const USER_DRIVEN_INTERACTIVE_CHILD_LEAD = "The user is actively driving this Project child.";
const USER_DRIVEN_INTERACTIVE_CHILD_ACKNOWLEDGEMENT_USER_QUERY_BASE = `${USER_DRIVEN_INTERACTIVE_CHILD_LEAD} Record the taskResult for coordination, but do not message the user or take over the child thread. If no coordinator bookkeeping is required, end without further action.`;
const SHELL_NOTIFICATION_ACKNOWLEDGEMENT_USER_QUERY_BASE = "Briefly inform the user about the task result and perform any follow-up actions (if needed).";
const SHELL_NOTIFICATION_ACKNOWLEDGEMENT_USER_QUERY = `<user_query>${SHELL_NOTIFICATION_ACKNOWLEDGEMENT_USER_QUERY_BASE}</user_query>`;
const COMPOSER_SHELL_NOTIFICATION_ACKNOWLEDGEMENT_USER_QUERY = `<user_query>${SHELL_NOTIFICATION_ACKNOWLEDGEMENT_USER_QUERY_BASE} If there's no follow-ups needed, don't explicitly say that.</user_query>`;

export interface BackgroundCompletionFormatOptions {
  readonly timeZone?: string;
  readonly includeTimestamp: boolean;
  readonly modelInfo?: { readonly isComposer1?: boolean; readonly isComposer15?: boolean; readonly isComposer2?: boolean; readonly isComposerMatterhorn?: boolean };
  readonly enableAgentChatLinks: boolean;
  readonly hideAsyncSubagentTaskNotifications: boolean;
  readonly includeCloudSubagentViewLinks: boolean;
}

function wrapUserQuery(wrapped: string): string { return `<user_query>${wrapped}</user_query>`; }

export function neutralizeBackgroundTaskDetailCloseTags(detail: string): string {
  return detail.replace(/<\/\s*(task|system_notification)\s*>/gi, "&lt;/$1>").replace(/<(\/?)\s*user_query\s*>/gi, "&lt;$1user_query>");
}

export function getShellNotificationAcknowledgementUserQuery(modelInfo: BackgroundCompletionFormatOptions["modelInfo"]): string {
  if (modelInfo?.isComposer1 || modelInfo?.isComposer15 || modelInfo?.isComposer2 || modelInfo?.isComposerMatterhorn) return COMPOSER_SHELL_NOTIFICATION_ACKNOWLEDGEMENT_USER_QUERY;
  return SHELL_NOTIFICATION_ACKNOWLEDGEMENT_USER_QUERY;
}

export function getNotificationAcknowledgementUserQuery(
  taskResults: readonly BackgroundTaskCompletion[],
  formatOptions: BackgroundCompletionFormatOptions,
): string {
  if (taskResults.length > 0 && taskResults.every(taskResult => taskResult.notificationContext === BackgroundTaskNotificationContext.USER_DRIVEN_INTERACTIVE_CHILD)) return wrapUserQuery(`${USER_DRIVEN_INTERACTIVE_CHILD_ACKNOWLEDGEMENT_USER_QUERY_BASE}${SUBAGENT_NOTIFICATION_ACKNOWLEDGEMENT_USER_QUERY_SUFFIX}`);
  for (const taskResult of taskResults) {
    if (taskResult.kind === BackgroundTaskKind.SUBAGENT) {
      const basePrompt = formatOptions.hideAsyncSubagentTaskNotifications ? SUBAGENT_NOTIFICATION_ACKNOWLEDGEMENT_USER_QUERY_HIDDEN_SUMMARY_BASE : SUBAGENT_NOTIFICATION_ACKNOWLEDGEMENT_USER_QUERY_WITH_VISIBLE_SUMMARY_BASE;
      let chatLinkInstruction = "";
      if (formatOptions.enableAgentChatLinks) {
        if (formatOptions.hideAsyncSubagentTaskNotifications) {
          chatLinkInstruction = SUBAGENT_NOTIFICATION_NAMED_LINK_INSTRUCTION;
          if (formatOptions.includeCloudSubagentViewLinks) chatLinkInstruction += SUBAGENT_NOTIFICATION_CLOUD_VIEW_LINK_INSTRUCTION;
        } else chatLinkInstruction = SUBAGENT_NOTIFICATION_CHAT_LINK_INSTRUCTION;
      }
      return wrapUserQuery(`${basePrompt}${chatLinkInstruction}${SUBAGENT_NOTIFICATION_ACKNOWLEDGEMENT_USER_QUERY_SUFFIX}`);
    }
  }
  return getShellNotificationAcknowledgementUserQuery(formatOptions.modelInfo);
}

export function backgroundTaskKindLabel(kind: BackgroundTaskKind): string {
  switch (kind) {
    case BackgroundTaskKind.SHELL: return "shell";
    case BackgroundTaskKind.SUBAGENT: return "subagent";
    case BackgroundTaskKind.UNSPECIFIED: return "unknown";
    default: return "unknown";
  }
}

export function backgroundTaskStatusLabel(status: BackgroundTaskStatus): string {
  switch (status) {
    case BackgroundTaskStatus.SUCCESS: return "success";
    case BackgroundTaskStatus.ERROR: return "error";
    case BackgroundTaskStatus.ABORTED: return "aborted";
    case BackgroundTaskStatus.UNSPECIFIED: return "unknown";
    default: return "unknown";
  }
}

function CompletedTasksSection(sectionProps: PromptProps): PromptNode {
  const taskResults = Array.isArray(sectionProps.taskResults)
    ? sectionProps.taskResults.filter((candidate): candidate is BackgroundTaskCompletion => candidate instanceof BackgroundTaskCompletion)
    : [];
  const allAreProgress = taskResults.length > 0 && taskResults.every(isShellOutputCompletion);
  const introText = allAreProgress
    ? taskResults.length === 1 ? "The following task has notified. If you were already aware, ignore this notification and do not restate prior responses." : "The following tasks notified. If you were already aware, ignore this notification and do not restate prior responses."
    : taskResults.length === 1 ? "The following task has finished. If you were already aware, ignore this notification and do not restate prior responses." : "The following tasks finished. If you were already aware, ignore this notification and do not restate prior responses.";
  return jsxs("section", { title: SYSTEM_NOTIFICATION_TAG, children: [jsx("p", { children: introText }), taskResults.map((taskResult, position) => {
    const detailLines = [
      `kind: ${backgroundTaskKindLabel(taskResult.kind)}`,
      `status: ${backgroundTaskStatusLabel(taskResult.status)}`,
      ...(taskResult.reason === BackgroundTaskCompletionReason.WORKER_REPARENTED ? ["reason: worker_reparented"] : []),
      `task_id: ${escapePromptXmlText(taskResult.taskId)}`,
      `title: ${escapePromptXmlText(taskResult.title)}`,
      ...(taskResult.toolCallId ? [`tool_call_id: ${escapePromptXmlText(taskResult.toolCallId)}`] : []),
      ...(taskResult.subagentId ? [`agent_id: ${escapePromptXmlText(taskResult.subagentId)}`] : []),
      ...(taskResult.detail ? [`detail: ${neutralizeBackgroundTaskDetailCloseTags(taskResult.detail)}`] : []),
      ...(taskResult.outputPath ? [`output_path: ${escapePromptXmlText(taskResult.outputPath)}`] : []),
    ];
    return jsx("section", { title: "task", children: detailLines.join("\n") }, position);
  })] });
}

export function formatBackgroundCompletions(taskResults: readonly BackgroundTaskCompletion[], formatOptions: BackgroundCompletionFormatOptions): string {
  const timestampPrefix = formatOptions.includeTimestamp ? buildTimestampPrefix(formatOptions.timeZone) : "";
  const renderedBody = renderContent(jsx(CompletedTasksSection, { taskResults }));
  return `${timestampPrefix}${renderedBody}\n${getNotificationAcknowledgementUserQuery(taskResults, formatOptions)}`;
}

export function formatMetaParentBackgroundCompletions(taskResults: readonly BackgroundTaskCompletion[], formatOptions: BackgroundCompletionFormatOptions): string {
  const responseBlock = (rawOutput: string): string => {
    const escapedText = escapePromptXmlText(rawOutput.trim());
    return ["<response>", escapedText.length > 0 ? escapedText : "No output", "</response>"].join("\n");
  };
  const timestampPrefix = formatOptions.includeTimestamp ? buildTimestampPrefix(formatOptions.timeZone) : "";
  const renderedBody = taskResults.map(taskResult => {
    const includeResult = taskResult.kind !== BackgroundTaskKind.SUBAGENT || formatOptions.hideAsyncSubagentTaskNotifications;
    const resultText = includeResult ? taskResult.detail ?? taskResult.outputPath ?? taskResult.title ?? "No result was provided." : "Subagent completed; result is already visible to the user.";
    const titlePrefix = taskResult.title && includeResult ? `title: ${escapePromptXmlText(taskResult.title)}\n` : "";
    return `${META_PARENT_COMPLETION_OPEN_TAG}\nagent_id: ${escapePromptXmlText(taskResult.taskId)}\nstatus: ${backgroundTaskStatusLabel(taskResult.status)}\n${titlePrefix}response:\n${responseBlock(resultText)}\n${META_PARENT_COMPLETION_CLOSE_TAG}`;
  }).join("\n\n");
  return `${timestampPrefix}${META_PARENT_COMPLETION_SYSTEM_REMINDER}\n\n${renderedBody}\n${getNotificationAcknowledgementUserQuery(taskResults, formatOptions)}`;
}

export function summarizeBackgroundTaskCompletions(taskResults: readonly BackgroundTaskCompletion[]): {
  readonly num_completions: number;
  readonly kind_counts: { readonly shell: number; readonly subagent: number; readonly unknown: number };
  readonly status_counts: { readonly success: number; readonly error: number; readonly aborted: number; readonly unknown: number };
} {
  const kindCounts = { shell: 0, subagent: 0, unknown: 0 };
  const statusCounts = { success: 0, error: 0, aborted: 0, unknown: 0 };
  for (const taskResult of taskResults) {
    if (taskResult.kind === BackgroundTaskKind.SHELL) kindCounts.shell += 1;
    else if (taskResult.kind === BackgroundTaskKind.SUBAGENT) kindCounts.subagent += 1;
    else kindCounts.unknown += 1;
    if (taskResult.status === BackgroundTaskStatus.SUCCESS) statusCounts.success += 1;
    else if (taskResult.status === BackgroundTaskStatus.ERROR) statusCounts.error += 1;
    else if (taskResult.status === BackgroundTaskStatus.ABORTED) statusCounts.aborted += 1;
    else statusCounts.unknown += 1;
  }
  return { num_completions: taskResults.length, kind_counts: kindCounts, status_counts: statusCounts };
}

export function isShellOutputCompletion(taskResult: BackgroundTaskCompletion): boolean {
  return taskResult.reason === BackgroundTaskCompletionReason.TASK_PROGRESS;
}

export function getBackgroundTaskCompletionMetadata(taskResults: readonly BackgroundTaskCompletion[]): { readonly title?: string; readonly taskId?: string } | undefined {
  const firstMetadata = taskResults.map(taskResult => {
    const title = taskResult.title.trim();
    const taskId = taskResult.taskId.trim();
    if (title.length === 0 && taskId.length === 0) return undefined;
    return { ...(title.length > 0 ? { title } : {}), ...(taskId.length > 0 ? { taskId } : {}) };
  }).find(candidate => candidate !== undefined);
  return firstMetadata;
}

export function getBackgroundTaskCompletionThreadId(taskResults: readonly BackgroundTaskCompletion[], stateHandler: { getSubagentThreadId(taskId: string): string | undefined }): string | undefined {
  let resolvedThread: string | undefined;
  for (const taskResult of taskResults) {
    const threadId = taskResult.threadId?.trim() || stateHandler.getSubagentThreadId(taskResult.taskId);
    if (threadId === undefined || threadId.length === 0) continue;
    if (resolvedThread === undefined) resolvedThread = threadId;
    else if (threadId !== resolvedThread) return undefined;
  }
  return resolvedThread;
}
