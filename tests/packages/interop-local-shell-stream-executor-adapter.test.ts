import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { ForceBackgroundShellStatus, ShellBackgroundReason, ShellStream } from "../../source/adapters/interop/proto/generated/agent/v1/shell_exec_pb.ts"
import { SandboxPolicy_Type } from "../../source/adapters/interop/proto/generated/agent/v1/sandbox_pb.ts"
import { localShellForegroundHandoffToInterop, localShellStreamEventToInterop } from "../../source/adapters/interop/agent/local-shell-stream-executor-adapter.ts"

describe("the local shell stream interop adapter", () => {
  it("encodes Slate start, output and exit events to the generated stream", () => {
    const start = localShellStreamEventToInterop({ type: "start", policy: { type: "workspace_readwrite" } })
    const stdout = localShellStreamEventToInterop({ type: "stdout", data: "hello" })
    const exit = localShellStreamEventToInterop({
      type: "exit",
      code: 7,
      cwd: "/repo",
      outputLocation: { filePath: "/repo/output.txt", sizeBytes: 5n, lineCount: 1n },
      aborted: false,
      localExecutionTimeMs: 19,
    })

    assert.equal(start instanceof ShellStream, true)
    assert.equal(start.event.case, "start")
    if (start.event.case !== "start") assert.fail("expected a start event")
    assert.equal(start.event.value.sandboxPolicy?.type, SandboxPolicy_Type.WORKSPACE_READWRITE)
    assert.equal(stdout.event.case, "stdout")
    if (stdout.event.case !== "stdout") assert.fail("expected stdout")
    assert.equal(stdout.event.value.data, "hello")
    assert.equal(exit.event.case, "exit")
    if (exit.event.case !== "exit") assert.fail("expected an exit event")
    assert.equal(exit.event.value.code, 7)
    assert.equal(exit.event.value.outputLocation?.filePath, "/repo/output.txt")
  })

  it("encodes foreground handoff status and the accepted run", () => {
    const notFound = localShellForegroundHandoffToInterop({ status: "not_found" })
    assert.equal(notFound.status, ForceBackgroundShellStatus.NOT_FOUND)

    const accepted = localShellForegroundHandoffToInterop({
      status: "accepted",
      shellResult: {
        shellId: 42,
        command: "tail -f output",
        workingDirectory: "/repo",
        msToWait: 250,
        backgroundReason: "user",
        interleavedOutput: "before handoff",
      },
    })
    assert.equal(accepted.status, ForceBackgroundShellStatus.ACCEPTED)
    assert.equal(accepted.shellResult?.result.case, "success")
    if (accepted.shellResult?.result.case !== "success") assert.fail("expected a successful shell result")
    assert.equal(accepted.shellResult.result.value.backgroundReason, ShellBackgroundReason.USER_REQUEST)
    assert.equal(accepted.shellResult.result.value.interleavedOutput, "before handoff")
  })
})
