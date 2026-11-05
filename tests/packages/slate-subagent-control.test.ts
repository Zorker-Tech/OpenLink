import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createContext } from "../../source/packages/context/context.ts"
import { RemoteResourceAccessor } from "../../source/packages/agent-exec/resource-provider.ts"
import {
  createSlateSubagentBackgroundHandoffExecutor,
  slateSubagentBackgroundHandoffExecutorResource,
} from "../../source/packages/agent-exec/subagent-control.ts"

describe("the Slate subagent handoff contract", () => {
  it("accepts only a tool call that still owns a running subagent", async () => {
    const executor = createSlateSubagentBackgroundHandoffExecutor(toolCallId => toolCallId === "call-live")

    assert.deepEqual(await executor.execute(createContext(), { toolCallId: "call-live" }), { status: "accepted" })
    assert.deepEqual(await executor.execute(createContext(), { toolCallId: "call-finished" }), { status: "not-found" })
    assert.deepEqual(await executor.execute(createContext(), { toolCallId: "" }), { status: "not-found" })
  })

  it("fails closed when a turn did not bind its local control resource", async () => {
    const accessor = new RemoteResourceAccessor({} as never)
    const executor = accessor.get(slateSubagentBackgroundHandoffExecutorResource)

    await assert.rejects(
      executor.execute(createContext(), { toolCallId: "call-live" }),
      /only available in its owning turn/,
    )
  })
})
