import assert from "node:assert/strict"
import { test } from "node:test"

import { McpMetaToolInstructions } from "../../source/packages/agent/prompts/mcp-meta-tool-instructions.ts"
import type { UserInfoMcpDescriptor } from "../../source/packages/agent/prompts/user-info-data-contracts.ts"

const descriptors: readonly UserInfoMcpDescriptor[] = [{
  serverIdentifier: "files",
  serverUseInstructions: "Use this server for shared files.",
  tools: [{ toolName: "search" }, { toolName: "read" }],
}]

test("no tool descriptors means there is no discovery block", () => {
  assert.equal(McpMetaToolInstructions([], {
    discoveryToolName: "find_tools",
    invocationToolName: "run_tool",
    useDynamicToolNamespaces: false,
  }), "")
})

test("server-backed instructions expose complete lookup and bounded catalog search", () => {
  const instructions = McpMetaToolInstructions(descriptors, {
    discoveryToolName: "find_tools",
    invocationToolName: "run_tool",
    useDynamicToolNamespaces: false,
    fetchMcpResourceToolName: "fetch_resource",
    listMcpResourcesToolName: "list_resources",
  })

  assert.match(instructions, /^<mcp_meta_tools>/)
  assert.match(instructions, /server-specific/i)
  assert.match(instructions, /one-tool lookup/i)
  assert.match(instructions, /complete schema/i)
  assert.match(instructions, /RE2/)
  assert.match(instructions, /\[truncated\]/)
  assert.match(instructions, /MANDATORY/)
  assert.match(instructions, /files/)
  assert.match(instructions, /list_resources/)
  assert.match(instructions, /fetch_resource/)
  assert.match(instructions, /mcp_auth/)
  assert.match(instructions, /user explicitly asks for browser use/i)
})

test("dynamic-namespace instructions use namespace lookups and the same resource tools", () => {
  const instructions = McpMetaToolInstructions(descriptors, {
    discoveryToolName: "inspect_namespace",
    invocationToolName: "call_dynamic_tool",
    useDynamicToolNamespaces: true,
    fetchMcpResourceToolName: "fetch_resource",
  })

  assert.match(instructions, /^<dynamic_tools>/)
  assert.match(instructions, /namespace-wide lookup/i)
  assert.match(instructions, /one-tool lookup/i)
  assert.match(instructions, /complete schema/i)
  assert.match(instructions, /No arguments for the full catalog/i)
  assert.match(instructions, /\[truncated\]/)
  assert.match(instructions, /Connect files|files/)
  assert.match(instructions, /fetch_resource/)
  assert.match(instructions, /inspect_namespace/)
  assert.match(instructions, /call_dynamic_tool/)
  assert.match(instructions, /user explicitly asks for browser use/i)
})
