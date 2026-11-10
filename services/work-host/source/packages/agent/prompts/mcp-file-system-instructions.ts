import { sanitizeMcpServerFolder } from "../../../shared/node/mcp/mcp-server-folder.ts"

export interface McpFileSystemPromptServer {
  readonly serverIdentifier: string
  readonly folderPath?: string | undefined
  readonly serverUseInstructions?: string | undefined
}

export interface McpFileSystemPromptToolNames {
  readonly callTool: string
  readonly listResources: string
  readonly readResource: string
}

export interface McpFileSystemPromptInput {
  readonly workspaceProjectDir: string
  readonly servers: readonly McpFileSystemPromptServer[]
  readonly toolNames: McpFileSystemPromptToolNames
  readonly authenticationRule: string
}

const MARKUP_ATTRIBUTE_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&apos;",
  "\r": "&#13;",
  "\n": "&#10;",
})

function escapeMarkupAttribute(value: string): string {
  return value.replace(/[&<>"'\r\n]/g, character => MARKUP_ATTRIBUTE_ESCAPES[character] ?? character)
}

function descriptorRoot(workspaceProjectDir: string): string {
  return `${workspaceProjectDir.replace(/[\\/]+$/, "")}/mcps`
}

function descriptorFolder(
  root: string,
  server: McpFileSystemPromptServer,
): string {
  return server.folderPath ?? `${root}/${sanitizeMcpServerFolder(server.serverIdentifier)}`
}

function renderServer(
  root: string,
  server: McpFileSystemPromptServer,
): string {
  const name = escapeMarkupAttribute(server.serverIdentifier)
  const folder = escapeMarkupAttribute(descriptorFolder(root, server))
  const useInstructions = server.serverUseInstructions === undefined
    ? ""
    : ` serverUseInstructions="${escapeMarkupAttribute(server.serverUseInstructions)}"`
  return `<mcp_file_system_server name="${name}" folderPath="${folder}"${useInstructions} />`
}

/**
 * Renders the durable MCP file-system route as a model-facing procedure.
 *
 * The descriptor tree is an index, not an optional hint: a tool call is made only after its
 * descriptor has been read. Values placed in the server inventory are escaped because server names
 * and provider instructions are external data, not markup.
 */
export function renderMcpFileSystemInstructions(input: McpFileSystemPromptInput): string {
  if (input.servers.length === 0) return ""

  const root = descriptorRoot(input.workspaceProjectDir)
  const { callTool, listResources, readResource } = input.toolNames
  const inventory = input.servers
    .map(server => renderServer(root, server))
    .join("\n")

  return [
    "<mcp_file_system>",
    "MCP is reachable through a browsable descriptor tree for this turn.",
    "",
    "## Calling MCP tools",
    `1. Choose the MCP server that owns the capability needed for the request. When the user names or links a service that is represented by a server, inspect that server proactively.`,
    `2. Before calling any MCP tool, list and read its JSON descriptor under \`${root}/<server>/tools\`. This schema check is mandatory: the descriptor defines the tool name, arguments, required fields and types.`,
    `3. Invoke the selected tool with \`${callTool}\`. Reuse the descriptor's argument names exactly.`,
    "",
    "## Reading MCP resources",
    `Use \`${listResources}\` to discover server resources, or read the matching JSON descriptor under \`${root}/<server>/resources\`. Those descriptors carry the resource URI, display name, description and media type.`,
    `Use \`${readResource}\` with the server and resource URI to return the resource body. Resources are read-only.`,
    "",
    "## Authentication",
    input.authenticationRule,
    "",
    "## Available servers",
    "The following server identities and descriptor folders are active:",
    "<mcp_file_system_servers>",
    inventory,
    "</mcp_file_system_servers>",
    "</mcp_file_system>",
  ].join("\n")
}
