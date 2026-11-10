import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { McpFileSystemOptions } from "../../source/adapters/interop/proto/generated/agent/v1/mcp_pb.ts"
import { toInteropMcpFileSystemOptions } from "../../source/adapters/interop/agent/mcp-file-system-options-adapter.ts"

describe("the MCP file-catalog interop adapter", () => {
  it("maps Slate's descriptor fields and normalized annotations to the executor schema", () => {
    const result = toInteropMcpFileSystemOptions({
      enabled: true,
      workspaceProjectDir: "/workspace",
      mcpDescriptors: [{
        serverIdentifier: "server-1",
        serverName: "Server One",
        folderPath: "/workspace/mcps/server-1",
        pluginId: "plugin-1",
        instructions: "use carefully",
        tools: [{
          toolName: "read",
          definitionPath: "/workspace/mcps/server-1/tools/read.json",
          annotations: { title: "Read", readOnlyHint: true, extra: "drop" },
        }],
      }],
    })

    assert.equal(result instanceof McpFileSystemOptions, true)
    assert.equal(result.enabled, true)
    assert.equal(result.workspaceProjectDir, "/workspace")
    assert.equal(result.mcpDescriptors[0]?.pluginDbId, "plugin-1")
    assert.equal(result.mcpDescriptors[0]?.serverUseInstructions, "use carefully")
    assert.equal(result.mcpDescriptors[0]?.tools[0]?.annotationsJson, JSON.stringify({ title: "Read", readOnlyHint: true }))
  })
})
