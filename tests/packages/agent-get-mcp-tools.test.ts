import { test } from "node:test"
import assert from "node:assert/strict"
import { Value } from "@bufbuild/protobuf"

import { createGetMcpToolsTool } from "../../source/packages/agent/tools/mcp/get-mcp-tools.ts"
import { DynamicToolRegistry } from "../../source/packages/agent/tools/mcp/builtin-tools.ts"
import { CustomToolCallError } from "../../source/packages/agent/tools/tool-support.ts"
import { ToolErrorClassification } from "../../source/packages/agent/tools/tool-errors.ts"
import { DYNAMIC_TOOLS_NAMESPACE, mcpStateExecutorResource } from "../../source/packages/agent-exec/mcp-operations.ts"
import { writeExecutorResource } from "../../source/packages/agent-exec/write-operation.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import { AgentMode, ToolCall } from "../../source/packages/proto/generated/agent/v1/agent_pb.ts"
import {
  McpDescriptor,
  McpInstructions,
  McpToolDescriptor,
  type McpMetaToolOptions,
} from "../../source/packages/proto/generated/agent/v1/mcp_pb.ts"
import { McpStateExecResult, McpStateSuccess } from "../../source/packages/proto/generated/agent/v1/mcp_exec_pb.ts"
import { WriteResult, WriteSuccess } from "../../source/packages/proto/generated/agent/v1/write_exec_pb.ts"
import { GetMcpToolsAgentResult, GetMcpToolsError } from "../../source/packages/proto/generated/agent/v1/get_mcp_tools_tool_pb.ts"
import type { TextResult } from "../../source/packages/chat-inference/prompt-executor.ts"

// ---------------------------------------------------------------------------------------------
// the harness
// ---------------------------------------------------------------------------------------------

type Tool = Record<string, unknown>

const longDescription = "d".repeat(400)
const BUILTIN_DESCRIPTION = "A first-party tool.\n  It keeps   its own spacing."

function toolDescriptor(toolName: string, description?: string): McpToolDescriptor {
  return new McpToolDescriptor({
    toolName,
    ...(description === undefined ? {} : { description }),
    inputSchema: Value.fromJson({ type: "object", properties: { query: { type: "string" } } }),
  })
}

const authDescriptor = () =>
  new McpToolDescriptor({ toolName: "mcp_auth", description: "Authenticate this MCP server so its tools can be used." })

function descriptor(serverIdentifier: string, tools: McpToolDescriptor[], instructions?: string): McpDescriptor {
  return new McpDescriptor({
    serverIdentifier,
    serverName: serverIdentifier,
    tools,
    ...(instructions === undefined ? {} : { serverUseInstructions: instructions }),
  })
}

const SNAPSHOT = [
  descriptor("mcp-alpha", [toolDescriptor("search", "Search things."), toolDescriptor("read", longDescription)], "Use alpha for searching."),
  descriptor("mcp-beta", [toolDescriptor("write", "Write things.")]),
]

function harness(options: {
  descriptors?: McpDescriptor[]
  live?: McpDescriptor[] | "fail"
  liveStatus?: string
  registry?: DynamicToolRegistry
  projectDir?: string
  allowAuth?: boolean
  blocked?: (input: { serverIdentifier: string; toolName: string }) => boolean
  stateHandler?: unknown
  mcpToolName?: string
} = {}) {
  const writes: string[] = []
  const stateArgs: unknown[] = []
  const accessor = {
    get: (resource: unknown) => resource === mcpStateExecutorResource
      ? {
        async execute(_ctx: Context, args: unknown) {
          stateArgs.push(args)
          if (options.live === "fail") throw new Error("the execution side is gone")
          // By default the live answer is the same as the turn's snapshot; a test that cares about the
          // difference says so.
          const servers = options.live === undefined ? (options.descriptors ?? SNAPSHOT) : options.live
          return new McpStateExecResult({
            result: {
              case: "success",
              value: new McpStateSuccess({
                servers: servers.map(server => ({
                  serverIdentifier: server.serverIdentifier,
                  serverName: server.serverName,
                  tools: server.tools.map(tool => ({
                    toolName: tool.toolName,
                    ...(tool.description === undefined ? {} : { description: tool.description }),
                    ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
                  })),
                  instructions: (server.serverUseInstructions ?? "").length === 0
                    ? []
                    : [new McpInstructions({ instructions: server.serverUseInstructions ?? "" })],
                  ...(options.liveStatus === undefined ? {} : { status: options.liveStatus }),
                })),
              }),
            },
          })
        },
      }
      : {
        async execute(_ctx: Context, args: { fileText?: string }) {
          writes.push(args.fileText ?? "")
          return new WriteResult({ result: { case: "success", value: new WriteSuccess({ path: "/repo/.slate/tools/output.json" }) } })
        },
      },
  }
  const metaOptions = { mcpDescriptors: options.descriptors ?? SNAPSHOT } as unknown as McpMetaToolOptions
  const build = () => createGetMcpToolsTool(metaOptions, {
    resourceAccessor: accessor as never,
    ...(options.projectDir === undefined ? {} : { projectDir: options.projectDir }),
    ...(options.registry === undefined ? {} : { dynamicToolRegistry: options.registry }),
    ...(options.allowAuth === true ? { allowInteractiveMcpAuth: true } : {}),
    ...(options.blocked === undefined ? {} : { isMcpToolBlocked: options.blocked }),
    ...(options.mcpToolName === undefined ? {} : { callMcpToolName: options.mcpToolName }),
  }) as Tool
  const interaction = {
    calls: [] as ToolCall[],
    handler: {
      emitPartialToolCall() {},
      async executeToolCall(ctx: unknown, toolCall: ToolCall, _callId: string, run: (ctx: unknown) => Promise<unknown>) {
        interaction.calls.push(toolCall)
        return await run(ctx)
      },
    },
  }
  const call = async (args: Record<string, unknown>, meta: Record<string, unknown> = {}): Promise<GetMcpToolsAgentResult> => {
    const tool = build()
    const execute = tool.execute as (ctx: unknown, handler: unknown, stream: AsyncIterable<string>, meta: unknown) => Promise<GetMcpToolsAgentResult>
    const stream = (async function* () { yield JSON.stringify(args) })()
    return await execute(createContext(), interaction.handler, stream, {
      toolCallId: "call-1",
      ...(options.stateHandler === undefined ? {} : { stateHandler: options.stateHandler }),
      ...meta,
    })
  }
  const payloadOf = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const result = await call(args)
    assert.equal(result.result.case, "success")
    return JSON.parse((result.result as { value: { content: string } }).value.content) as Record<string, unknown>
  }
  return { call, payloadOf, build, writes, stateArgs, interaction }
}

const errorOf = async (promise: Promise<GetMcpToolsAgentResult>): Promise<CustomToolCallError> => {
  try {
    await promise
  } catch (error) {
    assert.equal(error instanceof CustomToolCallError, true, `expected a tool call error, got ${String(error)}`)
    return error as CustomToolCallError
  }
  throw new Error("expected the call to fail")
}

const jsonSchemaOf = (tool: Tool) => tool.parameters as Record<string, unknown>

test("control characters and line breaks are flattened in what the model reads", async () => {
  const noisy = descriptor("mcp-noisy", [toolDescriptor("search", "line one\n\tline two\u0000end")])
  const payload = await harness({ descriptors: [noisy], live: [noisy] }).payloadOf({})
  const servers = payload.servers as Array<{ tools: Array<{ description: string }> }>
  assert.equal(servers[0]?.tools[0]?.description, "line one line two end")
})

test("the catalog is listed by server name", async () => {
  const first = descriptor("mcp-zeta", [toolDescriptor("late")])
  const second = descriptor("mcp-alpha", [toolDescriptor("early")])
  const payload = await harness({ descriptors: [first, second], live: [first, second] }).payloadOf({})
  const servers = payload.servers as Array<{ server: string }>
  assert.deepEqual(servers.map(server => server.server), ["mcp-alpha", "mcp-zeta"])
})

// ---------------------------------------------------------------------------------------------
// the catalog
// ---------------------------------------------------------------------------------------------

test("the catalog lists every server with its tools in order", async () => {
  const payload = await harness().payloadOf({})
  assert.equal(payload.mode, "catalog")
  const servers = payload.servers as Array<Record<string, unknown>>
  assert.deepEqual(servers.map(server => server.server), ["mcp-alpha", "mcp-beta"])
  assert.deepEqual((servers[0]?.tools as Array<Record<string, unknown>>).map(tool => tool.tool), ["read", "search"])
  assert.equal(servers[0]?.serverStatus, "ready")
  assert.equal(servers[0]?.serverError, undefined)
})

test("a catalog description is shortened and says that it was", async () => {
  const payload = await harness().payloadOf({})
  const servers = payload.servers as Array<Record<string, unknown>>
  const read = (servers[0]?.tools as Array<Record<string, unknown>>).find(tool => tool.tool === "read")
  const description = String(read?.description)
  assert.equal(description.length, 200)
  assert.match(description, /\.\.\. \[truncated\]$/)
  // The short descriptions are the model's index, so a catalog does not carry schemas.
  assert.equal(read?.inputSchema, undefined)
})

test("a server lookup returns full descriptions and schemas", async () => {
  const payload = await harness().payloadOf({ server: "mcp-alpha" })
  assert.equal(payload.mode, "server")
  assert.equal(payload.serverDescription, "Use alpha for searching.")
  const tools = payload.tools as Array<Record<string, unknown>>
  assert.equal(String(tools.find(tool => tool.tool === "read")?.description).length, 400)
  assert.deepEqual(tools.find(tool => tool.tool === "search")?.inputSchema, { type: "object", properties: { query: { type: "string" } } })
})

test("a single tool lookup returns that tool and nothing else", async () => {
  const payload = await harness().payloadOf({ server: "mcp-alpha", toolName: "search" })
  assert.equal(payload.mode, "single_tool")
  assert.equal((payload.tool as Record<string, unknown>).tool, "search")
  assert.equal(payload.server, "mcp-alpha")
})

test("a tool name without a server is refused before anything is asked", async () => {
  const harnessed = harness()
  const error = await errorOf(harnessed.call({ toolName: "search" }))
  assert.equal(error.classification, ToolErrorClassification.INVALID_ARGS)
  assert.match(error.message, /toolName requires server to be set/)
  // Nothing was asked of the execution side, and the call itself was not recorded as running.
  assert.deepEqual(harnessed.stateArgs, [])
  assert.deepEqual(harnessed.interaction.calls, [])
})

test("a server that is not there lists the ones that are", async () => {
  const error = await errorOf(harness().call({ server: "mcp-gamma" }))
  assert.equal(error.classification, ToolErrorClassification.UNEXPECTED_ENVIRONMENT)
  assert.match(error.message, /MCP server "mcp-gamma" not found\. Available servers: mcp-alpha, mcp-beta/)
})

test("a server that is not there is not listed when there are none", async () => {
  const error = await errorOf(harness({ descriptors: [] }).call({ server: "mcp-gamma" }))
  assert.equal(error.message, 'MCP server "mcp-gamma" not found.')
})

test("a tool that is not there names the server it was looked for on", async () => {
  const error = await errorOf(harness().call({ server: "mcp-alpha", toolName: "nope" }))
  assert.equal(error.message, 'MCP tool "nope" not found on server "mcp-alpha".')
})

// ---------------------------------------------------------------------------------------------
// searching
// ---------------------------------------------------------------------------------------------

test("a pattern searches server and tool names together", async () => {
  const payload = await harness().payloadOf({ pattern: "^mcp-(alpha|beta)$" })
  assert.equal(payload.mode, "search")
  const matches = payload.matches as Array<Record<string, unknown>>
  // A server that matches by name is listed as itself and again as each of its tools, since a model that
  // asked for the server needs to know what is on it.
  assert.deepEqual(matches.map(match => `${String(match.server)}/${String(match.tool ?? "")}`), [
    "mcp-alpha/",
    "mcp-alpha/read",
    "mcp-alpha/search",
    "mcp-beta/",
    "mcp-beta/write",
  ])
  assert.equal(matches[0]?.description, "Use alpha for searching.")
})

test("a pattern can match a tool name alone", async () => {
  const payload = await harness().payloadOf({ pattern: "writ" })
  const matches = payload.matches as Array<Record<string, unknown>>
  assert.deepEqual(matches.map(match => `${String(match.server)}/${String(match.tool)}`), ["mcp-beta/write"])
})

test("a pattern scoped to a server only searches that server's tools", async () => {
  // A pattern that does not match the server's own name, so only tool rows come back.
  const payload = await harness().payloadOf({ server: "mcp-alpha", pattern: "^(read|search)$" })
  assert.deepEqual((payload.matches as Array<Record<string, unknown>>).map(match => match.tool), ["read", "search"])
  const other = await harness().payloadOf({ server: "mcp-beta", pattern: "^(read|search)$" })
  assert.deepEqual(other.matches, [])
})

test("a scoped search of a server that is not there fails the same way a lookup does", async () => {
  const error = await errorOf(harness().call({ server: "mcp-gamma", pattern: "x" }))
  assert.match(error.message, /not found\. Available servers/)
})

test("a pattern that is not a valid expression is refused", async () => {
  const error = await errorOf(harness().call({ pattern: "(unclosed" }))
  assert.equal(error.classification, ToolErrorClassification.INVALID_ARGS)
  assert.match(error.message, /Invalid regex pattern/)
})

test("a pattern longer than the limit is refused", async () => {
  const error = await errorOf(harness().call({ pattern: "a".repeat(257) }))
  assert.equal(error.classification, ToolErrorClassification.INVALID_ARGS)
  assert.match(error.message, /pattern cannot exceed 256 characters/)
})

// ---------------------------------------------------------------------------------------------
// authentication
// ---------------------------------------------------------------------------------------------

test("a server that only offers authentication is reported as needing it", async () => {
  const payload = await harness({ descriptors: [descriptor("mcp-auth-only", [authDescriptor()])] }).payloadOf({})
  const server = (payload.servers as Array<Record<string, unknown>>)[0]
  assert.equal(server?.serverStatus, "needsAuth")
  assert.match(String(server?.serverError), /requires authentication/)
  // The auth tool is not offered to a model that cannot use it.
  assert.deepEqual(server?.tools, [])
})

test("a server that can be authenticated keeps its auth tool", async () => {
  const payload = await harness({ descriptors: [descriptor("mcp-alpha", [toolDescriptor("search", "Search things.")])], allowAuth: true }).payloadOf({ server: "mcp-alpha" })
  const tools = (payload.tools as Array<Record<string, unknown>>).map(tool => tool.tool)
  assert.deepEqual(tools, ["mcp_auth", "search"])
})

test("a live server without an auth tool is offered the one from the turn's snapshot", async () => {
  const snapshots = [descriptor("mcp-alpha", [authDescriptor(), toolDescriptor("search")])]
  const live = [descriptor("mcp-alpha", [toolDescriptor("search")])]
  const payload = await harness({ descriptors: snapshots, live, allowAuth: true }).payloadOf({ server: "mcp-alpha" })
  const auth = (payload.tools as Array<Record<string, unknown>>).find(tool => tool.tool === "mcp_auth")
  assert.equal(auth?.description, "Authenticate this MCP server so its tools can be used.")
})

test("a live server whose only tool was authentication still reports that it needs it", async () => {
  // The live answer offers the auth tool, this environment cannot run it, and filtering leaves nothing —
  // which is what makes the server unauthenticated rather than merely empty.
  const live = [descriptor("mcp-alpha", [authDescriptor()])]
  const payload = await harness({ live }).payloadOf({})
  assert.equal((payload.servers as Array<Record<string, unknown>>)[0]?.serverStatus, "needsAuth")
  assert.match(String((payload.servers as Array<Record<string, unknown>>)[0]?.serverError), /requires authentication/)
})

// ---------------------------------------------------------------------------------------------
// where the picture comes from
// ---------------------------------------------------------------------------------------------

test("the live picture is preferred over the turn's snapshot", async () => {
  const live = [descriptor("mcp-live", [toolDescriptor("liveTool", "From the live answer.")])]
  const payload = await harness({ live }).payloadOf({})
  assert.deepEqual((payload.servers as Array<Record<string, unknown>>).map(server => server.server), ["mcp-live"])
})

test("a live lookup that fails falls back to the snapshot", async () => {
  const payload = await harness({ live: "fail" }).payloadOf({})
  assert.deepEqual((payload.servers as Array<Record<string, unknown>>).map(server => server.server), ["mcp-alpha", "mcp-beta"])
})

test("a server that is still loading says so", async () => {
  const payload = await harness({ live: [descriptor("mcp-alpha", [])], liveStatus: "loading" }).payloadOf({})
  assert.equal((payload.servers as Array<Record<string, unknown>>)[0]?.serverStatus, "loading")
  assert.match(String((payload.servers as Array<Record<string, unknown>>)[0]?.serverError), /still loading/)
})

test("a tool the platform refuses to offer is not offered", async () => {
  const blocked = ({ toolName }: { toolName: string }) => toolName === "read"
  const payload = await harness({ blocked }).payloadOf({ server: "mcp-alpha" })
  assert.deepEqual((payload.tools as Array<Record<string, unknown>>).map(tool => tool.tool), ["search"])
})

test("a project conversation is not offered the tools that move its workspace", async () => {
  const descriptors = [
    descriptor("cursor-app-control", [
      toolDescriptor("move_agent_to_root", "Move the agent."),
      toolDescriptor("create_project", "Create a project."),
      toolDescriptor("other", "Something else."),
    ]),
  ]
  const payload = await harness({ descriptors, stateHandler: { mode: AgentMode.PROJECT } }).payloadOf({ server: "cursor-app-control" })
  assert.deepEqual((payload.tools as Array<Record<string, unknown>>).map(tool => tool.tool), ["other"])
  // A conversation that is not a project's keeps them.
  const kept = await harness({ descriptors, stateHandler: { mode: AgentMode.AGENT } }).payloadOf({ server: "cursor-app-control" })
  assert.deepEqual((kept.tools as Array<Record<string, unknown>>).map(tool => tool.tool), ["create_project", "move_agent_to_root", "other"])
})

// ---------------------------------------------------------------------------------------------
// the platform's own namespace
// ---------------------------------------------------------------------------------------------

function registry(): DynamicToolRegistry {
  const builtin = {
    name: "BuiltinOne",
    // Written across lines on purpose: a first-party description is handed over as it is, while any other
    // description is flattened before it reaches a prompt.
    description: BUILTIN_DESCRIPTION,
    parameters: { jsonSchema: { type: "object", properties: {} } },
  }
  const registry = new DynamicToolRegistry()
  registry.replaceTools({ dynamicTools: [builtin], allTools: [builtin, { name: "NotDynamic", parameters: { jsonSchema: {} } }] })
  return registry
}

test("the platform's own tools are listed as one namespace", async () => {
  const payload = await harness({ registry: registry() }).payloadOf({})
  assert.equal(payload.mode, "catalog")
  const namespaces = payload.namespaces as Array<Record<string, unknown>>
  assert.deepEqual(namespaces.map(namespace => namespace.namespace), ["mcp-alpha", "mcp-beta", DYNAMIC_TOOLS_NAMESPACE])
  // The platform's own namespace is always usable, so it carries no status to distrust.
  assert.equal(namespaces[2]?.namespaceStatus, undefined)
})

test("the platform's own schemas are handed over as they are", async () => {
  const payload = await harness({ registry: registry() }).payloadOf({ namespace: DYNAMIC_TOOLS_NAMESPACE })
  assert.equal(payload.mode, "namespace")
  const tool = (payload.tools as Array<Record<string, unknown>>)[0]
  assert.equal(tool?.tool, "BuiltinOne")
  assert.equal(tool?.description, BUILTIN_DESCRIPTION)
  assert.equal(payload.namespaceDescription, "Native Slate tools for this session. These are highly recommended and useful tools that you should use when the right situation arises. Don't be afraid to look at one if it seems relevant, even if you don't end up using it. You MUST read the tool schemas before calling them.")
})

test("the namespace the model is shown is the one it asks with", async () => {
  const harnessed = harness({ registry: registry() })
  const payload = await harnessed.payloadOf({ namespace: "mcp-alpha" })
  assert.equal(payload.mode, "namespace")
  assert.equal(payload.namespace, "mcp-alpha")
  const error = await errorOf(harnessed.call({ toolName: "search" }))
  assert.match(error.message, /toolName requires namespace to be set/)
  const missing = await errorOf(harnessed.call({ namespace: "mcp-gamma" }))
  assert.match(missing.message, /namespace "mcp-gamma" not found\. Available namespaces:/)
})

test("a tool the model could call directly is not part of a namespace", async () => {
  const direct = new DynamicToolRegistry({ directToolRecoveryEnabled: true })
  direct.replaceTools({
    dynamicTools: [{ name: "BuiltinOne", description: BUILTIN_DESCRIPTION, parameters: { jsonSchema: {} } }],
    allTools: [{ name: "BuiltinOne", parameters: { jsonSchema: {} } }, { name: "NotDynamic", parameters: { jsonSchema: {} } }],
  })
  const error = await errorOf(harness({ registry: direct }).call({ namespace: DYNAMIC_TOOLS_NAMESPACE, toolName: "NotDynamic" }))
  assert.match(error.message, /already available directly and is not part of dynamic namespace/)
})

test("the model-facing schema asks for a namespace, not a server", () => {
  const withRegistry = harness({ registry: registry() }).build()
  const withoutRegistry = harness().build()
  assert.match(JSON.stringify(jsonSchemaOf(withRegistry)), /namespace/)
  assert.equal(JSON.stringify(jsonSchemaOf(withoutRegistry)).includes("namespace"), false)
  assert.equal(withRegistry.toolIdentifier, "GET_MCP_TOOLS")
  assert.equal(withRegistry.dynamicToolMetaRole, "discovery")
  assert.equal(withoutRegistry.name, "GetMcpTools")
})

// ---------------------------------------------------------------------------------------------
// a large answer
// ---------------------------------------------------------------------------------------------

test("an answer too large for a message is written to a file", async () => {
  const big = Array.from({ length: 200 }, (_, index) => toolDescriptor(`tool-${index}`, "d".repeat(200)))
  const harnessed = harness({ descriptors: [descriptor("mcp-big", big)], projectDir: "/repo" })
  const result = await harnessed.call({ server: "mcp-big" })
  const value = (result.result as { value: { content: string; outputFilePath?: string } }).value
  assert.equal(value.outputFilePath, "/repo/.slate/tools/output.json")
  assert.match(value.content, /Large output has been written to: \/repo\/\.slate\/tools\/output\.json/)
  assert.equal(harnessed.writes.length, 1)
  // The file holds the whole answer, not the note about it.
  assert.match(harnessed.writes[0] ?? "", /"tool": "tool-0"/)
})

test("an answer that fits is returned inline", async () => {
  const harnessed = harness({ projectDir: "/repo" })
  const result = await harnessed.call({})
  assert.equal((result.result as { value: { outputFilePath?: string } }).value.outputFilePath, undefined)
  assert.deepEqual(harnessed.writes, [])
})

// ---------------------------------------------------------------------------------------------
// what the model is told about the tool
// ---------------------------------------------------------------------------------------------

test("the description explains the five ways to call it", () => {
  const description = (harness().build().descriptionGenerator as (props: Record<string, unknown>) => string)({})
  assert.match(description, /There are 5 ways to call this tool/)
  assert.match(description, /\{"server":"<id>"\}/)
  assert.match(description, /Always call this tool to discover a tool's schema before calling it with CallMcpTool/)
})

test("the description names the invocation tool the session actually has", () => {
  const named = harness({ mcpToolName: "McpCall" }).build()
  const fromProps = harness().build()
  assert.match((named.descriptionGenerator as (props: Record<string, unknown>) => string)({}), /with McpCall\./)
  assert.match((fromProps.descriptionGenerator as (props: Record<string, unknown>) => string)({ allTools: { MCP: { name: "SessionCall" } } }), /with SessionCall\./)
})

test("a session that cannot authenticate is told to ask the user", () => {
  const description = (harness().build().descriptionGenerator as (props: Record<string, unknown>) => string)({})
  assert.match(description, /Ask the user to authenticate that MCP server in the Slate desktop IDE/)
})

test("a session that can authenticate is told how", () => {
  const description = (harness({ allowAuth: true }).build().descriptionGenerator as (props: Record<string, unknown>) => string)({})
  assert.match(description, /authenticate it by calling mcp_auth/)
})

test("a namespace session is told about the platform's own tools", () => {
  const description = (harness({ registry: registry() }).build().descriptionGenerator as (props: Record<string, unknown>) => string)({})
  assert.match(description, /First-party Slate tools: the reserved namespace "slate" lists built-in Slate tools available on demand \(BuiltinOne\)/)
  assert.match(description, /Discover and inspect tools available through dynamic namespaces/)
})

test("a session with no first-party tools is not told about them", () => {
  const description = (harness().build().descriptionGenerator as (props: Record<string, unknown>) => string)({})
  assert.equal(description.includes("First-party"), false)
})

test("a result is rendered as its content or its error", async () => {
  const harnessed = harness()
  const tool = harnessed.build()
  const render = tool.render as (ctx: unknown, result: GetMcpToolsAgentResult) => Promise<TextResult>
  const success = await harnessed.call({})
  const content = (success.result as { value: { content: string } }).value.content
  assert.equal((await render(createContext(), success)).content[0]?.text, content)
  const failed = new GetMcpToolsAgentResult({ result: { case: "error", value: new GetMcpToolsError({ error: "the catalog is unreadable" }) } })
  assert.equal((await render(createContext(), failed)).content[0]?.text, "Error: the catalog is unreadable")
})

test("a failure is serialized into the call's own error result", () => {
  const tool = harness().build()
  const call = (tool.serializeError as (error: unknown) => ToolCall)(new Error("the catalog is unreadable"))
  assert.equal(call.tool.case, "getMcpToolsToolCall")
  const value = (call.tool as { value: { result?: { result?: { case?: string; value?: { error: string } } } } }).value
  assert.equal(value.result?.result?.case, "error")
  assert.equal(value.result?.result?.value?.error, "the catalog is unreadable")
})
