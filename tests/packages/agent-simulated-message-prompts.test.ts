import { test } from "node:test"
import assert from "node:assert/strict"

import { renderSimulatedMessagePrompts } from "../../source/packages/agent/simulated-message-prompts.ts"
import { SimulatedMsgReason } from "../../source/packages/proto/generated/agent/v1/agent_pb.ts"
import {
  SelectedAgenticGitAction,
  SelectedAgenticGitActionPushParams,
  SelectedContext,
} from "../../source/packages/proto/generated/agent/v1/selected_context_pb.ts"

// ---------------------------------------------------------------------------------------------
// what a wake-up the user did not write is told
// ---------------------------------------------------------------------------------------------

const contextWithGitAction = (): SelectedContext =>
  new SelectedContext({
    selectedAgenticGitAction: new SelectedAgenticGitAction({
      params: { case: "createPrParams", value: new SelectedAgenticGitActionPushParams({}) },
    }),
  })

test("a git action taken from the diff view carries its instruction", () => {
  const parts = renderSimulatedMessagePrompts({
    selectedContext: contextWithGitAction(),
    simulatedMsgReason: SimulatedMsgReason.DIFF_TAB_CREATE_PR,
  })
  assert.equal(parts.length, 1)
  assert.equal(parts[0]?.type, "text")
  assert.match(parts[0]?.text ?? "", /^Push this branch to remote and create a pull request\./)
})

test("a reason neither source knows produces no content at all", () => {
  assert.deepEqual(
    renderSimulatedMessagePrompts({
      selectedContext: new SelectedContext({}),
      simulatedMsgReason: SimulatedMsgReason.UNSPECIFIED,
    }),
    [],
  )
})

test("a git action reason with no action in the context produces no content either", () => {
  assert.deepEqual(
    renderSimulatedMessagePrompts({
      selectedContext: new SelectedContext({}),
      simulatedMsgReason: SimulatedMsgReason.DIFF_TAB_COMMIT,
    }),
    [],
  )
})

test("a multitask wake-up names the tool this session launches subagents with", () => {
  const withModel = renderSimulatedMessagePrompts({
    selectedContext: new SelectedContext({}),
    simulatedMsgReason: SimulatedMsgReason.MULTITASK,
    modelInfo: { promptVersion: "latest", isComposer1: true },
  })
  assert.equal(withModel.length, 1)
  assert.match(withModel[0]?.text ?? "", /mcp_task/)

  const withoutModel = renderSimulatedMessagePrompts({
    selectedContext: new SelectedContext({}),
    simulatedMsgReason: SimulatedMsgReason.MULTITASK,
  })
  assert.equal(withoutModel.length, 1)
  assert.match(withoutModel[0]?.text ?? "", /using your subagent tool/)
})

test("the flags a session may set reach the instruction that uses them", () => {
  const context = new SelectedContext({
    selectedAgenticGitAction: new SelectedAgenticGitAction({
      params: { case: "createPrParams", value: new SelectedAgenticGitActionPushParams({}) },
    }),
  })
  const without = renderSimulatedMessagePrompts({
    selectedContext: context,
    simulatedMsgReason: SimulatedMsgReason.DIFF_TAB_CREATE_PR,
  })
  const with_ = renderSimulatedMessagePrompts({
    selectedContext: context,
    simulatedMsgReason: SimulatedMsgReason.DIFF_TAB_CREATE_PR,
    enablePrCreationForgeGuidance: true,
  })
  assert.notEqual(without[0]?.text, with_[0]?.text)
  assert.match(with_[0]?.text ?? "", /Create the pull request with the host's own command/)
})

test("a wake-up is told one thing at a time", () => {
  // The reasons the two sources know do not overlap, so a wake-up never carries two instructions.
  const reasons = [
    SimulatedMsgReason.DIFF_TAB_COMMIT,
    SimulatedMsgReason.DIFF_TAB_CREATE_PR,
    SimulatedMsgReason.MULTITASK,
    SimulatedMsgReason.MULTITASK_SPLIT_PRS,
    SimulatedMsgReason.BABYSIT_PR_IN_CLOUD,
  ]
  for (const reason of reasons) {
    const parts = renderSimulatedMessagePrompts({ selectedContext: contextWithGitAction(), simulatedMsgReason: reason })
    assert.equal(parts.length <= 1, true, `reason ${reason}`)
  }
})

test("splitting work into pull requests is instructed in this session", () => {
  const parts = renderSimulatedMessagePrompts({
    selectedContext: contextWithGitAction(),
    simulatedMsgReason: SimulatedMsgReason.MULTITASK_SPLIT_PRS,
  })
  assert.equal(parts.length, 1)
  assert.match(parts[0]?.text ?? "", /^Split the current work into small reviewable pull requests\./)
})
