import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createContext } from "../../source/packages/context/context.ts"
import { LazyTerminalExecutor } from "../../source/packages/shell-exec/lazy.ts"
import type { TerminalEvent, TerminalExecuteOptions, TerminalExecutor } from "../../source/packages/shell-exec/naive.ts"

describe("lazy terminal executor", () => {
  it("starts on first execution and forwards the original call and events", async () => {
    let builds = 0
    let invocation: { context: unknown; command: string; options: TerminalExecuteOptions | undefined } | undefined
    const event: TerminalEvent = { type: "stdout", data: Buffer.from("ready") }
    const executor: TerminalExecutor = {
      getCwd: async () => "/workspace",
      clone: () => executor,
      execute: (context, command, options) => {
        invocation = { context, command, options }
        return (async function* () { yield event })()
      },
    }
    const lazy = new LazyTerminalExecutor(async () => {
      builds += 1
      return executor
    })
    const context = createContext()
    const options: TerminalExecuteOptions = { workingDirectory: "/project", pipeStdin: true }
    assert.equal(builds, 0)

    const events: TerminalEvent[] = []
    for await (const item of lazy.execute(context, "printf ready", options)) events.push(item)

    assert.equal(builds, 1)
    assert.deepEqual(invocation, { context, command: "printf ready", options })
    assert.deepEqual(events, [event])
  })

  it("shares the failed initialization promise rather than rebuilding on later access", async () => {
    let builds = 0
    const failure = new Error("shell could not start")
    const lazy = new LazyTerminalExecutor(async () => {
      builds += 1
      throw failure
    })

    await assert.rejects(lazy.getCwd(), (error) => error === failure)
    await assert.rejects(lazy.getExecutor(), (error) => error === failure)
    assert.equal(builds, 1)
  })
})
