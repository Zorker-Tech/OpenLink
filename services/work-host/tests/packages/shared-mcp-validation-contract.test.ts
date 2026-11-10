import assert from "node:assert/strict"
import { test } from "node:test"

import { SlateMcpConfigError } from "../../source/shared/node/mcp/mcp-config-error.ts"
import { getCommand, getTransport, parseServerConfig, validateServerName } from "../../source/shared/node/mcp/mcp-validation.ts"

test("Slate's server config reports its transport and executable command", () => {
  assert.equal(getTransport({ command: "node", args: ["server.js"] }), "stdio")
  assert.equal(getCommand({ command: "node", args: ["server.js", "--safe"] }), "node server.js --safe")
  assert.equal(getCommand({ url: "https://mcp.example" }), undefined)
  assert.equal(getTransport({ url: "https://mcp.example", type: "sse" }), "sse")
  assert.equal(getTransport({ url: "https://mcp.example" }), "http")
})

test("server labels are trimmed and reject names that escape or collide", () => {
  assert.equal(validateServerName("  team-search  "), "team-search")
  for (const invalid of ["", "  ", "__proto__", "constructor", "prototype", "has/slash", "has\\slash", "has\0nul", "two--parts"]) {
    assert.throws(() => validateServerName(invalid), SlateMcpConfigError, invalid)
  }
})

test("JSON parsing is followed by the caller's Slate config validator", () => {
  const config = { url: "https://mcp.example", type: "http" as const }
  const seen: unknown[] = []
  const parsed = parseServerConfig(JSON.stringify(config), value => {
    seen.push(value)
    return value as typeof config
  })
  assert.deepEqual(parsed, config)
  assert.deepEqual(seen, [config])
  assert.throws(() => parseServerConfig("{", value => value as typeof config), SyntaxError)
})
