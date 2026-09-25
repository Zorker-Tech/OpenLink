import { test } from "node:test"
import assert from "node:assert/strict"

import { createCallMcpTool, createMcpTool } from "../../source/packages/agent/tools/mcp/mcp.ts"
import { indexMcpDescriptors } from "../../source/packages/agent/tools/mcp/mcp-call-options.ts"
import { McpToolResult } from "../../source/packages/proto/generated/agent/v1/mcp_tool_pb.ts"
import { McpResult, McpSuccess } from "../../source/packages/proto/generated/agent/v1/mcp_exec_pb.ts"
import { McpDescriptor, McpToolDescriptor } from "../../source/packages/proto/generated/agent/v1/mcp_pb.ts"
import { Value } from "@bufbuild/protobuf"

import { createContext } from "../../source/packages/context/context.ts"

// ---------------------------------------------------------------------------------------------
// the harness
// ---------------------------------------------------------------------------------------------

const toolDescriptor = (toolName: string, definitionPath?: string) =>
  new McpToolDescriptor({
    toolName,
    description: `${toolName} does something`,
    inputSchema: Value.fromJson({ type: "object", properties: { query: { type: "string" } } }),
    ...(definitionPath === undefined ? {} : { definitionPath }),
  })

const descriptor = (serverIdentifier: string, tools: McpToolDescriptor[]) =>
  new McpDescriptor({ serverIdentifier, serverName: serverIdentifier, tools })

/** An executor that answers with whatever the test says and records what it was asked. */
const execSuccess = () => new McpResult({ result: { case: "success", value: new McpSuccess({}) } })

function executor(behaviour: { result?: McpResult; error?: Error } = {}) {
  const calls: unknown[] = []
  return {
    calls,
    executor: {
      async execute(_ctx: unknown, args: unknown, options: unknown) {
        calls.push({ args, options })
        if (behaviour.error !== undefined) throw behaviour.error
        return behaviour.result ?? execSuccess()
      },
    },
  }
}

const accessor = (implementation: unknown) => ({
  get: () => implementation,
})

const toolMap = (...tools: Array<Record<string, unknown>>) => ({
  modelVisibleTools: tools,
  additionalExecutableTools: [],
}) as never

const interactionHandler = (options: { result?: unknown } = {}) => ({
  invocationId: "invocation-1",
  async executeToolCall(_ctx: unknown, _toolCall: unknown, _callId: string, run: (ctx: unknown) => Promise<unknown>) {
    return await run(_ctx)
  },
  ...options,
})

const stream = (value: unknown) => (async function* () { yield JSON.stringify(value) })()

// ---------------------------------------------------------------------------------------------
// a tool from a server
// ---------------------------------------------------------------------------------------------

test("a server's tool is offered under its own normalized name", () => {
  const tool = createMcpTool(accessor(executor().executor) as never, {
    name: "github.create.issue",
    providerIdentifier: "github",
    toolName: "create_issue",
    description: "Creates an issue",
    inputSchema: Value.fromJson({ type: "object", properties: { title: { type: "string" } } }),
  } as never)
  assert.equal(tool.toolIdentifier, "MCP")
  assert.equal(tool.name, "github_create_issue")
  assert.equal((tool.descriptionGenerator as () => string)(), "Creates an issue")
})

test("a tool name that is too long for a provider is shortened with a stable suffix", () => {
  const long = "a".repeat(80)
  const tool = createMcpTool(accessor(executor().executor) as never, {
    name: long,
    providerIdentifier: "github",
    toolName: "create_issue",
  } as never)
  const name = tool.name as string
  assert.equal(name.length, 64)
  assert.equal(name.startsWith("a".repeat(57)), true)
  // The suffix is derived from the name, so the same tool keeps the same name.
  const again = createMcpTool(accessor(executor().executor) as never, {
    name: long,
    providerIdentifier: "github",
    toolName: "create_issue",
  } as never)
  assert.equal(again.name, name)
})

test("a schema that is missing or empty is still a schema", () => {
  const withoutSchema = createMcpTool(accessor(executor().executor) as never, {
    name: "tool",
    providerIdentifier: "server",
    toolName: "tool",
  } as never)
  const parameters = withoutSchema.parameters as { jsonSchema: Record<string, unknown> }
  assert.deepEqual(parameters.jsonSchema, { type: "object", properties: {} })
  const emptySchema = createMcpTool(accessor(executor().executor) as never, {
    name: "tool",
    providerIdentifier: "server",
    toolName: "tool",
    inputSchema: Value.fromJson({ type: "object", properties: {} }),
  } as never)
  const emptyParameters = emptySchema.parameters as { jsonSchema: Record<string, unknown> }
  assert.deepEqual(emptyParameters.jsonSchema, { type: "object", properties: {} })
})

test("a schema whose properties are not an object is passed through as it is", () => {
  // The schema is the server's, so a shape this code does not recognize is not rewritten.
  const malformed = createMcpTool(accessor(executor().executor) as never, {
    name: "tool",
    providerIdentifier: "server",
    toolName: "tool",
    inputSchema: Value.fromJson({ type: "object", properties: "a string" } as never),
  } as never)
  const parameters = malformed.parameters as { jsonSchema: Record<string, unknown> }
  assert.deepEqual(parameters.jsonSchema, { type: "object", properties: "a string" })
})

test("a call to a server's tool reaches the executor with the arguments it was given", async () => {
  const recorded = executor()
  const tool = createMcpTool(accessor(recorded.executor) as never, {
    name: "github_create_issue",
    providerIdentifier: "github",
    toolName: "create_issue",
  } as never)
  const execute = tool.execute as (ctx: unknown, handler: unknown, argsStream: AsyncIterable<string>, meta: unknown) => Promise<unknown>
  await execute(createContext(), interactionHandler(), stream({ title: "a bug" }), { toolCallId: "call-1" })
  assert.equal(recorded.calls.length, 1)
  const args = (recorded.calls[0] as { args: { toolName: string; providerIdentifier: string; args: Record<string, unknown> } }).args
  assert.equal(args.toolName, "create_issue")
  assert.equal(args.providerIdentifier, "github")
  assert.deepEqual(Object.keys(args.args), ["title"])
})

test("arguments that are not JSON are refused before anything is asked of the server", async () => {
  const recorded = executor()
  const tool = createMcpTool(accessor(recorded.executor) as never, {
    name: "github_create_issue",
    providerIdentifier: "github",
    toolName: "create_issue",
  } as never)
  const execute = tool.execute as (ctx: unknown, handler: unknown, argsStream: AsyncIterable<string>, meta: unknown) => Promise<unknown>
  await assert.rejects(
    () => execute(createContext(), interactionHandler(), (async function* () { yield "{not json" })(), { toolCallId: "call-1" }),
    /not valid JSON/,
  )
  await assert.rejects(
    () => execute(createContext(), interactionHandler(), (async function* () { yield '"a string"' })(), { toolCallId: "call-1" }),
    /must be a JSON object/,
  )
  assert.deepEqual(recorded.calls, [])
})

test("a tool that fails records the failure and raises it", async () => {
  const recorded = executor({ error: new Error("the server refused") })
  const tool = createMcpTool(accessor(recorded.executor) as never, {
    name: "github_create_issue",
    providerIdentifier: "github",
    toolName: "create_issue",
  } as never)
  const execute = tool.execute as (ctx: unknown, handler: unknown, argsStream: AsyncIterable<string>, meta: unknown) => Promise<unknown>
  await assert.rejects(() => execute(createContext(), interactionHandler(), stream({}), { toolCallId: "call-1" }), /the server refused/)
})

test("a failure is serialized into the shape a call reports", () => {
  const tool = createMcpTool(accessor(executor().executor) as never, {
    name: "github_create_issue",
    providerIdentifier: "github",
    toolName: "create_issue",
  } as never)
  const call = (tool.serializeError as (error: unknown) => { tool: { case: string; value: { result?: { result?: { case?: string; value?: { error?: string } } } } } })(new Error("the server refused"))
  assert.equal(call.tool.case, "mcpToolCall")
  assert.equal(call.tool.value.result?.result?.case, "error")
  assert.equal(call.tool.value.result?.result?.value?.error, "Tool execution error")
})

// ---------------------------------------------------------------------------------------------
// the tool that calls any tool
// ---------------------------------------------------------------------------------------------

const callOptions = (overrides: Record<string, unknown> = {}) => ({
  resourceAccessor: accessor(executor().executor),
  // Without a state handler the session tracks nothing it has read, so the descriptors are checked.
  validateMcpToolDescriptors: true,
  mcpFileSystemOptions: { mcpDescriptors: [descriptor("github", [toolDescriptor("create_issue", "/defs/github.json")])] } as never,
  ...overrides,
}) as never

test("the meta tool is named for what the model calls", () => {
  const tool = createCallMcpTool(callOptions())
  assert.equal(tool.toolIdentifier, "MCP")
  assert.equal(tool.name, "CallMcpTool")
})

test("a call to a server the session does not have is refused", async () => {
  const tool = createCallMcpTool(callOptions())
  const execute = tool.execute as (ctx: unknown, handler: unknown, argsStream: AsyncIterable<string>, meta: unknown) => Promise<unknown>
  await assert.rejects(
    () => execute(createContext(), interactionHandler(), stream({ server: "gitlab", toolName: "create_issue", arguments: {} }), { toolCallId: "call-1" }),
    /gitlab/,
  )
})

test("a server the session does not have is refused when the session tracks its reads", async () => {
  // With a session that tracks what it has read, a server it does not have is refused here rather than
  // discovered by the executor.
  const tool = createCallMcpTool(callOptions({ validateMcpToolDescriptors: false }))
  const execute = tool.execute as (ctx: unknown, handler: unknown, argsStream: AsyncIterable<string>, meta: unknown) => Promise<unknown>
  await assert.rejects(
    () => execute(createContext(), interactionHandler(), stream({ server: "gitlab", toolName: "create_issue", arguments: {} }), {
      toolCallId: "call-1",
      stateHandler: { hasReadPath: () => false },
    }),
    /gitlab/,
  )
})

test("a definition the session has not read does not stop the call here", async () => {
  // The read check is one of several: what this call does about an unread definition is proceed, and the
  // platform's own guards decide the rest.
  const recorded = executor()
  const tool = createCallMcpTool(callOptions({ resourceAccessor: accessor(recorded.executor), validateMcpToolDescriptors: false }))
  const execute = tool.execute as (ctx: unknown, handler: unknown, argsStream: AsyncIterable<string>, meta: unknown) => Promise<unknown>
  await execute(createContext(), interactionHandler(), stream({ server: "github", toolName: "create_issue", arguments: {} }), {
    toolCallId: "call-1",
    stateHandler: { hasReadPath: () => false },
  })
  assert.equal(recorded.calls.length, 1)
})

test("a call to a tool the server does not have is refused", async () => {
  const tool = createCallMcpTool(callOptions())
  const execute = tool.execute as (ctx: unknown, handler: unknown, argsStream: AsyncIterable<string>, meta: unknown) => Promise<unknown>
  await assert.rejects(
    () => execute(createContext(), interactionHandler(), stream({ server: "github", toolName: "delete_everything", arguments: {} }), { toolCallId: "call-1" }),
    /delete_everything/,
  )
})

test("a call reaches the executor with the server, the tool and the arguments", async () => {
  const recorded = executor()
  const tool = createCallMcpTool(callOptions({ resourceAccessor: accessor(recorded.executor) }))
  const execute = tool.execute as (ctx: unknown, handler: unknown, argsStream: AsyncIterable<string>, meta: unknown) => Promise<unknown>
  await execute(createContext(), interactionHandler(), stream({ server: "github", toolName: "create_issue", arguments: { title: "a bug" } }), { toolCallId: "call-1" })
  assert.equal(recorded.calls.length, 1)
  const args = (recorded.calls[0] as { args: { serverIdentifier: string; toolName: string; args: Record<string, unknown> } }).args
  assert.equal(args.serverIdentifier, "github")
  assert.equal(args.toolName, "create_issue")
  assert.deepEqual(Object.keys(args.args), ["title"])
})

test("authenticating a server is refused where no user can approve it", async () => {
  // The descriptors are not validated here, which is the case where the auth tool can still be named.
  const tool = createCallMcpTool(callOptions({ validateMcpToolDescriptors: false }))
  const execute = tool.execute as (ctx: unknown, handler: unknown, argsStream: AsyncIterable<string>, meta: unknown) => Promise<unknown>
  await assert.rejects(
    () => execute(createContext(), interactionHandler(), stream({ server: "github", toolName: "mcp_auth", arguments: {} }), { toolCallId: "call-1" }),
    /Slate desktop IDE/,
  )
})

test("a tool the platform reserves for the parent agent is refused", async () => {
  const tool = createCallMcpTool(callOptions({
    isMcpToolBlocked: ({ toolName }: { toolName: string }) => toolName === "create_issue",
  }))
  const execute = tool.execute as (ctx: unknown, handler: unknown, argsStream: AsyncIterable<string>, meta: unknown) => Promise<unknown>
  await assert.rejects(
    () => execute(createContext(), interactionHandler(), stream({ server: "github", toolName: "create_issue", arguments: {} }), { toolCallId: "call-1" }),
    /not available in this agent context/,
  )
})

test("arguments sent as a quoted string are refused with how to fix the call", async () => {
  const recorded = executor()
  const tool = createCallMcpTool(callOptions({ resourceAccessor: accessor(recorded.executor) }))
  const execute = tool.execute as (ctx: unknown, handler: unknown, argsStream: AsyncIterable<string>, meta: unknown) => Promise<unknown>
  await assert.rejects(
    () => execute(createContext(), interactionHandler(), stream({ server: "github", toolName: "create_issue", arguments: "not an object" }), { toolCallId: "call-1" }),
    /as a JSON object literal rather than a quoted string/,
  )
  assert.deepEqual(recorded.calls, [])
})

test("a call with no arguments at all is a call with none", async () => {
  const recorded = executor()
  const tool = createCallMcpTool(callOptions({ resourceAccessor: accessor(recorded.executor) }))
  const execute = tool.execute as (ctx: unknown, handler: unknown, argsStream: AsyncIterable<string>, meta: unknown) => Promise<unknown>
  await execute(createContext(), interactionHandler(), stream({ server: "github", toolName: "create_issue" }), { toolCallId: "call-1" })
  const args = (recorded.calls[0] as { args: { args: Record<string, unknown> } }).args
  assert.deepEqual(args.args, {})
})

test("a call that fails is recorded and raised", async () => {
  const recorded = executor({ error: new Error("the server is down") })
  const tool = createCallMcpTool(callOptions({ resourceAccessor: accessor(recorded.executor) }))
  const execute = tool.execute as (ctx: unknown, handler: unknown, argsStream: AsyncIterable<string>, meta: unknown) => Promise<unknown>
  await assert.rejects(
    () => execute(createContext(), interactionHandler(), stream({ server: "github", toolName: "create_issue", arguments: {} }), { toolCallId: "call-1" }),
    /the server is down/,
  )
})

// ---------------------------------------------------------------------------------------------
// what the session knows about its servers
// ---------------------------------------------------------------------------------------------

test("the descriptors are indexed by the server's own identifier", () => {
  const index = indexMcpDescriptors({
    mcpMetaToolEnabled: false,
    mcpFileSystemOptions: { mcpDescriptors: [descriptor("github", [toolDescriptor("create_issue", "/defs/github.json")])] } as never,
  })
  assert.deepEqual([...index.serverDescriptors.keys()], ["github"])
  assert.equal(index.toolDefinitionPaths.get("github:create_issue"), "/defs/github.json")
})

test("the auth tool is only offered where authentication can happen", () => {
  const descriptors = [descriptor("github", [toolDescriptor("mcp_auth"), toolDescriptor("create_issue")])]
  const without = indexMcpDescriptors({ mcpMetaToolEnabled: false, mcpFileSystemOptions: { mcpDescriptors: descriptors } as never })
  assert.deepEqual(without.serverDescriptors.get("github")?.tools.map(tool => tool.toolName), ["create_issue"])
  const withAuth = indexMcpDescriptors({ mcpMetaToolEnabled: false, mcpFileSystemOptions: { mcpDescriptors: descriptors } as never, allowInteractiveMcpAuth: true })
  assert.deepEqual(withAuth.serverDescriptors.get("github")?.tools.map(tool => tool.toolName), ["mcp_auth", "create_issue"])
})

test("the meta tool's own descriptor list is used when it is enabled", () => {
  const index = indexMcpDescriptors({
    mcpMetaToolEnabled: true,
    mcpMetaToolOptions: { mcpDescriptors: [descriptor("from-meta", [toolDescriptor("a")])] } as never,
    mcpFileSystemOptions: { mcpDescriptors: [descriptor("from-files", [toolDescriptor("b")])] } as never,
  })
  assert.deepEqual([...index.serverDescriptors.keys()], ["from-meta"])
})
