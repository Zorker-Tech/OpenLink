import assert from "node:assert/strict"
import { test } from "node:test"

import { ExecServerMessage, ExecuteHookArgs } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import {
  SimpleControlledExecManager,
  type ControlledExecHandler,
} from "../../source/adapters/interop/agent/controlled-exec-manager-adapter.ts"

test("a completed controlled operation cancels the context it was given", async () => {
  const parent = createContext()
  let childSignal: AbortSignal | undefined
  const handler: ControlledExecHandler = {
    handle(context: Context) {
      childSignal = context.signal
      return (async function* () {})()
    },
  }
  const manager = new SimpleControlledExecManager()
  manager.register(handler)
  const serverMessage = new ExecServerMessage({ id: 7, message: { case: "executeHookArgs", value: new ExecuteHookArgs() } })
  const received: string[] = []

  for await (const message of manager.handle(parent, serverMessage)) {
    received.push(message.message.case ?? "unknown")
  }

  assert.deepEqual(received, ["streamClose"])
  assert.equal(childSignal?.aborted, true)
  assert.equal(parent.signal.aborted, false)
})
