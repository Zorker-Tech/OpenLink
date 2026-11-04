import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SlateMcpInstructionsAndToggles,
  type McpSettingsPort,
} from "../../source/shared/node/mcp/mcp-instructions-and-toggles.ts";
import type { SlateMcpAccountDisplay, SlateMcpDisplayRow } from "../../source/shared/node/mcp/mcp-display-runtime.ts";

function displayServer(
  id: string,
  name: string,
  serverIdentifier: string,
  accounts: readonly { accountKey: string; hasToken: boolean; serverIdentifier?: string }[] = [],
): SlateMcpDisplayRow {
  return {
    id,
    name,
    serverIdentifier,
    config: { url: `https://${name.toLowerCase()}.example.test` },
    isTeamServer: false,
    accounts,
  };
}

interface FixtureOptions {
  servers?: readonly SlateMcpDisplayRow[];
  tools?: Array<{ providerIdentifier: string; toolName: string; title?: string; description?: string }>;
  disabled?: Record<string, string[]>;
  legacy?: Record<string, string>;
  byId?: Record<string, string>;
  listResult?: unknown;
}

function fixture(options: FixtureOptions = {}) {
  const migrations: Array<{ serverId: string; displayName: string }> = [];
  const instructionWrites: Array<{ serverId: string; displayName: string; value: string; mirrorLegacyName: boolean }> = [];
  const disabledWrites: Record<string, string[]>[] = [];
  let disabled = options.disabled ?? {};
  let displayConfig: SlateMcpAccountDisplay | null = { servers: [...(options.servers ?? [])] };
  let toolsCalls = 0;
  const serversById = new Map((options.servers ?? []).map((server) => [server.id, server]));
  const settings: McpSettingsPort = {
    migrateMcpCustomInstructionToServerId: (args) => { migrations.push(args); },
    setMcpCustomInstructionByServerId: (args) => { instructionWrites.push(args); },
    getMcpDisabledToolsByServerId: () => disabled,
    setMcpDisabledToolsByServerId: (value) => { disabledWrites.push(value); disabled = value; },
    getMcpCustomInstructions: () => options.legacy ?? {},
    getMcpCustomInstructionsByServerId: () => options.byId ?? {},
  };
  const manager = new SlateMcpInstructionsAndToggles({
    settingsStore: () => settings,
    resolveDisplayServer: async (id) => serversById.get(id),
    listServers: async () => options.listResult ?? "listed",
    lastAccountDisplayConfig: () => displayConfig,
    getToolsRaw: async () => { toolsCalls += 1; return options.tools ?? []; },
  });
  return {
    manager,
    settings,
    migrations,
    instructionWrites,
    disabledWrites,
    get disabled() { return disabled; },
    get toolsCalls() { return toolsCalls; },
    setDisplayConfig: (value: SlateMcpAccountDisplay | null) => { displayConfig = value; },
  };
}

describe("MCP instruction and tool-toggle behavior contract", () => {
  it("migrates legacy instructions by server id but leaves the zero id alone", () => {
    const h = fixture();
    h.manager.migrateCustomInstructions([
      displayServer("0", "Built in", "built-in"),
      displayServer("11", "Remote", "remote"),
      displayServer("22", "Other", "other"),
    ]);
    assert.deepEqual(h.migrations, [
      { serverId: "11", displayName: "Remote" },
      { serverId: "22", displayName: "Other" },
    ]);
  });

  it("validates ids, rejects missing servers and mirrors legacy names only when unique", async () => {
    const unique = displayServer("11", "Remote", "remote");
    const duplicate = displayServer("12", "Remote", "remote-2");
    const h = fixture({ servers: [unique, duplicate], listResult: { servers: 2 } });
    assert.deepEqual(await h.manager.setServerCustomInstructions({ serverId: " 11 ", instructions: "use safely" }), { servers: 2 });
    assert.deepEqual(h.instructionWrites, [{ serverId: "11", displayName: "Remote", value: "use safely", mirrorLegacyName: false }]);
    await assert.rejects(() => h.manager.setServerCustomInstructions({ serverId: "99", instructions: "x" }), /MCP server not found/);
    await assert.rejects(() => h.manager.setServerCustomInstructions({ serverId: "0", instructions: "x" }), /positive decimal string/);

    const single = fixture({ servers: [unique] });
    await single.manager.setServerCustomInstructions({ serverId: "11", instructions: "one" });
    assert.equal(single.instructionWrites[0]?.mirrorLegacyName, true);
  });

  it("lists only tools owned by the display row and de-duplicates by first tool name", async () => {
    const owner = displayServer("11", "Remote", "provider-main", [
      { accountKey: "slot-a", hasToken: true, serverIdentifier: "provider-slot" },
    ]);
    const other = displayServer("12", "Other", "provider-other");
    const h = fixture({
      servers: [owner, other],
      disabled: { "11": ["search"] },
      tools: [
        { providerIdentifier: "provider-slot", toolName: "search", title: "First" },
        { providerIdentifier: "provider-main", toolName: "search", title: "Duplicate" },
        { providerIdentifier: "provider-other", toolName: "edit", description: "not owned" },
        { providerIdentifier: "provider-main", toolName: "read", description: "Read a file" },
      ],
    });
    assert.deepEqual(await h.manager.listServerTools("11"), [
      { name: "search", title: "First", isDisabled: true },
      { name: "read", description: "Read a file", isDisabled: false },
    ]);
    assert.equal(h.toolsCalls, 1);
    await assert.rejects(() => h.manager.listServerTools("99"), /MCP server not found/);
  });

  it("toggles one server's tool list without dropping other server settings", async () => {
    const server = displayServer("11", "Remote", "provider-main");
    const h = fixture({
      servers: [server],
      disabled: { "11": ["search", "search"], "22": ["other"], unknown: ["keep"] },
      tools: [{ providerIdentifier: "provider-main", toolName: "search" }],
    });
    const afterEnable = await h.manager.toggleMcpToolDisabled({ serverId: "11", toolName: "search" });
    assert.deepEqual(h.disabledWrites[0], { "11": [], "22": ["other"], unknown: ["keep"] });
    assert.deepEqual(afterEnable, [{ name: "search", isDisabled: false }]);

    await h.manager.toggleMcpToolDisabled({ serverId: "11", toolName: "search" });
    assert.deepEqual(h.disabledWrites[1], { "11": ["search"], "22": ["other"], unknown: ["keep"] });
  });

  it("requires a non-empty tool name and an existing server before changing toggles", async () => {
    const h = fixture({ servers: [displayServer("11", "Remote", "remote")] });
    await assert.rejects(() => h.manager.toggleMcpToolDisabled({ serverId: "11", toolName: "" }), /tool name is required/);
    await assert.rejects(() => h.manager.toggleMcpToolDisabled({ serverId: "99", toolName: "x" }), /MCP server not found/);
    assert.deepEqual(h.disabledWrites, []);
  });

  it("deletes one server's disabled tools without writing when there is nothing to delete", () => {
    const h = fixture({ disabled: { "11": ["a"], "22": ["b"] } });
    h.manager.deleteDisabledToolsForServer("missing");
    assert.deepEqual(h.disabledWrites, []);
    h.manager.deleteDisabledToolsForServer("11");
    assert.deepEqual(h.disabledWrites, [{ "22": ["b"] }]);
  });

  it("maps custom instructions by server and account identifiers over legacy names", () => {
    const first = displayServer("11", "Alpha", "alpha-main", [
      { accountKey: "one", hasToken: true, serverIdentifier: "alpha-account" },
    ]);
    const second = displayServer("22", "Beta", "beta-main");
    const h = fixture({
      servers: [first, second],
      legacy: { Alpha: "legacy alpha", Beta: "legacy beta", Unlisted: "keep" },
      byId: { "11": "   ", "22": "id beta" },
    });
    assert.deepEqual([...h.manager.getMcpCustomInstructions()], [
      ["Alpha", "legacy alpha"],
      ["Beta", "legacy beta"],
      ["Unlisted", "keep"],
      ["alpha-main", ""],
      ["alpha-account", ""],
      ["beta-main", "id beta"],
    ]);
  });

  it("returns legacy custom instructions unchanged when there is no account display config", () => {
    const h = fixture({ legacy: { one: "text", blank: "" } });
    h.setDisplayConfig(null);
    assert.deepEqual([...h.manager.getMcpCustomInstructions()], [["one", "text"], ["blank", ""]]);
  });
});
