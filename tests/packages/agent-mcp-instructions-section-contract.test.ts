import assert from "node:assert/strict"
import { test } from "node:test"

import { renderContent } from "../../source/packages/prompt-jsx/render-prompt.ts"
import { McpInstructionsSection } from "../../source/packages/agent/prompts/mcp-instructions-section.ts"

test("an empty instruction list produces an empty, named MCP section", () => {
  const section = McpInstructionsSection({ mcpEntries: [] })
  assert.equal(section.type, "section")
  assert.equal(section.props.title, "mcp_instructions")
  assert.equal(
    renderContent(section),
    '<mcp_instructions description="Instructions provided by MCP servers to help use them properly" />',
  )
})

test("server instructions preserve order and text while unknown server names stay visible", () => {
  const section = McpInstructionsSection({
    mcpEntries: [
      { serverName: "alpha", instructions: "  keep these spaces  " },
      { instructions: "Resource guidance" },
      { serverName: "beta", instructions: "Use the second service" },
    ],
  })
  assert.equal(section.children?.[0], "Server: alpha\n  keep these spaces  \n\nServer: unknown\nResource guidance\n\nServer: beta\nUse the second service")

  assert.equal(renderContent(section), [
    '<mcp_instructions description="Instructions provided by MCP servers to help use them properly">',
    "Server: alpha\n keep these spaces ",
    "",
    "Server: unknown\nResource guidance",
    "",
    "Server: beta\nUse the second service",
    "</mcp_instructions>",
  ].join("\n"))
})
