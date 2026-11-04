import {
  projectMcpServerAvailability,
  supportsInteractiveMcpAuth as supportsInteropMcpAuth,
  type SlateMcpServerAvailability,
} from "../../adapters/interop/agent/mcp-provider-identity-adapter.ts"

export {
  BROWSER_EXTENSION_MCP_PROVIDER_ID,
  BROWSER_MCP_PROVIDER_IDS,
  CUSTOM_USER_TOOLS_PROVIDER_ID,
  ENVIRONMENT_CONTROL_MCP_PROVIDER_ID,
  IDE_BROWSER_MCP_PROVIDER_ID,
  McpLeaseChangeReason,
  NON_AUTHENTICATABLE_MCP_PROVIDER_IDS,
} from "../../adapters/interop/agent/mcp-provider-identity-adapter.ts"
export {
  listMcpResourcesExecutorResource,
  mcpExecutorResource,
  mcpStateExecutorResource,
  readMcpResourceExecutorResource,
} from "../../adapters/interop/agent/mcp-exec-resource-adapter.ts"

/** The namespace owned by this runtime for tools requested on demand. */
export const DYNAMIC_TOOLS_NAMESPACE = "slate"

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
  readonly inputSchema?: { toJson(): unknown } | undefined
}

export interface McpLeaseChangeEvent {
  readonly serverIdentifiers?: readonly string[] | undefined
  readonly reason?: string | undefined
}

/** Provider identity is interpreted at the adapter boundary before this policy answers about interactive auth. */
export function supportsInteractiveMcpAuth(serverIdentifier: string): boolean {
  return supportsInteropMcpAuth(serverIdentifier)
}

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
  const {
    toolName,
    description,
    inputSchema,
    outputSchema,
    plugin,
    marketplace,
    pluginId,
    marketplaceId,
  } = tool
  return { name: toolName, description, arguments: inputSchema, outputSchema, plugin, marketplace, pluginId, marketplaceId }
}

export function parseMcpInputSchemaJson(inputSchemaJson: string | undefined): unknown {
  if (inputSchemaJson === undefined) return undefined
  try {
    return JSON.parse(inputSchemaJson) as unknown
  } catch {
    return undefined
  }
}

/** Prefer supplied JSON; use the message representation when text is absent or malformed. */
export function mcpInputSchemaToJson(tool: McpInputSchemaLike): unknown {
  const supplied = parseMcpInputSchemaJson(tool.inputSchemaJson)
  return supplied ?? tool.inputSchema?.toJson()
}

export function isFullMcpLeaseInvalidation(event: McpLeaseChangeEvent | undefined): boolean {
  return event === undefined || event.serverIdentifiers === undefined
}

/** Combine the two queued notifications, keeping a whole-catalog refresh wider than a named-server refresh. */
export function mergeMcpLeaseEvents(
  ...events: Array<McpLeaseChangeEvent | undefined>
): McpLeaseChangeEvent | undefined {
  if (events.length < 2) return events[0]
  const earlier = events[0]
  const later = events[1]
  if (isFullMcpLeaseInvalidation(later)) {
    return { serverIdentifiers: undefined, reason: earlier?.reason ?? later?.reason }
  }
  if (earlier === undefined) return later
  if (isFullMcpLeaseInvalidation(earlier)) {
    return { serverIdentifiers: undefined, reason: earlier.reason ?? later?.reason }
  }
  const serverIdentifiers = new Set(earlier.serverIdentifiers)
  for (const identifier of later?.serverIdentifiers ?? []) serverIdentifiers.add(identifier)
  return {
    serverIdentifiers: [...serverIdentifiers],
    reason: earlier.reason ?? later?.reason,
  }
}

const UNAVAILABLE_COPY: Partial<Record<SlateMcpServerAvailability, string>> = {
  "authentication-required": "This MCP server requires authentication before its tools can be used.",
  "discovery-failed": "This MCP server failed during live tool discovery. Its tools are unavailable until the connection is fixed.",
  loading: "This MCP server is still loading; tools may not be available yet.",
}

/** Translate a provider state first, then choose the message Slate shows for that state. */
export function mcpServerUnavailableReason(status: string): string | undefined {
  return UNAVAILABLE_COPY[projectMcpServerAvailability(status)]
}
