/**
 * The manager over every MCP server this host knows: how a listing is built out of the account's display, what the
 * account's scope change does, what adding and removing a server writes, how a plugin's uninstall is guarded, and what
 * the display lookups answer fresh or from the last read.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BUILTIN_MCP_SERVER_NAMES } from "../../source/shared/node/mcp/builtin-mcp.ts";
import { SlateMcpConfigError } from "../../source/shared/node/mcp/mcp-config-error.ts";
import { SlateMcpDefinitionSource } from "../../source/shared/node/mcp/mcp-definition-source.ts";
import { pinMcpDiagnosticsReporter, type McpDiagnostic } from "../../source/shared/node/mcp/mcp-diagnostics.ts";
import type { AccountDisplayConfig, DisplayServer, McpServerConfig } from "../../source/shared/node/mcp/mcp-display-runtime.ts";
import { SlateMcpManager, type EffectivePluginRow, type McpManagerSettingsPort } from "../../source/shared/node/mcp/mcp-manager.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const url = (name: string) => `https://${name}.invalid/mcp`;
const httpRow = (id: string, name: string, extra: Partial<DisplayServer> = {}): DisplayServer => ({ id, name, serverIdentifier: name, config: { url: url(name) }, isTeamServer: false, ...extra });
const stdioRow = (id: string, name: string, extra: Partial<DisplayServer> = {}): DisplayServer => ({ id, name, serverIdentifier: name, config: { command: `run-${name}` }, isTeamServer: false, ...extra });
const display = (servers: DisplayServer[], extra: Partial<AccountDisplayConfig> = {}): AccountDisplayConfig => ({ servers, ...extra });

/** The settings store, answering what the test put in it and writing down every call. */
function settingsSpy(seed: { instructions?: Record<string, string>; instructionsById?: Record<string, string>; disabled?: Record<string, string[]> } = {}) {
  const calls: string[] = [];
  const state = {
    instructions: { ...(seed.instructions ?? {}) },
    instructionsById: { ...(seed.instructionsById ?? {}) },
    disabled: { ...(seed.disabled ?? {}) },
  };
  const store: McpManagerSettingsPort = {
    scopeToAccount: (scope: string) => void calls.push(`scopeToAccount:${scope}`),
    migrateMcpCustomInstructionToServerId: (args) => void calls.push(`migrate:${args.serverId}:${args.displayName}`),
    getMcpCustomInstructions: () => state.instructions,
    getMcpCustomInstructionsByServerId: () => state.instructionsById,
    getMcpDisabledToolsByServerId: () => state.disabled,
    setMcpDisabledToolsByServerId: (value) => {
      state.disabled = { ...value };
      calls.push(`setDisabled:${JSON.stringify(value)}`);
    },
    getRawMcpCustomInstruction: (name) => state.instructions[name],
    getRawMcpCustomInstructionByServerId: (id) => state.instructionsById[id],
    setMcpCustomInstructionByServerId: (args) => {
      state.instructionsById[args.serverId] = args.value;
      calls.push(`setInstruction:${args.serverId}:${args.value}:${args.mirrorLegacyName}`);
    },
    deleteMcpCustomInstructionByServerId: (args) => {
      delete state.instructionsById[args.serverId];
      calls.push(`deleteInstruction:${args.serverId}:${args.displayName}:${args.deleteLegacyName}`);
    },
  };
  return { store, calls, state };
}

/** The box runtime the manager lists the computer's own servers through. */
function boxRuntimeSpy(options: { wired?: boolean; servers?: Array<{ serverIdentifier: string; status?: string; statusDetail?: string; toolCount: number; tools: Array<{ toolName: string }> }>; throwOnList?: boolean; tools?: Array<{ providerIdentifier: string; toolName: string }> } = {}) {
  const calls: string[] = [];
  return {
    runtime: {
      isBoxExecWired: () => options.wired === true,
      listBoxServers: async (identifiers: readonly string[]) => {
        calls.push(`listBoxServers:${identifiers.join(",")}`);
        if (options.throwOnList === true) throw new Error("the computer did not answer");
        return options.servers ?? [];
      },
      invalidateToolsCache: () => void calls.push("invalidateToolsCache"),
      resetPushState: () => void calls.push("resetPushState"),
      getToolsRaw: async () => options.tools ?? [],
    },
    calls,
  };
}

/** The backend's own MCP side: what it lists, and what it says about a connector's sign-in. */
function backendExecSpy(options: { entries?: Array<{ accountLabel: string; serverIdentifier: string; rowServerIdentifier: string; status?: string; tools: Array<{ toolName: string }> }>; authStatus?: Record<string, unknown>; throwOnTools?: boolean } = {}) {
  const calls: string[] = [];
  return {
    exec: {
      listTools: async (identifiers: readonly string[]) => {
        calls.push(`listTools:${identifiers.join(",")}`);
        if (options.throwOnTools === true) throw new Error("the backend did not answer");
        return options.entries ?? [];
      },
      checkAuthStatus: async () => {
        calls.push("checkAuthStatus");
        return options.authStatus ?? { hasValidToken: false, isAvailable: true, requiresAuth: false };
      },
      logoutAccount: async () => void calls.push("logoutAccount"),
      renameAccount: async () => void calls.push("renameAccount"),
      deleteAccount: async () => void calls.push("deleteAccount"),
    },
    calls,
  };
}

/** The account writer the manager adds and removes servers through. */
function writerSpy(options: { config?: Record<string, McpServerConfig>; ids?: Record<string, string> } = {}) {
  const calls: string[] = [];
  const written: Array<{ config: unknown; ids: unknown }> = [];
  return {
    writer: {
      getConfigForEdit: async () => ({ config: { mcpServers: options.config ?? {} }, serverIdsByName: options.ids ?? {} }),
      setConfig: async (config: unknown, ids: unknown) => {
        written.push({ config, ids });
        calls.push(`setConfig:${JSON.stringify(config)}:${JSON.stringify(ids)}`);
      },
      uninstallPlugin: async (args: { pluginId: bigint }) => void calls.push(`uninstallPlugin:${args.pluginId}`),
    },
    calls,
    written,
  };
}

/**
 * The manager and the world around it. What the host reads is pushed as the test goes: a real host's read always
 * answers with the account's current state, so the last state pushed keeps being the answer.
 */
function managerWorld(options: {
  displays?: boolean;
  accountServers?: boolean;
  accountConfig?: Record<string, McpServerConfig>;
  settings?: ReturnType<typeof settingsSpy>;
  box?: ReturnType<typeof boxRuntimeSpy>;
  backend?: ReturnType<typeof backendExecSpy>;
  writer?: ReturnType<typeof writerSpy>;
  effectivePlugins?: Array<{ pluginId: string; isEnabled: boolean; installMode?: string }> | Error;
  onConnectorAuth?: (event: Record<string, unknown>) => void;
  onAccountScopeApplied?: () => void;
  includeBuiltins?: boolean;
  parseServerConfig?: (value: unknown) => McpServerConfig;
} = {}) {
  const displayQueue: Array<AccountDisplayConfig | null> = [];
  const accountQueue: Array<AccountDisplayConfig | null> = [];
  const readCalls: string[] = [];
  const nextOf = (queue: Array<AccountDisplayConfig | null>, label: string): AccountDisplayConfig | null => {
    readCalls.push(label);
    if (queue.length === 0) return null;
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (next instanceof Error) throw next;
    return next;
  };
  const settings = options.settings ?? settingsSpy();
  const box = options.box ?? boxRuntimeSpy();
  const backend = options.backend ?? backendExecSpy();
  const writer = options.writer ?? writerSpy();
  const configuredPlugins = options.effectivePlugins;
  const effectivePluginsProvider: () => Promise<EffectivePluginRow[]> =
    configuredPlugins instanceof Error
      ? async () => {
          throw configuredPlugins;
        }
      : async () => configuredPlugins ?? [];
  const manager = new SlateMcpManager({
    includeBuiltins: options.includeBuiltins ?? false,
    settingsStore: settings.store,
    boxRuntime: box.runtime,
    backendMcpExec: backend.exec,
    accountMcpWriter: writer.writer,
    effectivePluginsProvider,
    ...(options.accountServers === true ? { accountServersProvider: async () => nextOf(accountQueue, "accountServers") } : {}),
    ...(options.displays === true ? { accountDisplayConfigProvider: async () => nextOf(displayQueue, "display") } : {}),
    ...(options.accountConfig === undefined ? {} : { accountConfigProvider: async () => (readCalls.push("config"), { mcpServers: options.accountConfig ?? {} }) }),
    parseServerConfig: options.parseServerConfig ?? ((value) => value as McpServerConfig),
    getMachineId: async () => "machine-1",
    ...(options.onConnectorAuth === undefined ? {} : { onConnectorAuth: options.onConnectorAuth }),
    ...(options.onAccountScopeApplied === undefined ? {} : { onAccountScopeApplied: options.onAccountScopeApplied }),
  });
  return {
    manager,
    settings,
    box,
    backend,
    writer,
    readCalls,
    // What is pushed becomes the account's state from here on; the last state pushed is the one that keeps answering.
    pushDisplay: (...states: Array<AccountDisplayConfig | null>) => {
      displayQueue.length = 0;
      displayQueue.push(...states);
    },
    pushAccountServers: (...states: Array<AccountDisplayConfig | null>) => {
      accountQueue.length = 0;
      accountQueue.push(...states);
    },
  };
}

describe("the manager's own ports and views", () => {
  it("answers for a host that never wired a settings store, and hands back what it was wired with", async () => {
    const world = managerWorld();
    const bare = new SlateMcpManager({ parseServerConfig: (value) => value as McpServerConfig, getMachineId: async () => "machine-1" });
    // Without a store every read answers emptily and every write is silence.
    assert.deepEqual([...bare.getMcpCustomInstructions()], []);
    assert.doesNotThrow(() => bare.setSettingsStore(world.settings.store));
    assert.equal(bare.settingsStoreView(), world.settings.store);
    assert.equal(bare.backendMcpExecView(), undefined);
    assert.equal(bare.onDiscoveryFailedView(), undefined);
    assert.equal(bare.lastAccountDisplayConfigView(), null);
    assert.equal(bare.definitionSourceView() instanceof SlateMcpDefinitionSource, true);
    // A host with a display but no store still answers, with an empty instruction for every connector.
    const displayed = new SlateMcpManager({
      accountDisplayConfigProvider: async () => display([stdioRow("12", "local")]),
      parseServerConfig: (value) => value as McpServerConfig,
      getMachineId: async () => "machine-1",
    });
    await displayed.listServers();
    assert.deepEqual([...displayed.getMcpCustomInstructions()], [["local", ""]]);
  });

  it("takes the settings store and the box runtime it is handed later", async () => {
    const first = settingsSpy();
    const second = settingsSpy({ instructionsById: { "7": "be careful" } });
    const box = boxRuntimeSpy({ wired: true, servers: [{ serverIdentifier: "local", status: "connected", toolCount: 1, tools: [] }] });
    const world = managerWorld({ settings: first, displays: true });
    world.pushDisplay(display([stdioRow("7", "local")]));
    assert.deepEqual(world.manager.settingsStoreView(), first.store);
    world.manager.setSettingsStore(second.store);
    world.manager.setBoxRuntime(box.runtime);
    const state = await world.manager.listServers();
    // The row is the box's, because the runtime that was handed over is the one that answers.
    assert.deepEqual([world.manager.settingsStoreView(), box.calls[0]], [second.store, "listBoxServers:local"]);
    assert.deepEqual(state.servers.map((server) => [server.id, server.name, server.status, server.customInstructions]), [["7", "local", "connected", "be careful"]]);
  });
});

describe("listing the servers", () => {
  it("builds the listing out of the account's display, dropping the platform's own rows", async () => {
    const builtinName = [...BUILTIN_MCP_SERVER_NAMES][0]!;
    const backend = backendExecSpy({ entries: [{ accountLabel: "default", serverIdentifier: "remote", rowServerIdentifier: "remote", status: "connected", tools: [{ toolName: "search" }, { toolName: "fetch" }] }] });
    const world = managerWorld({ displays: true, backend });
    world.pushDisplay(display([httpRow("11", "remote"), stdioRow("12", "local"), { ...httpRow("13", builtinName), serverIdentifier: builtinName }]));
    const state = await world.manager.listServers();
    assert.deepEqual(state.servers.map((server) => [server.id, server.name, server.toolCount, server.status]), [["11", "remote", 2, "connected"], ["12", "local", 0, "disconnected"]]);
    // The built-in row is not listed, is not migrated, and the backend was asked only for the http rows.
    assert.deepEqual(backend.calls, ["listTools:remote"]);
    // A box runtime that is not wired is not asked for the computer's servers at all.
    assert.deepEqual(world.box.calls, []);
    assert.deepEqual(world.settings.calls.filter((call) => call.startsWith("migrate")), ["migrate:11:remote", "migrate:12:local"]);
    assert.deepEqual(world.manager.lastAccountDisplayConfigView()?.servers.map((server) => server.name), ["remote", "local", builtinName]);
  });

  it("takes the account's configuration as rows when there is no display to read", async () => {
    const world = managerWorld({ accountConfig: { remote: { url: url("remote") }, local: { command: "run-local" }, [BUILTIN_MCP_SERVER_NAMES.values().next().value as string]: { command: "run-builtin" } } });
    const state = await world.manager.listServers();
    assert.deepEqual(state.servers.map((server) => [server.id, server.name, server.transport, server.status]), [["0", "remote", "http", "error"], ["0", "local", "stdio", "disconnected"]]);
    // Those rows carry no id, so nothing about them is migrated.
    assert.deepEqual(world.settings.calls, []);
    assert.equal(world.manager.lastAccountDisplayConfigView(), null);
  });

  it("asks the backend only when there is an http row, and keeps the tools a user may still call", async () => {
    const backend = backendExecSpy({ entries: [
      { accountLabel: "default", serverIdentifier: "remote", rowServerIdentifier: "remote", tools: [{ toolName: "search" }, { toolName: "blocked" }, { toolName: "fetch" }] },
      { accountLabel: "default", serverIdentifier: "unknown", rowServerIdentifier: "someone-else", tools: [{ toolName: "ghost" }] },
    ] });
    const settings = settingsSpy({ disabled: { "11": ["blocked"] } });
    const world = managerWorld({ displays: true, backend, settings });
    world.pushDisplay(display([httpRow("11", "remote")]));
    await world.manager.listServers();
    // Only the tools that are still enabled are handed on, and an entry no row owns is dropped.
    assert.deepEqual(await world.manager.listConnectedBackendTools(), [{ toolName: "search" }, { toolName: "fetch" }]);
    const first = await world.manager.listConnectedBackendTools();
    first.push({ toolName: "invented" });
    assert.equal((await world.manager.listConnectedBackendTools()).length, 2);
    // A display with nothing on the http side asks the backend nothing at all.
    const quiet = managerWorld({ displays: true, backend: backendExecSpy() });
    quiet.pushDisplay(display([stdioRow("12", "local")]));
    await quiet.manager.listServers();
    assert.deepEqual(quiet.backend.calls, []);
  });

  it("lists the computer's own servers, and says so when the computer cannot be reached", async () => {
    const box = boxRuntimeSpy({ wired: true, servers: [{ serverIdentifier: "local", status: "connected", toolCount: 3, tools: [] }] });
    const world = managerWorld({ displays: true, box });
    world.pushDisplay(display([stdioRow("12", "local"), stdioRow("13", "other")]));
    const state = await world.manager.listServers();
    assert.deepEqual(state.servers.map((server) => [server.name, server.toolCount, server.status]), [["local", 3, "connected"], ["other", 0, "error"]]);
    assert.deepEqual(box.calls, ["listBoxServers:local,other"]);
    // A box that answers with nothing for rows that exist is unavailable, not empty.
    const silent = managerWorld({ displays: true, box: boxRuntimeSpy({ wired: true, servers: [] }) });
    silent.pushDisplay(display([stdioRow("12", "local")]));
    assert.deepEqual((await silent.manager.listServers()).servers.map((server) => [server.status, server.statusDetail]), [["error", "Slate's computer unreachable"]]);
    // A box that fails to answer says which leg failed, and is unavailable too.
    const failures: McpDiagnostic[] = [];
    pinMcpDiagnosticsReporter((failure) => void failures.push(failure));
    try {
      const broken = managerWorld({ displays: true, box: boxRuntimeSpy({ wired: true, throwOnList: true }) });
      broken.pushDisplay(display([stdioRow("12", "local")]));
      const brokenState = await broken.manager.listServers();
      assert.deepEqual([brokenState.servers.map((server) => server.statusDetail), failures], [["Slate's computer unreachable"], [{ leg: "box-settings-list", errorClass: "Error" }]]);
    } finally {
      pinMcpDiagnosticsReporter(null);
    }
  });

  it("reports an admin-disabled row as disabled, and a connector that needs a sign-in as such", async () => {
    const backend = backendExecSpy({ entries: [{ accountLabel: "work", serverIdentifier: "slotted-work", rowServerIdentifier: "slotted", status: "connected", tools: [{ toolName: "search" }] }] });
    const world = managerWorld({ displays: true, backend });
    world.pushDisplay(display([
      httpRow("11", "blocked-by-admin", { disabledByTeamAdminPolicy: true }),
      httpRow("12", "team", { isTeamServer: true }),
      { ...httpRow("13", "slotted"), accounts: [{ accountKey: "default", hasToken: false }, { accountKey: "work", hasToken: true }] },
    ]));
    const state = await world.manager.listServers();
    assert.deepEqual(state.servers.map((server) => [server.id, server.accountKey, server.status, server.statusDetail]), [
      ["11", "default", "disabledByTeamAdminPolicy", "Disabled by team admin"],
      ["12", "default", "error", "Not reported by backend"],
      ["13", "default", "needsAuth", "Authentication required"],
      ["13", "work", "connected", undefined],
    ]);
    // A connector the admin disabled is not asked of the backend either.
    assert.deepEqual(backend.calls, ["listTools:team,slotted"]);
  });

  it("reads the account's display once for concurrent listings, and again after a reload", async () => {
    let reads = 0;
    const manager = new SlateMcpManager({
      accountServersProvider: async () => {
        reads += 1;
        return display([httpRow("11", "remote")]);
      },
      backendMcpExec: backendExecSpy().exec,
      parseServerConfig: (value) => value as McpServerConfig,
      getMachineId: async () => "machine-1",
    });
    const [first, second] = await Promise.all([manager.listServers(), manager.listServers()]);
    assert.deepEqual([reads, first.servers.length, second.servers.length], [1, 1, 1]);
    await manager.reload();
    await manager.listServers();
    assert.equal(reads, 2);
  });
});

describe("the account's scope", () => {
  it("applies a new scope once, forgetting what belonged to the old one", async () => {
    const scopes: string[] = [];
    const connectorAuth: Record<string, unknown>[] = [];
    const world = managerWorld({
      accountServers: true,
      box: boxRuntimeSpy({ wired: true }),
      backend: backendExecSpy({ authStatus: { hasValidToken: false, isAvailable: true, requiresAuth: true, authUrl: "https://auth.invalid/start" } }),
      onAccountScopeApplied: () => void scopes.push("applied"),
      onConnectorAuth: (event) => void connectorAuth.push(event),
    });
    // The read the definition source starts at construction settles first, so this listing is a read of its own.
    await tick();
    const scopesApplied = () => world.settings.calls.filter((call) => call.startsWith("scopeToAccount"));
    const migrations = () => world.settings.calls.filter((call) => call.startsWith("migrate")).length;
    world.pushAccountServers(display([httpRow("11", "remote")], { cacheScope: "account-a" }));
    await world.manager.listServers();
    // The rows are migrated once as they are adopted and once as they are listed, and the scope is applied once.
    assert.deepEqual([scopesApplied(), scopes, migrations()], [["scopeToAccount:account-a"], ["applied"], 2]);
    // The configuration the account resolved is the one the definition source reads from.
    assert.deepEqual(world.manager.definitionSourceView().peekHttpServerNames(), ["remote"]);
    await world.manager.listServers();
    assert.deepEqual([scopesApplied(), scopes, migrations()], [["scopeToAccount:account-a"], ["applied"], 4]);
    // A sign-in that is still pending when the account changes is cancelled rather than left waiting.
    assert.equal(((await world.manager.authenticateServer("11", "default")) as { status: string }).status, "started");
    world.pushAccountServers(display([httpRow("11", "remote")], { cacheScope: "account-b" }));
    await world.manager.listServers();
    assert.deepEqual([scopesApplied(), scopes, migrations()], [["scopeToAccount:account-a", "scopeToAccount:account-b"], ["applied", "applied"], 7]);
    assert.deepEqual(connectorAuth, [
      { phase: "flow_started", outcome: "ok", serverName: "remote", serverId: "11", reauth: false },
      { phase: "token_stored", outcome: "cancelled", serverName: "remote", serverId: "11" },
    ]);
    assert.equal(world.box.calls.filter((call) => call === "invalidateToolsCache").length, 1);
  });

  it("keeps the last display when the account's read is unavailable, and asks again next time", async () => {
    const world = managerWorld({ accountServers: true });
    world.pushAccountServers(display([httpRow("11", "remote")], { cacheScope: "account-a" }), display([httpRow("11", "remote")], { cacheScope: "account-a", unavailable: true }), display([httpRow("11", "remote")], { cacheScope: "account-a" }));
    await world.manager.listServers();
    // The unavailable read still lists what the same account showed before, and is not remembered as the answer.
    assert.deepEqual((await world.manager.listServers()).servers.map((server) => server.name), ["remote"]);
    assert.deepEqual((await world.manager.listServers()).servers.map((server) => server.name), ["remote"]);
    assert.equal(world.readCalls.filter((call) => call === "accountServers").length, 3);
  });

  it("keeps what the account could not resolve this time, and shows nothing of an account that could not be read", async () => {
    const world = managerWorld({ accountServers: true });
    await tick();
    world.pushAccountServers(display([httpRow("11", "remote")], { cacheScope: "account-a" }));
    await world.manager.listServers();
    // A row the account could not resolve this time is the row it showed before.
    world.pushAccountServers(display([], { cacheScope: "account-a", unresolvedServerIds: ["11"] }));
    assert.deepEqual((await world.manager.listServers()).servers.map((server) => server.name), ["remote"]);
    // The next account's rows are its own, and an account that could not be read shows none of the old one's.
    world.pushAccountServers(display([httpRow("21", "other")], { cacheScope: "account-b" }));
    assert.deepEqual((await world.manager.listServers()).servers.map((server) => server.name), ["other"]);
    world.pushAccountServers(display([], { cacheScope: "account-c", unavailable: true }));
    assert.deepEqual((await world.manager.listServers()).servers, []);
    // The old account's rows are not what the manager is left holding.
    assert.equal(world.manager.lastAccountDisplayConfigView(), null);
  });

  it("drops a display that arrived after the account was refreshed", async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const manager = new SlateMcpManager({
      accountServersProvider: async () => {
        await held;
        return display([httpRow("11", "stale")]);
      },
      backendMcpExec: backendExecSpy().exec,
      parseServerConfig: (value) => value as McpServerConfig,
      getMachineId: async () => "machine-1",
    });
    const listing = manager.listServers();
    // The account is refreshed while the old read is still in flight, so what it brings back is not this account's.
    manager.refreshAccountConfigInBackground();
    release!();
    assert.deepEqual((await listing).servers, []);
  });
});

describe("adding and removing a server", () => {
  it("refuses a name the platform keeps for itself, and a host that is not signed in", async () => {
    const builtinName = [...BUILTIN_MCP_SERVER_NAMES][0]!;
    const world = managerWorld();
    await assert.rejects(() => world.manager.addServer({ name: builtinName, configJson: "{}" }), (error: unknown) => error instanceof SlateMcpConfigError && /is reserved for a built-in Slate server/.test(error.message));
    await assert.rejects(() => world.manager.addServer({ name: "  ", configJson: "{}" }), /MCP server name is required/);
    // A name is validated before its configuration is read, so a bad name is refused even with no parser at all.
    const bare = new SlateMcpManager({ parseServerConfig: undefined as never, getMachineId: async () => "machine-1" });
    await assert.rejects(() => bare.addServer({ name: builtinName, configJson: "not json" }), /is reserved for a built-in Slate server/);
    const unsigned = new SlateMcpManager({ parseServerConfig: (value) => value as McpServerConfig, getMachineId: async () => "machine-1" });
    await assert.rejects(() => unsigned.addServer({ name: "mine", configJson: "{}" }), /requires a signed-in Slate account/);
  });

  it("adds a server to the account's configuration and lists again", async () => {
    const writer = writerSpy({ config: { existing: { url: url("existing") } }, ids: { existing: "5" } });
    const world = managerWorld({ writer, displays: true });
    world.pushDisplay(display([httpRow("11", "mine"), httpRow("12", "existing")]));
    const state = await world.manager.addServer({ name: "mine", configJson: JSON.stringify({ url: url("mine") }) });
    assert.deepEqual(writer.written, [{ config: { mcpServers: { existing: { url: url("existing") }, mine: { url: url("mine") } } }, ids: { existing: "5" } }]);
    assert.deepEqual(state.servers.map((server) => server.name), ["mine", "existing"]);
  });

  it("removes a plugin's row by uninstalling the plugin, and a plain row from the account", async () => {
    const pluginWriter = writerSpy();
    const pluginWorld = managerWorld({ writer: pluginWriter, displays: true });
    pluginWorld.pushDisplay(display([httpRow("11", "mine", { pluginId: "77" })]), display([]));
    const pluginState = await pluginWorld.manager.removeServer("11");
    assert.deepEqual([pluginWriter.calls, pluginState.removed], [["uninstallPlugin:77"], true]);
    const writer = writerSpy({ config: { mine: { url: url("mine") }, other: { url: url("other") } }, ids: { mine: "11", other: "12" } });
    const plain = managerWorld({ writer, displays: true });
    plain.pushDisplay(display([httpRow("11", "mine")]), display([httpRow("12", "other")]));
    const plainState = await plain.manager.removeServer("11");
    assert.deepEqual([writer.written, plainState.removed], [[{ config: { mcpServers: { other: { url: url("other") } } }, ids: { other: "12" } }], true]);
    assert.deepEqual(plain.settings.calls.filter((call) => call.startsWith("deleteInstruction")), ["deleteInstruction:11:mine:true"]);
  });

  it("leaves a server that is still listed, saying whether it is the team's", async () => {
    const writer = writerSpy({ config: { mine: { url: url("mine") } }, ids: { mine: "11" } });
    const team = managerWorld({ writer, displays: true });
    team.pushDisplay(display([httpRow("11", "mine")]), display([httpRow("11", "mine", { isTeamServer: true })]));
    const teamState = await team.manager.removeServer("11");
    assert.deepEqual([teamState.removed, teamState.reason, teamState.state.servers.map((server) => server.name)], [false, "team-server", ["mine"]]);
    const kept = managerWorld({ writer, displays: true });
    kept.pushDisplay(display([httpRow("11", "mine")]), display([httpRow("11", "mine")]));
    assert.deepEqual([(await kept.manager.removeServer("11")).removed, (await kept.manager.removeServer("11")).reason], [false, "still-present"]);
    // A row the account requires is removed from the account, not by uninstalling a plugin.
    const requiredWriter = writerSpy({ config: { mine: { url: url("mine") } }, ids: { mine: "11" } });
    const required = managerWorld({ writer: requiredWriter, displays: true });
    required.pushDisplay(display([httpRow("11", "mine", { pluginId: "77", isRequired: true })]), display([httpRow("12", "other")]));
    const requiredState = await required.manager.removeServer("11");
    assert.deepEqual([requiredWriter.calls.filter((call) => call.startsWith("uninstallPlugin")), requiredState.removed], [[], true]);
    // A row the team's own policy manages is removed from the account, not by uninstalling a plugin.
    const managedWriter = writerSpy({ config: { mine: { url: url("mine") } }, ids: { mine: "11" } });
    const managed = managerWorld({ writer: managedWriter, displays: true });
    managed.pushDisplay(display([httpRow("11", "mine", { pluginId: "77", managedByTeamPluginPolicy: true })]), display([httpRow("12", "other")]));
    const managedState = await managed.manager.removeServer("11");
    assert.deepEqual([managedWriter.calls.filter((call) => call.startsWith("uninstallPlugin")), managedState.removed], [[], true]);
    // A server the account's own map no longer names is removed without writing anything.
    const unknownWriter = writerSpy({ config: { other: { url: url("other") } }, ids: { other: "12" } });
    const unknown = managerWorld({ writer: unknownWriter, displays: true });
    unknown.pushDisplay(display([httpRow("11", "mine")]), display([httpRow("12", "other")]));
    const unknownState = await unknown.manager.removeServer("11");
    assert.deepEqual([unknownState.removed, unknownWriter.written.length], [true, 0]);
    // A sign-in still waiting for a server that is being removed is cancelled rather than left behind.
    const pending: Record<string, unknown>[] = [];
    const waited = managerWorld({
      writer,
      displays: true,
      backend: backendExecSpy({ authStatus: { hasValidToken: false, isAvailable: true, requiresAuth: true, authUrl: "https://auth.invalid/start" } }),
      onConnectorAuth: (event) => void pending.push(event),
    });
    waited.pushDisplay(display([httpRow("11", "mine")]));
    await waited.manager.listServers();
    await waited.manager.authenticateServer("11", "default");
    waited.pushDisplay(display([httpRow("12", "other")]));
    await waited.manager.removeServer("11");
    assert.deepEqual(pending.map((event) => event["outcome"]), ["ok", "cancelled"]);
  });

  it("keeps the legacy instruction when another row answers to the same name", async () => {
    const writer = writerSpy({ config: { mine: { url: url("mine") } }, ids: { mine: "11" } });
    const world = managerWorld({ writer, displays: true });
    world.pushDisplay(display([httpRow("11", "mine"), httpRow("21", "mine")]), display([httpRow("21", "mine")]));
    await world.manager.removeServer("11");
    assert.deepEqual(world.settings.calls.filter((call) => call.startsWith("deleteInstruction")), ["deleteInstruction:11:mine:false"]);
  });
});

describe("uninstalling a plugin", () => {
  it("uninstalls when the plugin is gone and no row of it is left", async () => {
    const writer = writerSpy();
    const world = managerWorld({ writer, displays: true, effectivePlugins: [{ pluginId: "77", isEnabled: false }] });
    world.pushDisplay(display([httpRow("11", "mine", { pluginId: "77" })]), display([]));
    const result = await world.manager.uninstallPlugin("77");
    assert.deepEqual([writer.calls, result.removed, result.state.servers], [["uninstallPlugin:77"], true, []]);
  });

  it("says what is left when a row of the plugin survives", async () => {
    const rows = [httpRow("11", "mine", { pluginId: "77" })];
    const mine = managerWorld({ displays: true, effectivePlugins: [{ pluginId: "77", isEnabled: true }] });
    mine.pushDisplay(display(rows));
    const mineResult = await mine.manager.uninstallPlugin("77");
    assert.deepEqual([mineResult.removed, mineResult.reason], [false, "still-present"]);
    const team = managerWorld({ displays: true, effectivePlugins: [] });
    team.pushDisplay(display([httpRow("11", "mine", { pluginId: "77", isTeamServer: true })]));
    const teamResult = await team.manager.uninstallPlugin("77");
    assert.deepEqual([teamResult.removed, teamResult.reason], [false, "team-server"]);
    // A plugin list that cannot be read is not proof that the plugin is gone, even with no row of it left.
    const unreadable = managerWorld({ displays: true, effectivePlugins: new Error("the plugin list is unavailable") });
    unreadable.pushDisplay(display(rows));
    const unreadableResult = await unreadable.manager.uninstallPlugin("77");
    assert.deepEqual([unreadableResult.removed, unreadableResult.reason], [false, "still-present"]);
    unreadable.pushDisplay(display([]));
    const goneButUnreadable = await unreadable.manager.uninstallPlugin("77");
    assert.deepEqual([goneButUnreadable.removed, goneButUnreadable.reason], [false, "still-present"]);
  });

  it("refuses to uninstall what the team requires, and what cannot be checked", async () => {
    const required = managerWorld({ displays: true, effectivePlugins: [] });
    required.pushDisplay(display([httpRow("11", "mine", { pluginId: "77", isRequired: true })]));
    await assert.rejects(() => required.manager.uninstallPlugin("77"), /required by the user's team/);
    const teamRequired = managerWorld({ displays: true, effectivePlugins: [{ pluginId: "77", isEnabled: true, installMode: "team-required" }] });
    teamRequired.pushDisplay(display([httpRow("11", "mine", { pluginId: "77" })]));
    await assert.rejects(() => teamRequired.manager.uninstallPlugin("77"), /required by the user's team/);
    // With no display and no plugin list there is nothing to check the policy against.
    const uncheckable = new SlateMcpManager({ accountMcpWriter: writerSpy().writer, parseServerConfig: (value) => value as McpServerConfig, getMachineId: async () => "machine-1" });
    await assert.rejects(() => uncheckable.uninstallPlugin("77"), /Couldn't verify this plugin's team policy right now/);
  });

  it("forgets the settings of the rows it removed, and only of those", async () => {
    const writer = writerSpy();
    const settings = settingsSpy({ disabled: { "11": ["search"], "12": ["search"] } });
    const world = managerWorld({ writer, settings, displays: true, effectivePlugins: [{ pluginId: "77", isEnabled: false }] });
    world.pushDisplay(display([httpRow("11", "mine", { pluginId: "77" }), httpRow("12", "team-owned", { pluginId: "77", isTeamServer: true })]));
    const result = await world.manager.uninstallPlugin("77");
    // The team's own row keeps its settings: it was not this account's to forget, and it keeps the plugin installed.
    assert.deepEqual([world.settings.calls.filter((call) => !call.startsWith("migrate")), result.removed, result.reason], [["deleteInstruction:11:mine:true", 'setDisabled:{"12":["search"]}'], false, "still-present"]);
  });

  it("reads the plugin list as the manager's own plugin list", async () => {
    const world = managerWorld({ effectivePlugins: [{ pluginId: "77", isEnabled: true }] });
    assert.deepEqual(await world.manager.listEffectivePlugins(), [{ pluginId: "77", isEnabled: true }]);
    assert.deepEqual(await managerWorld().manager.listEffectivePlugins(), []);
  });
});

describe("resolving a server's display row", () => {
  it("answers from the fresh read the caller asked for, and refuses when it is not there", async () => {
    const world = managerWorld({ accountServers: true });
    world.pushAccountServers(display([httpRow("11", "remote")]), display([httpRow("11", "remote")], { unavailable: true }), display([httpRow("11", "remote")]));
    assert.deepEqual((await world.manager.resolveDisplayServer("11", { requireFreshRead: true }))?.name, "remote");
    await assert.rejects(() => world.manager.resolveDisplayServer("11", { requireFreshRead: true }), /account display config unavailable/);
    // The unavailable read did not become the last display, so the next read still answers.
    assert.deepEqual((await world.manager.resolveDisplayServer("11"))?.name, "remote");
  });

  it("refuses a fresh read with nothing to read, and falls back to the last display otherwise", async () => {
    const bare = new SlateMcpManager({ parseServerConfig: (value) => value as McpServerConfig, getMachineId: async () => "machine-1" });
    await assert.rejects(() => bare.resolveDisplayServer("11", { requireFreshRead: true }), /no account display config provider/);
    assert.equal(await bare.resolveDisplayServer("11"), undefined);
    // A display provider that fails is only fatal when the caller asked for a fresh read.
    const world = managerWorld({ displays: true });
    world.pushDisplay(new Error("the display is unavailable") as never, display([httpRow("11", "remote")]));
    assert.equal(await world.manager.resolveDisplayServer("11"), undefined);
    assert.deepEqual((await world.manager.resolveDisplayServer("11"))?.name, "remote");
    const strict = managerWorld({ displays: true });
    strict.pushDisplay(new Error("the display is unavailable") as never);
    await assert.rejects(() => strict.manager.resolveDisplayServer("11", { requireFreshRead: true }), /the display is unavailable/);
    // A read that answers nothing at all is refused the same way.
    const empty = managerWorld({ displays: true });
    await assert.rejects(() => empty.manager.resolveDisplayServer("11", { requireFreshRead: true }), /account display config unavailable/);
    // So is a display that came back unavailable.
    const unavailable = managerWorld({ displays: true });
    unavailable.pushDisplay(display([httpRow("11", "remote")], { unavailable: true }));
    await assert.rejects(() => unavailable.manager.resolveDisplayServer("11", { requireFreshRead: true }), /account display config unavailable/);
  });

  it("does not fall back to another account's rows when this one has a reader", async () => {
    const world = managerWorld({ accountServers: true, displays: true });
    world.pushAccountServers(display([httpRow("11", "remote")]));
    world.pushDisplay(display([httpRow("12", "elsewhere")]));
    await world.manager.listServers();
    // The account's own read is the only one that answers while the host has an account reader.
    assert.deepEqual((await world.manager.resolveDisplayServer("11"))?.name, "remote");
    assert.equal(await world.manager.resolveDisplayServer("12"), undefined);
    assert.deepEqual(world.readCalls.filter((call) => call === "display"), []);
  });
});

describe("what the host refreshes and what it delegates", () => {
  it("refreshes the account's configuration in the background, and lets go of the tools caches", async () => {
    const box = boxRuntimeSpy({ wired: true });
    const world = managerWorld({ accountConfig: { remote: { url: url("remote") } }, box });
    await world.manager.listServers();
    assert.equal(world.readCalls.filter((call) => call === "config").length >= 1, true);
    const reads = () => world.readCalls.filter((call) => call === "config").length;
    const before = reads();
    world.manager.refreshAccountConfigInBackground();
    await tick();
    assert.deepEqual([box.calls, reads() > before], [["listBoxServers:"], true]);
    const beforeReload = reads();
    await world.manager.reload();
    assert.deepEqual([box.calls, reads() > beforeReload], [["listBoxServers:", "invalidateToolsCache", "resetPushState"], true]);
  });

  it("hands the host's own calls to the parts that own them", async () => {
    const backend = backendExecSpy({ authStatus: { hasValidToken: false, isAvailable: true, requiresAuth: true, authUrl: "https://auth.invalid/start" } });
    const box = boxRuntimeSpy({ wired: true, tools: [{ providerIdentifier: "remote", toolName: "search" }] });
    const completions: unknown[] = [];
    const connectorAuth: Record<string, unknown>[] = [];
    const world = managerWorld({ displays: true, backend, box, onConnectorAuth: (event) => void connectorAuth.push(event) });
    world.pushDisplay(display([httpRow("11", "remote"), stdioRow("12", "local")]));
    world.manager.setAuthCompletionObserver((completion) => void completions.push(completion));
    await world.manager.listServers();
    // A sign-in that starts leaves a watch behind, and the same sign-in seen elsewhere is reported as the agent's.
    assert.equal(((await world.manager.authenticateServer("11", "default", "agent-1", false, "connector_card")) as { status: string }).status, "started");
    assert.deepEqual(connectorAuth, [
      { phase: "card_clicked", outcome: "ok", serverName: "remote", serverId: "11" },
      { phase: "flow_started", outcome: "ok", serverName: "remote", serverId: "11", reauth: false },
    ]);
    assert.equal(world.manager.noteAuthCompletedElsewhere("11", "default"), "agent-1");
    // The tool list of a server is read through the box runtime's own tools, and the switch is remembered.
    assert.deepEqual(await world.manager.listServerTools("11"), [{ name: "search", isDisabled: false }]);
    await world.manager.toggleMcpToolDisabled({ serverId: "11", toolName: "search" });
    assert.deepEqual(await world.manager.listServerTools("11"), [{ name: "search", isDisabled: true }]);
    await world.manager.setServerCustomInstructions({ serverId: "11", instructions: "be careful" });
    // Every connector the display names carries an instruction; only the one that was set has one.
    assert.deepEqual([...world.manager.getMcpCustomInstructions()], [["remote", "be careful"], ["local", ""]]);
    // An account slot's own calls go to the backend that owns them.
    await world.manager.logoutAccount("11", "default");
    await world.manager.renameAccount("11", "default", "work");
    await world.manager.removeAccount("11", "default");
    assert.deepEqual(backend.calls.filter((call) => call.endsWith("Account")), ["logoutAccount", "renameAccount", "deleteAccount"]);
    // Taking the manager down lets go of a sign-in that is still waiting, without calling it cancelled.
    assert.equal(((await world.manager.authenticateServer("11", "default", "agent-1", true)) as { status: string }).status, "started");
    await world.manager.dispose();
    assert.deepEqual([completions, connectorAuth.map((event) => [event["phase"], event["outcome"]])], [[], [["card_clicked", "ok"], ["flow_started", "ok"], ["flow_started", "ok"]]]);
  });

  it("validates the ids and names it is handed", async () => {
    const world = managerWorld({ displays: true });
    world.pushDisplay(display([httpRow("11", "remote")]));
    await assert.rejects(() => world.manager.removeServer("not-an-id"), /MCP server ID must be a positive decimal string/);
    await assert.rejects(() => world.manager.resolveDisplayServer("0"), /MCP server ID must be a positive decimal string/);
    await assert.rejects(() => world.manager.listServerTools("12"), /MCP server not found/);
    await assert.rejects(() => world.manager.uninstallPlugin("plugin-77"), /Invalid marketplace plugin id/);
  });
});
