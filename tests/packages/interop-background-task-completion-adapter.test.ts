import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AgentMode,
  BackgroundTaskCompletion,
  BackgroundTaskCompletionAction,
  BackgroundTaskCompletionReason,
  BackgroundTaskKind,
  BackgroundTaskNotificationContext,
  BackgroundTaskStatus,
  SimulatedMsgReason,
} from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts";
import { toRedactedBackgroundTaskCompletionAction } from "../../source/adapters/interop/redacted-protos/generated/agent/v1/agent_redacted.ts";
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts";
import {
  createBackgroundCompletionUserMessage,
  decodeStoredBackgroundTaskCompletionAction,
  fromInteropBackgroundTaskCompletion,
} from "../../source/adapters/interop/agent/background-task-completion-adapter.ts";
import { SlateMode } from "../../source/packages/agent/mode-processing.ts";

test("a stored completion becomes a Slate task record with normalized values", () => {
  const slate = fromInteropBackgroundTaskCompletion(new BackgroundTaskCompletion({
    kind: BackgroundTaskKind.SHELL,
    status: BackgroundTaskStatus.ERROR,
    taskId: "task-1",
    title: "the shell task",
    detail: "command failed",
    outputPath: "/repo/output.txt",
    reason: BackgroundTaskCompletionReason.TASK_PROGRESS,
    threadId: "thread-1",
    notificationContext: BackgroundTaskNotificationContext.USER_DRIVEN_INTERACTIVE_CHILD,
  }));

  assert.deepEqual(slate, {
    kind: "shell",
    status: "error",
    taskId: "task-1",
    title: "the shell task",
    detail: "command failed",
    outputPath: "/repo/output.txt",
    reason: "task-progress",
    threadId: "thread-1",
    notificationContext: "user-driven-interactive-child",
  });
});

test("a redacted action keeps its stored completion for session recording and projects policy data", () => {
  const stored = new BackgroundTaskCompletion({
    kind: BackgroundTaskKind.SUBAGENT,
    status: BackgroundTaskStatus.SUCCESS,
    taskId: "task-2",
    title: "research",
    subagentId: "agent-2",
    toolCallId: "call-2",
    reason: BackgroundTaskCompletionReason.WORKER_REPARENTED,
  });
  const action = toRedactedBackgroundTaskCompletionAction(
    new BackgroundTaskCompletionAction({ completions: [stored] }),
    PrivacyMode.NO_STORAGE,
  );
  const decoded = decodeStoredBackgroundTaskCompletionAction(action);

  assert.equal(decoded.storedCompletions.length, 1);
  assert.equal(decoded.storedCompletions[0]?.taskId, "task-2");
  assert.deepEqual(decoded.completions, [{
    kind: "subagent",
    status: "success",
    taskId: "task-2",
    title: "research",
    subagentId: "agent-2",
    toolCallId: "call-2",
    reason: "worker-reparented",
    notificationContext: "other",
  }]);
});

test("a Slate completion mode is encoded only when creating the stored user message", () => {
  const { userMessage } = createBackgroundCompletionUserMessage({
    text: "background work finished",
    messageId: "message-1",
    mode: SlateMode.MULTITASK,
    privacyMode: PrivacyMode.NO_STORAGE,
  });

  assert.equal(userMessage.mode, AgentMode.MULTITASK);
  assert.equal(userMessage.simulatedMsgReason, SimulatedMsgReason.BACKGROUND_TASK_COMPLETION);
});
