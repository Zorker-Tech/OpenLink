import assert from "node:assert/strict"
import test from "node:test"

import { ShellCommandParsingResult_ExecutableCommand } from "../../source/adapters/interop/proto/generated/agent/v1/shell_exec_pb.ts"
import { buildHostShellArgs } from "../../source/adapters/interop/agent/box-shell-command-adapter.ts"

test("host shell input is projected into the generated command envelope", () => {
  const result = buildHostShellArgs({
    command: "ls -la /workspace",
    name: "ls",
    workingDirectory: "/workspace",
    toolCallId: "call-7",
  })

  assert.equal(result.command, "ls -la /workspace")
  assert.equal(result.workingDirectory, "/workspace")
  assert.equal(result.toolCallId, "call-7")
  assert.equal(result.skipApproval, true)
  assert.equal(result.parsingResult?.parsingFailed, false)
  assert.equal(result.parsingResult?.hasRedirects, false)
  assert.equal(result.parsingResult?.hasCommandSubstitution, false)
  assert.deepEqual(result.parsingResult?.executableCommands, [
    new ShellCommandParsingResult_ExecutableCommand({ name: "ls", args: [], fullText: "ls -la /workspace" }),
  ])
})
