/**
 * What has to be true before an MCP tool is called.
 *
 * Two questions are asked first. Does the tool exist — because a call to a server or a tool the session
 * does not have is a failure the model should be told about in the terms it can act on, and the two cases
 * read differently: a missing server is answered by listing what is there, a missing tool by the same list
 * narrowed to its tools. And has the model read the tool's definition — because an MCP tool's arguments
 * are only described in that file, so calling one without reading it is guessing, and the answer says
 * which file was not read rather than that the call was wrong.
 *
 * Both checks are answered from the session's descriptors and from the paths already read this turn, and
 * a session that has no descriptors to check against, or a server whose tools are described elsewhere, is
 * allowed through: the check exists to catch a skipped read, not to invent a requirement.
 */

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

/** A call to a server or tool this session does not have is refused with what it does have. */
export function assertMcpToolIsCallable(
  session: McpDescriptorIndex,
  serverIdentifier: string,
  toolName: string,
  getMcpToolsToolName: string,
  useDynamicToolNamespaces: boolean,
): void {
  const descriptor = session.serverDescriptors.get(serverIdentifier)
  if (descriptor === undefined) {
    throw new McpServerDoesNotExistError(
      serverIdentifier,
      `Use ${getMcpToolsToolName} to discover available ${useDynamicToolNamespaces ? "namespaces" : "servers"}.`,
    )
  }
  if (!descriptor.tools.some(tool => tool.toolName === toolName)) {
    throw new McpExecToolNotFoundError(
      `Tool ${toolName} was not found. Use ${getMcpToolsToolName} to discover available ${useDynamicToolNamespaces ? "namespaces" : "servers"} and their tools.`,
    )
  }
}

export function checkToolDefinitionRead(
  session: McpDescriptorIndex,
  mcpMetaToolEnabled: boolean,
  serverIdentifier: string,
  toolName: string,
  stateHandler: McpReadPathStateHandler | undefined,
): McpToolDefinitionReadCheck {
  // A session that does not track what has been read cannot be held to having read anything.
  if (stateHandler === undefined) return { kind: "read" }

  const serverDescriptor = session.serverDescriptors.get(serverIdentifier)
  if (serverDescriptor === undefined) {
    // Under the meta tool an empty list means the descriptors have not arrived yet, not that none exist.
    if (mcpMetaToolEnabled && session.serverDescriptors.size === 0) return { kind: "read" }
    return { kind: "noServer", serverIdentifier }
  }

  const definitionPath = session.toolDefinitionPaths.get(`${serverIdentifier}:${toolName}`)
  if (definitionPath === undefined) {
    // The meta tool describes its tools in the prompt rather than in files, so there is nothing to read.
    if (mcpMetaToolEnabled) return { kind: "read" }
    return {
      kind: "noTool",
      toolName,
      serverPath: serverDescriptor.folderPath,
    }
  }
  if (stateHandler.hasReadPath(safeString(definitionPath))) return { kind: "read" }
  return { kind: "unread", unreadPath: definitionPath }
}
