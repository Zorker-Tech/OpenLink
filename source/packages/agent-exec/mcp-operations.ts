/**
 * The MCP operations, and what the platform knows about the servers behind them.
 *
 * An MCP server is someone else's process: it may need authentication, it may still be loading, it may
 * have failed, and the tools it offers arrive as files rather than as compiled code. Two kinds of thing
 * live here for that reason.
 *
 * The first is what the platform knows without asking: which servers cannot be authenticated at all
 * because they belong to the environment rather than to the user, which ones are browsers, and how a
 * server's state is worded when it is not usable. The second is the channel itself — listing a server's
 * resources, reading one, asking for its state, and calling its tools are all operations that run where
 * the server runs, so each is named once here and served through the exec channel like any other.
 */

import type { JsonValue } from "@bufbuild/protobuf"

import type {
  ListMcpResourcesExecArgs,
  ListMcpResourcesExecResult,
  McpArgs,
  McpResult,
  McpStateExecArgs,
  McpStateExecResult,
  ReadMcpResourceExecArgs,
  ReadMcpResourceExecResult,
} from "../proto/generated/agent/v1/mcp_exec_pb.ts"
import { SimpleControlledExecHandler } from "./controlled-exec.ts"
import { ExecutorResource, type Executor, type RemoteExecManager } from "./executor-resources.ts"
import { createResource, type ControlledExecManager } from "./resource-provider.ts"
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-serialization.ts"

/**
 * The identifiers a server registers itself under. These are wire values — the server is the one that
 * says what it is called — so they are matched, never invented.
 */
export const BROWSER_EXTENSION_MCP_PROVIDER_ID = "cursor-browser-extension"
export const IDE_BROWSER_MCP_PROVIDER_ID = "cursor-ide-browser"
export const ENVIRONMENT_CONTROL_MCP_PROVIDER_ID = "cursor-dev-control"
export const CUSTOM_USER_TOOLS_PROVIDER_ID = "custom-user-tools"

/** Servers that are part of the environment: there is no account to authenticate them against. */
export const NON_AUTHENTICATABLE_MCP_PROVIDER_IDS = new Set([
  "cursor-app-control",
  "cursor-backend-control",
  BROWSER_EXTENSION_MCP_PROVIDER_ID,
  IDE_BROWSER_MCP_PROVIDER_ID,
  ENVIRONMENT_CONTROL_MCP_PROVIDER_ID,
  CUSTOM_USER_TOOLS_PROVIDER_ID,
  "fsd",
])

/** The namespace the platform's own on-demand tools are listed under. */
export const DYNAMIC_TOOLS_NAMESPACE = "slate"

export const BROWSER_MCP_PROVIDER_IDS = new Set([
  ENVIRONMENT_CONTROL_MCP_PROVIDER_ID,
  IDE_BROWSER_MCP_PROVIDER_ID,
])

/** Why a lease over a server's tool list changed; the values travel to whoever listens for them. */
export const McpLeaseChangeReason = {
  Snapshots: "cursor_mcp_lease_snapshot_store",
  Status: "cursor_mcp_lease_server_status",
  Settings: "cursor_mcp_lease_settings",
  Providers: "cursor_mcp_lease_providers",
  Unknown: "cursor_mcp_lease_unknown",
} as const

export type McpLeaseChangeReason = (typeof McpLeaseChangeReason)[keyof typeof McpLeaseChangeReason]

export interface McpToolFileLike {
  readonly toolName: string
  readonly description?: string | undefined
  readonly inputSchema?: unknown
  readonly outputSchema?: unknown
  readonly plugin?: string | undefined
  readonly marketplace?: string | undefined
  readonly pluginId?: string | undefined
  readonly marketplaceId?: string | undefined
}

export interface McpInputSchemaLike {
  readonly inputSchemaJson?: string | undefined
  readonly inputSchema?: { toJson(): JsonValue } | undefined
}

export interface McpLeaseChangeEvent {
  readonly serverIdentifiers?: readonly string[] | undefined
  readonly reason?: string | undefined
}

export function supportsInteractiveMcpAuth(serverIdentifier: string): boolean {
  return !NON_AUTHENTICATABLE_MCP_PROVIDER_IDS.has(serverIdentifier)
}

/** The file a server's tool is written as, in the shape the file-system view reads it. */
export function buildMcpToolFileContent(tool: McpToolFileLike): {
  readonly name: string
  readonly description: string | undefined
  readonly arguments: unknown
  readonly outputSchema: unknown
  readonly plugin: string | undefined
  readonly marketplace: string | undefined
  readonly pluginId: string | undefined
  readonly marketplaceId: string | undefined
} {
  return {
    name: tool.toolName,
    description: tool.description,
    arguments: tool.inputSchema,
    outputSchema: tool.outputSchema,
    plugin: tool.plugin,
    marketplace: tool.marketplace,
    pluginId: tool.pluginId,
    marketplaceId: tool.marketplaceId,
  }
}

export function parseMcpInputSchemaJson(inputSchemaJson: string | undefined): JsonValue | undefined {
  if (inputSchemaJson === undefined) return undefined
  try {
    return JSON.parse(inputSchemaJson) as JsonValue
  } catch {
    return undefined
  }
}

/** A server may hand its schema over as JSON text or as a message; the text wins when both are there. */
export function mcpInputSchemaToJson(tool: McpInputSchemaLike): JsonValue | undefined {
  return parseMcpInputSchemaJson(tool.inputSchemaJson) ?? tool.inputSchema?.toJson()
}

/** A change that names no servers invalidates the whole lease. */
export function isFullMcpLeaseInvalidation(event: McpLeaseChangeEvent | undefined): boolean {
  return event === undefined || event.serverIdentifiers === undefined
}

/** Merging two changes: the wider one wins, and the reasons are taken in order of how specific they are. */
export function mergeMcpLeaseEvents(
  ...events: Array<McpLeaseChangeEvent | undefined>
): McpLeaseChangeEvent | undefined {
  const [a, b] = events
  if (events.length < 2) return a
  if (isFullMcpLeaseInvalidation(b)) {
    return { serverIdentifiers: undefined, reason: a?.reason ?? b?.reason }
  }
  if (a === undefined) return b
  if (isFullMcpLeaseInvalidation(a)) {
    return { serverIdentifiers: undefined, reason: a.reason ?? b?.reason }
  }
  return {
    serverIdentifiers: [...new Set([...(a.serverIdentifiers ?? []), ...(b?.serverIdentifiers ?? [])])],
    reason: a.reason ?? b?.reason,
  }
}

/** What a server's state means for its tools, or nothing when the state needs no explaining. */
export function mcpServerUnavailableReason(status: string): string | undefined {
  switch (status) {
    case "needsAuth":
      return "This MCP server requires authentication before its tools can be used."
    case "error":
      return "This MCP server failed during live tool discovery. Its tools are unavailable until the connection is fixed."
    case "loading":
      return "This MCP server is still loading; tools may not be available yet."
    default:
      return undefined
  }
}

export const mcpExecutorResource = createResource<Executor<McpArgs, McpResult>, RemoteExecManager, ControlledExecManager>(
  execManager => new ExecutorResource(
    execManager,
    createServerSerializer("mcpArgs"),
    createClientDeserializer("mcpResult"),
  ),
  (implementation, controlledExecManager) => {
    controlledExecManager.register(new SimpleControlledExecHandler(
      implementation,
      createServerDeserializer("mcpArgs"),
      createClientSerializer("mcpResult"),
    ))
  },
)

export const listMcpResourcesExecutorResource = createResource<
  Executor<ListMcpResourcesExecArgs, ListMcpResourcesExecResult>,
  RemoteExecManager,
  ControlledExecManager
>(
  execManager => new ExecutorResource(
    execManager,
    createServerSerializer("listMcpResourcesExecArgs"),
    createClientDeserializer("listMcpResourcesExecResult"),
  ),
  (implementation, controlledExecManager) => {
    controlledExecManager.register(new SimpleControlledExecHandler(
      implementation,
      createServerDeserializer("listMcpResourcesExecArgs"),
      createClientSerializer("listMcpResourcesExecResult"),
    ))
  },
)

export const readMcpResourceExecutorResource = createResource<
  Executor<ReadMcpResourceExecArgs, ReadMcpResourceExecResult>,
  RemoteExecManager,
  ControlledExecManager
>(
  execManager => new ExecutorResource(
    execManager,
    createServerSerializer("readMcpResourceExecArgs"),
    createClientDeserializer("readMcpResourceExecResult"),
  ),
  (implementation, controlledExecManager) => {
    controlledExecManager.register(new SimpleControlledExecHandler(
      implementation,
      createServerDeserializer("readMcpResourceExecArgs"),
      createClientSerializer("readMcpResourceExecResult"),
    ))
  },
)

export const mcpStateExecutorResource = createResource<
  Executor<McpStateExecArgs, McpStateExecResult>,
  RemoteExecManager,
  ControlledExecManager
>(
  execManager => new ExecutorResource(
    execManager,
    createServerSerializer("mcpStateExecArgs"),
    createClientDeserializer("mcpStateExecResult"),
  ),
  (implementation, controlledExecManager) => {
    controlledExecManager.register(new SimpleControlledExecHandler(
      implementation,
      createServerDeserializer("mcpStateExecArgs"),
      createClientSerializer("mcpStateExecResult"),
    ))
  },
)
