/**
 * The manager over every MCP server this host knows.
 *
 * It owns the account's display of its servers and everything the host does with them: the listing the UI reads, the
 * tools the model may call, adding and removing a server, uninstalling a plugin, the sign-in a connector is waiting
 * for, and the account slots behind them. The parts that own a piece of that work are composed here rather than
 * re-implemented — the definition source, the listing summaries, the instructions and toggles, the account slots, the
 * catalog flow and the sign-in watches — and what this file itself decides is:
 *
 * - which reader the display comes from (the account's own servers when the host has that provider, otherwise the
 *   provider it was handed), and the same choice for the definition source's configuration;
 * - how one account read is shared, when a read that arrived late is dropped, what a scope change forgets, and that an
 *   unavailable read leaves the last known display in place;
 * - how the listing is assembled out of rows, the backend's tools and the computer's own servers;
 * - what adding and removing writes, and what an uninstall must refuse to do.
 */

import { isEffectivePluginInstalled } from "../../mcp.ts";
import { mergeUnresolvedAccountServers } from "./account-display-cache.ts";
import { BUILTIN_MCP_SERVER_NAMES } from "./builtin-mcp.ts";
import { SlateMcpAccountSlotLifecycle } from "./mcp-account-slot-lifecycle.ts";
import { SlateMcpAuthWatchLifecycle } from "./mcp-auth-watch-lifecycle.ts";
import { AUTH_WATCH_POLL_INTERVAL_MS, AUTH_WATCH_POLL_TIMEOUT_MS, AUTH_WATCH_TIMEOUT_MS } from "./mcp-auth-watch.ts";
import { SlateMcpCatalogFlow } from "./mcp-catalog-flow.ts";
import { SlateMcpConfigError } from "./mcp-config-error.ts";
import { backendEntryBelongsToRow, SlateMcpDefinitionSource, type McpRuntimeConfig } from "./mcp-definition-source.ts";
import { reportMcpHostEdgeFailure } from "./mcp-diagnostics.ts";
import { runtimeConfigFromDisplay, validateMarketplacePluginId, type AccountDisplayConfig, type DisplayServer, type McpServerConfig } from "./mcp-display-runtime.ts";
import { SlateMcpInstructionsAndToggles, type McpSettingsPort } from "./mcp-instructions-and-toggles.ts";
import { SlateMcpListingSummaries } from "./mcp-listing-summaries.ts";
import { validateMcpServerId } from "./mcp-server-id.ts";
import { parseServerConfig, validateServerName } from "./mcp-validation.ts";

/** What the manager reads and writes about a server's instructions and its tools' switches. */
export interface McpManagerSettingsPort extends McpSettingsPort {
  /** The store's data belongs to one account; a scope change tells it which one. */
  scopeToAccount(scope: string): void;
  getRawMcpCustomInstruction(name: string): string | undefined;
  getRawMcpCustomInstructionByServerId(id: string): string | undefined;
  deleteMcpCustomInstructionByServerId(args: { serverId: string; displayName: string; deleteLegacyName: boolean }): void;
}

/** A host that never wired a store still gets answers: every read is empty and every write is silence. */
const EMPTY_SETTINGS: McpManagerSettingsPort = {
  scopeToAccount() {},
  migrateMcpCustomInstructionToServerId() {},
  getMcpCustomInstructions: () => ({}),
  getMcpCustomInstructionsByServerId: () => ({}),
  getMcpDisabledToolsByServerId: () => ({}),
  setMcpDisabledToolsByServerId() {},
  getRawMcpCustomInstruction: () => undefined,
  getRawMcpCustomInstructionByServerId: () => undefined,
  setMcpCustomInstructionByServerId() {},
  deleteMcpCustomInstructionByServerId() {},
};

/** A tool as the backend's own listing names it; whatever else it carries rides along untouched. */
export interface McpBackendTool {
  readonly name: string;
  readonly providerIdentifier: string;
  readonly toolName: string;
}

/** One server's entry in the backend's tool listing, as the backend attributes it to a row. */
export interface McpBackendToolEntry {
  readonly accountLabel: string;
  readonly serverIdentifier?: string;
  readonly status?: string;
  readonly rowServerIdentifier?: string;
  readonly tools: McpBackendTool[];
}

/** What the backend says about a connector's sign-in. */
export interface McpConnectorAuthStatus {
  readonly hasValidToken?: boolean;
  readonly isAvailable?: boolean;
  readonly requiresAuth?: boolean;
  readonly authUrl?: string;
  readonly error?: string;
}

/** The backend's MCP side: the tools it lists and the account calls the slots make. */
export interface McpBackendExecPort {
  listTools(serverIdentifiers: readonly string[]): Promise<McpBackendToolEntry[]>;
  checkAuthStatus(args: { serverId: number; accountKey: string; oauthRedirectUri: string; forceReauth: boolean }): Promise<McpConnectorAuthStatus>;
  logoutAccount(args: { serverUrl: string; accountKey: string }): Promise<void>;
  renameAccount(args: { serverId: number; accountKey: string; newAccountKey: string }): Promise<void>;
  deleteAccount(args: { serverId: number; accountKey: string }): Promise<void>;
}

/** One of the computer's own servers, as the box runtime reports it. */
export interface McpBoxServerEntry {
  readonly serverIdentifier: string;
  readonly status?: string;
  readonly statusDetail?: string;
  readonly toolCount: number;
  readonly tools: { readonly toolName: string }[];
}

/** The box runtime: the computer's servers, the tools it discovered, and the caches a reload drops. */
export interface McpBoxRuntimePort {
  isBoxExecWired?(): boolean;
  listBoxServers(serverIdentifiers: readonly string[], options?: unknown): Promise<McpBoxServerEntry[]>;
  invalidateToolsCache?(): void;
  resetPushState?(): void;
  getToolsRaw?(): Promise<{ readonly providerIdentifier: string; readonly toolName: string; readonly title?: string; readonly description?: string }[]>;
}

/** The signed-in account's own MCP configuration, as the writer reads and writes it. */
export interface McpAccountWriterPort {
  getConfigForEdit(): Promise<{ config: { mcpServers: Record<string, unknown> }; serverIdsByName: Record<string, string | number | bigint> }>;
  setConfig(config: { mcpServers: Record<string, unknown> }, serverIdsByName: Record<string, string | number | bigint>): Promise<void>;
  uninstallPlugin(args: { pluginId: bigint }): Promise<void>;
}

/** One plugin as the account's effective-plugin list reports it. */
export interface EffectivePluginRow {
  readonly pluginId: string;
  readonly isEnabled: boolean;
  readonly installMode?: string;
}

/** One server as the listing shows it. */
export interface McpServerSummary {
  readonly id: string;
  readonly name: string;
  readonly serverIdentifier: string;
  readonly accountKey: string;
  readonly rowServerIdentifier: string;
  readonly transport: "stdio" | "sse" | "http";
  readonly command?: string | undefined;
  readonly url?: string | undefined;
  readonly toolCount: number;
  readonly disabledToolCount?: number | undefined;
  readonly customInstructions: string;
  readonly isTeamServer: boolean;
  readonly pluginId?: string | undefined;
  readonly isRequired?: boolean | undefined;
  readonly managedByTeamPluginPolicy?: boolean | undefined;
  readonly status: string;
  readonly statusDetail?: string | undefined;
}

export interface McpListingState {
  readonly servers: McpServerSummary[];
}

export interface McpManagerOptions {
  settingsStore?: McpManagerSettingsPort;
  boxRuntime?: McpBoxRuntimePort;
  backendMcpExec?: McpBackendExecPort;
  accountMcpWriter?: McpAccountWriterPort;
  effectivePluginsProvider?: () => Promise<EffectivePluginRow[]>;
  /** The account's servers; when it is wired the display and the configuration both come from it. */
  accountServersProvider?: () => Promise<AccountDisplayConfig | null>;
  /** The display the host reads when it has no account-servers provider of its own. */
  accountDisplayConfigProvider?: () => Promise<AccountDisplayConfig | null>;
  /** The account's configuration the host reads when it has no account-servers provider of its own. */
  accountConfigProvider?: () => Promise<McpRuntimeConfig | null>;
  includeBuiltins?: boolean;
  /** How a server's configuration is parsed out of the JSON a user typed. */
  parseServerConfig: (value: unknown) => McpServerConfig;
  getMachineId: () => Promise<string> | string;
  onConnectorAuth?(event: Record<string, unknown>): void;
  onAccountScopeApplied?(): void;
  onDiscoveryFailed?: unknown;
  authWatchPollIntervalMs?: number;
  authWatchTimeoutMs?: number;
  authWatchPollTimeoutMs?: number;
}

/** A visible row that carries a server identifier, paired with it so the filters stay readable. */
type TransportRow = { readonly row: DisplayServer; readonly identifier: string };

const rowsFromRuntimeConfig = (runtime: Record<string, McpServerConfig>): DisplayServer[] =>
  Object.entries(runtime).map(([serverIdentifier, config]) => ({ id: "0", name: serverIdentifier, serverIdentifier, config, isTeamServer: false, disabledByTeamAdminPolicy: false }));

const transportRows = (rows: readonly DisplayServer[], kind: "url" | "command"): TransportRow[] =>
  rows.flatMap((row) => row.serverIdentifier != null && row.disabledByTeamAdminPolicy !== true && kind in row.config ? [{ row, identifier: row.serverIdentifier }] : []);

export class SlateMcpManager {
  private settingsStore: McpManagerSettingsPort;
  private boxRuntime: McpBoxRuntimePort | undefined;
  private readonly backendMcpExec: McpBackendExecPort | undefined;
  private readonly definitionSource: SlateMcpDefinitionSource;
  private readonly accountWriter: McpAccountWriterPort | undefined;
  private readonly effectivePluginsProvider: (() => Promise<EffectivePluginRow[]>) | undefined;
  private readonly accountServersProvider: (() => Promise<AccountDisplayConfig | null>) | undefined;
  private readonly accountDisplayConfigProvider: (() => Promise<AccountDisplayConfig | null>) | undefined;
  private accountPromise: Promise<AccountDisplayConfig | null> | undefined;
  private generation = 0;
  private lastDisplay: AccountDisplayConfig | null = null;
  private lastState: McpListingState | null = null;
  private lastBackendTools: McpBackendTool[] = [];
  private lastScope: string | undefined;
  private readonly authWatches: SlateMcpAuthWatchLifecycle;
  private readonly summaries: SlateMcpListingSummaries;
  private readonly instructions: SlateMcpInstructionsAndToggles;
  private readonly slots: SlateMcpAccountSlotLifecycle;
  private readonly catalog: SlateMcpCatalogFlow;

  constructor(private readonly options: McpManagerOptions) {
    this.settingsStore = options.settingsStore ?? EMPTY_SETTINGS;
    this.boxRuntime = options.boxRuntime;
    this.backendMcpExec = options.backendMcpExec;
    this.accountWriter = options.accountMcpWriter;
    this.effectivePluginsProvider = options.effectivePluginsProvider;
    this.accountServersProvider = options.accountServersProvider;
    // With the account's own servers wired, the display is read through the shared account read; without it the host's
    // own provider is the only reader there is.
    this.accountDisplayConfigProvider = options.accountServersProvider == null ? options.accountDisplayConfigProvider : () => this.loadAccountServers();
    this.definitionSource = new SlateMcpDefinitionSource(
      options.includeBuiltins ?? true,
      options.accountServersProvider == null ? options.accountConfigProvider : async () => runtimeConfigFromDisplay(await this.loadAccountServers()),
    );
    this.authWatches = new SlateMcpAuthWatchLifecycle({
      backendMcpExec: this.backendMcpExec,
      authWatchPollIntervalMs: options.authWatchPollIntervalMs ?? AUTH_WATCH_POLL_INTERVAL_MS,
      authWatchTimeoutMs: options.authWatchTimeoutMs ?? AUTH_WATCH_TIMEOUT_MS,
      authWatchPollTimeoutMs: options.authWatchPollTimeoutMs ?? AUTH_WATCH_POLL_TIMEOUT_MS,
      resolveDisplayServer: (id, watchOptions) => this.resolveDisplayServer(id, watchOptions),
      reload: () => this.reload(),
      ...(options.onConnectorAuth === undefined ? {} : { onConnectorAuth: options.onConnectorAuth }),
    });
    this.summaries = new SlateMcpListingSummaries({
      settingsStore: () => this.settingsStore,
      isBoxExecWired: () => this.boxRuntime?.isBoxExecWired?.() === true,
    });
    this.instructions = new SlateMcpInstructionsAndToggles({
      settingsStore: () => this.settingsStore,
      resolveDisplayServer: (id) => this.resolveDisplayServer(id),
      listServers: () => this.listServers(),
      lastAccountDisplayConfig: () => this.lastDisplay,
      getToolsRaw: async () => [...((await this.boxRuntime?.getToolsRaw?.()) ?? [])],
    });
    this.catalog = new SlateMcpCatalogFlow({
      getMachineId: options.getMachineId,
      listEffectivePlugins: () => this.listEffectivePlugins(),
      requireAccountWriter: () => this.requireAccountWriter(),
      reloadServers: () => this.reloadServers(),
    });
    this.slots = new SlateMcpAccountSlotLifecycle({
      backendMcpExec: this.backendMcpExec as NonNullable<McpBackendExecPort>,
      definitionSource: this.definitionSource,
      resolveDisplayServer: (id) => this.resolveDisplayServer(id),
      reloadServers: () => this.reloadServers(),
      clearPendingAuthWatch: (id, key) => this.authWatches.clearPendingAuthWatchCancelled(id, key),
      notifyWatchCancelled: (watch) => this.authWatches.notifyWatchCancelled(watch),
      lastAccountDisplayConfig: () => this.lastDisplay,
      setLastAccountDisplayConfig: (display) => {
        this.lastDisplay = display;
      },
      lastListedState: () => this.lastState,
      setLastListedState: (state) => {
        this.lastState = state;
      },
      invalidateToolsCache: () => this.boxRuntime?.invalidateToolsCache?.(),
      resetPushState: () => this.boxRuntime?.resetPushState?.(),
    });
  }

  /**
   * One account read at a time: the promise is shared while it is in flight, a read that arrives after the account
   * moved on is dropped in favour of what the current scope already had, and an account that could not be read leaves
   * the last display in place — and is asked again next time.
   */
  private loadAccountServers(): Promise<AccountDisplayConfig | null> {
    if (this.accountPromise != null) return this.accountPromise;
    const generation = ++this.generation;
    const promise = (this.accountServersProvider?.() ?? Promise.resolve(null)).then((display) => this.adoptAccountDisplay(display, generation));
    this.accountPromise = promise;
    const clear = (): void => {
      if (this.accountPromise === promise) this.accountPromise = undefined;
    };
    void promise.then(clear, clear);
    return promise;
  }

  private adoptAccountDisplay(display: AccountDisplayConfig | null, generation: number): AccountDisplayConfig | null {
    const cached = this.cachedDisplayFor(display);
    if (generation !== this.generation) return cached;
    if (display == null) {
      this.definitionSource.clearLastKnownAccountConfig();
      return null;
    }
    if (display.cacheScope !== undefined && display.cacheScope !== this.lastScope) this.applyScopeChange(display.cacheScope);
    if (display.unavailable === true) {
      if (cached == null) this.accountPromise = undefined;
      return cached;
    }
    const resolved = mergeUnresolvedAccountServers(display, cached);
    this.lastDisplay = resolved;
    this.definitionSource.adoptAccountConfig(runtimeConfigFromDisplay(resolved));
    this.instructions.migrateCustomInstructions(resolved.servers);
    return resolved;
  }

  /** What this account already showed, when the read carries the scope it was made under. */
  private cachedDisplayFor(display: AccountDisplayConfig | null): AccountDisplayConfig | null {
    return display?.cacheScope !== undefined && display.cacheScope === this.lastScope ? this.lastDisplay : null;
  }

  /** A different account's servers replace this one's: the scope is applied, and nothing of the old one survives it. */
  private applyScopeChange(scope: string): void {
    if (this.lastScope !== undefined) {
      this.lastDisplay = null;
      this.lastState = null;
      this.authWatches.clearAllPendingAuthWatchesCancelled();
      this.boxRuntime?.invalidateToolsCache?.();
    }
    this.settingsStore.scopeToAccount(scope);
    this.lastScope = scope;
    this.options.onAccountScopeApplied?.();
    this.definitionSource.clearLastKnownAccountConfig();
    this.definitionSource.clearCache();
  }

  setBoxRuntime(runtime: McpBoxRuntimePort): void {
    this.boxRuntime = runtime;
  }

  definitionSourceView(): SlateMcpDefinitionSource {
    return this.definitionSource;
  }

  lastAccountDisplayConfigView(): AccountDisplayConfig | null {
    return this.lastDisplay;
  }

  settingsStoreView(): McpManagerSettingsPort {
    return this.settingsStore;
  }

  backendMcpExecView(): McpBackendExecPort | undefined {
    return this.backendMcpExec;
  }

  onDiscoveryFailedView(): unknown {
    return this.options.onDiscoveryFailed;
  }

  setSettingsStore(settings: McpManagerSettingsPort): void {
    this.settingsStore = settings;
  }

  setAuthCompletionObserver(observer: (completion: unknown) => void): void {
    this.authWatches.setAuthCompletionObserver(observer);
  }

  /** What the account shows, listed: the admin's own rows, the backend's connectors and the computer's servers. */
  async listServers(): Promise<McpListingState> {
    const display = await this.accountDisplayConfigProvider?.();
    if (display != null) this.lastDisplay = display;
    const effectiveDisplay = display ?? (this.accountServersProvider == null ? this.lastDisplay : null);
    const runtime = await this.definitionSource.getUserServerConfigs();
    const rows = effectiveDisplay?.servers ?? (this.accountServersProvider == null ? rowsFromRuntimeConfig(runtime) : []);
    const visible = rows.filter((server) => server.serverIdentifier == null || !BUILTIN_MCP_SERVER_NAMES.has(server.serverIdentifier));
    this.instructions.migrateCustomInstructions(visible);
    const http = transportRows(visible, "url");
    const stdio = transportRows(visible, "command");
    const backend = http.length > 0 ? await this.backendMcpExec!.listTools(http.map((row) => row.identifier)) : [];
    const disabledByServer = this.settingsStore.getMcpDisabledToolsByServerId?.() ?? {};
    this.lastBackendTools = backendToolsFor(http, backend, disabledByServer);
    const box = await this.boxServersFor(stdio.map((row) => row.identifier));
    const servers = visible.flatMap((server) => this.summariseServer(server, backend, box));
    return (this.lastState = { servers });
  }

  /** The tools of the connectors this account has that the user has not switched off. */
  async listConnectedBackendTools(): Promise<McpBackendTool[]> {
    await this.listServers();
    return [...this.lastBackendTools];
  }

  /** The computer's own servers, and whether the computer could be reached at all. */
  private async boxServersFor(identifiers: readonly string[]): Promise<{ byName: Map<string, McpBoxServerEntry>; unavailable: boolean }> {
    const byName = new Map<string, McpBoxServerEntry>();
    if (this.boxRuntime?.isBoxExecWired?.() !== true) return { byName, unavailable: false };
    try {
      for (const server of await this.boxRuntime.listBoxServers(identifiers)) byName.set(server.serverIdentifier, server);
      // Rows that exist but no answer for them is an unreachable computer, not an empty one.
      return { byName, unavailable: identifiers.length > 0 && byName.size === 0 };
    } catch (error) {
      reportMcpHostEdgeFailure("box-settings-list", error);
      return { byName, unavailable: true };
    }
  }

  private summariseServer(server: DisplayServer, backend: readonly McpBackendToolEntry[], box: { byName: Map<string, McpBoxServerEntry>; unavailable: boolean }): McpServerSummary[] {
    if (server.disabledByTeamAdminPolicy === true) return [this.summaries.createAdminDisabledServerSummary(server)];
    if (!("url" in server.config)) return [this.summaries.createBoxServerSummary(server, boxEntryFor(box.byName, server.serverIdentifier), box.unavailable)];
    return this.summaries.createBackendServerSummaries(server, backend.filter((entry) => backendEntryBelongsToRow(entry, server.serverIdentifier ?? "")));
  }

  async addServer(request: { name: string; configJson: string }): Promise<McpListingState> {
    const name = this.validateInstallableName(request.name);
    const config = parseServerConfig(request.configJson, this.options.parseServerConfig);
    await this.addServersToAccount({ [name]: config });
    return this.reloadServers();
  }

  getCatalog(token: () => Promise<string | null | undefined>, options?: { forceRefresh?: boolean }): Promise<unknown[]> {
    return this.catalog.getCatalog(token, options);
  }

  resolvePluginLogo(url: string): Promise<unknown> {
    return this.catalog.resolvePluginLogo(url);
  }

  installEntry(request: { entryId: string; values?: Record<string, string>; hasTeamConfiguredVariables?: boolean }, token: () => Promise<string | null | undefined>): Promise<unknown> {
    return this.catalog.installEntry(request, token);
  }

  updatePluginInstall(request: { pluginId: string; values: Record<string, string> }, token: () => Promise<string | null | undefined>): Promise<unknown> {
    return this.catalog.updatePluginInstall(request, token);
  }

  private validateInstallableName(name: string): string {
    const validated = validateServerName(name);
    if (BUILTIN_MCP_SERVER_NAMES.has(validated)) throw new SlateMcpConfigError(`MCP server name "${validated}" is reserved for a built-in Slate server.`);
    return validated;
  }

  private requireAccountWriter(): McpAccountWriterPort {
    if (this.accountWriter == null) throw new SlateMcpConfigError("Managing MCP servers requires a signed-in Slate account.");
    return this.accountWriter;
  }

  private async addServersToAccount(servers: Record<string, McpServerConfig>): Promise<void> {
    const writer = this.requireAccountWriter();
    const { config, serverIdsByName } = await writer.getConfigForEdit();
    await writer.setConfig({ mcpServers: { ...config.mcpServers, ...servers } }, serverIdsByName);
  }

  /** Removing a row a plugin owns means uninstalling that plugin; anything else is removed from the account. */
  async removeServer(rawId: string): Promise<RemoveOutcome> {
    const id = validateMcpServerId(rawId);
    const row = await this.resolveDisplayServer(id);
    if (row?.pluginId != null && row.isTeamServer !== true && row.managedByTeamPluginPolicy !== true && row.isRequired !== true) return this.uninstallPluginRows(row.pluginId, id);
    const writer = this.requireAccountWriter();
    const current = await writer.getConfigForEdit();
    const name = Object.entries(current.serverIdsByName).find(([, value]) => value.toString() === id)?.[0];
    if (name == null || !(name in current.config.mcpServers)) return this.classifyRemoveOutcome(id, await this.listServers());
    const servers = { ...current.config.mcpServers };
    delete servers[name];
    const ids = { ...current.serverIdsByName };
    delete ids[name];
    await writer.setConfig({ mcpServers: servers }, ids);
    this.authWatches.clearPendingAuthWatchesForServer(id);
    const displayName = row?.name;
    const sameNameRows = this.lastDisplay?.servers.filter((server) => server.name === displayName).length ?? 1;
    // The legacy instruction belongs to the name, so it is only forgotten when no other row answers to it.
    this.settingsStore.deleteMcpCustomInstructionByServerId({ serverId: id, displayName: displayName ?? name, deleteLegacyName: displayName != null && sameNameRows <= 1 });
    this.instructions.deleteDisabledToolsForServer(id);
    return this.classifyRemoveOutcome(id, await this.reloadServers(id));
  }

  private classifyRemoveOutcome(id: string, state: McpListingState): RemoveOutcome {
    const remaining = state.servers.find((server) => server.id === id);
    return remaining == null ? { state, removed: true } : { state, removed: false, reason: remaining.isTeamServer ? "team-server" : "still-present" };
  }

  listEffectivePlugins(): Promise<EffectivePluginRow[]> {
    return this.effectivePluginsProvider == null ? Promise.resolve([]) : this.effectivePluginsProvider();
  }

  /** Uninstalling a plugin: the account's rows of it are gone, and the plugin is not installed for this account. */
  async uninstallPlugin(raw: string): Promise<RemoveOutcome> {
    const id = validateMarketplacePluginId(raw);
    const state = await this.performPluginUninstall(id);
    let gone = this.effectivePluginsProvider == null;
    if (!gone)
      try {
        gone = !(await this.effectivePluginsProvider!()).some((plugin) => plugin.pluginId === id && isEffectivePluginInstalled(plugin));
      } catch {
        // A plugin list that cannot be read is not proof that the plugin is gone.
      }
    const rows = state.servers.filter((server) => server.pluginId === id);
    return gone && rows.length === 0
      ? { state, removed: true }
      : { state, removed: false, reason: !gone || rows.some((row) => row.isTeamServer !== true) ? "still-present" : "team-server" };
  }

  /**
   * The part of an uninstall that touches the account: what the plugin's team policy says is checked first, then the
   * plugin is uninstalled, then the rows it owned forget their settings.
   */
  private async performPluginUninstall(id: string): Promise<McpListingState> {
    const writer = this.requireAccountWriter();
    const { display, effective } = await this.pluginPolicySnapshot();
    if (display == null && effective == null) throw new SlateMcpConfigError("Couldn't verify this plugin's team policy right now, so nothing was uninstalled. Try again.");
    const rows = (display?.servers ?? []).filter((server) => server.pluginId === id);
    if (rows.some((row) => row.isRequired === true) || (effective ?? []).some((plugin) => plugin.pluginId === id && plugin.installMode === "team-required"))
      throw new SlateMcpConfigError("This plugin is required by the user's team and can't be uninstalled.");
    const attributedRows = rows.filter((row) => row.isTeamServer !== true);
    await writer.uninstallPlugin({ pluginId: BigInt(id) });
    for (const row of attributedRows) {
      this.authWatches.clearPendingAuthWatchesForServer(row.id);
      const sameNameRows = display?.servers.filter((server) => server.name === row.name).length ?? 1;
      this.settingsStore.deleteMcpCustomInstructionByServerId({ serverId: row.id, displayName: row.name, deleteLegacyName: sameNameRows <= 1 });
      this.instructions.deleteDisabledToolsForServer(row.id);
    }
    return this.reloadServers();
  }

  /** What the account shows and what the plugin list says, each read on its own so one failing read is not the other. */
  private async pluginPolicySnapshot(): Promise<{ display: AccountDisplayConfig | null; effective: EffectivePluginRow[] | null }> {
    let display = this.accountDisplayConfigProvider == null ? this.lastDisplay : null;
    if (display == null && this.accountDisplayConfigProvider != null) {
      try {
        display = await this.accountDisplayConfigProvider();
        if (display != null) this.lastDisplay = display;
      } catch {
        display = this.lastDisplay;
      }
    }
    let effective: EffectivePluginRow[] | null = null;
    if (this.effectivePluginsProvider != null) {
      try {
        effective = await this.effectivePluginsProvider();
      } catch {
        effective = null;
      }
    }
    return { display, effective };
  }

  private async uninstallPluginRows(pluginId: string, serverId: string): Promise<RemoveOutcome> {
    return this.classifyRemoveOutcome(serverId, await this.performPluginUninstall(pluginId));
  }

  logoutAccount(id: string, key: string): Promise<unknown> {
    return this.slots.logoutAccount(id, key);
  }

  renameAccount(id: string, key: string, next: string): Promise<unknown> {
    return this.slots.renameAccount(id, key, next);
  }

  removeAccount(id: string, key: string): Promise<unknown> {
    return this.slots.removeAccount(id, key);
  }

  setServerCustomInstructions(args: { serverId: string; instructions: string }): Promise<unknown> {
    return this.instructions.setServerCustomInstructions(args);
  }

  listServerTools(id: string): Promise<unknown> {
    return this.instructions.listServerTools(id);
  }

  toggleMcpToolDisabled(args: { serverId: string; toolName: string }): Promise<unknown> {
    return this.instructions.toggleMcpToolDisabled(args);
  }

  getMcpCustomInstructions(): Map<string, string> {
    return this.instructions.getMcpCustomInstructions();
  }

  /** The account's servers, read again — with a row the caller already knows is gone left out of the listing. */
  async reloadServers(removed?: string): Promise<McpListingState> {
    await this.reload();
    if (removed != null && this.lastDisplay != null) this.lastDisplay = { ...this.lastDisplay, servers: this.lastDisplay.servers.filter((server) => server.id !== removed) };
    return this.listServers();
  }

  refreshAccountConfigInBackground(): void {
    this.generation += 1;
    this.accountPromise = undefined;
    this.definitionSource.refreshInBackground();
  }

  authenticateServer(rawId: string, rawKey?: string, requestingAgentId?: string | null, forceReauth?: boolean, trigger?: string | null): Promise<unknown> {
    return this.authWatches.authenticateServer(rawId, rawKey, requestingAgentId, forceReauth, trigger);
  }

  /**
   * The display row a server id names. A caller that needs a fresh read gets one and is refused rather than answered
   * from memory; everyone else reads the display and falls back to the last one only when there is no account reader.
   */
  async resolveDisplayServer(raw: string, options?: { requireFreshRead: boolean }): Promise<DisplayServer | undefined> {
    const id = validateMcpServerId(raw);
    if (options?.requireFreshRead === true && this.accountServersProvider != null) {
      const display = await this.accountServersProvider();
      if (display == null || display.unavailable === true) throw new SlateMcpConfigError("account display config unavailable");
      return display.servers.find((server) => server.id === id);
    }
    if (this.accountDisplayConfigProvider == null) {
      if (options?.requireFreshRead === true) throw new SlateMcpConfigError("no account display config provider");
      return undefined;
    }
    let display: AccountDisplayConfig | null = null;
    try {
      display = await this.accountDisplayConfigProvider();
    } catch (error) {
      if (options?.requireFreshRead === true) throw error;
    }
    if (display != null) this.lastDisplay = display;
    else if (options?.requireFreshRead === true) throw new SlateMcpConfigError("account display config unavailable");
    if (options?.requireFreshRead === true && display?.unavailable === true) throw new SlateMcpConfigError("account display config unavailable");
    return (display ?? (this.accountServersProvider == null ? this.lastDisplay : null))?.servers.find((server) => server.id === id);
  }

  noteAuthCompletedElsewhere(id: string, key: string): string | null {
    return this.authWatches.noteAuthCompletedElsewhere(id, key);
  }

  /** Taking the manager down stops the sign-ins it was still waiting for. */
  async dispose(): Promise<void> {
    this.authWatches.clearAllPendingAuthWatches();
  }

  /** The account's configuration is read again from the beginning, and the tools caches built on it are dropped. */
  async reload(): Promise<void> {
    this.generation += 1;
    this.accountPromise = undefined;
    this.definitionSource.clearCache();
    this.boxRuntime?.invalidateToolsCache?.();
    this.boxRuntime?.resetPushState?.();
  }
}

/** What removing a server or uninstalling a plugin answered. */
export interface RemoveOutcome {
  readonly state: McpListingState;
  readonly removed: boolean;
  readonly reason?: "team-server" | "still-present";
}

/** The tools of the connectors that are still enabled, in the order the backend listed them. */
function backendToolsFor(http: readonly TransportRow[], backend: readonly McpBackendToolEntry[], disabledByServer: Record<string, string[]>): McpBackendTool[] {
  return backend.flatMap((entry) => {
    const row = http.find((candidate) => backendEntryBelongsToRow(entry, candidate.identifier));
    if (row == null) return [];
    const disabled = disabledByServer[row.row.id] ?? [];
    return entry.tools.filter((tool) => !disabled.includes(tool.toolName));
  });
}

/** The box's entry for a row, when the row names a server at all. */
function boxEntryFor(byName: Map<string, McpBoxServerEntry>, identifier: string | null | undefined): McpBoxServerEntry | undefined {
  return identifier == null ? undefined : byName.get(identifier);
}
