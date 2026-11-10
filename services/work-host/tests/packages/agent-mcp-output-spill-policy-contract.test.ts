import assert from "node:assert/strict"
import { test } from "node:test"

import { buildTruncatedMcpOutputText, truncateMcpOutputUtf8 } from "../../source/packages/agent/tools/mcp/mcp-output-spill-policy.ts"

test("UTF-8 output is unchanged when it fits the byte budget", () => {
  assert.equal(truncateMcpOutputUtf8("small answer", 20), "small answer")
})

test("UTF-8 output is cut on a complete code point when the byte budget splits one", () => {
  const truncated = truncateMcpOutputUtf8("日日日", 4)

  assert.equal(truncated, "日")
  assert.equal(Buffer.byteLength(truncated, "utf8") <= 4, true)
  assert.equal(truncated.includes("\uFFFD"), false)
})

test("failed spills include the full byte count and a do-not-retry notice", () => {
  assert.equal(
    buildTruncatedMcpOutputText("abcdefgh", 4),
    "abcd\n\n[Output truncated: the full MCP tool output was 8 bytes, which exceeds the inline limit of 4 bytes, and could not be written to a file. The remainder was discarded; do not retry the same call expecting the full output.]",
  )
})

test("failed spills count UTF-8 bytes, not UTF-16 code units", () => {
  const output = buildTruncatedMcpOutputText("日".repeat(4), 4)

  assert.equal(output.startsWith("日"), true)
  assert.equal(output.includes("the full MCP tool output was 12 bytes"), true)
  assert.equal(output.includes("\uFFFD"), false)
})
