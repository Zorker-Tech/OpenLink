import assert from "node:assert/strict"
import test from "node:test"
import { z } from "zod"

import { lenientNumber, preprocessLenientNumber } from "../../source/packages/agent/tools/lenient-scalars.ts"

test("numeric strings are read when non-empty and finite parsing rules are unambiguous", () => {
  assert.equal(preprocessLenientNumber(" 42.5 "), 42.5)
  assert.equal(preprocessLenientNumber("1e3"), 1_000)
  assert.equal(preprocessLenientNumber(""), "")
  assert.equal(preprocessLenientNumber("  "), "  ")
  assert.equal(preprocessLenientNumber("many"), "many")
  assert.equal(preprocessLenientNumber("Infinity"), Infinity)
})

test("already typed values and schema-level constraints are preserved", () => {
  assert.equal(preprocessLenientNumber(undefined), undefined)
  assert.equal(preprocessLenientNumber(7), 7)
  assert.equal(preprocessLenientNumber(null), null)
  assert.equal(Number.isNaN(preprocessLenientNumber(Number.NaN) as number), true)

  const wholeNumber = lenientNumber(z.number().int())
  assert.equal(wholeNumber.parse("12"), 12)
  assert.equal(wholeNumber.safeParse("12.5").success, false)
})
