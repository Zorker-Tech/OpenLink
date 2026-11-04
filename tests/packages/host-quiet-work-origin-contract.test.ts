import assert from "node:assert/strict"
import { test } from "node:test"

import { createContext } from "../../source/packages/context/context.ts"
import { slateQuietWorkOriginKey } from "../../source/host/slate-quiet-work-origin.ts"

test("quiet-work origin values are optional context data and remain scoped to their branch", () => {
  const root = createContext()
  const origin = { kind: "automation", id: "daily-run" }

  assert.equal(root.get(slateQuietWorkOriginKey), undefined)

  const quietWork = root.with(slateQuietWorkOriginKey, origin)
  assert.strictEqual(quietWork.get(slateQuietWorkOriginKey), origin)
  assert.strictEqual(quietWork.withName("child").get(slateQuietWorkOriginKey), origin)
  assert.equal(root.get(slateQuietWorkOriginKey), undefined)
  assert.equal(quietWork.with(slateQuietWorkOriginKey, undefined).get(slateQuietWorkOriginKey), undefined)
})
