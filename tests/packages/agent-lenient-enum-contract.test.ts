import assert from "node:assert/strict"
import test from "node:test"

import { z } from "zod"

import { lenientEnum, preprocessLenientEnumValue } from "../../source/packages/agent/tools/lenient-scalars.ts"

test("enum coercion keeps exact values and resolves a unique case-insensitive choice", () => {
  const choices = ["fast", "slow"] as const
  assert.equal(preprocessLenientEnumValue("fast", choices), "fast")
  assert.equal(preprocessLenientEnumValue("FAST", choices), "fast")
  assert.equal(preprocessLenientEnumValue(" fast ", choices), " fast ")
  assert.equal(preprocessLenientEnumValue(4, choices), 4)
})

test("case-insensitive ambiguity remains invalid instead of choosing an option", () => {
  const schema = z.object({ mode: lenientEnum(z.enum(["Fast", "FAST"])) })
  assert.equal(preprocessLenientEnumValue("fast", ["Fast", "FAST"]), "fast")
  assert.equal(schema.safeParse({ mode: "fast" }).success, false)
})
