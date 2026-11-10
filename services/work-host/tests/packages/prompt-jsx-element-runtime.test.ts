import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { Fragment, jsx, jsxs } from "../../source/packages/prompt-jsx/element.ts"

describe("prompt JSX element runtime", () => {
  it("keeps an explicit props child even when it is falsey instead of falling back to varargs", () => {
    assert.deepEqual(jsx("p", { children: 0 }, "fallback").children, [0])
    assert.equal(jsx("p", { children: "" }, "fallback").children, undefined)
    assert.equal(jsx("p", { children: null }, "fallback").children, undefined)
  })

  it("uses varargs only when props do not provide children and keeps JSX helpers equivalent", () => {
    assert.deepEqual(jsx("p", {}, "one", false, "two").children, ["one", "two"])
    assert.deepEqual(jsxs(Fragment, { children: ["one", null, "two"] }).children, ["one", "two"])
  })
})
