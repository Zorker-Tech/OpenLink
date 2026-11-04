import assert from "node:assert/strict"
import test from "node:test"

import { SimulatedMsgReason } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { multitaskActionForReason } from "../../source/adapters/interop/agent/multitask-action-reason-adapter.ts"

test("counterpart wake reasons map only to the two Slate multitask actions", () => {
  assert.equal(multitaskActionForReason(SimulatedMsgReason.MULTITASK), "start-self-fork")
  assert.equal(multitaskActionForReason(SimulatedMsgReason.BUILD_IN_PARALLEL), "execute-plan-in-parallel")
  assert.equal(multitaskActionForReason(SimulatedMsgReason.UNSPECIFIED), undefined)
})
