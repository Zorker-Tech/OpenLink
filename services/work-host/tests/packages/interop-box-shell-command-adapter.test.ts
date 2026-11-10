import assert from "node:assert/strict"
import test from "node:test"

import { buildHostShellArgs } from "../../source/host/boxes/box-shell-command.ts"

test("host shell input creates a Slate command request with its parse summary", () => {
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
  assert.equal(result.parsing?.failed, false)
  assert.equal(result.parsing?.hasRedirects, false)
  assert.equal(result.parsing?.hasCommandSubstitution, false)
  assert.deepEqual(result.parsing?.executableCommands, [
    { name: "ls", arguments: [], fullText: "ls -la /workspace" },
  ])
  assert.deepEqual(result.parsing?.redirects, [])
})
