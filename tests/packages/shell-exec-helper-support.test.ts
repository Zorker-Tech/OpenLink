import { test } from "node:test"
import assert from "node:assert/strict"

import {
  getLastSandboxFailureReason,
  isSandboxHelperSupported,
  spawnWithSandboxHelper,
  spawnWithSandboxHelperPolicy,
} from "../../source/packages/shell-exec/sandbox/helper-support.ts"

test("without a configured helper the sandbox says so, and remembers the answer", () => {
  assert.equal(isSandboxHelperSupported(), false)
  assert.equal(getLastSandboxFailureReason(), "Sandbox binary path was not configured")
  assert.equal(isSandboxHelperSupported(), false, "the answer is cached rather than re-probed")
  assert.equal(getLastSandboxFailureReason(), "Sandbox binary path was not configured")
})

test("nothing is spawned without the helper, and a policy that cannot be run through it is refused", () => {
  assert.throws(
    () => spawnWithSandboxHelper("/bin/echo", ["hi"], {}, { type: "insecure_none" }),
    /Sandbox binary not available: Sandbox binary path was not configured/,
    "even a policy that would run directly needs the helper to be configured first",
  )
  assert.throws(
    () => spawnWithSandboxHelperPolicy("/bin/echo", ["hi"], {}, { type: "insecure_none" }),
    /Expected workspace_readwrite or workspace_readonly policy/,
    "the helper only runs workspace policies",
  )
  assert.throws(
    () => spawnWithSandboxHelperPolicy("/bin/echo", ["hi"], {}, { type: "other" } as never),
    /Expected workspace_readwrite or workspace_readonly policy/,
  )
})
