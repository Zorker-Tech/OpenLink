/**
 * The instructions for reaching MCP tools through the file system, when there is no meta tool.
 *
 * Two ways of reaching MCP exist, and they are mutually exclusive: through a meta tool that discovers
 * and invokes by name, or through a file system the agent browses — each server's tools written out as
 * descriptor files it reads before calling anything. This is the file-system variant, and it is only
 * written when that route is actually open: the file system enabled, the feature turned on, at least
 * one server present, and the meta tool not enabled to take precedence.
 *
 * An ask-mode run that still filters edit tools gets nothing at all: it cannot write, so describing how
 * to write would only invite an attempt that must fail.
 */

import { renderMcpFileSystemInstructions } from "../prompts/mcp-file-system-instructions.ts"
import { MCP_AUTH_INSTRUCTION } from "./mcp-auth-instruction.ts"
import type { UserInfoMode, UserInfoModelProfile } from "../prompts/user-info-profile-contract.ts"
import type { UserInfoMcpFileSystemOptions, UserInfoMcpMetaToolOptions } from "../prompts/user-info-data-contracts.ts"

export type McpFileSystemModelInfo = Pick<UserInfoModelProfile, "mcpToolNameStyle">

export interface McpFileSystemParams {
  readonly mode?: UserInfoMode | undefined
  readonly enableFilterEditToolsInAskMode?: boolean | undefined
  readonly mcpFileSystemOptions?: UserInfoMcpFileSystemOptions | undefined
  readonly mcpMetaToolOptions?: Pick<UserInfoMcpMetaToolOptions, "enabled"> | undefined
  readonly featureFlags?: { readonly enableMCPFileSystem?: boolean | undefined } | undefined
  readonly modelInfo?: McpFileSystemModelInfo | undefined
}

/**
 * The tool names the file-system instructions use. A model trained on the PascalCase names would not
 * find them spelled any other way, and one trained on the file-system names would not find the
 * PascalCase ones, so the choice is made from the model rather than from the platform.
 */
export function getMcpFileSystemToolNames(modelInfo: McpFileSystemModelInfo | undefined): {
  readonly callMcpTool: string
  readonly listMcpResources: string
  readonly fetchMcpResource: string
} {
  if (modelInfo?.mcpToolNameStyle === "pascal") {
    return {
      callMcpTool: "CallMcpTool",
      listMcpResources: "ListMcpResources",
      fetchMcpResource: "FetchMcpResource",
    }
  }
  return {
    callMcpTool: "call_mcp_tool",
    listMcpResources: "list_mcp_resources",
    fetchMcpResource: "fetch_mcp_resource",
  }
}

export function getMcpFileSystemInstructions(params: McpFileSystemParams): string {
  const isAskMode = params.mode === "ask"
  const shouldFilterEditToolsInAskMode = isAskMode && (params.enableFilterEditToolsInAskMode ?? true)
  if (shouldFilterEditToolsInAskMode) return ""
  // A meta tool takes over discovery and invocation; describing both routes would confuse the model.
  if (params.mcpMetaToolOptions?.enabled === true) return ""
  const mcpFileSystemOptions = params.mcpFileSystemOptions
  const hasMcpDescriptors = (mcpFileSystemOptions?.mcpDescriptors.length ?? 0) > 0
  const isMcpFileSystemEnabled = mcpFileSystemOptions?.enabled ?? false
  const isMcpFileSystemCompatible = params.featureFlags?.enableMCPFileSystem === true
  if (!isMcpFileSystemEnabled || !isMcpFileSystemCompatible || !hasMcpDescriptors || !mcpFileSystemOptions) return ""
  const toolNames = getMcpFileSystemToolNames(params.modelInfo)
  const instructions = renderMcpFileSystemInstructions({
    workspaceProjectDir: mcpFileSystemOptions.workspaceProjectDir,
    servers: mcpFileSystemOptions.mcpDescriptors.map(descriptor => ({
      serverIdentifier: descriptor.serverIdentifier,
      ...(descriptor.folderPath === undefined ? {} : { folderPath: descriptor.folderPath }),
      ...(descriptor.serverUseInstructions === undefined ? {} : { serverUseInstructions: descriptor.serverUseInstructions }),
    })),
    toolNames: {
      callTool: toolNames.callMcpTool,
      listResources: toolNames.listMcpResources,
      readResource: toolNames.fetchMcpResource,
    },
    authenticationRule: MCP_AUTH_INSTRUCTION,
  })
  // An incomplete MCP tool set is a reason to do the rest of the work, not to reach for a browser.
  return `${instructions}

If the available MCP tools do not fully support what the user asked you to do, complete the work you can with the current tool set. In your work summary, include what you were unable to do with MCP and why. Do not use browser automation to work around missing or unavailable MCP tools unless the user explicitly asks you to use the browser.`
}
