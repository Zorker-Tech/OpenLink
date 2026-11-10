import assert from "node:assert/strict"
import { test } from "node:test"

import { captureSync } from "../../source/packages/utils/attempt.ts"

test("captureSync returns synchronous values verbatim and does not await thenables", () => {
  for (const value of [undefined, null, false, 0, ""] as const) {
    assert.deepEqual(captureSync(() => value), { ok: true, value })
  }

  const pending = Promise.resolve("still a value")
  const result = captureSync(() => pending)
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.value, pending)
})

test("captureSync preserves the original thrown value including falsey and object values", () => {
  for (const error of [undefined, null, false, 0, "", { kind: "failure" }]) {
    const result = captureSync(() => { throw error })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error, error)
  }
})
