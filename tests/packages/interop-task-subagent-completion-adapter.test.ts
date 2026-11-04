import { test } from "node:test"
import assert from "node:assert/strict"

import {
  createTaskSubagentFollowupActionInterop,
  createTaskSubagentPersistedStateInterop,
  createTaskSubagentSuccessResultInterop,
} from "../../source/adapters/interop/agent/task-subagent-completion-adapter.ts"
import { SelectedContext } from "../../source/adapters/interop/proto/generated/agent/v1/selected_context_pb.ts"
import {
  AgentMode,
  ConversationAction,
  ConversationStateStructure,
  SubagentPersistedState,
  TaskResult,
} from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"

test("subagent completion interop preserves the external action, persistence, and result envelopes", () => {
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

  const result = createTaskSubagentSuccessResultInterop({
    agentId: "subagent-42",
    conversationSteps: [],
    durationMs: 17,
    resultSuffix: "Done.",
  }) as TaskResult
  assert.equal(result.result.case, "success")
  if (result.result.case !== "success") throw new Error("expected a successful task result")
  assert.equal(result.result.value.agentId, "subagent-42")
  assert.equal(result.result.value.durationMs, 17n)
  assert.equal(result.result.value.resultSuffix, "Done.")
})
