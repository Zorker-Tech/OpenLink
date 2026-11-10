import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  getMcpFileSystemInstructions,
  getMcpFileSystemToolNames,
  type McpFileSystemParams,
} from "../../source/packages/agent/utils/mcp-file-system.ts"

function enabledFilesystem(overrides: Partial<McpFileSystemParams> = {}): McpFileSystemParams {
  return {
    mcpFileSystemOptions: {
      enabled: true,
      workspaceProjectDir: "/workspace/project",
      mcpDescriptors: [{
        serverIdentifier: "issue-tracker",
        folderPath: "/workspace/project/mcps/issue-tracker",
        serverUseInstructions: "Authenticate before creating an issue.",
        tools: [],
      }],
    },
    featureFlags: { enableMCPFileSystem: true },
    ...overrides,
  }
}

describe("MCP filesystem prompt policy", () => {
  it("does not describe a disabled, unsupported, empty, competing, or filtered route", () => {
    const cases: Array<[string, McpFileSystemParams]> = [
      ["filesystem disabled", enabledFilesystem({ mcpFileSystemOptions: { ...enabledFilesystem().mcpFileSystemOptions!, enabled: false } })],
      ["feature unavailable", enabledFilesystem({ featureFlags: undefined })],
      ["no descriptors", enabledFilesystem({ mcpFileSystemOptions: { ...enabledFilesystem().mcpFileSystemOptions!, mcpDescriptors: [] } })],
      ["meta tool enabled", enabledFilesystem({ mcpMetaToolOptions: { enabled: true } })],
      ["Ask filters edit tools", enabledFilesystem({ mode: "ask" })],
    ]

    for (const [reason, params] of cases) assert.equal(getMcpFileSystemInstructions(params), "", reason)
  })

  it("keeps the filesystem route available in Ask when edit-tool filtering is explicitly disabled", () => {
    const instructions = getMcpFileSystemInstructions(enabledFilesystem({
      mode: "ask",
      enableFilterEditToolsInAskMode: false,
    }))

    assert.match(instructions, /<mcp_file_system>/)
    assert.match(instructions, /issue-tracker/)
  })

  it("uses the model's tool-name style and keeps resource and server instructions", () => {
    assert.deepEqual(getMcpFileSystemToolNames(undefined), {
      callMcpTool: "call_mcp_tool",
      listMcpResources: "list_mcp_resources",
      fetchMcpResource: "fetch_mcp_resource",
    })
    assert.deepEqual(getMcpFileSystemToolNames({ mcpToolNameStyle: "pascal" }), {
      callMcpTool: "CallMcpTool",
      listMcpResources: "ListMcpResources",
      fetchMcpResource: "FetchMcpResource",
    })

    const snake = getMcpFileSystemInstructions(enabledFilesystem())
    const pascal = getMcpFileSystemInstructions(enabledFilesystem({ modelInfo: { mcpToolNameStyle: "pascal" } }))
    assert.match(snake, /`call_mcp_tool`/)
    assert.match(snake, /`list_mcp_resources`/)
    assert.match(snake, /Authenticate before creating an issue\./)
    assert.match(snake, /Before calling any MCP tool, list and read its JSON descriptor/)
    assert.match(snake, /resource URI, display name, description and media type/)
    assert.match(snake, /list_resources|list_mcp_resources/)
    assert.match(pascal, /`CallMcpTool`/)
    assert.match(pascal, /`ListMcpResources`/)
  })

  it("escapes external names and instructions and supplies a folder for an incomplete descriptor", () => {
    const instructions = getMcpFileSystemInstructions(enabledFilesystem({
      mcpFileSystemOptions: {
        enabled: true,
        workspaceProjectDir: "/workspace/project/",
        mcpDescriptors: [{
          serverIdentifier: 'issue"&<tracker>',
          serverUseInstructions: "Use <read> & write\nonly when asked.",
          tools: [],
        }],
      },
    }))

    assert.match(instructions, /name="issue&quot;&amp;&lt;tracker&gt;"/)
    assert.match(instructions, /folderPath="\/workspace\/project\/mcps\/issuetracker"/)
    assert.match(instructions, /serverUseInstructions="Use &lt;read&gt; &amp; write&#10;only when asked\."/)
    assert.doesNotMatch(instructions, /folderPath="undefined"/)
    assert.doesNotMatch(instructions, /name="issue"&/)
  })

  it("teaches one-server-at-a-time authentication before the server inventory", () => {
    const instructions = getMcpFileSystemInstructions(enabledFilesystem())
    const authentication = instructions.indexOf("## Authentication")
    const inventory = instructions.indexOf("## Available servers")
    assert.equal(authentication >= 0 && authentication < inventory, true)
    assert.match(instructions, /Authenticate one server at a time/)
  })

  it("leaves a clear partial-work summary rule at the end", () => {
    const instructions = getMcpFileSystemInstructions(enabledFilesystem())
    assert.match(instructions, /include what you were unable to do with MCP and why/)
    assert.match(instructions, /Do not use browser automation/)
  })
})
