import assert from "node:assert/strict"
import { test } from "node:test"

import { projectMcpArguments } from "../../source/adapters/interop/mcp/mcp-argument-projection-adapter.ts"

test("generated argument values become plain JSON while existing values pass through", () => {
  const generatedMessage = {
    value: { query: "books", limit: 5 },
    toJson() { return this.value },
  }
  const ordinaryObject = { keep: true }
  const args = {
    query: generatedMessage,
    regular: ordinaryObject,
    flag: false,
    empty: null,
  }

  assert.deepEqual(projectMcpArguments(args), {
    query: { query: "books", limit: 5 },
    regular: ordinaryObject,
    flag: false,
    empty: null,
  })
  assert.equal(projectMcpArguments(args).regular, ordinaryObject)
})
