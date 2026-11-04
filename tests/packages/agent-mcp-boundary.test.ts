import { test } from "node:test"
import assert from "node:assert/strict"

import {
  MCP_AUTH_VIRTUAL_TOOL_NAME,
  buildMcpCallSchemas,
} from "../../source/packages/agent/tools/mcp/mcp-call-options.ts"
import { indexInteropMcpDescriptors } from "../../source/adapters/interop/agent/mcp-descriptor-index-adapter.ts"
import {
  McpExecToolNotFoundError,
  McpInvalidArgsToolDefinitionReminderError,
  McpPermissionDeniedError,
  McpServerDoesNotExistError,
  McpWithoutReadToolDefinitionError,
  createMcpTransportError,
  getWrappedMcpErrorClassification,
  isInvalidMcpArgumentsError,
} from "../../source/packages/agent/tools/mcp/mcp-result-boundary.ts"
import {
  convertExecSuccessToToolSuccess,
  createMcpToolCall,
  createVirtualMcpAuthSuccessResult,
  renderMcpToolResult,
} from "../../source/adapters/interop/agent/mcp-result-adapter.ts"
import {
  McpApproved,
  McpError,
  McpImageContent,
  McpPermissionDenied,
  McpRejected,
  McpResult,
  McpServerNotFound,
  McpSuccess,
  McpTextContent,
  McpToolNotFound,
  McpToolResultContentItem,
} from "../../source/adapters/interop/proto/generated/agent/v1/mcp_exec_pb.ts"
import { McpToolError, McpToolResult } from "../../source/adapters/interop/proto/generated/agent/v1/mcp_tool_pb.ts"
import { McpDescriptor, McpFileSystemOptions, McpMetaToolOptions, McpToolDescriptor } from "../../source/adapters/interop/proto/generated/agent/v1/mcp_pb.ts"
import { CustomToolCallError, ToolCallRejectedError, ToolErrorClassification } from "../../source/packages/agent/tools/tool-errors.ts"
import { ASK_MODE_MODEL_ERROR } from "../../source/packages/agent/tools/tool-support.ts"
import type { OutputLocation } from "../../source/adapters/interop/proto/generated/agent/v1/utils_pb.ts"

// ---------------------------------------------------------------------------------------------
// which servers and tools a session can call
// ---------------------------------------------------------------------------------------------

function descriptor(serverIdentifier: string, tools: Array<{ toolName: string; definitionPath?: string }>): McpDescriptor {
  return new McpDescriptor({
    serverIdentifier,
    serverName: `${serverIdentifier} server`,
    tools: tools.map(tool => new McpToolDescriptor({
      toolName: tool.toolName,
      ...(tool.definitionPath === undefined ? {} : { definitionPath: tool.definitionPath }),
    })),
  })
}

test("the descriptors the session can call come from the meta tool or from the filesystem options", () => {
  const fromMeta = new McpMetaToolOptions({ enabled: true, mcpDescriptors: [descriptor("meta-server", [{ toolName: "search" }])] })
  const fromFiles = new McpFileSystemOptions({ enabled: true, workspaceProjectDir: "/repo", mcpDescriptors: [descriptor("file-server", [{ toolName: "search" }])] })

  const viaMeta = indexInteropMcpDescriptors({ mcpMetaToolEnabled: true, mcpMetaToolOptions: fromMeta, mcpFileSystemOptions: fromFiles })
  assert.deepEqual(Array.from(viaMeta.serverDescriptors.keys()), ["meta-server"])

  const viaFiles = indexInteropMcpDescriptors({ mcpMetaToolEnabled: false, mcpMetaToolOptions: fromMeta, mcpFileSystemOptions: fromFiles })
  assert.deepEqual(Array.from(viaFiles.serverDescriptors.keys()), ["file-server"])
})

test("a session that cannot sign in does not offer the sign-in tool", () => {
  const options = new McpMetaToolOptions({
    enabled: true,
    mcpDescriptors: [descriptor("server-a", [{ toolName: MCP_AUTH_VIRTUAL_TOOL_NAME }, { toolName: "search" }])],
  })
  const withoutAuth = indexInteropMcpDescriptors({ mcpMetaToolEnabled: true, mcpMetaToolOptions: options })
  assert.deepEqual(withoutAuth.serverDescriptors.get("server-a")?.tools.map(tool => tool.toolName), ["search"])

  const withAuth = indexInteropMcpDescriptors({ mcpMetaToolEnabled: true, mcpMetaToolOptions: options, allowInteractiveMcpAuth: true })
  assert.deepEqual(withAuth.serverDescriptors.get("server-a")?.tools.map(tool => tool.toolName), [MCP_AUTH_VIRTUAL_TOOL_NAME, "search"])
})

test("a tool's definition file is remembered under its server and name", () => {
  const options = new McpMetaToolOptions({
    enabled: true,
    mcpDescriptors: [descriptor("server-a", [
      { toolName: "search", definitionPath: "/repo/mcps/server-a/search.md" },
      { toolName: "fetch" },
    ])],
  })
  const index = indexInteropMcpDescriptors({ mcpMetaToolEnabled: true, mcpMetaToolOptions: options })
  assert.deepEqual(Array.from(index.toolDefinitionPaths.entries()), [["server-a:search", "/repo/mcps/server-a/search.md"]])
})

// ---------------------------------------------------------------------------------------------
// the shape of the call, and the shapes models actually send
// ---------------------------------------------------------------------------------------------

const propertiesOf = (schema: unknown): string[] => Object.keys((schema as { shape: Record<string, unknown> }).shape)

test("a dynamic namespace call names its server by namespace and carries its metadata beside the arguments", () => {
  const dynamic = buildMcpCallSchemas({ useDynamicToolNamespaces: true, smartModeClassifierMode: false })
  assert.deepEqual(propertiesOf(dynamic.parametersSchema), ["namespace", "toolName", "mcpDetails", "arguments"])

  const plain = buildMcpCallSchemas({ useDynamicToolNamespaces: false, smartModeClassifierMode: false })
  assert.deepEqual(propertiesOf(plain.parametersSchema), ["server", "toolName", "description", "arguments"])
})

test("an approval retry is only offered when the classifier is running", () => {
  const without = buildMcpCallSchemas({ useDynamicToolNamespaces: false, smartModeClassifierMode: false })
  assert.deepEqual(propertiesOf(without.parametersSchema), ["server", "toolName", "description", "arguments"])

  const with_ = buildMcpCallSchemas({ useDynamicToolNamespaces: false, smartModeClassifierMode: true })
  assert.deepEqual(propertiesOf(with_.parametersSchema), ["server", "toolName", "description", "requestSmartModeApproval", "smartModeBlockReason", "arguments"])
})

test("a call that names the server as a namespace is read back into the server field", () => {
  const schemas = buildMcpCallSchemas({ useDynamicToolNamespaces: true, smartModeClassifierMode: false })
  assert.deepEqual(
    schemas.normalizeInput({ namespace: "server-a", toolName: "search", arguments: { q: "x" } }),
    { server: "server-a", toolName: "search", arguments: { q: "x" } },
  )
})

test("a call with no tool identity is refused with what is missing", () => {
  const schemas = buildMcpCallSchemas({ useDynamicToolNamespaces: true, smartModeClassifierMode: false })
  assert.throws(
    () => schemas.normalizeInput({ arguments: { q: "x" } }),
    /Missing required fields: namespace, toolName\. Re-issue the call with the tool's identity set; `arguments` alone does not identify the tool\./,
  )
  assert.throws(() => schemas.normalizeInput({ namespace: "server-a", arguments: {} }), /Missing required field: toolName\./)
})

test("a description sent under its old name is read as the description", () => {
  const schemas = buildMcpCallSchemas({ useDynamicToolNamespaces: false, smartModeClassifierMode: false })
  assert.deepEqual(
    schemas.normalizeInput({ server: "s", toolName: "t", descriptionForMcp: "send the message", arguments: {} }),
    { server: "s", toolName: "t", description: "send the message", arguments: {} },
  )
})

test("arguments sent as a quoted string are read as the object they hold", () => {
  const schemas = buildMcpCallSchemas({ useDynamicToolNamespaces: false, smartModeClassifierMode: false })
  assert.deepEqual(
    schemas.normalizeInput({ server: "s", toolName: "t", arguments: '{"q":"x"}' }),
    { server: "s", toolName: "t", arguments: { q: "x" } },
  )
})

test("a string that only looks like JSON is refused with how to send it", () => {
  const schemas = buildMcpCallSchemas({ useDynamicToolNamespaces: false, smartModeClassifierMode: false })
  assert.throws(
    () => schemas.normalizeInput({ server: "s", toolName: "t", arguments: "not json at all" }),
    /Failed to parse arguments string as JSON object\. Re-issue the call with `arguments` as a JSON object literal rather than a quoted string\./,
  )
})

test("metadata folded into a repaired argument string is lifted back out", () => {
  const schemas = buildMcpCallSchemas({ useDynamicToolNamespaces: true, smartModeClassifierMode: false })
  const repaired = schemas.normalizeInput({
    namespace: "server-a",
    toolName: "search",
    arguments: '{"mcpDetails":{"description":"send the message"}}}',
  }) as Record<string, unknown>
  assert.deepEqual(repaired.arguments, {})
  assert.deepEqual(repaired.mcpDetails, { description: "send the message" })

  const foldedDescription = schemas.normalizeInput({
    namespace: "server-a",
    toolName: "search",
    arguments: '{"descriptionForMcp":"send the message","x":1}}',
  }) as Record<string, unknown>
  assert.equal(foldedDescription.description, "send the message")
  assert.deepEqual(foldedDescription.arguments, { x: 1 })
})

test("a description that leaked outside the arguments is recovered", () => {
  const schemas = buildMcpCallSchemas({ useDynamicToolNamespaces: false, smartModeClassifierMode: false })
  const normalized = schemas.normalizeInput({
    server: "s",
    toolName: "t",
    arguments: '{"x":1}<parameter name="description">send the message</parameter>',
  }) as Record<string, unknown>
  assert.equal(normalized.description, "send the message")
  assert.deepEqual(normalized.arguments, { x: 1 })
})

test("approval fields inside the arguments are moved out before the server sees them", () => {
  const schemas = buildMcpCallSchemas({ useDynamicToolNamespaces: false, smartModeClassifierMode: true })
  assert.deepEqual(
    schemas.normalizeInput({
      server: "s",
      toolName: "t",
      arguments: { q: "x", requestSmartModeApproval: true, smartModeBlockReason: "writes to a shared channel" },
    }),
    {
      server: "s",
      toolName: "t",
      arguments: { q: "x" },
      requestSmartModeApproval: true,
      smartModeBlockReason: "writes to a shared channel",
    },
  )

  const withoutClassifier = buildMcpCallSchemas({ useDynamicToolNamespaces: false, smartModeClassifierMode: false })
  assert.deepEqual(
    withoutClassifier.normalizeInput({ server: "s", toolName: "t", arguments: { requestSmartModeApproval: true } }),
    { server: "s", toolName: "t", arguments: { requestSmartModeApproval: true } },
  )
})

test("the parsing schema accepts a namespace call and folds its metadata into the call", () => {
  const schemas = buildMcpCallSchemas({ useDynamicToolNamespaces: true, smartModeClassifierMode: true })
  const parsed = schemas.parsingParametersSchema.parse({
    namespace: "server-a",
    toolName: "search",
    mcpDetails: { description: "send the message", requestSmartModeApproval: true },
    arguments: { q: "x" },
  })
  assert.deepEqual(parsed, {
    server: "server-a",
    toolName: "search",
    arguments: { q: "x" },
    description: "send the message",
    requestSmartModeApproval: true,
    smartModeBlockReason: undefined,
  })
})

test("the parsing schema refuses a call with no identity and accepts one without arguments", () => {
  const schemas = buildMcpCallSchemas({ useDynamicToolNamespaces: true, smartModeClassifierMode: false })
  assert.throws(() => schemas.parsingParametersSchema.parse({ toolName: "search" }), /Missing required field: namespace\./)
  assert.deepEqual(schemas.parsingParametersSchema.parse({ namespace: "server-a", toolName: "search" }), {
    server: "server-a",
    toolName: "search",
    description: undefined,
    requestSmartModeApproval: undefined,
    smartModeBlockReason: undefined,
  })
})

// ---------------------------------------------------------------------------------------------
// what came back: results, refusals and the guidance each failure deserves
// ---------------------------------------------------------------------------------------------

const successOf = (content: McpToolResultContentItem[], isError = false): McpResult => new McpResult({
  result: { case: "success", value: new McpSuccess({ content, isError }) },
})

const textItem = (text: string, outputLocation?: OutputLocation): McpToolResultContentItem => new McpToolResultContentItem({
  content: { case: "text", value: new McpTextContent({ text, ...(outputLocation === undefined ? {} : { outputLocation }) }) },
})

test("a successful server answer becomes the tool's own success", () => {
  const execResult = successOf([textItem("done")])
  const converted = convertExecSuccessToToolSuccess(execResult, undefined, undefined, undefined, undefined)
  assert.equal(converted.result.case, "success")
  assert.equal(converted.result.case === "success" ? converted.result.value.content[0]?.content.case : "", "text")
})

test("a refusal is reported as a refusal, with what the session may do about it", () => {
  const readonly = new McpResult({ result: { case: "permissionDenied", value: new McpPermissionDenied({ error: "no writes", isReadonly: true }) } })
  assert.throws(
    () => convertExecSuccessToToolSuccess(readonly, undefined, undefined, undefined, undefined),
    (error: unknown) => error instanceof McpPermissionDeniedError &&
      error.isReadonly &&
      error.modelVisibleErrorMessage === "You are in ask mode and cannot run non read-only tools. Ask the user to switch to agent mode if edits are required.",
  )

  const denied = new McpResult({ result: { case: "permissionDenied", value: new McpPermissionDenied({ error: "no writes", isReadonly: false }) } })
  assert.throws(
    () => convertExecSuccessToToolSuccess(denied, undefined, undefined, undefined, undefined),
    (error: unknown) => error instanceof McpPermissionDeniedError && error.modelVisibleErrorMessage === "Permission denied: no writes",
  )

  const rejected = new McpResult({ result: { case: "rejected", value: new McpRejected({ reason: "" }) } })
  assert.throws(() => convertExecSuccessToToolSuccess(rejected, undefined, undefined, undefined, undefined), ToolCallRejectedError)
})

test("a server failure is classified when the message says what it was", () => {
  const invalidArgs = createMcpTransportError("MCP error -32602: bad arguments")
  assert.equal(invalidArgs instanceof CustomToolCallError, true)
  assert.equal(isInvalidMcpArgumentsError(invalidArgs), true)

  const timeout = createMcpTransportError("MCP error -32001: connection timed out after 30s")
  assert.equal(getWrappedMcpErrorClassification(timeout), ToolErrorClassification.TIMEOUT)

  const unrecognized = createMcpTransportError("the server said no")
  assert.equal(unrecognized instanceof CustomToolCallError, false)
  assert.equal(unrecognized.message, "the server said no")
  assert.equal(getWrappedMcpErrorClassification(unrecognized), ToolErrorClassification.OTHER_ERROR)
})

test("a failure to call a tool at all is answered with reading its definition first", () => {
  const failed = new McpResult({ result: { case: "error", value: new McpError({ error: "MCP error -32602: bad arguments" }) } })
  assert.throws(
    () => convertExecSuccessToToolSuccess(failed, "Read the tool definition first.", undefined, undefined, undefined),
    (error: unknown) => error instanceof McpWithoutReadToolDefinitionError &&
      error.classification === ToolErrorClassification.INVALID_ARGS &&
      error.modelVisibleErrorMessage === "MCP error -32602: bad arguments. Read the tool definition first.",
  )

  // Without the reminder the failure keeps its own classification and is thrown as it was.
  assert.throws(
    () => convertExecSuccessToToolSuccess(failed, undefined, undefined, undefined, undefined),
    (error: unknown) => isInvalidMcpArgumentsError(error),
  )
})

test("bad arguments that were never checked against the definition say so", () => {
  const failed = new McpResult({ result: { case: "error", value: new McpError({ error: "MCP error -32600: invalid request" }) } })
  assert.throws(
    () => convertExecSuccessToToolSuccess(failed, undefined, "Read the tool definition first.", undefined, undefined),
    (error: unknown) => error instanceof McpInvalidArgsToolDefinitionReminderError &&
      error.modelVisibleErrorMessage === "MCP error -32600: invalid request. Read the tool definition first.",
  )
})

test("a missing tool points at the servers when the whole server is missing", () => {
  const missing = new McpResult({
    result: { case: "toolNotFound", value: new McpToolNotFound({ name: "server-b-search", availableTools: ["server-a-search"] }) },
  })
  assert.throws(
    () => convertExecSuccessToToolSuccess(missing, undefined, undefined, undefined, "GetMcpTools", "server-b"),
    (error: unknown) => error instanceof McpServerDoesNotExistError &&
      error.modelVisibleErrorMessage === "MCP server does not exist: server-b. Use GetMcpTools to discover available servers.",
  )
})

test("a missing tool points at the descriptor files when the session has them", () => {
  const missing = new McpResult({
    result: { case: "toolNotFound", value: new McpToolNotFound({ name: "search", availableTools: ["server-a-fetch"] }) },
  })
  assert.throws(
    () => convertExecSuccessToToolSuccess(missing, undefined, undefined, { enabled: true, workspaceProjectDir: "/repo" }, undefined, "server-a"),
    (error: unknown) => error instanceof McpExecToolNotFoundError &&
      error.modelVisibleErrorMessage.includes("/repo/mcps"),
  )

  const withoutFiles = new McpResult({
    result: { case: "toolNotFound", value: new McpToolNotFound({ name: "search", availableTools: [] }) },
  })
  assert.throws(
    () => convertExecSuccessToToolSuccess(withoutFiles, undefined, undefined, undefined, "ListMcpServers"),
    (error: unknown) => error instanceof McpExecToolNotFoundError &&
      error.modelVisibleErrorMessage === "Tool search was not found. Use ListMcpServers to discover available servers and their tools.",
  )
})

test("a missing server lists the servers that do exist", () => {
  const withServers = new McpResult({
    result: { case: "serverNotFound", value: new McpServerNotFound({ name: "server-b", availableServers: ["server-a", "server-c"] }) },
  })
  assert.throws(
    () => convertExecSuccessToToolSuccess(withServers, undefined, undefined, undefined, undefined),
    (error: unknown) => error instanceof McpServerDoesNotExistError &&
      error.readServerDefReminder === "Available servers: server-a, server-c",
  )

  const none = new McpResult({ result: { case: "serverNotFound", value: new McpServerNotFound({ name: "server-b", availableServers: [] }) } })
  assert.throws(
    () => convertExecSuccessToToolSuccess(none, undefined, undefined, { enabled: true, workspaceProjectDir: "/repo" }, undefined),
    (error: unknown) => error instanceof McpServerDoesNotExistError &&
      error.readServerDefReminder === "No MCP servers available. Read the MCP server descriptor files to discover available servers.",
  )
  assert.throws(
    () => convertExecSuccessToToolSuccess(none, undefined, undefined, undefined, undefined),
    (error: unknown) => error instanceof McpServerDoesNotExistError &&
      error.readServerDefReminder === "No MCP servers available. Use GetMcpTools to discover available servers.",
  )
})

test("a result that is only an approval cannot stand in for tool output", () => {
  const approved = new McpResult({ result: { case: "approved", value: new McpApproved({}) } })
  assert.throws(() => convertExecSuccessToToolSuccess(approved, undefined, undefined, undefined, undefined), /Approval-only MCP result cannot be used as tool output/)

  const noCase = new McpResult({})
  assert.throws(() => convertExecSuccessToToolSuccess(noCase, undefined, undefined, undefined, undefined), /Exec result has no case/)
})

test("a sign-in result says the server's tools are now available", () => {
  const result = createVirtualMcpAuthSuccessResult("server-a")
  const rendered = renderMcpToolResult(result)
  assert.equal(rendered.isError, false)
  assert.deepEqual(rendered.content, [{
    type: "text",
    text: "Successfully authenticated MCP server: server-a. The server's tools should now be available.",
  }])
})

test("the call a turn records carries the tool call", () => {
  const call = createMcpToolCall({ args: undefined, result: undefined, description: "search the server" } as never)
  assert.equal(call.tool.case, "mcpToolCall")
  assert.equal(call.tool.case === "mcpToolCall" ? call.tool.value.description : "", "search the server")
})

// ---------------------------------------------------------------------------------------------
// what the turn shows: text, images, and where a large output went
// ---------------------------------------------------------------------------------------------

test("a text result is shown as its text", () => {
  const rendered = renderMcpToolResult(convertExecSuccessToToolSuccess(successOf([textItem("the answer")]), undefined, undefined, undefined, undefined))
  assert.deepEqual(rendered.content, [{ type: "text", text: "the answer" }])
  assert.equal(rendered.isError, false)
})

test("an image result is sent as bytes with the mime type the server gave", () => {
  const bytes = new Uint8Array([1, 2, 3, 4])
  const result = convertExecSuccessToToolSuccess(
    successOf([new McpToolResultContentItem({ content: { case: "image", value: new McpImageContent({ data: bytes, mimeType: "image/png" }) } })]),
    undefined,
    undefined,
    undefined,
    undefined,
  )
  assert.deepEqual(renderMcpToolResult(result).content, [{
    type: "image",
    data: Buffer.from(bytes).toString("base64"),
    mimeType: "image/png",
  }])
})

test("a text result that was written to a file says where it went and how big it is", () => {
  const location = { filePath: "/repo/.slate/outputs/big.txt", sizeBytes: 2048n, lineCount: 120n } as unknown as OutputLocation
  const rendered = renderMcpToolResult(convertExecSuccessToToolSuccess(successOf([textItem("", location)]), undefined, undefined, undefined, undefined))
  assert.deepEqual(rendered.content, [{
    type: "text",
    text: "Large output has been written to: /repo/.slate/outputs/big.txt (2.0 KB, 120 lines)",
  }])

  const small = { filePath: "/repo/.slate/outputs/small.txt", sizeBytes: 512n, lineCount: 3n } as unknown as OutputLocation
  const smallRendered = renderMcpToolResult(convertExecSuccessToToolSuccess(successOf([textItem("", small)]), undefined, undefined, undefined, undefined))
  assert.deepEqual(smallRendered.content, [{
    type: "text",
    text: "Large output has been written to: /repo/.slate/outputs/small.txt (512 bytes, 3 lines)",
  }])
})

test("a server that answered with an error is shown as an error", () => {
  const errored = new McpToolResult({
    result: { case: "success", value: new McpSuccess({ content: [textItem("failed")], isError: true }) },
  })
  assert.equal(renderMcpToolResult(errored).isError, true)
})

test("the recorded failures are shown with the guidance they carry", () => {
  const rejected = new McpToolResult({ result: { case: "rejected", value: new McpRejected({ reason: "needs approval" }) } })
  assert.deepEqual(renderMcpToolResult(rejected).content, [{ type: "text", text: "Tool rejected: needs approval" }])
  const rejectedWithoutReason = new McpToolResult({ result: { case: "rejected", value: new McpRejected({}) } })
  assert.deepEqual(renderMcpToolResult(rejectedWithoutReason).content, [{ type: "text", text: "Tool rejected" }])

  const withReminder = new McpToolResult({
    result: { case: "error", value: new McpToolError({ error: "bad arguments", readToolDefReminder: "Read the definition." }) },
  })
  assert.deepEqual(renderMcpToolResult(withReminder).content, [{ type: "text", text: "Error: bad arguments. Read the definition." }])
  const withoutReminder = new McpToolResult({ result: { case: "error", value: new McpToolError({ error: "bad arguments" }) } })
  assert.deepEqual(renderMcpToolResult(withoutReminder).content, [{ type: "text", text: "Error: bad arguments" }])

  const readonlyDenied = new McpToolResult({
    result: { case: "permissionDenied", value: new McpPermissionDenied({ error: "no writes", isReadonly: true }) },
  })
  assert.deepEqual(renderMcpToolResult(readonlyDenied).content, [{ type: "text", text: ASK_MODE_MODEL_ERROR }])
  const denied = new McpToolResult({
    result: { case: "permissionDenied", value: new McpPermissionDenied({ error: "no writes", isReadonly: false }) },
  })
  assert.deepEqual(renderMcpToolResult(denied).content, [{ type: "text", text: "Permission denied: no writes" }])
})

test("a result with nothing in it is shown as an unknown error", () => {
  assert.deepEqual(renderMcpToolResult(new McpToolResult({})).content, [{ type: "text", text: "Unknown error" }])
})
