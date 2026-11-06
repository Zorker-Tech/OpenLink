import assert from "node:assert/strict"
import { test } from "node:test"

import {
  slateAgentActionFromQueuedInterop,
  slateAgentActionFromRedactedInterop,
} from "../../source/adapters/interop/agent/turn-agent-run-projection-adapter.ts"
import { createSlateResumeAgentAction, isSlateResumeActionPayload, SlateAgentActionKind, isSlateUserMessageActionPayload } from "../../source/packages/agent/agent-action-state.ts"
import { createSlateUserMessageInput } from "../../source/packages/agent/user-message-state.ts"
import { isSlateExecutePlanActionPayload } from "../../source/packages/agent/actions/execute-plan-contracts.ts"
import { SlateMode } from "../../source/packages/agent/mode-processing.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"

test("every supported runner route maps to a Slate kind and retains unconverted payloads during migration", () => {
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
    } else {
      assert.equal(action.payload, payload, sourceCase)
    }
    assert.equal(action.context.privacyMode, PrivacyMode.NO_STORAGE, sourceCase)
    assert.equal(action.context.telemetryName, sourceCase, sourceCase)
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
