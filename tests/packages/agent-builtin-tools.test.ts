import { test } from "node:test"
import assert from "node:assert/strict"

import { getToolFamily } from "../../source/packages/agent/tools/tool-families.ts"
import {
  DynamicToolRegistry,
  agentToolResultToMcpToolResult,
  isReservedDynamicToolsNamespace,
  resolveDynamicDispatchToolName,
} from "../../source/packages/agent/tools/mcp/builtin-tools.ts"
import { DYNAMIC_TOOLS_NAMESPACE } from "../../source/packages/agent-exec/mcp-operations.ts"

// ---------------------------------------------------------------------------------------------
// the tool families
// ---------------------------------------------------------------------------------------------

test("a tool's family is looked up by its identifier", () => {
  assert.equal(getToolFamily("READ"), "quality")
  assert.equal(getToolFamily("SHELL"), "quality")
  assert.equal(getToolFamily("MCP"), "extensions")
  assert.equal(getToolFamily("PI_READ"), "data-tools")
  assert.equal(getToolFamily("RECORD_SCREEN"), "background")
  assert.equal(getToolFamily("REPORT_BUG"), "bug-hunting")
  assert.equal(getToolFamily("CODE_LINEAGE"), "core")
})

test("an identifier this build does not know is counted with the general family", () => {
  assert.equal(getToolFamily("unknown"), "quality")
  assert.equal(getToolFamily("SOMETHING_NEW"), undefined)
})

// ---------------------------------------------------------------------------------------------
// the dynamic tool registry
// ---------------------------------------------------------------------------------------------

function tool(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    description: `${name} description`,
    parameters: { jsonSchema: { type: "object" } },
    ...overrides,
  } as never
}

test("an empty registry has nothing to offer", () => {
  const registry = new DynamicToolRegistry()
  assert.equal(registry.isEmpty(), true)
  assert.deepEqual(registry.getTools(), [])
  assert.equal(registry.getMcpDescriptor(), undefined)
})

test("the registry describes its tools as a server of their own", () => {
  const registry = new DynamicToolRegistry()
  registry.replaceTools({ dynamicTools: [tool("zeta"), tool("alpha")], allTools: [tool("zeta"), tool("alpha")] })
  assert.equal(registry.isEmpty(), false)
  assert.deepEqual(registry.getToolNames(), ["alpha", "zeta"])

  const descriptor = registry.getMcpDescriptor()
  assert.equal(descriptor?.serverIdentifier, DYNAMIC_TOOLS_NAMESPACE)
  assert.deepEqual(descriptor?.tools.map(entry => entry.toolName), ["alpha", "zeta"])
  assert.match(String(descriptor?.serverUseInstructions), /Native Slate tools for this session/)
})

test("a tool's concise context is added to the instructions", () => {
  const registry = new DynamicToolRegistry()
  registry.replaceTools({
    dynamicTools: [tool("alpha", { contextType: { type: "dynamic", conciseStaticContext: "  does a thing  " } })],
    allTools: [tool("alpha", { contextType: { type: "dynamic", conciseStaticContext: "  does a thing  " } })],
  })
  assert.match(String(registry.getMcpDescriptor()?.serverUseInstructions), /- alpha: does a thing/)
})

test("a tool that writes its own description is asked for the unseen-tool version", () => {
  const registry = new DynamicToolRegistry()
  const generating = tool("alpha", {
    descriptionGenerator: (_props: unknown, options: { promptVisible: boolean }) =>
      options.promptVisible ? "visible" : "hidden",
  })
  registry.replaceTools({ dynamicTools: [generating], allTools: [generating] })
  assert.equal(registry.getMcpDescriptor()?.tools[0]?.description, "hidden")
})

test("the descriptor is cached per set of meta tool names", () => {
  const registry = new DynamicToolRegistry()
  registry.replaceTools({ dynamicTools: [tool("alpha")], allTools: [tool("alpha")] })
  const first = registry.getMcpDescriptor({ discoveryToolName: "Get", invocationToolName: "Call" })
  const again = registry.getMcpDescriptor({ discoveryToolName: "Get", invocationToolName: "Call" })
  assert.equal(first, again)
  const other = registry.getMcpDescriptor({ discoveryToolName: "Other", invocationToolName: "Call" })
  assert.notEqual(first, other)
})

test("which names are static is tracked only for a session that can dispatch directly", () => {
  // The same tool objects appear in both lists, which is how the registry is called: membership is by
  // identity, so the dynamic side is the set of tools that were held back.
  const dynamicTool = tool("alpha")
  const staticTool = tool("beta")

  const plain = new DynamicToolRegistry()
  plain.replaceTools({ dynamicTools: [dynamicTool], allTools: [dynamicTool, staticTool] })
  assert.equal(plain.isStaticTool("beta"), false)
  assert.equal(plain.usesDirectToolRecovery(), false)

  const recovering = new DynamicToolRegistry({ directToolRecoveryEnabled: true })
  recovering.replaceTools({ dynamicTools: [dynamicTool], allTools: [dynamicTool, staticTool] })
  assert.equal(recovering.isStaticTool("beta"), true)
  assert.equal(recovering.isStaticTool("alpha"), false)
  assert.equal(recovering.usesDirectToolRecovery(), true)
})

test("a tool can be found by name", () => {
  const registry = new DynamicToolRegistry()
  registry.replaceTools({ dynamicTools: [tool("alpha")], allTools: [tool("alpha")] })
  assert.equal(registry.getTool("alpha")?.name, "alpha")
  assert.equal(registry.getTool("nope"), undefined)
})

// ---------------------------------------------------------------------------------------------
// dispatching through the meta tool
// ---------------------------------------------------------------------------------------------

test("a dispatch in our own namespace resolves to the tool's own name", () => {
  const registry = new DynamicToolRegistry()
  registry.replaceTools({ dynamicTools: [tool("alpha")], allTools: [tool("alpha")] })
  assert.equal(
    resolveDynamicDispatchToolName(JSON.stringify({ namespace: DYNAMIC_TOOLS_NAMESPACE, toolName: "alpha" }), registry),
    "alpha",
  )
  assert.equal(isReservedDynamicToolsNamespace(DYNAMIC_TOOLS_NAMESPACE), true)
  assert.equal(isReservedDynamicToolsNamespace("some-mcp-server"), false)
})

test("a server-shaped dispatch is read the same way", () => {
  const registry = new DynamicToolRegistry()
  registry.replaceTools({ dynamicTools: [tool("alpha")], allTools: [tool("alpha")] })
  assert.equal(
    resolveDynamicDispatchToolName(JSON.stringify({ server: DYNAMIC_TOOLS_NAMESPACE, toolName: "alpha" }), registry),
    "alpha",
  )
})

test("a dispatch for another namespace, or an unknown tool, resolves to nothing", () => {
  const registry = new DynamicToolRegistry()
  registry.replaceTools({ dynamicTools: [tool("alpha")], allTools: [tool("alpha")] })
  const dispatch = (payload: unknown) => resolveDynamicDispatchToolName(JSON.stringify(payload), registry)
  assert.equal(dispatch({ namespace: "other", toolName: "alpha" }), undefined)
  assert.equal(dispatch({ namespace: DYNAMIC_TOOLS_NAMESPACE, toolName: "nope" }), undefined)
  assert.equal(dispatch({ namespace: DYNAMIC_TOOLS_NAMESPACE }), undefined)
  assert.equal(dispatch({ toolName: "alpha" }), undefined)
  assert.equal(dispatch([DYNAMIC_TOOLS_NAMESPACE, "alpha"]), undefined)
  assert.equal(dispatch("a string"), undefined)
  assert.equal(resolveDynamicDispatchToolName("{not json", registry), undefined)
})

// ---------------------------------------------------------------------------------------------
// the result an MCP caller reads
// ---------------------------------------------------------------------------------------------

test("a rendered tool result becomes an MCP result with its content and its error flag", () => {
  const result = agentToolResultToMcpToolResult({
    content: [
      { type: "text", text: "output" },
      { type: "image", data: Buffer.from("bytes").toString("base64"), mimeType: "image/png" },
      { type: "other", text: "{\"value\":1}" },
    ],
    isError: true,
  })
  assert.equal(result.result.case, "success")
  const success = result.result.value as { content: Array<{ content: { case?: string; value?: unknown } }>; isError: boolean }
  assert.equal(success.content.length, 3)
  assert.equal(success.content[0]?.content.case, "text")
  assert.equal(success.content[1]?.content.case, "image")
  // An item the platform has no MCP equivalent for travels as its JSON.
  assert.match(String((success.content[2]?.content.value as { text: string }).text), /value/)
  assert.equal(success.isError, true)
})

test("an image without a mime type is sent as a PNG", () => {
  const result = agentToolResultToMcpToolResult({
    content: [{ type: "image", data: Buffer.from("bytes").toString("base64") }],
  })
  const success = result.result.value as { content: Array<{ content: { value: { mimeType: string } } }> }
  assert.equal(success.content[0]?.content.value.mimeType, "image/png")
})
