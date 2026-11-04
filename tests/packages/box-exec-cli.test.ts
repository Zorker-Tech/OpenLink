import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { runBoxExecCli } from "../../source/box-exec/cli.ts"

describe("the box exec command line", () => {
  it("leaves a successful startup alone", async () => {
    const writes: string[] = []
    const codes: number[] = []

    await runBoxExecCli(async () => {}, {
      writeStderr: line => { writes.push(line) },
      setExitCode: code => { codes.push(code) },
    })

    assert.deepEqual(writes, [])
    assert.deepEqual(codes, [])
  })

  it("reports an error with its stack and marks startup as failed", async () => {
    const writes: string[] = []
    const codes: number[] = []
    const failure = new Error("listener could not bind")

    await runBoxExecCli(async () => { throw failure }, {
      writeStderr: line => { writes.push(line) },
      setExitCode: code => { codes.push(code) },
    })

    assert.deepEqual(writes, [`box-exec-daemon: ${failure.stack}\n`])
    assert.deepEqual(codes, [1])
  })

  it("renders a non-error startup failure as text", async () => {
    const writes: string[] = []
    const codes: number[] = []

    await runBoxExecCli(async () => { throw "bad startup result" }, {
      writeStderr: line => { writes.push(line) },
      setExitCode: code => { codes.push(code) },
    })

    assert.deepEqual(writes, ["box-exec-daemon: bad startup result\n"])
    assert.deepEqual(codes, [1])
  })
})
