import assert from "node:assert/strict"
import { test } from "node:test"

import { DEFAULT_SLATE_BOX_RUNTIME, isBoxRuntime, type BoxRuntime } from "../../source/shared/box-runtime.ts"

test("remote is the default and local Docker is the only alternate runtime", () => {
  assert.equal(DEFAULT_SLATE_BOX_RUNTIME, "remote")
  assert.equal(isBoxRuntime("remote"), true)
  assert.equal(isBoxRuntime("local-docker"), true)
  for (const value of ["docker", "local", "REMOTE", "", null, undefined, 0, {}]) {
    assert.equal(isBoxRuntime(value), false, String(value))
  }
})

test("accepted runtime values narrow to the Slate-owned union", () => {
  const value: unknown = "local-docker"
  if (!isBoxRuntime(value)) assert.fail("the known alternate runtime should be accepted")
  const runtime: BoxRuntime = value
  assert.equal(runtime, "local-docker")
})
