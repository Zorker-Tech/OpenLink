import assert from "node:assert/strict"
import test from "node:test"

import { SelectedSubagent } from "../../source/adapters/interop/proto/generated/agent/v1/selected_context_pb.ts"
import { toSubagentNameInputs } from "../../source/adapters/interop/agent/selected-subagents-adapter.ts"

test("selected subagent records project their names in the supplied order", () => {
  assert.deepEqual(toSubagentNameInputs([
    new SelectedSubagent({ name: "explore" }),
    new SelectedSubagent({ name: "plan" }),
  ]), [{ name: "explore" }, { name: "plan" }])
})
