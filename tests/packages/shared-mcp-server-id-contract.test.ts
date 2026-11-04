import assert from "node:assert/strict"
import test from "node:test"

import { SlateMcpConfigError } from "../../source/shared/node/mcp/mcp-config-error.ts"
import {
  isMcpServerId,
  parseInt32McpServerId,
  validateMcpServerId,
} from "../../source/shared/node/mcp/mcp-server-id.ts"

test("server identifiers are positive decimal strings after outer whitespace is removed", () => {
  for (const value of ["1", "12", " 12 ", "2147483647"]) assert.equal(isMcpServerId(value), true)
  for (const value of ["", "  ", "0", "01", "-1", "+1", "1.5", "1e2", "１２"]) {
    assert.equal(isMcpServerId(value), false, value)
  }
  assert.equal(validateMcpServerId(" 42 "), "42")
})

test("integer parsing enforces the supported bound and gives typed configuration errors", () => {
  assert.equal(parseInt32McpServerId("2147483647"), 2_147_483_647)
  assert.throws(() => parseInt32McpServerId("2147483648"), (error: unknown) => {
    assert.ok(error instanceof SlateMcpConfigError)
    assert.match((error as Error).message, /outside the supported range/)
    return true
  })
  assert.throws(() => validateMcpServerId("0"), SlateMcpConfigError)
})
