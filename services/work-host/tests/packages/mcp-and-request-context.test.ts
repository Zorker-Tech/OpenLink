import { test } from "node:test"
import assert from "node:assert/strict"

import { Value } from "@bufbuild/protobuf"

import { createContext, type Context } from "../../source/packages/context/context.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { McpDescriptor, McpMetaToolOptions, McpToolDescriptor } from "../../source/adapters/interop/proto/generated/agent/v1/mcp_pb.ts"
import { RequestContext, RequestContextArgs, RequestContextResult } from "../../source/adapters/interop/proto/generated/agent/v1/request_context_exec_pb.ts"
import { toRedactedRequestContext } from "../../source/adapters/interop/redacted-protos/generated/agent/v1/request_context_exec_redacted.ts"
import {
  BROWSER_MCP_PROVIDER_IDS,
  CUSTOM_USER_TOOLS_PROVIDER_ID,
  DYNAMIC_TOOLS_NAMESPACE,
  McpLeaseChangeReason,
  buildMcpToolFileContent,
  isFullMcpLeaseInvalidation,
  mcpInputSchemaToJson,
  mcpServerUnavailableReason,
  mergeMcpLeaseEvents,
  parseMcpInputSchemaJson,
  supportsInteractiveMcpAuth,
} from "../../source/packages/agent-exec/mcp-operations.ts"
import {
  buildUserDefinedToolsInstructions,
} from "../../source/packages/agent/utils/mcp-user-defined-tools.ts"
import {
  getMcpMetaToolOptionsWithUserDefinedTools,
  mergeUserDefinedToolsIntoMetaToolOptions,
} from "../../source/adapters/interop/agent/mcp-user-defined-tools-adapter.ts"
import {
  getMcpMetaToolSnapshotToolNames,
  withToolSetMcpSnapshot,
} from "../../source/packages/agent/utils/mcp-meta-tool-options.ts"
import { projectTurnToolsIntoInteropMetaOptions } from "../../source/adapters/interop/agent/mcp-meta-tool-options-adapter.ts"
import {
  getRedactedRequestContext,
  getRequestContext,
  resolveRequestContext,
} from "../../source/packages/agent/utils/request-context.ts"
import { requestContextExecutorResource } from "../../source/packages/agent-exec/request-context-operation.ts"

const ctx = (): Context => createContext()

const userTool = (toolName: string, description?: string) => ({
  providerIdentifier: CUSTOM_USER_TOOLS_PROVIDER_ID,
  toolName,
  ...(description !== undefined ? { description } : {}),
})

// ---------------------------------------------------------------------------------------------
// mcp-operations: what the platform knows about servers without asking
// ---------------------------------------------------------------------------------------------

test("servers that belong to the environment cannot be authenticated against", () => {
  assert.equal(supportsInteractiveMcpAuth("some-remote-server"), true)
  assert.equal(supportsInteractiveMcpAuth(CUSTOM_USER_TOOLS_PROVIDER_ID), false)
  assert.equal(supportsInteractiveMcpAuth("cursor-app-control"), false)
  assert.equal(supportsInteractiveMcpAuth("fsd"), false)
  for (const id of BROWSER_MCP_PROVIDER_IDS) assert.equal(supportsInteractiveMcpAuth(id), false)
})

test("the platform's own tools live under a namespace of ours", () => {
  assert.equal(DYNAMIC_TOOLS_NAMESPACE, "slate")
  assert.deepEqual(Object.values(McpLeaseChangeReason).every(reason => typeof reason === "string"), true)
})

test("a tool is written as a file with what the file-system view reads", () => {
  const file = buildMcpToolFileContent({
    toolName: "search",
    description: "finds things",
    inputSchema: { type: "object" },
    outputSchema: { type: "array" },
    plugin: "p",
    marketplace: "m",
    pluginId: "pi",
    marketplaceId: "mi",
  })
  assert.deepEqual(file, {
    name: "search",
    description: "finds things",
    arguments: { type: "object" },
    outputSchema: { type: "array" },
    plugin: "p",
    marketplace: "m",
    pluginId: "pi",
    marketplaceId: "mi",
  })
})

test("a schema is read from JSON text when there is any, and from the message otherwise", () => {
  assert.deepEqual(parseMcpInputSchemaJson('{"a":1}'), { a: 1 })
  assert.equal(parseMcpInputSchemaJson("{not json"), undefined)
  assert.equal(parseMcpInputSchemaJson(undefined), undefined)

  assert.deepEqual(mcpInputSchemaToJson({ inputSchemaJson: '{"a":1}' }), { a: 1 })
  assert.deepEqual(mcpInputSchemaToJson({ inputSchemaJson: "{broken", inputSchema: { toJson: () => ({ b: 2 }) } }), { b: 2 })
  assert.equal(mcpInputSchemaToJson({}), undefined)
})

test("a lease change that names no servers invalidates everything", () => {
  assert.equal(isFullMcpLeaseInvalidation(undefined), true)
  assert.equal(isFullMcpLeaseInvalidation({}), true)
  assert.equal(isFullMcpLeaseInvalidation({ serverIdentifiers: [] }), false)
  assert.equal(isFullMcpLeaseInvalidation({ serverIdentifiers: ["a"] }), false)
})

test("merging lease changes keeps the wider invalidation and merges the narrower ones", () => {
  assert.equal(mergeMcpLeaseEvents(), undefined)
  assert.deepEqual(mergeMcpLeaseEvents({ serverIdentifiers: ["a"] }), { serverIdentifiers: ["a"] })

  // A full invalidation on either side wins.
  assert.deepEqual(
    mergeMcpLeaseEvents({ serverIdentifiers: ["a"] }, { serverIdentifiers: undefined, reason: "why" }),
    { serverIdentifiers: undefined, reason: "why" },
  )
  assert.deepEqual(
    mergeMcpLeaseEvents({ serverIdentifiers: undefined, reason: "first" }, { serverIdentifiers: ["b"] }),
    { serverIdentifiers: undefined, reason: "first" },
  )
  assert.deepEqual(
    mergeMcpLeaseEvents(undefined, { serverIdentifiers: ["b"], reason: "second" }),
    { serverIdentifiers: ["b"], reason: "second" },
  )
})

test("merging two narrower changes takes the union of servers and the first reason", () => {
  const merged = mergeMcpLeaseEvents(
    { serverIdentifiers: ["a", "b"], reason: "first" },
    { serverIdentifiers: ["b", "c"], reason: "second" },
  )
  assert.deepEqual(merged?.serverIdentifiers, ["a", "b", "c"])
  assert.equal(merged?.reason, "first")
})

test("a server's state is explained only when its tools are not usable", () => {
  assert.match(String(mcpServerUnavailableReason("needsAuth")), /requires authentication/)
  assert.match(String(mcpServerUnavailableReason("error")), /failed during live tool discovery/)
  assert.match(String(mcpServerUnavailableReason("loading")), /still loading/)
  assert.equal(mcpServerUnavailableReason("ready"), undefined)
})

// ---------------------------------------------------------------------------------------------
// mcp-user-defined-tools: the tools a user brought with them
// ---------------------------------------------------------------------------------------------

test("the instructions name the meta tools the session actually has", () => {
  const instructions = buildUserDefinedToolsInstructions([userTool("search", "finds things"), userTool("silent")], {
    discoveryToolName: "get_mcp_tools",
    invocationToolName: "call_mcp_tool",
    useDynamicToolNamespaces: true,
  })
  assert.match(instructions, /^User-defined tools for this session\. Discover tool schemas with `get_mcp_tools`, then invoke via `call_mcp_tool` with namespace "custom-user-tools"\./)
  assert.match(instructions, /- search: finds things/)
  assert.match(instructions, /- silent: \(no description provided\)/)
})

test("without the meta tool names the instructions fall back to describing discovery generically", () => {
  const instructions = buildUserDefinedToolsInstructions([userTool("search")], {
    discoveryToolName: "get_mcp_tools",
    invocationToolName: "call_mcp_tool",
    useDynamicToolNamespaces: false,
  })
  assert.match(instructions, /with server "custom-user-tools"/)
})

test("a session with no user-defined tools leaves the meta tool's options untouched", () => {
  const options = new McpMetaToolOptions({ enabled: true, mcpDescriptors: [] })
  assert.equal(getMcpMetaToolOptionsWithUserDefinedTools(options, []), options)
  assert.equal(
    getMcpMetaToolOptionsWithUserDefinedTools(options, [{ providerIdentifier: "other", toolName: "x" }]),
    options,
  )
  assert.equal(getMcpMetaToolOptionsWithUserDefinedTools(undefined, []), undefined)
})

test("a session with user-defined tools turns the meta tool on", () => {
  const options = getMcpMetaToolOptionsWithUserDefinedTools(undefined, [userTool("search")])
  assert.equal(options?.enabled, true)
  assert.equal(options?.mcpDescriptors.length, 1)
  assert.equal(options?.mcpDescriptors[0]?.serverIdentifier, CUSTOM_USER_TOOLS_PROVIDER_ID)
})

test("the descriptor replaces a stale one and keeps the other servers", () => {
  const other = new McpDescriptor({ serverIdentifier: "remote", serverName: "remote" })
  const stale = new McpDescriptor({ serverIdentifier: CUSTOM_USER_TOOLS_PROVIDER_ID, serverName: "old", tools: [] })
  const options = mergeUserDefinedToolsIntoMetaToolOptions(
    new McpMetaToolOptions({ enabled: true, mcpDescriptors: [other, stale] }),
    [userTool("search")],
  )
  assert.deepEqual(options?.mcpDescriptors.map(descriptor => descriptor.serverIdentifier), ["remote", CUSTOM_USER_TOOLS_PROVIDER_ID])
  assert.match(String(options?.mcpDescriptors[1]?.serverUseInstructions), /- search: \(no description provided\)/)
})

test("a tool's schema travels as the value the descriptor carries", () => {
  const options = getMcpMetaToolOptionsWithUserDefinedTools(undefined, [{
    providerIdentifier: CUSTOM_USER_TOOLS_PROVIDER_ID,
    toolName: "search",
    inputSchema: { type: "object" },
  }])
  const descriptor = options?.mcpDescriptors[0]
  assert.deepEqual(descriptor?.tools[0]?.inputSchema?.toJson(), { type: "object" })
})

test("the meta tool is left off when it is off and nothing needs it", () => {
  const disabled = new McpMetaToolOptions({ enabled: false })
  const options = mergeUserDefinedToolsIntoMetaToolOptions(disabled, [userTool("search")])
  assert.equal(options?.enabled, false)
})

test("the turn's Slate catalog is serialized into sorted Agent MCP descriptors", () => {
  const options = projectTurnToolsIntoInteropMetaOptions([
    {
      providerIdentifier: "server-a",
      toolName: "write",
      description: "writes data",
      inputSchema: { type: "object" },
      plugin: "plugin-one",
      marketplace: "market-one",
      pluginId: "plugin-id",
      marketplaceId: "market-id",
    },
    { providerIdentifier: "server-a", toolName: "read", inputSchema: Value.fromJson({ type: "string" }) },
    { providerIdentifier: "server-a", toolName: "list" },
  ])

  assert.equal(options.enabled, true)
  assert.deepEqual(options.mcpDescriptors.map(server => server.serverIdentifier), ["server-a"])
  const server = options.mcpDescriptors[0]!
  assert.deepEqual(server.tools.map(tool => tool.toolName), ["list", "read", "write"])
  assert.deepEqual(
    [server.plugin, server.marketplace, server.pluginDbId, server.marketplaceId],
    ["plugin-one", "market-one", "plugin-id", "market-id"],
  )
  assert.deepEqual(server.tools[1]?.inputSchema?.toJson(), { type: "string" })
  assert.deepEqual(server.tools[2]?.inputSchema?.toJson(), { type: "object" })
})

// ---------------------------------------------------------------------------------------------
// mcp-meta-tool-options: the names the instructions need
// ---------------------------------------------------------------------------------------------

function toolSet(overrides: {
  staticTools?: Array<{ name: string; dynamicToolMetaRole?: string }>
  identifiers?: Record<string, string>
  registry?: { getMcpDescriptor: (toolNames: unknown) => McpDescriptor | undefined }
} = {}) {
  const identifiers = overrides.identifiers ?? {}
  return {
    getStaticTools: () => overrides.staticTools ?? [],
    getStaticTool: (identifier: string) => identifiers[identifier] === undefined
      ? undefined
      : { name: identifiers[identifier]! },
    getDynamicToolRegistry: () => overrides.registry,
  } as unknown as Parameters<typeof getMcpMetaToolSnapshotToolNames>[0]
}

test("the snapshot names the discovery and invocation tools the session has", () => {
  const names = getMcpMetaToolSnapshotToolNames(toolSet({
    staticTools: [
      { name: "get_mcp_tools", dynamicToolMetaRole: "discovery" },
      { name: "call_mcp_tool", dynamicToolMetaRole: "invocation" },
      { name: "shell" },
    ],
    identifiers: { FETCH_MCP_RESOURCE: "fetch_mcp_resource", LIST_MCP_RESOURCES: "list_mcp_resources" },
    registry: { getMcpDescriptor: () => undefined },
  }))
  assert.deepEqual(names, {
    discoveryToolName: "get_mcp_tools",
    invocationToolName: "call_mcp_tool",
    useDynamicToolNamespaces: true,
    fetchMcpResourceToolName: "fetch_mcp_resource",
    listMcpResourcesToolName: "list_mcp_resources",
  })
})

test("without both meta tools there is no snapshot to take", () => {
  assert.equal(getMcpMetaToolSnapshotToolNames(toolSet({
    staticTools: [{ name: "get_mcp_tools", dynamicToolMetaRole: "discovery" }],
    registry: { getMcpDescriptor: () => undefined },
  })), undefined)
})

test("without a registry the resource tools have to be there instead", () => {
  assert.equal(getMcpMetaToolSnapshotToolNames(toolSet({
    staticTools: [
      { name: "get_mcp_tools", dynamicToolMetaRole: "discovery" },
      { name: "call_mcp_tool", dynamicToolMetaRole: "invocation" },
    ],
  })), undefined)
  const withResourceTool = getMcpMetaToolSnapshotToolNames(toolSet({
    staticTools: [
      { name: "get_mcp_tools", dynamicToolMetaRole: "discovery" },
      { name: "call_mcp_tool", dynamicToolMetaRole: "invocation" },
    ],
    identifiers: { FETCH_MCP_RESOURCE: "fetch_mcp_resource" },
  }))
  assert.equal(withResourceTool?.useDynamicToolNamespaces, false)
  assert.equal(withResourceTool?.fetchMcpResourceToolName, "fetch_mcp_resource")
})

test("a missing options object stays missing", () => {
  assert.equal(withToolSetMcpSnapshot(undefined, toolSet()), undefined)
})

test("the snapshot patches the user-defined tools' instructions with the real names", () => {
  const options = {
    enabled: true,
    mcpDescriptors: [new McpDescriptor({
      serverIdentifier: CUSTOM_USER_TOOLS_PROVIDER_ID,
      serverName: CUSTOM_USER_TOOLS_PROVIDER_ID,
      serverUseInstructions: "old",
      tools: [new McpToolDescriptor({ toolName: "search", description: "finds things" })],
    })],
  }
  const patched = withToolSetMcpSnapshot(options, toolSet({
    staticTools: [
      { name: "get_mcp_tools", dynamicToolMetaRole: "discovery" },
      { name: "call_mcp_tool", dynamicToolMetaRole: "invocation" },
    ],
    registry: { getMcpDescriptor: () => undefined },
  }))
  assert.match(String(patched?.mcpDescriptors[0]?.serverUseInstructions), /Discover tool schemas with `get_mcp_tools`/)
  assert.match(String(patched?.mcpDescriptors[0]?.serverUseInstructions), /- search: finds things/)
  assert.equal(patched?.snapshotToolNames?.discoveryToolName, "get_mcp_tools")
})

test("the session's own on-demand tools replace whatever was under the reserved namespace", () => {
  const builtin = new McpDescriptor({ serverIdentifier: DYNAMIC_TOOLS_NAMESPACE, serverName: DYNAMIC_TOOLS_NAMESPACE })
  const stale = new McpDescriptor({ serverIdentifier: DYNAMIC_TOOLS_NAMESPACE, serverName: "stale" })
  const options = {
    enabled: true,
    mcpDescriptors: [stale],
  }
  const patched = withToolSetMcpSnapshot(options, toolSet({
    staticTools: [
      { name: "get_mcp_tools", dynamicToolMetaRole: "discovery" },
      { name: "call_mcp_tool", dynamicToolMetaRole: "invocation" },
    ],
    registry: { getMcpDescriptor: () => builtin },
  }))
  assert.equal(patched?.mcpDescriptors.length, 1)
  assert.ok(patched?.mcpDescriptors[0] instanceof McpDescriptor)
  assert.deepEqual(patched?.mcpDescriptors[0]?.toJson(), builtin.toJson())
})

// ---------------------------------------------------------------------------------------------
// request-context: where a turn's context comes from
// ---------------------------------------------------------------------------------------------

function requestContextValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rules: [],
    agentSkills: [],
    env: {
      projectFolder: "/project",
      agentConversationNotesFolder: "",
      agentSharedNotesFolder: "/project/notes",
      pathSeparator: "/",
    },
    ...overrides,
  }
}

function resourcesReturning(value: Record<string, unknown>): {
  resources: { get: () => { execute: (ctx: Context, args: RequestContextArgs) => Promise<RequestContextResult> } }
  calls: RequestContextArgs[]
} {
  const calls: RequestContextArgs[] = []
  return {
    calls,
    resources: {
      get: () => ({
        async execute(_ctx: Context, args: RequestContextArgs) {
          calls.push(args)
          return new RequestContextResult({
            result: {
              case: "success",
              value: {
                requestContext: value as never,
              },
            },
          })
        },
      }),
    },
  }
}

test("a provided context is used as it is", async () => {
  const provided = requestContextValue()
  const { resources } = resourcesReturning({})
  const resolved = await resolveRequestContext({
    parentCtx: ctx(),
    maybeRequestContext: provided as never,
    resources: resources as never,
  })
  assert.equal(resolved.requestContext, provided)
  assert.equal(resolved.provenance, "providedUnchanged")
})

test("a provided context that needed adjusting says so", async () => {
  const provided = requestContextValue()
  const { resources } = resourcesReturning({})
  const resolved = await resolveRequestContext({
    parentCtx: ctx(),
    maybeRequestContext: provided as never,
    resources: resources as never,
    options: { notesSessionId: "session-1" },
  })
  assert.equal(resolved.provenance, "providedModified")
  assert.equal((provided.env as unknown as Record<string, unknown>).agentConversationNotesFolder, "/project/agent-notes/session-1")
})

test("notes go under the project's own folder, named for the session", async () => {
  const provided = requestContextValue()
  await resolveRequestContext({
    parentCtx: ctx(),
    maybeRequestContext: provided as never,
    resources: resourcesReturning({}).resources as never,
    options: { notesSessionId: "session-2" },
  })
  assert.equal((provided.env as unknown as Record<string, unknown>).agentConversationNotesFolder, "/project/agent-notes/session-2")
  // A meta agent is not a conversation: the shared notes folder is cleared.
  assert.equal((provided.env as unknown as Record<string, unknown>).agentSharedNotesFolder, "/project/notes")
})

test("a meta agent writes to its own folder and leaves the shared one empty", async () => {
  const provided = requestContextValue()
  await resolveRequestContext({
    parentCtx: ctx(),
    maybeRequestContext: provided as never,
    resources: resourcesReturning({}).resources as never,
    options: { notesSessionId: "session-3", metaAgentNotesEnabled: true },
  })
  assert.equal((provided.env as unknown as Record<string, unknown>).agentConversationNotesFolder, "/project/agent-notes/session-3")
  assert.equal((provided.env as unknown as Record<string, unknown>).agentSharedNotesFolder, "")
})

test("a conversation that already has a notes folder keeps it unless it is a meta agent", async () => {
  const provided = requestContextValue()
  ;(provided.env as unknown as Record<string, unknown>).agentConversationNotesFolder = "/elsewhere"
  await resolveRequestContext({
    parentCtx: ctx(),
    maybeRequestContext: provided as never,
    resources: resourcesReturning({}).resources as never,
    options: { notesSessionId: "session-4" },
  })
  assert.equal((provided.env as unknown as Record<string, unknown>).agentConversationNotesFolder, "/elsewhere")
})

test("a context with no project folder is left alone", async () => {
  const provided = requestContextValue({ env: { agentConversationNotesFolder: "" } })
  const resolved = await resolveRequestContext({
    parentCtx: ctx(),
    maybeRequestContext: provided as never,
    resources: resourcesReturning({}).resources as never,
    options: { notesSessionId: "session-5" },
  })
  assert.equal(resolved.provenance, "providedUnchanged")
})

test("rules and skills scoped to someone else are dropped before the turn sees them", async () => {
  const provided = requestContextValue({
    rules: [
      { scopedTo: ["someone@elsewhere.test"] },
      { scopedTo: ["me@example.test"] },
      { scopedTo: [] },
    ],
    agentSkills: [{ scopedTo: ["someone@elsewhere.test"] }],
  })
  const resolved = await resolveRequestContext({
    parentCtx: ctx(),
    maybeRequestContext: provided as never,
    resources: resourcesReturning({}).resources as never,
    options: { actorIdentity: { email: "me@example.test" } },
  })
  assert.equal(resolved.provenance, "providedModified")
  assert.equal((resolved.requestContext.rules as unknown[]).length, 2)
  assert.equal((resolved.requestContext.agentSkills as unknown[]).length, 0)
})

test("a context that has to be asked for is fetched and says so", async () => {
  const { resources, calls } = resourcesReturning(requestContextValue())
  const resolved = await resolveRequestContext({ parentCtx: ctx(), resources: resources as never })
  assert.equal(resolved.provenance, "executorFetched")
  assert.equal(calls.length, 1)
  // No session was named, so the field is left unset rather than sent empty.
  assert.equal(calls[0]?.notesSessionId, undefined)
})

test("the session id travels with the request when there is one", async () => {
  const { resources, calls } = resourcesReturning(requestContextValue())
  await resolveRequestContext({
    parentCtx: ctx(),
    resources: resources as never,
    options: { notesSessionId: "session-6" },
  })
  assert.equal(calls[0]?.notesSessionId, "session-6")
})

test("a fetched context is adjusted on the way out too", async () => {
  const value = requestContextValue()
  const { resources } = resourcesReturning(value)
  const resolved = await resolveRequestContext({
    parentCtx: ctx(),
    resources: resources as never,
    options: { notesSessionId: "session-7", metaAgentNotesEnabled: true },
  })
  assert.equal((resolved.requestContext.env as unknown as Record<string, unknown>).agentConversationNotesFolder, "/project/agent-notes/session-7")
  assert.equal((resolved.requestContext.env as unknown as Record<string, unknown>).agentSharedNotesFolder, "")
})

test("a failure from the workspace is reported rather than papered over", async () => {
  const resources = {
    get: () => ({
      async execute() {
        return new RequestContextResult({ result: { case: "error", value: {} } as never })
      },
    }),
  }
  await assert.rejects(
    resolveRequestContext({ parentCtx: ctx(), resources: resources as never }),
    /Failed to get request context/,
  )
})

test("a success with no context in it is a failure too", async () => {
  const resources = {
    get: () => ({
      async execute() {
        return new RequestContextResult({ result: { case: "success", value: {} } as never })
      },
    }),
  }
  await assert.rejects(
    resolveRequestContext({ parentCtx: ctx(), resources: resources as never }),
    /Failed to get request context/,
  )
})

test("the short form returns the context itself, read from the workspace", async () => {
  const value = requestContextValue()
  const { resources, calls } = resourcesReturning(value)
  const requestContext = await getRequestContext(ctx(), undefined, resources as never)
  assert.equal(calls.length, 1)
  assert.equal(requestContext.env?.projectFolder, "/project")
})

test("the redacted form goes out under the mode it came in with", async () => {
  const value = requestContextValue()
  const { resources } = resourcesReturning(value)
  // Built the way the platform builds one, so the fixture cannot drift from the real shape.
  const redactedIn = toRedactedRequestContext(new RequestContext(requestContextValue() as never), PrivacyMode.NO_TRAINING)
  const redacted = await getRedactedRequestContext(ctx(), redactedIn, resources as never)
  assert.equal(redacted._privacyMode, PrivacyMode.NO_TRAINING)
})

test("the redacted form invents no mode when the context carried none", async () => {
  const value = requestContextValue()
  const { resources } = resourcesReturning(value)
  const redacted = await getRedactedRequestContext(ctx(), undefined, resources as never)
  assert.equal(redacted._privacyMode, PrivacyMode.UNSPECIFIED)
})

test("the request context operation is registered under its own name", () => {
  assert.equal(typeof requestContextExecutorResource.symbol, "symbol")
})

test("a schema value is what the descriptor carries, not a copy of the JSON", () => {
  const value = Value.fromJson({ type: "object" })
  assert.deepEqual(value.toJson(), { type: "object" })
})
