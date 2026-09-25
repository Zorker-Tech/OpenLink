import { test } from "node:test"
import assert from "node:assert/strict"

import { AgentRoot } from "../../source/packages/agent/index.ts"
import { AbstractUserMessageActionHandler } from "../../source/packages/agent/actions/user-message-action/abstract-user-message-action-handler.ts"

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
    {},
  )
}

test("every action the platform can send has a handler, and nothing else does", () => {
  const agent = createAgent()
  for (const actionCase of [
    "userMessageAction",
    "subscriptionNotificationAction",
    "goalContinuationAction",
    "resumeAction",
    "summarizeAction",
    "shellCommandAction",
    "cancelAction",
    "executePlanAction",
    "asyncAskQuestionCompletionAction",
    "backgroundTaskCompletionAction",
    "backgroundShellAction",
    "backgroundSubagentAction",
  ]) {
    assert.equal(agent.actionHandlers.has(actionCase), true, actionCase)
  }
  assert.equal(agent.actionHandlers.has("somethingNobodyHandlesAction"), false)
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
  assert.equal(agent.shouldTrackAgentTypeChange("userMessageAction"), true)
  assert.equal(agent.shouldTrackAgentTypeChange("executePlanAction"), true)
  // A cancel does not change what the conversation is, and neither does an action nobody named.
  assert.equal(agent.shouldTrackAgentTypeChange("cancelAction"), false)
  assert.equal(agent.shouldTrackAgentTypeChange(undefined), false)
})

test("the split-step handler is the one that can run a step of the action", () => {
  const agent = createAgent()
  assert.equal(agent.getSplitStepHandler("userMessageAction"), agent.actionHandlers.get("userMessageAction"))
  // The actions that have no step loop of their own run the user-message handler's.
  const subscription = agent.actionHandlers.get("subscriptionNotificationAction")
  assert.equal(agent.getSplitStepHandler("subscriptionNotificationAction"), subscription.getUserMessageActionHandler())
  // With no action named, the first handler that can run a step is used.
  assert.equal(agent.getSplitStepHandler(undefined) instanceof AbstractUserMessageActionHandler, true)
  // A handler that cannot run a step at all is refused rather than run as something it is not.
  assert.throws(() => agent.getSplitStepHandler("backgroundShellAction"), /does not support split-step execution/)
})
