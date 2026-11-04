import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderContent } from "../../source/packages/prompt-jsx/index.ts";
import { DYNAMIC_TOOLS_NAMESPACE } from "../../source/packages/agent-exec/mcp-operations.ts";
import { McpMetaToolServerList, McpMetaToolServersSection } from "../../source/packages/agent/prompts/mcp-catalog.ts";
import type { UserInfoMcpDescriptor } from "../../source/packages/agent/prompts/user-info-data-contracts.ts";

describe("user-info MCP catalog projection", () => {
  it("renders ordered server entries and omits empty optional attributes", () => {
    const descriptors: UserInfoMcpDescriptor[] = [
      {
        serverIdentifier: "server-one",
        tools: [{ toolName: "search" }, { toolName: "fetch" }],
        serverUseInstructions: "use these tools",
      },
      { serverIdentifier: "server-empty", tools: [] },
    ];

    assert.equal(McpMetaToolServerList(descriptors), [
      "<mcp_meta_tool_servers>",
      "<mcp_meta_tool_server name=\"server-one\" tools=\"search, fetch\" serverUseInstructions=\"use these tools\" />",
      "<mcp_meta_tool_server name=\"server-empty\" />",
      "</mcp_meta_tool_servers>",
    ].join("\n"));
    assert.equal(McpMetaToolServerList([]), "");
  });

  it("marks Slate's dynamic namespace as platform-owned and the others as MCP", () => {
    const descriptors: UserInfoMcpDescriptor[] = [
      { serverIdentifier: DYNAMIC_TOOLS_NAMESPACE, tools: [{ toolName: "native" }], serverUseInstructions: "platform guidance" },
      { serverIdentifier: "remote-server", tools: [{ toolName: "remote" }], serverUseInstructions: "remote guidance" },
    ];
    const rendered = McpMetaToolServerList(descriptors, true);
    assert.equal(rendered, [
      "<dynamic_tool_namespaces>",
      "<namespace name=\"slate\" tools=\"native\" namespaceUseInstructions=\"platform guidance\" source=\"platform\" />",
      "<namespace name=\"remote-server\" tools=\"remote\" namespaceUseInstructions=\"remote guidance\" source=\"mcp\" />",
      "</dynamic_tool_namespaces>",
    ].join("\n"));
  });

  it("omits a complete empty section but keeps the incomplete notice and snapshot tool names", () => {
    const options = { mcpDescriptors: [], snapshotToolNames: { discoveryToolName: "FindMcp", invocationToolName: "CallMcp" } };
    assert.equal(renderContent(McpMetaToolServersSection({ mcpMetaToolOptions: options, mcpInfoComplete: true })), "");
    const incomplete = renderContent(McpMetaToolServersSection({ mcpMetaToolOptions: options, mcpInfoComplete: false }));
    assert.match(incomplete, /mcp_server_catalog/);
    assert.match(incomplete, /server discovery is still warming/);
    assert.match(incomplete, /FindMcp/);
    assert.match(incomplete, /CallMcp/);
  });
});
