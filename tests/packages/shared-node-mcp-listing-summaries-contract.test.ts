import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_MCP_ACCOUNT_KEY } from "../../source/shared/mcp.ts";
import { SlateMcpListingSummaries } from "../../source/shared/node/mcp/mcp-listing-summaries.ts";

function summaries(options: { wired?: boolean; disabled?: Record<string, string[]>; byId?: string; byName?: string } = {}) {
  const reads: string[] = [];
  const value = new SlateMcpListingSummaries({
    settingsStore: () => ({
      getMcpDisabledToolsByServerId: () => options.disabled ?? {},
      getRawMcpCustomInstructionByServerId: (id: string) => { reads.push(`id:${id}`); return options.byId; },
      getRawMcpCustomInstruction: (name: string) => { reads.push(`name:${name}`); return options.byName; },
    }),
    isBoxExecWired: () => options.wired === true,
  });
  return { value, reads };
}

const httpServer = {
  id: "11",
  name: "Remote",
  serverIdentifier: "row-11",
  config: { url: "https://mcp.example", type: "sse" },
  isTeamServer: true,
  pluginId: "plugin-1",
  isRequired: true,
  managedByTeamPluginPolicy: true,
};

describe("MCP listing summary projection", () => {
  it("projects per-account backend status, identifiers, disabled tools and server metadata", () => {
    const { value, reads } = summaries({ disabled: { "11": ["search"] }, byId: "  id instruction  ", byName: "name fallback" });
    const server = {
      ...httpServer,
      accounts: [
        { accountKey: "work", hasToken: true },
        { accountKey: "home", hasToken: false, serverIdentifier: "slot-home" },
      ],
    };
    const result = value.createBackendServerSummaries(server as never, [
      { accountLabel: "work", serverIdentifier: "backend-work", status: "connected", tools: [{ toolName: "search" }, { toolName: "read" }] },
      { accountLabel: "home", serverIdentifier: "backend-home", status: "error", tools: [{ toolName: "search" }] },
    ]);
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], {
      id: "11",
      name: "Remote",
      serverIdentifier: "backend-work",
      accountKey: "work",
      rowServerIdentifier: "row-11",
      transport: "sse",
      command: undefined,
      url: "https://mcp.example",
      toolCount: 1,
      disabledToolCount: 1,
      customInstructions: "id instruction",
      isTeamServer: true,
      pluginId: "plugin-1",
      isRequired: true,
      managedByTeamPluginPolicy: true,
      status: "connected",
    });
    assert.equal(result[1]?.serverIdentifier, "slot-home");
    assert.equal(result[1]?.status, "needsAuth");
    assert.equal(result[1]?.statusDetail, "Authentication required");
    assert.equal(result[1]?.toolCount, 0);
    assert.deepEqual(reads, ["id:11", "id:11"]);
  });

  it("uses the default account row when no explicit slots exist", () => {
    const { value } = summaries();
    const result = value.createBackendServerSummaries(httpServer as never, [
      { accountLabel: DEFAULT_MCP_ACCOUNT_KEY, tools: [] },
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.accountKey, DEFAULT_MCP_ACCOUNT_KEY);
    assert.equal(result[0]?.serverIdentifier, "row-11");
    assert.equal(result[0]?.status, "error");
    assert.equal(result[0]?.statusDetail, "Not reported by backend");
    assert.equal(result[0]?.toolCount, 0);
  });

  it("projects box status and counts only tools that remain enabled", () => {
    const { value } = summaries({ wired: true, disabled: { "11": ["search"] }, byName: "from name" });
    const server = { ...httpServer, config: { command: "node", args: ["mcp.js"] } };
    const result = value.createBoxServerSummary(server as never, {
      status: "error",
      statusDetail: "disconnected",
      toolCount: 5,
      tools: [{ toolName: "search" }, { toolName: "read" }],
    }, false);
    assert.equal(result.status, "error");
    assert.equal(result.statusDetail, "disconnected");
    assert.equal(result.transport, "stdio");
    assert.equal(result.command, "node mcp.js");
    assert.equal(result.url, undefined);
    assert.equal(result.toolCount, 1);
    assert.equal(result.disabledToolCount, 1);
    assert.equal(result.customInstructions, "from name");

    const disconnected = summaries({ wired: false }).value.createBoxServerSummary(server as never, undefined, true);
    assert.deepEqual([disconnected.status, disconnected.statusDetail, disconnected.toolCount], ["disconnected", "Runs on Slate's computer", 0]);
  });

  it("labels admin-disabled servers without pretending a backend was checked", () => {
    const { value } = summaries();
    const result = value.createAdminDisabledServerSummary({ ...httpServer, serverIdentifier: undefined } as never);
    assert.equal(result.serverIdentifier, "mcp-row-11");
    assert.equal(result.accountKey, DEFAULT_MCP_ACCOUNT_KEY);
    assert.equal(result.toolCount, 0);
    assert.equal(result.status, "disabledByTeamAdminPolicy");
    assert.equal(result.statusDetail, "Disabled by team admin");
  });
});
