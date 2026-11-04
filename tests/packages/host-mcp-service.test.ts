/**
 * The host's MCP service: the shapes it hands the host's ports, what each management call writes and who it tells, the
 * tools the model is given, and the box listing with the follow-ups it schedules.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createHostMcp, McpHostService, toPluginSummary } from "../../source/host/mcp/mcp-service.ts";
import { toAuthResult, toCatalogFields, toInstalledServer, toInstalledServers } from "../../source/adapters/interop/mcp/host-service-adapter.ts";
import type { CatalogPlugin, EffectivePlugin, McpServerSummary } from "../../source/host/mcp/mcp-service-contracts.ts";
import type { BoxMcpExecPort } from "../../source/adapters/interop/agent/box-mcp-exec-adapter.ts";
import type { SlateMcpAccountDisplay, SlateMcpDisplayRow } from "../../source/shared/node/mcp/mcp-display-runtime.ts";
import type { McpManagerSettingsPort } from "../../source/shared/node/mcp/mcp-manager.ts";
import { SlateMcpExecutor } from "../../source/shared/node/mcp/tools-discovery.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const url = (name: string) => `https://${name}.invalid/mcp`;
const httpRow = (id: string, name: string, extra: Partial<SlateMcpDisplayRow> = {}): SlateMcpDisplayRow => ({ id, name, serverIdentifier: name, config: { url: url(name) }, isTeamServer: false, ...extra });
const stdioRow = (id: string, name: string, extra: Partial<SlateMcpDisplayRow> = {}): SlateMcpDisplayRow => ({ id, name, serverIdentifier: name, config: { command: `run-${name}` }, isTeamServer: false, ...extra });
const summary = (extra: Partial<McpServerSummary> = {}): McpServerSummary => ({ id: "11", name: "remote", serverIdentifier: "remote", accountKey: "default", isTeamServer: false, status: "connected", transport: "http", toolCount: 2, customInstructions: "", ...extra });

/** A settings store that answers what it was given, and nothing else. */
function settingsSpy(seed: { disabled?: Record<string, string[]> } = {}): McpManagerSettingsPort {
  let disabled = { ...(seed.disabled ?? {}) };
  return {
    scopeToAccount: () => {},
    migrateMcpCustomInstructionToServerId: () => {},
    getMcpCustomInstructions: () => ({}),
    getMcpCustomInstructionsByServerId: () => ({}),
    getMcpDisabledToolsByServerId: () => disabled,
    setMcpDisabledToolsByServerId: (value) => void (disabled = { ...value }),
    getRawMcpCustomInstruction: () => undefined,
    getRawMcpCustomInstructionByServerId: () => undefined,
    setMcpCustomInstructionByServerId: () => {},
    deleteMcpCustomInstructionByServerId: () => {},
  };
}

function hostWorld(options: { rows?: SlateMcpDisplayRow[]; effectivePlugins?: EffectivePlugin[] | Error; writerConfig?: Record<string, unknown>; boxRows?: Array<{ serverIdentifier: string; status: string; statusDetail?: string; toolCount: number; tools: Array<{ name: string; providerIdentifier: string; toolName: string; clientKey: string }> }>; settings?: McpManagerSettingsPort } = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  let mutated = 0;
  // The account's own state: what it shows is what its configuration still holds.
  let rows = [...(options.rows ?? [httpRow("11", "remote")])];
  let configReads = 0;
  const display: SlateMcpAccountDisplay = { get servers() { return rows; } };
  const backendTools: Array<Array<{ accountLabel: string; serverIdentifier: string; rowServerIdentifier: string; status?: string; tools: Array<{ name: string; providerIdentifier: string; toolName: string; description?: string }> }>> = [];
  const exec = {
    listTools: async (identifiers: readonly string[]) => {
      calls.push(`listTools:${identifiers.join(",")}`);
      return backendTools.shift() ?? [];
    },
    checkAuthStatus: async (args: { serverId: number }) => {
      calls.push(`checkAuthStatus:${args.serverId}`);
      return { hasValidToken: false, isAvailable: true, requiresAuth: true, authUrl: "https://auth.invalid/start" };
    },
    logoutAccount: async () => void calls.push("logoutAccount"),
    renameAccount: async (args: { serverId: number }) => void calls.push(`renameAccount:${args.serverId}`),
    deleteAccount: async (args: { serverId: number }) => void calls.push(`deleteAccount:${args.serverId}`),
  };
  const written: Array<{ config: unknown; ids: unknown }> = [];
  const writer = {
    getConfigForEdit: async () => ({ config: { mcpServers: options.writerConfig ?? {} }, serverIdsByName: { remote: "11" } }),
    setConfig: async (config: unknown, ids: unknown) => {
      written.push({ config, ids });
      calls.push(`setConfig:${JSON.stringify(config)}`);
      // The account keeps only the servers its configuration still names.
      const configured = Object.keys((config as { mcpServers: Record<string, unknown> }).mcpServers);
      rows = rows.filter((row) => configured.includes(row.serverIdentifier ?? ""));
    },
    installPlugin: async (args: { pluginId: bigint }) => void calls.push(`installPlugin:${args.pluginId}`),
    updatePluginInstall: async (args: { pluginId: bigint }) => void calls.push(`updatePluginInstall:${args.pluginId}`),
    uninstallPlugin: async (args: { pluginId: string }) => void calls.push(`uninstallPlugin:${args.pluginId}`),
  };
  const boxRows = [...(options.boxRows ?? [])];
  const pushedConfigs: string[] = [];
  const boxExec: BoxMcpExecPort = {
    loadServers: async (configJson: string) => {
      pushedConfigs.push(configJson);
      calls.push(`loadServers:${configJson.length}`);
    },
    listTools: async (identifiers) => {
      calls.push(`boxListTools:${identifiers.join(",")}`);
      // The box answers about the servers it has, however often it is asked.
      return identifiers.flatMap((identifier) => boxRows.filter((row) => row.serverIdentifier === identifier));
    },
    executeTool: async () => {
      throw new Error("the box was not asked to run anything");
    },
  };
  const skills: { syncs: string[]; removed: string[][]; failSync?: boolean } = { syncs: [], removed: [] };
  const configuredPlugins = options.effectivePlugins;
  const host = createHostMcp({
    accountDisplayConfigProvider: async () => display,
    accountConfigProvider: async () => {
      configReads += 1;
      return { mcpServers: Object.fromEntries(rows.flatMap((row) => (row.serverIdentifier == null ? [] : [[row.serverIdentifier, row.config]]))) };
    },
    accountMcpWriter: writer,
    backendMcpExec: exec,
    settingsStore: options.settings ?? settingsSpy(),
    boxMcpExec: boxExec,
    effectivePluginsProvider:
      configuredPlugins instanceof Error
        ? async () => {
            throw configuredPlugins;
          }
        : async () => configuredPlugins ?? [],
    getMachineId: async () => "machine-1",
    getAccessToken: async () => "token",
    pluginSkills: {
      sync: async (trigger: string) => {
        skills.syncs.push(trigger);
        if (skills.failSync === true) throw new Error("the skills sync failed");
        return [];
      },
      status: () => ({ authBlocked: [] }),
      removeLiveReferences: (urls: readonly string[]) => void skills.removed.push([...urls]),
    },
    onServersMutated: () => void (mutated += 1),
    log: (message: string) => void logs.push(message),
  });
  return { host, calls, logs, written, skills, backendTools, boxRows, pushedConfigs, get configReads() { return configReads; }, get mutated() { return mutated; } };
}

describe("the shapes the host's ports are handed", () => {
  it("turns a server into what the UI shows, saying only what was said", () => {
    assert.deepEqual(toInstalledServer(summary()), {
      id: "11", name: "remote", serverIdentifier: "remote", accountKey: "default", isTeamServer: false, status: "connected", transport: "http", toolCount: 2, customInstructions: "",
    });
    assert.deepEqual(toInstalledServer(summary({ pluginId: "77", statusDetail: "waiting", disabledToolCount: 3 })), {
      id: "11", name: "remote", serverIdentifier: "remote", accountKey: "default", pluginId: "77", isTeamServer: false, status: "connected", statusDetail: "waiting", transport: "http", toolCount: 2, disabledToolCount: 3, customInstructions: "",
    });
    assert.deepEqual(toInstalledServers({ servers: [summary(), summary({ id: "12", name: "other" })] }).map((server) => server["id"]), ["11", "12"]);
  });

  it("answers a plugin's fields with the two switches a form needs", () => {
    assert.deepEqual(toCatalogFields(undefined), []);
    assert.deepEqual(toCatalogFields(null), []);
    assert.deepEqual(toCatalogFields([{ key: "k", label: "L", hint: "h" }, { key: "s", label: "S", hint: "h", isSecret: true }, { key: "r", label: "R", hint: "h", isRequired: true }]), [
      { key: "k", label: "L", hint: "h", isRequired: false, isSecret: false },
      { key: "s", label: "S", hint: "h", isRequired: false, isSecret: true },
      { key: "r", label: "R", hint: "h", isRequired: true, isSecret: false },
    ]);
  });

  it("names what a sign-in attempt answered", () => {
    assert.deepEqual(toAuthResult({ status: "started", serverName: "remote", authorizationUrl: "https://auth.invalid/start" }), { kind: "started", authorizationUrl: "https://auth.invalid/start", serverName: "remote" });
    assert.deepEqual(toAuthResult({ status: "already-authenticated", serverName: "remote" }), { kind: "already-authenticated", serverName: "remote" });
    assert.deepEqual(toAuthResult({ status: "not-configured", serverName: "remote" }), { kind: "not-configured", serverName: "remote" });
    assert.deepEqual(toAuthResult({ status: "not-supported", serverName: "remote", message: "no sign-in link" }), { kind: "not-supported", message: "no sign-in link", serverName: "remote" });
  });

  it("says whether a plugin is installed from the account's own list or from its rows", () => {
    const view: CatalogPlugin = { id: "77", name: "mine", displayName: "Mine", description: "d", category: "c", connectors: [{}, {}], skills: [{ name: "s1", description: "d1", sourceUrl: "https://skills.invalid/s1" }] };
    // The list says it is installed, and what it says about the mode is carried.
    assert.deepEqual(toPluginSummary(view, [{ pluginId: "77", isEnabled: true, installMode: "user" }], []), {
      pluginId: "77", name: "mine", displayName: "Mine", description: "d", category: "c", isInstalled: true, installMode: "user", connectorCount: 2, skills: [{ name: "s1", description: "d1" }],
    });
    // The list says the plugin exists but is not installed, so a row that belongs to it does not make it installed.
    assert.deepEqual(toPluginSummary(view, [{ pluginId: "77", isEnabled: false, installMode: "user" }], [summary({ pluginId: "77" })]), {
      pluginId: "77", name: "mine", displayName: "Mine", description: "d", category: "c", isInstalled: false, connectorCount: 2, skills: [{ name: "s1", description: "d1" }],
    });
    // The list said nothing about it at all, and a row of the account's belongs to it.
    assert.deepEqual(toPluginSummary(view, [], [summary({ pluginId: "77" })]), {
      pluginId: "77", name: "mine", displayName: "Mine", description: "d", category: "c", isInstalled: true, installMode: "unknown", connectorCount: 2, skills: [{ name: "s1", description: "d1" }],
    });
    // A list that could not be read leaves the rows to speak, and a catalog with nothing said about its connectors is one.
    assert.deepEqual(toPluginSummary({ id: "77", name: "mine" }, null, []), { pluginId: "77", name: "mine", displayName: undefined, description: undefined, category: undefined, isInstalled: false, connectorCount: 1, skills: [] });
  });
});

describe("what the host's own port does", () => {
  it("lists what the account shows, and hands every change to the host once", async () => {
    const world = hostWorld({ rows: [httpRow("11", "remote"), stdioRow("12", "local")], settings: settingsSpy({ disabled: { "11": ["search"] } }), writerConfig: { remote: { url: url("remote") }, local: { command: "run-local" } } });
    world.backendTools.push([{ accountLabel: "default", serverIdentifier: "remote", rowServerIdentifier: "remote", status: "connected", tools: [{ name: "search", providerIdentifier: "remote", toolName: "search" }, { name: "fetch", providerIdentifier: "remote", toolName: "fetch" }] }]);
    assert.deepEqual((await world.host.management.listInstalled()).map((server) => [server["id"], server["name"], server["pluginId"], server["toolCount"], server["disabledToolCount"]]), [["11", "remote", undefined, 1, 1], ["12", "local", undefined, 0, undefined]]);
    // Adding, removing and restarting all write through the account and tell the host exactly once.
    const added = await world.host.management.add({ name: "mine", configJson: JSON.stringify({ url: url("mine") }) });
    assert.deepEqual([world.written.length, world.mutated, added.length >= 1], [1, 1, true]);
    assert.deepEqual(world.written[0]!.config, { mcpServers: { remote: { url: url("remote") }, local: { command: "run-local" }, mine: { url: url("mine") } } });
    // Instructions are set through the manager, which lists again.
    assert.deepEqual((await world.host.management.setInstructions({ serverId: "11", instructions: "be careful" })).length, 2);
    assert.equal(world.mutated, 2);
    // Removing the server takes it out of the account, and the listing after that no longer shows it.
    const removed = await world.host.management.removeServer("11");
    assert.deepEqual([world.written.length, world.mutated, removed.removed, removed.reason, removed.servers.map((server) => [server["name"], server["rowServerIdentifier"]])], [2, 3, true, undefined, [["local", undefined]]]);
    await world.host.management.restart();
    assert.equal(world.mutated, 4);
    await world.host.dispose();
  });

  it("tells the host a sign-in started, and says nothing when there is nothing to sign in to", async () => {
    const world = hostWorld();
    assert.deepEqual(await world.host.management.authenticate("11", "default", "agent-1"), { kind: "started", authorizationUrl: "https://auth.invalid/start", serverName: "remote" });
    // The connector's id goes to the wire as the decimal string it is.
    assert.deepEqual([world.mutated, world.calls.filter((call) => call.startsWith("checkAuthStatus"))], [1, ["checkAuthStatus:11"]]);
    // A server the account does not have is not a change to anything.
    assert.deepEqual(await world.host.management.authenticate("99", "default"), { kind: "not-configured", serverName: "99" });
    assert.equal(world.mutated, 1);
    await world.host.dispose();
  });

  it("uninstalls a plugin through the account, and only tells the skills when the install record cleared", async () => {
    const world = hostWorld({ effectivePlugins: [{ pluginId: "77", isEnabled: false }] });
    // The catalog cannot be read here, so there are no source urls to retire — the uninstall still goes through.
    assert.deepEqual(await world.host.management.uninstallPlugin("77"), { removed: true });
    assert.deepEqual([world.calls.filter((call) => call.startsWith("uninstallPlugin")), world.skills.removed, world.skills.syncs, world.mutated], [["uninstallPlugin:77"], [[]], ["uninstall"], 1]);
    // A plugin the account still has installed is not a cleared install record.
    const kept = hostWorld({ effectivePlugins: [{ pluginId: "77", isEnabled: true }] });
    assert.deepEqual(await kept.host.management.uninstallPlugin("77"), { removed: false, reason: "still-present" });
    assert.deepEqual([kept.skills.removed, kept.skills.syncs], [[], []]);
    await world.host.dispose();
    await kept.host.dispose();
  });

  it("does not let a skills sync that failed reach the caller", async () => {
    const world = hostWorld({ effectivePlugins: [{ pluginId: "77", isEnabled: false }] });
    world.skills.failSync = true;
    assert.deepEqual(await world.host.management.uninstallPlugin("77"), { removed: true });
    await tick();
    assert.deepEqual(world.skills.syncs, ["uninstall"]);
    // An install needs the marketplace, and a marketplace this host cannot reach is the caller's to hear.
    await assert.rejects(() => world.host.management.install({ id: "77" }));
    await world.host.dispose();
  });

  it("hands the model the account's tools first, and the discovered ones after", async () => {
    const world = hostWorld({ rows: [httpRow("11", "remote")], settings: settingsSpy({ disabled: { "11": ["only-discovered"] } }) });
    world.backendTools.push(
      [{ accountLabel: "default", serverIdentifier: "remote", rowServerIdentifier: "remote", status: "connected", tools: [{ name: "shared", providerIdentifier: "remote", toolName: "shared", description: "connected" }, { name: "only-connected", providerIdentifier: "remote", toolName: "only-connected" }] }],
      [{ accountLabel: "default", serverIdentifier: "remote", rowServerIdentifier: "remote", status: "connected", tools: [{ name: "shared", providerIdentifier: "remote", toolName: "shared", description: "discovered" }, { name: "only-discovered", providerIdentifier: "remote", toolName: "only-discovered" }] }],
    );
    // The tools a turn starts with are the ones already resolved: nothing is discovered for the first turn.
    assert.deepEqual(await world.host.mcp.getTools({}), []);
    const tools = (await world.host.mcp.listTools({})) as Array<{ name: string; description?: string }>;
    // A name the account's own listing already knows keeps that listing's tool, and a tool this account switched off
    // is not discovered either.
    assert.deepEqual(tools.map((tool) => [tool.name, tool.description]), [["shared", "connected"], ["only-connected", undefined]]);
    // The transport of a server comes from the discovery, and the executor and the state executor are the host's own.
    assert.equal(await world.host.mcp.resolveToolTransport("remote"), "http");
    assert.equal(world.host.mcp.createExecutor() instanceof SlateMcpExecutor, true);
    const state = await world.host.mcp.createStateExecutor().execute({});
    assert.deepEqual([state.result.case, state.result.case === "success" ? state.result.value.servers.length : -1], ["success", 1]);
    assert.deepEqual([...world.host.mcp.getCustomInstructions()], [["remote", ""]]);
    await world.host.dispose();
  });

  it("renames and removes an account through the backend, with the connector's id as the wire takes it", async () => {
    const world = hostWorld({ rows: [httpRow("11", "remote")], writerConfig: { remote: { url: url("remote") } } });
    await world.host.management.renameAccount({ serverId: "11", accountKey: "default", newAccountKey: "work" });
    await world.host.management.removeAccount({ serverId: "11", accountKey: "default" });
    assert.deepEqual(world.calls.filter((call) => call.startsWith("renameAccount") || call.startsWith("deleteAccount")), ["renameAccount:11", "deleteAccount:11"]);
    assert.equal(world.mutated, 2);
    await world.host.dispose();
  });

  it("answers which slot needs a sign-in, and refreshes the account's configuration in the background", async () => {
    const world = hostWorld({ rows: [httpRow("11", "remote", { accounts: [{ accountKey: "work", hasToken: false }] }), httpRow("12", "plain")] });
    world.backendTools.push([{ accountLabel: "work", serverIdentifier: "remote-work", rowServerIdentifier: "remote", status: "connected", tools: [] }, { accountLabel: "default", serverIdentifier: "plain", rowServerIdentifier: "plain", status: "connected", tools: [] }]);
    assert.deepEqual(await world.host.mcp.resolveNeedsAuthSlot("remote-work"), { serverId: "11", serverName: "remote" });
    // A connector that is connected needs no sign-in, and neither does an identifier nobody has.
    assert.equal(await world.host.mcp.resolveNeedsAuthSlot("plain"), null);
    assert.equal(await world.host.mcp.resolveNeedsAuthSlot("nobody"), null);
    // A refresh re-reads the account's configuration without waiting for it.
    const reads = world.configReads;
    world.host.mcp.refreshAccountConfig();
    await tick();
    assert.equal(world.configReads > reads, true);
    await world.host.dispose();
  });

  it("lists the computer's own servers through the box, and swaps the box exec when the host has a new one", async () => {
    const world = hostWorld({ rows: [stdioRow("12", "local")], boxRows: [{ serverIdentifier: "local", status: "connected", toolCount: 2, tools: [] }] });
    assert.deepEqual(await world.host.listBoxServers(["local"]), [{ serverIdentifier: "local", status: "connected", toolCount: 2, tools: [] }]);
    assert.deepEqual(world.calls.filter((call) => call.startsWith("boxListTools")), ["boxListTools:local"]);
    // What the box was told to run is the account's own stdio servers, with nothing the platform keeps for itself.
    const pushed = world.calls.find((call) => call.startsWith("loadServers"));
    assert.deepEqual([pushed != null, world.pushedConfigs[0]!.includes("local"), world.pushedConfigs[0]!.includes("slate-box-computer")], [true, true, false]);
    // The listing asks the box about them, so their status is the box's.
    assert.deepEqual((await world.host.management.listInstalled()).map((server) => [server["name"], server["status"]]), [["local", "connected"]]);
    // A host that hands over another box exec is the one that answers from then on.
    const swapped: string[] = [];
    world.host.setBoxMcpExec({ loadServers: async () => {}, listTools: async (ids: readonly string[]) => (swapped.push(ids.join(",")), []), executeTool: async () => { throw new Error("not asked"); } });
    assert.deepEqual(await world.host.listBoxServers(["local"]), []);
    assert.deepEqual(swapped, ["local"]);
    await world.host.dispose();
  });

  it("counts a server's tools with the store the host hands over later", async () => {
    const world = hostWorld({ rows: [httpRow("11", "remote")], settings: settingsSpy({ disabled: { "11": ["search"] } }) });
    world.backendTools.push([{ accountLabel: "default", serverIdentifier: "remote", rowServerIdentifier: "remote", status: "connected", tools: [{ name: "search", providerIdentifier: "remote", toolName: "search" }, { name: "fetch", providerIdentifier: "remote", toolName: "fetch" }] }]);
    assert.deepEqual((await world.host.management.listInstalled()).map((server) => [server["toolCount"], server["disabledToolCount"]]), [[1, 1]]);
    // The store handed over later is the one the next listing counts with.
    world.host.setSettingsStore(settingsSpy({ disabled: { "11": ["search", "fetch"] } }));
    world.backendTools.push([{ accountLabel: "default", serverIdentifier: "remote", rowServerIdentifier: "remote", status: "connected", tools: [{ name: "search", providerIdentifier: "remote", toolName: "search" }, { name: "fetch", providerIdentifier: "remote", toolName: "fetch" }] }]);
    assert.deepEqual((await world.host.management.listInstalled()).map((server) => [server["toolCount"], server["disabledToolCount"]]), [[0, 2]]);
    await world.host.dispose();
  });
});

describe("the host's MCP service", () => {
  function serviceWorld(options: { boxRows?: Array<{ serverIdentifier: string; status: string; statusDetail?: string; toolCount: number; tools: never[] }>; pluginSkills?: boolean } = {}) {
    const logs: string[] = [];
    const authCompletion: unknown[] = [];
    const services: { syncs: string[] } = { syncs: [] };
    const service = new McpHostService({
      auth: { getAccessToken: async () => "token", getMachineId: async () => "machine-1" },
      foreverBox: { box: {} as never },
      settings: settingsSpy(),
      log: (message: string) => void logs.push(message),
      ...(options.pluginSkills === true
        ? { pluginSkills: { sync: async (trigger: string) => (services.syncs.push(trigger), []), status: () => ({ authBlocked: ["x"] }), removeLiveReferences: () => {} } }
        : {}),
    });
    return { service, logs, authCompletion, services };
  }

  it("gives the host its two surfaces, its two subscriptions and its plugin-skill calls", async () => {
    const world = serviceWorld({ pluginSkills: true });
    assert.equal(typeof world.service.api.mcp.listTools, "function");
    assert.equal(typeof world.service.api.management.listInstalled, "function");
    const first = (event: unknown) => void world.authCompletion.push(event);
    const second = (event: unknown) => void world.authCompletion.push(["second", event]);
    const offFirst = world.service.api.subscribeToAuthCompletion(first);
    world.service.api.subscribeToAuthCompletion(second);
    world.service.emitAuthCompletion({ phase: "flow_started" });
    assert.deepEqual(world.authCompletion, [{ phase: "flow_started" }, ["second", { phase: "flow_started" }]]);
    assert.equal(offFirst(), true);
    world.service.emitAuthCompletion({ phase: "token_stored" });
    assert.deepEqual(world.authCompletion.length, 3);
    // A server update reaches its own listeners only.
    const updates: unknown[] = [];
    const offUpdates = world.service.api.subscribeToServersUpdated((event) => void updates.push(event));
    world.service.emitServersUpdated({ servers: [{ id: "11" }] });
    assert.deepEqual(updates, [{ servers: [{ id: "11" }] }]);
    assert.equal(offUpdates(), true);
    // The plugin skills are the host's own calls, and its status is answered as it is.
    assert.deepEqual(await world.service.api.syncPluginSkills(), []);
    assert.deepEqual([world.services.syncs, world.service.api.pluginSyncStatus()], [["desktop"], { authBlocked: ["x"] }]);
    await world.service.dispose();
  });

  it("answers a host that has no plugin skills at all", async () => {
    const world = serviceWorld();
    assert.deepEqual(await world.service.api.syncPluginSkills(), []);
    assert.deepEqual(world.service.api.pluginSyncStatus(), { authBlocked: [] });
    await world.service.dispose();
  });

  it("asks about a box server that is still starting, once, and says what changed", async () => {
    const world = serviceWorld();
    const updates: { servers: unknown[] }[] = [];
    world.service.api.subscribeToServersUpdated((event) => void updates.push(event));
    // The host's own MCP port answers the box listing; the service asks again for the ones that are not settled.
    const asked: string[][] = [];
    let askedTimes = 0;
    (world.service as unknown as { hostMcp: { listBoxServers: (ids: readonly string[], options?: { kickOnly?: boolean }) => Promise<Array<{ serverIdentifier: string; status: string; statusDetail?: string; toolCount: number }>> } }).hostMcp = {
      ...world.service.hostMcp,
      listBoxServers: async (ids) => {
        asked.push([...ids]);
        askedTimes += 1;
        // The server that was still starting has settled by the time it is asked about again.
        return ids.map((id) => (id === "starting" && askedTimes === 1 ? { serverIdentifier: id, status: "loading", toolCount: 0 } : id === "starting" ? { serverIdentifier: id, status: "connected", statusDetail: "started", toolCount: 4 } : { serverIdentifier: id, status: "connected", toolCount: 3 }));
      },
    };
    assert.deepEqual(await world.service.listBoxServers(["starting", "ready", "starting"]), [
      { serverIdentifier: "starting", status: "loading", toolCount: 0 },
      { serverIdentifier: "ready", status: "connected", toolCount: 3 },
      { serverIdentifier: "starting", status: "loading", toolCount: 0 },
    ]);
    // Only the unsettled server is followed up — once, however often it was listed — and what came back is handed on.
    assert.deepEqual(asked, [["starting", "ready", "starting"], ["starting"]]);
    assert.deepEqual(updates, [{ servers: [{ serverIdentifier: "starting", status: "connected", statusDetail: "started", toolCount: 4 }] }]);
    assert.equal(world.service.statusFollowUps.size, 0);
    // A server that is already settled is not asked about again.
    await world.service.listBoxServers(["ready"]);
    assert.deepEqual(asked.slice(2), [["ready"]]);
    await world.service.dispose();
  });

  it("lets go of a follow-up still in flight when it goes down", async () => {
    const world = serviceWorld();
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let asked = 0;
    (world.service as unknown as { hostMcp: { listBoxServers: (ids: readonly string[]) => Promise<Array<{ serverIdentifier: string; status: string; toolCount: number }>> } }).hostMcp = {
      ...world.service.hostMcp,
      listBoxServers: async (ids: readonly string[]) => {
        asked += 1;
        if (asked > 1) await held;
        return ids.map((id) => ({ serverIdentifier: id, status: "loading", toolCount: 0 }));
      },
    };
    const updates: unknown[] = [];
    world.service.api.subscribeToServersUpdated((event) => void updates.push(event));
    await world.service.listBoxServers(["starting"]);
    assert.equal(world.service.statusFollowUps.size, 1);
    await world.service.dispose();
    // The follow-up that comes back after that neither reaches the host nor says anything, even when it failed.
    assert.equal(world.service.statusFollowUps.size, 0);
    release!();
    await tick();
    assert.deepEqual([updates, world.logs], [[], []]);
    // The same follow-up failing after the service went down is silent as well.
    const failing = serviceWorld();
    let failRelease: (() => void) | undefined;
    const heldFail = new Promise<void>((resolve) => (failRelease = resolve));
    let askedAgain = 0;
    (failing.service as unknown as { hostMcp: { listBoxServers: (ids: readonly string[]) => Promise<Array<{ serverIdentifier: string; status: string; toolCount: number }>> } }).hostMcp = {
      ...failing.service.hostMcp,
      listBoxServers: async (ids: readonly string[]) => {
        askedAgain += 1;
        if (askedAgain > 1) {
          await heldFail;
          throw new Error("the box did not answer");
        }
        return ids.map((id) => ({ serverIdentifier: id, status: "loading", toolCount: 0 }));
      },
    };
    await failing.service.listBoxServers(["starting"]);
    await failing.service.dispose();
    failRelease!();
    await tick();
    assert.deepEqual(failing.logs, []);
  });

  it("says a follow-up failed, and stops saying anything once the service is down", async () => {
    const world = serviceWorld();
    let followUp = false;
    (world.service as unknown as { hostMcp: { listBoxServers: (ids: readonly string[]) => Promise<Array<{ serverIdentifier: string; status: string; toolCount: number }>> } }).hostMcp = {
      ...world.service.hostMcp,
      listBoxServers: async (ids: readonly string[]) => {
        if (followUp) throw new Error("the box did not answer");
        followUp = true;
        return [{ serverIdentifier: ids[0]!, status: "error", toolCount: 0 }];
      },
    };
    const updates: unknown[] = [];
    world.service.api.subscribeToServersUpdated((event) => void updates.push(event));
    await world.service.listBoxServers(["broken"]);
    assert.deepEqual(world.logs, ["[slate:mcp] box MCP status follow-up failed for broken: the box did not answer"]);
    assert.deepEqual(updates, []);
    // Once the service is down, a listing neither follows anything up nor reaches a listener.
    await world.service.dispose();
    followUp = false;
    assert.deepEqual(await world.service.listBoxServers(["broken"]), [{ serverIdentifier: "broken", status: "error", toolCount: 0 }]);
    assert.equal(world.service.statusFollowUps.size, 0);
    world.service.emitAuthCompletion({ phase: "flow_started" });
    world.service.emitServersUpdated({ servers: [] });
    assert.deepEqual(updates, []);
    // Taking it down twice is not taking it down again.
    await world.service.dispose();
  });
});
