import { test } from "node:test"
import assert from "node:assert/strict"

import { AgentRoot } from "../../source/packages/agent/index.ts"
import { AbstractUserMessageActionHandler } from "../../source/packages/agent/actions/user-message-action/abstract-user-message-action-handler.ts"
import { NoopConversationActionReceiver } from "../../source/packages/agent-core/conversation-actions/remote-receiver.ts"
import type { SlateAgentAction } from "../../source/packages/agent/agent-action-state.ts"

// The root assembles the agent from what the platform hands it; nothing it does needs a live session, so a
// bare configuration is enough to see how it is wired.

function createAgent(config: Record<string, unknown> = {}) {
  return new AgentRoot(
    { backgroundSummarizationProps: {}, systemPromptGenerator: () => "", ...config },
    {},
    { sendUpdate: async () => {}, enqueuePostTurnEndedWork: () => {} },
    { get: () => undefined },
    {},
    {},
    new NoopConversationActionReceiver<SlateAgentAction>(),
  )
}

test("every action the platform can send has a handler, and nothing else does", () => {
  const agent = createAgent()
  for (const actionKind of [
    "user-message",
    "subscription-notification",
    "goal-continuation",
    "resume",
    "summarize",
    "shell-command",
    "cancel",
    "execute-plan",
    "ask-question-completion",
    "background-task-completion",
    "background-shell",
    "background-subagent",
  ]) {
    assert.equal(agent.actionHandlers.has(actionKind as never), true, actionKind)
  }
  assert.equal(agent.actionHandlers.has("unsupported"), false)
})

test("a handler is recognized by the step it knows how to run", () => {
  const agent = createAgent()
  assert.equal(agent.isSingleStepHandler({ handleSingleStep: () => {} }), true)
  assert.equal(agent.isSingleStepHandler({ handleModelStep: () => {} }), false)
  assert.equal(agent.isSplitStepHandler({ handleModelStep: () => {} }), true)
  assert.equal(agent.isSplitStepHandler({ handle: () => {} }), false)
})

test("only the actions that can change the agent type are tracked for it", () => {
  const agent = createAgent()
  assert.equal(agent.shouldTrackAgentTypeChange("user-message"), true)
  assert.equal(agent.shouldTrackAgentTypeChange("execute-plan"), true)
  // A cancel does not change what the conversation is, and neither does an action nobody named.
  assert.equal(agent.shouldTrackAgentTypeChange("cancel"), false)
  assert.equal(agent.shouldTrackAgentTypeChange("unsupported"), false)
  assert.equal(agent.shouldTrackAgentTypeChange(undefined), false)
})

test("the split-step handler is the one that can run a step of the action", () => {
  const agent = createAgent()
  assert.equal(agent.getSplitStepHandler("user-message"), agent.actionHandlers.get("user-message"))
  // The actions that have no step loop of their own run the user-message handler's.
  const subscription = agent.actionHandlers.get("subscription-notification")
  assert.equal(agent.getSplitStepHandler("subscription-notification"), subscription.getUserMessageActionHandler())
  // With no action named, the first handler that can run a step is used.
  assert.equal(agent.getSplitStepHandler(undefined) instanceof AbstractUserMessageActionHandler, true)
  // A handler that cannot run a step at all is refused rather than run as something it is not.
  assert.throws(() => agent.getSplitStepHandler("background-shell"), /does not support split-step execution/)
})
