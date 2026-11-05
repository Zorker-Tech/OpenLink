import { test } from "node:test"
import assert from "node:assert/strict"

import {
  createTaskSubagentFollowupActionInterop,
  createTaskSubagentPersistedStateInterop,
} from "../../source/adapters/interop/agent/task-subagent-completion-adapter.ts"
import { createSlateTaskSuccessResult } from "../../source/packages/agent/tools/task-result-state.ts"
import { SelectedContext } from "../../source/adapters/interop/proto/generated/agent/v1/selected_context_pb.ts"
import {
  AgentMode,
  ConversationAction,
  ConversationStateStructure,
  SubagentPersistedState,
} from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"

test("subagent completion keeps external action and persistence edges and a Slate success result", () => {
  const selectedContext = new SelectedContext({})
  const action = createTaskSubagentFollowupActionInterop({
    text: "continue the task",
    messageId: "stable-message-id",
    useAskMode: true,
    selectedContext,
  }) as ConversationAction

  assert.equal(action.action.case, "userMessageAction")
  if (action.action.case !== "userMessageAction") throw new Error("expected a user-message action")
  assert.equal(action.action.value.userMessage?.text, "continue the task")
  assert.equal(action.action.value.userMessage?.messageId, "stable-message-id")
  assert.equal(action.action.value.userMessage?.mode, AgentMode.ASK)
  assert.equal(action.action.value.userMessage?.selectedContext, selectedContext)

  const conversationState = new ConversationStateStructure({ turns: [new Uint8Array([3, 5, 8])] })
  const persisted = createTaskSubagentPersistedStateInterop({
    conversationState,
    modelId: "slate-model",
  }) as SubagentPersistedState
  assert.equal(persisted.conversationState, conversationState)
  assert.equal(persisted.modelId, "slate-model")

  const result = createSlateTaskSuccessResult({
    agentId: "subagent-42",
    conversationSteps: [],
    durationMs: 17n,
    isBackground: false,
    backgroundReason: "unspecified",
    resultSuffix: "Done.",
  })
  assert.equal(result.kind, "success")
  if (result.kind !== "success") throw new Error("expected a successful task result")
  assert.equal(result.agentId, "subagent-42")
  assert.equal(result.durationMs, 17n)
  assert.equal(result.resultSuffix, "Done.")
})
