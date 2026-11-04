import assert from "node:assert/strict"
import test from "node:test"
import { z } from "zod"

import { lenientBoolean, preprocessLenientBoolean } from "../../source/packages/agent/tools/lenient-scalars.ts"

test("only the exact text booleans are converted", () => {
  assert.equal(preprocessLenientBoolean("true"), true)
  assert.equal(preprocessLenientBoolean("false"), false)
  for (const value of ["True", " true ", "false ", "yes", 1, null, undefined]) {
    assert.equal(preprocessLenientBoolean(value), value)
  }
})

test("a lenient boolean still delegates all remaining validation to its schema", () => {
  const enabled = lenientBoolean(z.boolean())
  assert.equal(enabled.parse("true"), true)
  assert.equal(enabled.safeParse("yes").success, false)
})
