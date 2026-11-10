import { test } from "node:test"
import assert from "node:assert/strict"

import { createMcpToolRegistry } from "../../source/packages/agent/tools/mcp/mcp-tool-registry.ts"
import { ToolSetHandle } from "../../source/packages/agent/tools/tool-execution.ts"
import { McpDescriptor, McpToolDescriptor, type McpMetaToolOptions } from "../../source/adapters/interop/proto/generated/agent/v1/mcp_pb.ts"
import { McpResult, McpSuccess } from "../../source/adapters/interop/proto/generated/agent/v1/mcp_exec_pb.ts"
import { Value } from "@bufbuild/protobuf"

// ---------------------------------------------------------------------------------------------
// the harness
// ---------------------------------------------------------------------------------------------

const descriptor = new McpDescriptor({
  serverIdentifier: "github",
  serverName: "github",
  tools: [new McpToolDescriptor({ toolName: "create_issue", description: "Creates an issue", inputSchema: Value.fromJson({ type: "object", properties: {} }) })],
})

const executor = {
  async execute() {
    return new McpResult({ result: { case: "success", value: new McpSuccess({}) } })
  },
}

const accessor = { get: () => executor }

const registryOptions = (overrides: Record<string, unknown> = {}) => ({
  resourceAccessor: accessor,
  mcpMetaToolOptions: { mcpDescriptors: [descriptor] } as unknown as McpMetaToolOptions,
  mcpFileSystemOptions: { mcpDescriptors: [descriptor] } as never,
  ...overrides,
}) as never

const identifiersOf = (handle: ToolSetHandle) => handle.getStaticTools().map(tool => tool.toolIdentifier)

// ---------------------------------------------------------------------------------------------
// what the set contains
// ---------------------------------------------------------------------------------------------

test("the invocation tool is always installed", () => {
  const handle = createMcpToolRegistry(registryOptions())
  assert.equal(identifiersOf(handle).includes("MCP"), true)
})

test("discovery is installed when the caller supplied what it needs", () => {
  const handle = createMcpToolRegistry(registryOptions())
  const names = handle.getStaticTools().map(tool => tool.name)
  assert.equal(names.includes("GetMcpTools"), true)
  assert.equal(names.includes("CallMcpTool"), true)
})

test("discovery is left to the caller when there are no descriptors to describe", () => {
  const handle = createMcpToolRegistry(registryOptions({ mcpMetaToolOptions: undefined }))
  const names = handle.getStaticTools().map(tool => tool.name)
  assert.equal(names.includes("GetMcpTools"), false)
  assert.equal(names.includes("CallMcpTool"), true)
})

test("the tools the caller already had are kept", () => {
  const existing = [{ toolIdentifier: "OTHER", name: "SomethingElse", dynamicToolMetaRole: "invocation" }]
  const handle = createMcpToolRegistry(registryOptions({ existingTools: existing }))
  assert.equal(handle.getStaticTools().some(tool => tool.name === "SomethingElse"), true)
})

test("keeps caller tools first, then discovery, and invocation last without changing the input list", () => {
  const existing = [
    { toolIdentifier: "FIRST", name: "FirstTool", dynamicToolMetaRole: "invocation" },
    { toolIdentifier: "SECOND", name: "SecondTool", dynamicToolMetaRole: "invocation" },
  ]
  const expectedExistingNames = existing.map(tool => tool.name)
  const handle = createMcpToolRegistry(registryOptions({ existingTools: existing }))

  assert.deepEqual(handle.getStaticTools().map(tool => tool.name), [
    "FirstTool",
    "SecondTool",
    "GetMcpTools",
    "CallMcpTool",
  ])
  assert.deepEqual(existing.map(tool => tool.name), expectedExistingNames)
})

test("the invocation tool is named what the caller asked for", () => {
  const handle = createMcpToolRegistry(registryOptions({ name: "McpCall" }))
  assert.equal(handle.getStaticTools().some(tool => tool.name === "McpCall"), true)
})

test("the discovery tool is told what the invocation tool is called", () => {
  const handle = createMcpToolRegistry(registryOptions({ name: "McpCall" }))
  const discovery = handle.getStaticTools().find(tool => tool.name === "GetMcpTools")
  const description = (discovery?.descriptionGenerator as (props: Record<string, unknown>) => string)({})
  assert.match(description, /McpCall/)
})

test("the project directory is handed to discovery when there is one", () => {
  const handle = createMcpToolRegistry(registryOptions({ projectDir: "/repo" }))
  assert.equal(handle.getStaticTools().some(tool => tool.name === "GetMcpTools"), true)
})

test("the set is a handle the agent's action handlers can consume", () => {
  const handle = createMcpToolRegistry(registryOptions())
  assert.equal(handle instanceof ToolSetHandle, true)
  assert.equal(handle.getStaticTools().length >= 2, true)
})
