import assert from "node:assert/strict"
import test from "node:test"

import { SandboxPolicy, SandboxPolicy_Type } from "../../source/adapters/interop/proto/generated/agent/v1/sandbox_pb.ts"
import {
  ShellAbortReason,
  ShellBackgroundReason,
  ShellFailure,
  ShellResult,
  ShellSuccess,
} from "../../source/adapters/interop/proto/generated/agent/v1/shell_exec_pb.ts"
import { renderInteropShellResultToString } from "../../source/adapters/interop/agent/shell-result-format-adapter.ts"

test("generated sandbox and shell enums become prompt-owned formatter choices", () => {
  const aborted = new ShellResult({
    result: {
      case: "failure",
      value: new ShellFailure({ command: "ls", interleavedOutput: "partial", abortReason: ShellAbortReason.USER_ABORT }),
    },
    sandboxPolicy: new SandboxPolicy({ type: SandboxPolicy_Type.WORKSPACE_READONLY, networkAccess: false }),
  } as never)
  const userBackgrounded = new ShellResult({
    result: {
      case: "success",
      value: new ShellSuccess({
        command: "sleep 100",
        shellId: 5,
        msToWait: 1_000,
        backgroundReason: ShellBackgroundReason.USER_REQUEST,
      }),
    },
  } as never)

  const abortedText = renderInteropShellResultToString(aborted)
  const backgroundText = renderInteropShellResultToString(userBackgrounded, { discourageAwait: true })

  assert.match(abortedText, /^The user stopped the command\./)
  assert.match(abortedText, /Filesystem writes are blocked/)
  assert.match(backgroundText, /The user moved the command to the background after 1000ms\./)
  assert.match(backgroundText, /Do NOT await it/)
})
