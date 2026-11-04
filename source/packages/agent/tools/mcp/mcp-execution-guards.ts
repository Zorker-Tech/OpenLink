/** Validates MCP calls against the descriptors and read-path history held by a session. */

import type { RedactedString } from "../../../redaction/redacted-values.ts"
import { safeString } from "../../../redaction/create.ts"
import {
  McpExecToolNotFoundError,
  McpServerDoesNotExistError,
} from "./mcp-result-boundary.ts"
import type { McpDescriptorIndex } from "./mcp-call-options.ts"

export type McpToolDefinitionReadCheck =
  | { readonly kind: "read" }
  | { readonly kind: "noServer"; readonly serverIdentifier: string }
  | { readonly kind: "noTool"; readonly toolName: string; readonly serverPath: string | undefined }
  | { readonly kind: "unread"; readonly unreadPath: string }

export interface McpReadPathStateHandler {
  hasReadPath(path: RedactedString): boolean
}

function readOkay(): McpToolDefinitionReadCheck {
  return { kind: "read" }
}

function discoveryHint(toolName: string, dynamicNamespaces: boolean, includeTools: boolean): string {
  const where = dynamicNamespaces ? "namespaces" : "servers"
  const suffix = includeTools ? " and their tools" : ""
  return `Use ${toolName} to discover available ${where}${suffix}.`
}

/** Refuses a missing server or tool with the discovery route this session exposes. */
export function assertMcpToolIsCallable(
  session: McpDescriptorIndex,
  serverIdentifier: string,
  toolName: string,
  getMcpToolsToolName: string,
  useDynamicToolNamespaces: boolean,
): void {
  const server = session.serverDescriptors.get(serverIdentifier)
  if (server === undefined) {
    throw new McpServerDoesNotExistError(
      serverIdentifier,
      discoveryHint(getMcpToolsToolName, useDynamicToolNamespaces, false),
    )
  }

  const matchingTool = server.tools.find(tool => tool.toolName === toolName)
  if (matchingTool !== undefined) return

  const hint = discoveryHint(getMcpToolsToolName, useDynamicToolNamespaces, true)
  throw new McpExecToolNotFoundError(`Tool ${toolName} was not found. ${hint}`)
}

function missingServerResult(
  session: McpDescriptorIndex,
  mcpMetaToolEnabled: boolean,
  serverIdentifier: string,
): McpToolDefinitionReadCheck | undefined {
  if (session.serverDescriptors.has(serverIdentifier)) return undefined
  if (mcpMetaToolEnabled && session.serverDescriptors.size === 0) return readOkay()
  return { kind: "noServer", serverIdentifier }
}

/** Returns why the definition is usable, missing, or not yet read in this turn. */
export function checkToolDefinitionRead(
  session: McpDescriptorIndex,
  mcpMetaToolEnabled: boolean,
  serverIdentifier: string,
  toolName: string,
  stateHandler: McpReadPathStateHandler | undefined,
): McpToolDefinitionReadCheck {
  if (stateHandler === undefined) return readOkay()

  const missingServer = missingServerResult(session, mcpMetaToolEnabled, serverIdentifier)
  if (missingServer !== undefined) return missingServer

  const server = session.serverDescriptors.get(serverIdentifier)!
  const definitionPath = session.toolDefinitionPaths.get(`${serverIdentifier}:${toolName}`)
  if (definitionPath === undefined) {
    if (mcpMetaToolEnabled) return readOkay()
    return {
      kind: "noTool",
      toolName,
      serverPath: server.folderPath,
    }
  }

  return stateHandler.hasReadPath(safeString(definitionPath))
    ? readOkay()
    : { kind: "unread", unreadPath: definitionPath }
}
