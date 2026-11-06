import assert from "node:assert/strict"
import { test } from "node:test"

import {
  slateAgentActionFromQueuedInterop,
  slateAgentActionFromRedactedInterop,
  slateAgentActionFromInterop,
} from "../../source/adapters/interop/agent/turn-agent-run-projection-adapter.ts"
import { createSlateResumeAgentAction, isSlateResumeActionPayload, SlateAgentActionKind, isSlateUserMessageActionPayload } from "../../source/packages/agent/agent-action-state.ts"
import { createSlateUserMessageInput } from "../../source/packages/agent/user-message-state.ts"
import { isSlateExecutePlanActionPayload } from "../../source/packages/agent/actions/execute-plan-contracts.ts"
import {
  isSlateCancelActionPayload,
  redactSlateCancelActionPayload,
  type SlateCancelActionPayload,
} from "../../source/packages/agent/actions/cancel-action-contracts.ts"
import {
  createSlateGoalContinuationActionPayload,
  isSlateGoalContinuationActionPayload,
} from "../../source/packages/agent/actions/goal-continuation-contracts.ts"
import { isSlateSubscriptionNotificationActionPayload } from "../../source/packages/agent/actions/subscription-notification-contracts.ts"
import {
  isSlateBackgroundTaskCompletionActionPayload,
  type SlateBackgroundTaskCompletionActionPayload,
} from "../../source/packages/agent/actions/background-task-completion-contracts.ts"
import {
  isSlateShellCommandActionPayload,
  type SlateShellCommandActionPayload,
} from "../../source/packages/agent/actions/shell-command-action-contracts.ts"
import {
  isSlateBackgroundShellActionPayload,
  isSlateBackgroundSubagentActionPayload,
  type SlateBackgroundShellActionPayload,
  type SlateBackgroundSubagentActionPayload,
} from "../../source/packages/agent/actions/background-side-channel-contracts.ts"
import {
  isSlateContextInjectionActionPayload,
  type SlateContextInjectionActionPayload,
} from "../../source/packages/agent/actions/context-injection-action-contracts.ts"
import {
  isSlateCancelSubagentActionPayload,
  type SlateCancelSubagentActionPayload,
} from "../../source/packages/agent/actions/cancel-subagent-action-contracts.ts"
import {
  createSlateSummarizeActionPayload,
  isSlateSummarizeActionPayload,
} from "../../source/packages/agent/actions/summarize-action-contracts.ts"
import { SlateMode } from "../../source/packages/agent/mode-processing.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { PrivacyCapability } from "../../source/packages/redaction/classification.ts"
import { isRedactedString } from "../../source/packages/redaction/redacted-values.ts"
import type { AskQuestionCompletionAction } from "../../source/packages/agent/actions/ask-question-completion.ts"
import {
  BackgroundTaskCompletion,
  BackgroundTaskCompletionAction,
  BackgroundTaskCompletionReason,
  BackgroundTaskKind,
  ConversationAction,
  ShellCommand,
  ShellCommandAction,
} from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { toRedactedBackgroundTaskCompletionAction } from "../../source/adapters/interop/redacted-protos/generated/agent/v1/agent_redacted.ts"

test("every supported runner route maps to a Slate kind and first-party payload contract", () => {
  const routes = [
    ["userMessageAction", SlateAgentActionKind.USER_MESSAGE],
    ["resumeAction", SlateAgentActionKind.RESUME],
    ["cancelAction", SlateAgentActionKind.CANCEL],
    ["summarizeAction", SlateAgentActionKind.SUMMARIZE],
    ["shellCommandAction", SlateAgentActionKind.SHELL_COMMAND],
    ["startPlanAction", SlateAgentActionKind.DEPRECATED_PLAN_START],
    ["executePlanAction", SlateAgentActionKind.EXECUTE_PLAN],
    ["asyncAskQuestionCompletionAction", SlateAgentActionKind.ASK_QUESTION_COMPLETION],
    ["cancelSubagentAction", SlateAgentActionKind.CANCEL_SUBAGENT],
    ["backgroundTaskCompletionAction", SlateAgentActionKind.BACKGROUND_TASK_COMPLETION],
    ["backgroundShellAction", SlateAgentActionKind.BACKGROUND_SHELL],
    ["backgroundSubagentAction", SlateAgentActionKind.BACKGROUND_SUBAGENT],
    ["subscriptionNotificationAction", SlateAgentActionKind.SUBSCRIPTION_NOTIFICATION],
    ["goalContinuationAction", SlateAgentActionKind.GOAL_CONTINUATION],
    ["injectContextAction", SlateAgentActionKind.CONTEXT_INJECTION],
  ] as const

  for (const [sourceCase, expectedKind] of routes) {
    const payload = { sourceCase }
    const action = slateAgentActionFromQueuedInterop({ case: sourceCase, value: payload }, PrivacyMode.NO_STORAGE)
    assert.equal(action.kind, expectedKind, sourceCase)
    if (sourceCase === "userMessageAction") {
      assert.equal((action.payload as { schema?: unknown }).schema, "slate.agent-action.user-message")
      assert.ok((action.payload as { compatibility?: { legacyPayload?: unknown } }).compatibility?.legacyPayload)
    } else if (sourceCase === "resumeAction") {
      assert.equal((action.payload as { schema?: unknown }).schema, "slate.agent-action.resume")
      assert.ok((action.payload as { compatibility?: { legacyPayload?: unknown } }).compatibility?.legacyPayload)
    } else if (sourceCase === "executePlanAction") {
      assert.equal(isSlateExecutePlanActionPayload(action.payload), true)
    } else if (sourceCase === "summarizeAction") {
      assert.equal(isSlateSummarizeActionPayload(action.payload), true)
    } else if (sourceCase === "cancelAction") {
      assert.equal(isSlateCancelActionPayload(action.payload), true)
    } else if (sourceCase === "backgroundTaskCompletionAction") {
      const payload = action.payload as SlateBackgroundTaskCompletionActionPayload
      assert.equal(isSlateBackgroundTaskCompletionActionPayload(payload), true)
      assert.deepEqual(payload.completions, [])
      assert.ok(payload.compatibility?.legacyPayload)
    } else if (sourceCase === "goalContinuationAction") {
      assert.equal(isSlateGoalContinuationActionPayload(action.payload), true)
    } else if (sourceCase === "subscriptionNotificationAction") {
      assert.equal(isSlateSubscriptionNotificationActionPayload(action.payload), true)
    } else if (sourceCase === "shellCommandAction") {
      const payload = action.payload as SlateShellCommandActionPayload
      assert.equal(isSlateShellCommandActionPayload(payload), true)
      assert.equal(payload.privacyMode, PrivacyMode.NO_STORAGE)
      assert.ok(payload.compatibility?.legacyPayload)
    } else if (sourceCase === "backgroundShellAction") {
      const payload = action.payload as SlateBackgroundShellActionPayload
      assert.equal(isSlateBackgroundShellActionPayload(payload), true)
      assert.equal(payload.toolCallId, "")
      assert.ok(payload.compatibility?.legacyPayload)
    } else if (sourceCase === "backgroundSubagentAction") {
      const payload = action.payload as SlateBackgroundSubagentActionPayload
      assert.equal(isSlateBackgroundSubagentActionPayload(payload), true)
      assert.equal(payload.toolCallId, "")
      assert.ok(payload.compatibility?.legacyPayload)
    } else if (sourceCase === "cancelSubagentAction") {
      const payload = action.payload as SlateCancelSubagentActionPayload
      assert.equal(isSlateCancelSubagentActionPayload(payload), true)
      assert.equal(payload.subagentId, "")
      assert.ok(payload.compatibility?.legacyPayload)
    } else if (sourceCase === "injectContextAction") {
      const payload = action.payload as SlateContextInjectionActionPayload
      assert.equal(isSlateContextInjectionActionPayload(payload), true)
      assert.equal(payload.context.kind, "missing")
      assert.ok(payload.compatibility?.legacyPayload)
    } else if (sourceCase === "asyncAskQuestionCompletionAction") {
      const payload = action.payload as AskQuestionCompletionAction
      assert.equal(payload.schema, "slate.agent-action.ask-question-completion")
      assert.equal(payload.version, 1)
      assert.equal(payload.originalToolCallId, "")
      assert.ok(payload.compatibility?.legacyPayload)
    } else {
      assert.equal(action.payload, payload, sourceCase)
    }
    assert.equal(action.context.privacyMode, PrivacyMode.NO_STORAGE, sourceCase)
    assert.equal(action.context.telemetryName, sourceCase, sourceCase)
  }
})

test("ask-question completion uses Slate fields and preserves the historical payload for recovery", () => {
  const legacyPayload = {
    originalToolCallId: "call-17",
    originalArgs: {
      title: "Choose a store",
      questions: [{
        id: "q1",
        prompt: "Which database?",
        allowMultiple: false,
        options: [{ id: "opt-1", label: "PostgreSQL" }],
      }],
    },
    result: {
      result: {
        case: "success",
        value: { answers: [{ questionId: "q1", selectedOptionIds: ["opt-1"], freeformText: "" }] },
      },
    },
  }
  const action = slateAgentActionFromRedactedInterop({
    _privacyMode: PrivacyMode.NO_STORAGE,
    action: { case: "asyncAskQuestionCompletionAction", value: legacyPayload },
  } as never)
  const payload = action.payload as AskQuestionCompletionAction

  assert.equal(action.kind, SlateAgentActionKind.ASK_QUESTION_COMPLETION)
  assert.equal(payload.schema, "slate.agent-action.ask-question-completion")
  assert.equal(payload.version, 1)
  assert.equal(payload.originalToolCallId, "call-17")
  const title = payload.originalArgs?.title
  const questionPrompt = payload.originalArgs?.questions[0]?.prompt
  assert.ok(title !== undefined && isRedactedString(title))
  assert.ok(questionPrompt !== undefined && isRedactedString(questionPrompt))
  assert.equal(title.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "Choose a store")
  assert.equal(questionPrompt.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "Which database?")
  assert.equal(payload.result?.kind, "answered")
  assert.equal(payload.compatibility?.legacyResult, legacyPayload.result)
  assert.equal(payload.compatibility?.legacyPayload, legacyPayload)
})

test("cancel actions carry a Slate reason and preserve historical resolution data", () => {
  const legacyPayload = {
    reason: "user stopped the turn",
    interruptedPendingToolCallResolutions: { resolutions: [{ toolCallId: "call-3" }] },
  }
  const action = slateAgentActionFromRedactedInterop({
    _privacyMode: PrivacyMode.NO_STORAGE,
    action: { case: "cancelAction", value: legacyPayload },
  } as never)
  const payload = action.payload as SlateCancelActionPayload

  assert.equal(action.kind, SlateAgentActionKind.CANCEL)
  assert.equal(isSlateCancelActionPayload(payload), true)
  assert.ok(typeof payload.reason !== "string")
  if (typeof payload.reason !== "string") {
    assert.equal(payload.reason.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "user stopped the turn")
  }
  const rebound = redactSlateCancelActionPayload(payload, PrivacyMode.UNSPECIFIED)
  assert.ok(typeof rebound.reason !== "string")
  if (typeof rebound.reason !== "string") {
    assert.equal(rebound.reason.getPrivacyContext().privacyMode, PrivacyMode.UNSPECIFIED)
    assert.equal(rebound.reason.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "user stopped the turn")
  }
  assert.deepEqual(payload.compatibility?.interruptedToolResolutions, legacyPayload.interruptedPendingToolCallResolutions)
  assert.equal(payload.compatibility?.legacyPayload, legacyPayload)
})

test("background-task completion routes use a Slate batch with a historical recovery sidecar", () => {
  const payload = slateAgentActionFromQueuedInterop({
    case: "backgroundTaskCompletionAction",
    value: { completions: [] },
  }, PrivacyMode.NO_STORAGE).payload as SlateBackgroundTaskCompletionActionPayload

  assert.equal(isSlateBackgroundTaskCompletionActionPayload(payload), true)
  assert.equal(payload.schema, "slate.agent-action.background-task-completion")
  assert.equal(payload.version, 1)
  assert.deepEqual(payload.completions, [])
  assert.ok(payload.compatibility?.legacyPayload)
})

test("background-task completion projections preserve unsupported enum codes", () => {
  const historicalAction = toRedactedBackgroundTaskCompletionAction(
    new BackgroundTaskCompletionAction({
      completions: [new BackgroundTaskCompletion({
        taskId: "task-future",
        kind: BackgroundTaskKind.SUBAGENT,
        status: 97 as never,
        title: "future status",
        reason: BackgroundTaskCompletionReason.TASK_FINISHED,
        notificationContext: 98 as never,
      })],
    }),
    PrivacyMode.NO_STORAGE,
  )
  const action = slateAgentActionFromRedactedInterop({
    _privacyMode: PrivacyMode.NO_STORAGE,
    action: { case: "backgroundTaskCompletionAction", value: historicalAction as never },
  } as never)
  const payload = action.payload as SlateBackgroundTaskCompletionActionPayload

  assert.equal(action.kind, SlateAgentActionKind.BACKGROUND_TASK_COMPLETION)
  assert.equal(payload.completions[0]?.kind, "subagent")
  assert.equal(payload.completions[0]?.status, "unknown")
  assert.deepEqual(payload.completions[0]?.compatibility, {
    legacyStatusCode: 97,
    legacyReasonCode: BackgroundTaskCompletionReason.TASK_FINISHED,
    legacyNotificationContextCode: 98,
  })
  assert.equal(payload.compatibility?.legacyPayload, historicalAction)
})

test("shell command projections preserve the typed command and resume execution id", () => {
  const legacyAction = new ConversationAction({
    action: {
      case: "shellCommandAction",
      value: new ShellCommandAction({
        shellCommand: new ShellCommand({ command: "echo slate" }),
        execId: "resume-7",
      }),
    },
  })
  const action = slateAgentActionFromInterop(legacyAction, PrivacyMode.NO_STORAGE)
  const payload = action.payload as SlateShellCommandActionPayload
  const commandText = payload.commandText

  assert.equal(action.kind, SlateAgentActionKind.SHELL_COMMAND)
  assert.equal(isSlateShellCommandActionPayload(payload), true)
  assert.equal(payload.schema, "slate.agent-action.shell-command")
  assert.equal(payload.resumeExecutionId, "resume-7")
  assert.ok(commandText !== undefined)
  assert.equal(
    typeof commandText === "string" ? commandText : commandText.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
    "echo slate",
  )
  assert.ok(payload.compatibility?.legacyPayload)
})

test("background side-channel actions preserve their Slate call identifiers", () => {
  const shell = slateAgentActionFromRedactedInterop({
    _privacyMode: PrivacyMode.NO_STORAGE,
    action: { case: "backgroundShellAction", value: { toolCallId: "shell-call-9" } },
  } as never)
  const shellPayload = shell.payload as SlateBackgroundShellActionPayload
  assert.equal(shell.kind, SlateAgentActionKind.BACKGROUND_SHELL)
  assert.equal(isSlateBackgroundShellActionPayload(shellPayload), true)
  assert.equal(shellPayload.toolCallId, "shell-call-9")

  const subagent = slateAgentActionFromRedactedInterop({
    _privacyMode: PrivacyMode.NO_STORAGE,
    action: { case: "backgroundSubagentAction", value: { toolCallId: "subagent-call-4" } },
  } as never)
  const subagentPayload = subagent.payload as SlateBackgroundSubagentActionPayload
  assert.equal(subagent.kind, SlateAgentActionKind.BACKGROUND_SUBAGENT)
  assert.equal(isSlateBackgroundSubagentActionPayload(subagentPayload), true)
  assert.equal(subagentPayload.toolCallId, "subagent-call-4")
})

test("cancel-subagent route preserves the target id in a Slate action payload", () => {
  const action = slateAgentActionFromRedactedInterop({
    _privacyMode: PrivacyMode.NO_STORAGE,
    action: { case: "cancelSubagentAction", value: { subagentId: "agent-42" } },
  } as never)
  const payload = action.payload as SlateCancelSubagentActionPayload

  assert.equal(action.kind, SlateAgentActionKind.CANCEL_SUBAGENT)
  assert.equal(isSlateCancelSubagentActionPayload(payload), true)
  assert.equal(payload.schema, "slate.agent-action.cancel-subagent")
  assert.equal(payload.subagentId, "agent-42")
  assert.deepEqual(payload.compatibility?.legacyPayload, { subagentId: "agent-42" })
})

test("context injection has Slate user and system context variants", () => {
  const system = slateAgentActionFromRedactedInterop({
    _privacyMode: PrivacyMode.NO_STORAGE,
    action: {
      case: "injectContextAction",
      value: {
        injectionId: "inject-1",
        expectedRunId: "run-4",
        payload: { case: "systemContext", value: { producer: "scheduler", content: "scheduled context" } },
      },
    },
  } as never)
  const systemPayload = system.payload as SlateContextInjectionActionPayload
  assert.equal(system.kind, SlateAgentActionKind.CONTEXT_INJECTION)
  assert.equal(isSlateContextInjectionActionPayload(systemPayload), true)
  assert.equal(systemPayload.injectionId, "inject-1")
  assert.deepEqual(systemPayload.context.kind, "system")
  if (systemPayload.context.kind === "system") {
    assert.equal(systemPayload.context.producer, "scheduler")
    const text = systemPayload.context.content
    assert.equal(isRedactedString(text) ? text.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED) : text, "scheduled context")
  }

  const user = slateAgentActionFromRedactedInterop({
    _privacyMode: PrivacyMode.NO_STORAGE,
    action: {
      case: "injectContextAction",
      value: {
        injectionId: "inject-2",
        expectedRunId: "run-5",
        payload: {
          case: "userContext",
          value: { userMessage: { text: "user context", messageId: "message-7" }, requestContext: { source: "legacy" } },
        },
      },
    },
  } as never)
  const userPayload = user.payload as SlateContextInjectionActionPayload
  assert.equal(userPayload.context.kind, "user")
  if (userPayload.context.kind === "user") {
    assert.equal(userPayload.context.message?.messageId, "message-7")
    assert.deepEqual(userPayload.compatibility?.legacyRequestContext, { source: "legacy" })
  }
})

test("missing and unknown routes remain distinguishable, and the unknown source name is retained", () => {
  const missing = slateAgentActionFromQueuedInterop({ case: undefined }, PrivacyMode.UNSPECIFIED)
  assert.equal(missing.kind, SlateAgentActionKind.MISSING)
  assert.equal(missing.payload, undefined)

  const unsupported = slateAgentActionFromQueuedInterop({ case: "futureAction", value: { id: "x" } }, PrivacyMode.UNSPECIFIED)
  assert.equal(unsupported.kind, SlateAgentActionKind.UNSUPPORTED)
  assert.equal(unsupported.compatibility?.sourceKind, "futureAction")
  assert.deepEqual(unsupported.payload, { id: "x" })
})

test("redacted action context is projected into Slate actor and request metadata", () => {
  const action = slateAgentActionFromRedactedInterop({
    _privacyMode: PrivacyMode.NO_STORAGE,
    triggeringAuthId: "auth-1",
    triggeringUserInfo: { userId: "user-1" },
    requestContextParts: { requestId: "request-1" },
    action: { case: "userMessageAction", value: { userMessage: { text: "hello" } } },
  } as never)

  assert.equal(action.kind, SlateAgentActionKind.USER_MESSAGE)
  assert.equal(action.context.privacyMode, PrivacyMode.NO_STORAGE)
  assert.deepEqual(action.context.actor, { authId: "auth-1", userInfo: { userId: "user-1" } })
  assert.deepEqual(action.context.requestReferences, { requestId: "request-1" })
})

test("Slate user-message input applies Slate defaults and validates the versioned payload", () => {
  const message = createSlateUserMessageInput({ text: "hello" })
  assert.equal(message.messageId, "")
  assert.equal(message.mode, SlateMode.UNSPECIFIED)
  assert.deepEqual(message.conversationStateBlobId, new Uint8Array())
  assert.deepEqual(message.hookContexts, [])

  const payload = {
    schema: "slate.agent-action.user-message",
    version: 1,
    message,
    earlierMessages: [],
    notifyUser: false,
  } as const
  assert.equal(isSlateUserMessageActionPayload(payload), true)
  assert.equal(isSlateUserMessageActionPayload({ ...payload, earlierMessages: [null] }), false)
})

test("a canonical retry uses the empty Slate resume payload", () => {
  const action = createSlateResumeAgentAction(PrivacyMode.NO_STORAGE)
  assert.equal(action.kind, SlateAgentActionKind.RESUME)
  assert.equal(action.context.privacyMode, PrivacyMode.NO_STORAGE)
  assert.equal(isSlateResumeActionPayload(action.payload), true)
  assert.deepEqual(action.payload.compatibility, undefined)
})

test("summarize actions use Slate's versioned empty request", () => {
  const payload = createSlateSummarizeActionPayload()
  assert.deepEqual(payload, { schema: "slate.agent-action.summarize", version: 1 })
  assert.equal(isSlateSummarizeActionPayload(payload), true)
  assert.equal(isSlateSummarizeActionPayload({ ...payload, version: 2 }), false)
})

test("goal continuation routes use Slate's versioned wake trigger", () => {
  const payload = createSlateGoalContinuationActionPayload()
  assert.deepEqual(payload, { schema: "slate.agent-action.goal-continuation", version: 1 })
  assert.equal(isSlateGoalContinuationActionPayload(payload), true)
  assert.equal(isSlateGoalContinuationActionPayload({ ...payload, version: 2 }), false)
})
