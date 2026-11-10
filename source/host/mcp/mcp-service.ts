/**
 * The host's MCP service: the manager over the account's servers, the tools the model is given, and the surface the
 * host's own UI talks to.
 *
 * This is the composition root where the platform's own calls meet the ports the rest of the host reads: the account's
 * dashboard client (servers, plugins, the configuration writer, the tool exec) is adapted to what the manager asks for,
 * and what the manager answers is turned into the shapes the host's ports name. Every change the UI can make goes
 * through one place (`mutate`), so the host hears about it exactly once, and a sign-in that actually started is the
 * one change that is not a mutation of the account's servers but still tells the host to look again.
 */

import { createAccountMcpWriter, fetchAccountMcpServers, fetchEffectiveUserPlugins, type AccountMcpClient, type AccountMcpDependencies } from "../../adapters/interop/slate-backend/account-mcp.ts";
import { createMcpAccountWriterAdapters } from "../../adapters/interop/agent/mcp-catalog-install-adapter.ts";
import { createDashboardSlateBackendMcpExec, type DashboardMcpExecClient } from "../../adapters/interop/slate-backend/backend-mcp-exec.ts";
import { createMcpDashboardClient } from "../../adapters/interop/slate-backend/mcp-dashboard-client-adapter.ts";
import { getSlateInferenceBackendUrl } from "../../adapters/interop/slate-backend/slate-backend-client.ts";
import { isEffectivePluginInstalled, uninstallClearedInstallRecord } from "../../shared/mcp.ts";
import type { McpRuntimeConfig } from "../../shared/node/mcp/mcp-definition-source.ts";
import type { SlateMcpAccountDisplay, SlateMcpDisplayRow } from "../../shared/node/mcp/mcp-display-runtime.ts";
import type { McpCatalogInstallPort } from "../../shared/node/mcp/mcp-catalog-flow.ts";
import { SlateMcpManager, type McpAccountWriterPort, type McpBackendExecPort, type McpManagerSettingsPort } from "../../shared/node/mcp/mcp-manager.ts";
import { createMcpToolsDiscovery, SlateMcpExecutor } from "../../shared/node/mcp/tools-discovery.ts";
import type { CapableBox } from "../boxes/box-capabilities.ts";
import { createMcpStateExecutorAdapter } from "../../adapters/interop/mcp/mcp-state-executor-adapter.ts";
import {
  asMcpBackendExecPort,
  authOutcomeFromManager,
  catalogViewsOf,
  serverStateFromManager,
  toAuthResult,
  toCatalogFields,
  toInstalledServer,
  toInstalledServers,
} from "../../adapters/interop/mcp/host-service-adapter.ts";
import { createBoxSlateMcpExec, type BoxMcpExecPort } from "../../adapters/interop/agent/box-mcp-exec-adapter.ts";
import type { CatalogField, CatalogPlugin, EffectivePlugin, McpServerSummary, ServerState } from "./mcp-service-contracts.ts";

/** One server as the host's own port names it, and the catalog's views as the marketplace names them. */
/** The plugin skills a change to the account's plugins has to be told about. */
export interface PluginSkillsPort {
  sync(trigger: string): Promise<unknown[]>;
  status(): unknown;
  removeLiveReferences?(sourceUrls: readonly string[]): void;
}

/**
 * One plugin in the catalog, with what this account's own list and rows say about it: a plugin is installed when the
 * account's list says so, or when the list said nothing about it and one of the account's servers belongs to it.
 */
export function toPluginSummary(view: CatalogPlugin, effectivePlugins: readonly EffectivePlugin[] | null, servers: readonly McpServerSummary[]): Record<string, unknown> {
  const record = effectivePlugins?.find((plugin) => plugin.pluginId === view.id);
  const effective = record != null && isEffectivePluginInstalled(record) ? record : undefined;
  const attributed = servers.find((server) => server.pluginId === view.id);
  const installed = effective != null || (record == null && attributed != null);
  return {
    pluginId: view.id,
    name: view.name,
    displayName: view.displayName,
    description: view.description,
    category: view.category,
    isInstalled: installed,
    ...(installed ? { installMode: effective?.installMode ?? "unknown" } : {}),
    connectorCount: view.connectors?.length ?? 1,
    skills: (view.skills ?? []).map(({ name, description }) => ({ name, description })),
  };
}

/** A skills sync is background work: a failure is not this call's to carry. */
export function syncPluginSkillsInBackground(pluginSkills: PluginSkillsPort | undefined, trigger: string): void {
  void pluginSkills?.sync(trigger).catch(() => {});
}

/**
 * The backend's tool exec in the shape the manager's ports name. The wire takes a connector id as the decimal string it
 * is, and the calls that own one pass the number they parsed, so the host converts here; the wire's own status is only
 * handed on when it is something the listing can read.
 */
export interface CreateHostMcpOptions {
  accountConfigProvider?: () => Promise<McpRuntimeConfig | null>;
  accountDisplayConfigProvider?: () => Promise<SlateMcpAccountDisplay | null>;
  accountServersProvider?: () => Promise<SlateMcpAccountDisplay | null>;
  accountMcpWriter?: McpAccountWriterPort;
  catalogInstallPort?: McpCatalogInstallPort;
  backendMcpExec: McpBackendExecPort;
  settingsStore?: McpManagerSettingsPort;
  effectivePluginsProvider?: () => Promise<EffectivePlugin[]>;
  boxMcpExec?: BoxMcpExecPort;
  getMachineId: () => Promise<string>;
  getAccessToken?: () => Promise<string | null>;
  pluginSkills?: PluginSkillsPort;
  onServersMutated?: () => void;
  onServerAuthenticated?: (completion: unknown) => void;
  onDiscoveryFailed?: (event: Record<string, unknown>) => void;
  onConnectorAuth?: (event: Record<string, unknown>) => void;
  log?: (message: string) => void;
}

/** What the model is given: the tools of the account's connectors and the ones this host discovered. */
export interface McpToolSurface {
  getTools(ctx?: unknown): Promise<unknown[]>;
  listTools(ctx?: unknown): Promise<unknown[]>;
  createExecutor(persistImage?: unknown, spillLargeText?: unknown, auditIdentity?: unknown): SlateMcpExecutor;
  refreshAccountConfig(): void;
  createStateExecutor(): ReturnType<typeof createMcpStateExecutorAdapter>;
  getCustomInstructions(): Map<string, string>;
  resolveToolTransport(id: string): Promise<unknown>;
  resolveNeedsAuthSlot(id: string): Promise<{ serverId: string; serverName: string } | null>;
}

/** What the host's UI can do to the account's servers and plugins. */
export interface McpManagementSurface {
  listInstalled(): Promise<Record<string, unknown>[]>;
  listPlugins(): Promise<Record<string, unknown>[]>;
  getPlugin(pluginId: string): Promise<Record<string, unknown> | null>;
  uninstallPlugin(pluginId: string): Promise<{ removed: boolean; reason?: string }>;
  setInstructions(args: { serverId: string; instructions: string }): Promise<Record<string, unknown>[]>;
  install(args: { id: string; values?: Record<string, string> }): Promise<Record<string, unknown>[]>;
  add(args: { name: string; configJson: string }): Promise<Record<string, unknown>[]>;
  removeServer(serverId: string): Promise<{ removed: boolean; reason?: string; servers: Record<string, unknown>[] }>;
  restart(): Promise<Record<string, unknown>[]>;
  authenticate(serverId: string, accountKey: string, requestingAgentId?: string, forceReauth?: boolean): Promise<Record<string, unknown>>;
  logoutAccount(args: { serverId: string; accountKey: string }): Promise<Record<string, unknown>[]>;
  renameAccount(args: { serverId: string; accountKey: string; newAccountKey: string }): Promise<Record<string, unknown>[]>;
  removeAccount(args: { serverId: string; accountKey: string }): Promise<Record<string, unknown>[]>;
}

export interface McpHostPort {
  mcp: McpToolSurface;
  management: McpManagementSurface;
  setSettingsStore(settings: McpManagerSettingsPort): void;
  listBoxServers(ids: readonly string[], options?: { kickOnly?: boolean }): Promise<Array<{ serverIdentifier: string; status: string; statusDetail?: string; toolCount: number }>>;
  noteAuthCompletedElsewhere(serverId: string, accountKey: string): string | null;
  setBoxMcpExec(exec: BoxMcpExecPort): void;
  dispose(): Promise<void>;
}

export function createHostMcp(deps: CreateHostMcpOptions): McpHostPort {
  const log = deps.log ?? ((message: string) => console.log(`[slate:mcp] ${message}`));
  const manager = new SlateMcpManager({
    includeBuiltins: false,
    ...(deps.accountConfigProvider === undefined ? {} : { accountConfigProvider: deps.accountConfigProvider }),
    ...(deps.accountDisplayConfigProvider === undefined ? {} : { accountDisplayConfigProvider: deps.accountDisplayConfigProvider }),
    ...(deps.accountServersProvider === undefined ? {} : { accountServersProvider: deps.accountServersProvider }),
    ...(deps.accountMcpWriter === undefined ? {} : { accountMcpWriter: deps.accountMcpWriter }),
    ...(deps.catalogInstallPort === undefined ? {} : { catalogInstallPort: deps.catalogInstallPort }),
    backendMcpExec: deps.backendMcpExec,
    ...(deps.settingsStore === undefined ? {} : { settingsStore: deps.settingsStore }),
    ...(deps.effectivePluginsProvider === undefined ? {} : { effectivePluginsProvider: deps.effectivePluginsProvider }),
    ...(deps.onConnectorAuth === undefined ? {} : { onConnectorAuth: deps.onConnectorAuth }),
    getMachineId: deps.getMachineId,
    // The manager parses what a user typed into a server's configuration itself, from the JSON it was handed.
    parseServerConfig: (value) => value as SlateMcpDisplayRow["config"],
  });
  const discovery = createMcpToolsDiscovery(
    {
      definitionSource: manager.definitionSourceView(),
      lastAccountDisplayConfig: () => manager.lastAccountDisplayConfigView(),
      settingsStore: () => manager.settingsStoreView(),
      backendMcpExec: deps.backendMcpExec,
    },
    {
      ...(deps.boxMcpExec === undefined ? {} : { boxMcpExec: deps.boxMcpExec }),
      ...(deps.onDiscoveryFailed === undefined ? {} : { onDiscoveryFailed: deps.onDiscoveryFailed }),
      ...(deps.onConnectorAuth === undefined ? {} : { onConnectorAuth: deps.onConnectorAuth }),
    },
  );
  manager.setBoxRuntime(discovery);
  const token = deps.getAccessToken ?? (async () => null);
  if (deps.onServerAuthenticated != null) manager.setAuthCompletionObserver(deps.onServerAuthenticated);
  /** The account's own plugin list is a best effort: a read that failed is a listing without it, not a listing that fails. */
  const readEffective = async (): Promise<EffectivePlugin[] | null> => {
    try {
      return await manager.listEffectivePlugins();
    } catch (error) {
      log(`effective-plugins read degraded to attributed rows: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };
  /** Every change goes through here, so the host is told to look again exactly once per change. */
  const mutate = async <T>(work: () => Promise<T>): Promise<T> => {
    const result = await work();
    deps.onServersMutated?.();
    return result;
  };
  /** The source urls a plugin's skills live at, as far as the catalog can say right now. */
  const skillSourceUrls = async (pluginId: string): Promise<string[]> => {
    const views = catalogViewsOf(await manager.getCatalog(token));
    return views.find((view) => view.id === pluginId)?.skills?.flatMap((skill) => (skill.sourceUrl == null ? [] : [skill.sourceUrl])) ?? [];
  };
  const management: McpManagementSurface = {
    listInstalled: async () => toInstalledServers(await manager.listServers()),
    listPlugins: async () => {
      const [views, state, effective] = await Promise.all([manager.getCatalog(token), manager.listServers(), readEffective()]);
      return catalogViewsOf(views).map((view) => toPluginSummary(view, effective, state.servers));
    },
    getPlugin: async (pluginId: string) => {
      let views = catalogViewsOf(await manager.getCatalog(token));
      let view = views.find((entry) => entry.id === pluginId);
      // A plugin the held catalog does not know is looked for once more in a fresh one before saying it is not there.
      if (view == null) {
        views = catalogViewsOf(await manager.getCatalog(token, { forceRefresh: true }));
        view = views.find((entry) => entry.id === pluginId);
      }
      if (view == null) return null;
      const [state, effective] = await Promise.all([manager.listServers(), readEffective()]);
      return {
        ...toPluginSummary(view, effective, state.servers),
        fields: toCatalogFields(view.fields),
        servers: state.servers.filter((server) => server.pluginId === view.id).map(toInstalledServer),
      };
    },
    uninstallPlugin: async (pluginId: string) => {
      let urls: string[] = [];
      try {
        urls = await skillSourceUrls(pluginId);
      } catch {}
      const result = await mutate(() => manager.uninstallPlugin(pluginId));
      // A plugin that is no longer installed for this account keeps no live references to its skills.
      if (uninstallClearedInstallRecord(result)) {
        try {
          deps.pluginSkills?.removeLiveReferences?.(urls);
        } catch {}
        syncPluginSkillsInBackground(deps.pluginSkills, "uninstall");
      }
      return { removed: result.removed, ...(result.reason == null ? {} : { reason: result.reason }) };
    },
    setInstructions: async (args: { serverId: string; instructions: string }) => toInstalledServers(serverStateFromManager(await mutate(() => manager.setServerCustomInstructions(args)))),
    install: async (args: { id: string; values?: Record<string, string> }) => {
      const servers = toInstalledServers(serverStateFromManager(await mutate(() => manager.installEntry({ entryId: args.id, ...(args.values == null ? {} : { values: args.values }) }, token))));
      try {
        deps.pluginSkills?.removeLiveReferences?.(await skillSourceUrls(args.id));
      } catch {}
      syncPluginSkillsInBackground(deps.pluginSkills, "install");
      return servers;
    },
    add: async (args: { name: string; configJson: string }) => toInstalledServers(serverStateFromManager(await mutate(() => manager.addServer(args)))),
    removeServer: async (serverId: string) => {
      const result = await mutate(() => manager.removeServer(serverId));
      return { removed: result.removed, ...(result.reason == null ? {} : { reason: result.reason }), servers: toInstalledServers(result.state) };
    },
    restart: async () => toInstalledServers(serverStateFromManager(await mutate(() => manager.reloadServers()))),
    // A sign-in that started changed nothing about the account's servers yet, but the host should look again.
    authenticate: async (serverId: string, accountKey: string, requestingAgentId?: string, forceReauth?: boolean) => {
      const result = toAuthResult(authOutcomeFromManager(await manager.authenticateServer(serverId, accountKey, requestingAgentId ?? null, forceReauth)));
      if (result["kind"] === "started") deps.onServersMutated?.();
      return result;
    },
    logoutAccount: async (args: { serverId: string; accountKey: string }) => toInstalledServers(serverStateFromManager(await mutate(() => manager.logoutAccount(args.serverId, args.accountKey)))),
    renameAccount: async (args: { serverId: string; accountKey: string; newAccountKey: string }) => toInstalledServers(serverStateFromManager(await mutate(() => manager.renameAccount(args.serverId, args.accountKey, args.newAccountKey)))),
    removeAccount: async (args: { serverId: string; accountKey: string }) => toInstalledServers(serverStateFromManager(await mutate(() => manager.removeAccount(args.serverId, args.accountKey)))),
  };
  return {
    mcp: {
      getTools: (ctx?: unknown) => discovery.getToolsForTurnStart(ctx),
      // The account's own tools come first: a name the platform already knows is not discovered twice.
      listTools: async (ctx?: unknown) => {
        const connected = await manager.listConnectedBackendTools();
        const discovered = await discovery.getTools(ctx);
        const byName = new Map<string, unknown>();
        for (const tool of [...connected, ...(discovered as readonly { name: string }[])])
          if (!byName.has(tool.name)) byName.set(tool.name, tool);
        return [...byName.values()];
      },
      createExecutor: (persistImage?: unknown, spillLargeText?: unknown, auditIdentity?: unknown) => new SlateMcpExecutor(discovery, persistImage, spillLargeText, auditIdentity),
      refreshAccountConfig: () => manager.refreshAccountConfigInBackground(),
      createStateExecutor: () => createMcpStateExecutorAdapter({ getTools: (ctx: unknown) => discovery.getTools(ctx) }),
      getCustomInstructions: () => manager.getMcpCustomInstructions(),
      resolveToolTransport: (id: string) => discovery.resolveProviderTransport(id),
      resolveNeedsAuthSlot: async (id: string) => {
        const summary = (await manager.listServers()).servers.find((server) => server.serverIdentifier === id && server.status === "needsAuth");
        return summary == null ? null : { serverId: summary.id, serverName: summary.name };
      },
    },
    management,
    setSettingsStore: (settings: McpManagerSettingsPort) => manager.setSettingsStore(settings),
    listBoxServers: (ids: readonly string[], options?: { kickOnly?: boolean }) => discovery.listBoxServers([...ids], options),
    noteAuthCompletedElsewhere: (serverId: string, accountKey: string) => manager.noteAuthCompletedElsewhere(serverId, accountKey),
    setBoxMcpExec: (exec: BoxMcpExecPort) => discovery.setBoxMcpExec(exec),
    dispose: () => manager.dispose(),
  };
}

export interface McpHostServiceDeps {
  auth: {
    getAccessToken(args: { backendUrl: string }): Promise<string>;
    getMachineId(): Promise<string>;
  };
  foreverBox: { readonly box: CapableBox };
  settings: McpManagerSettingsPort;
  log(message: string): void;
  pluginSkills?: PluginSkillsPort;
  onDiscoveryFailed?: (event: Record<string, unknown>) => void;
  onConnectorAuth?: (event: Record<string, unknown>) => void;
}

/** What the host's UI is given: the two surfaces, the box's own listing, and the two subscriptions it can hold. */
export interface McpHostServiceApi {
  mcp: McpToolSurface;
  management: McpManagementSurface;
  listBoxServers(ids: readonly string[]): Promise<Array<{ serverIdentifier: string; status: string; statusDetail?: string; toolCount: number }>>;
  subscribeToAuthCompletion(listener: (event: unknown) => void): () => boolean;
  noteAuthCompletedElsewhere(serverId: string, accountKey: string): string | null;
  subscribeToServersUpdated(listener: (event: { servers: unknown[] }) => void): () => boolean;
  syncPluginSkills(): Promise<unknown[]>;
  pluginSyncStatus(): unknown;
}

export class McpHostService {
  readonly authCompletionListeners = new Set<(event: unknown) => void>();
  readonly serversUpdatedListeners = new Set<(event: { servers: unknown[] }) => void>();
  readonly statusFollowUps = new Map<string, Promise<void>>();
  private disposed = false;
  readonly hostMcp: McpHostPort;
  readonly api: McpHostServiceApi;

  constructor(readonly deps: McpHostServiceDeps) {
    const accountMcpDeps: AccountMcpDependencies = {
      getAccessToken: (options) => deps.auth.getAccessToken({ backendUrl: options?.backendUrl ?? getSlateInferenceBackendUrl() }),
      getMachineId: deps.auth.getMachineId,
      getBackendUrl: getSlateInferenceBackendUrl,
      createClient: (credentials) => createMcpDashboardClient(credentials) as AccountMcpClient,
    };
    const backendMcpExec = asMcpBackendExecPort(
      createDashboardSlateBackendMcpExec({
        getAccessToken: accountMcpDeps.getAccessToken,
        getMachineId: accountMcpDeps.getMachineId,
        createClient: (credentials) => createMcpDashboardClient(credentials) as DashboardMcpExecClient,
      }),
    );
    const accountWriterPorts = createMcpAccountWriterAdapters(createAccountMcpWriter(accountMcpDeps));
    this.hostMcp = createHostMcp({
      log: deps.log,
      onServerAuthenticated: (completion) => this.emitAuthCompletion(completion),
      onServersMutated: () => this.emitServersUpdated({ servers: [] }),
      ...(deps.pluginSkills == null ? {} : { pluginSkills: deps.pluginSkills }),
      getAccessToken: async () => {
        try {
          const token = await deps.auth.getAccessToken({ backendUrl: getSlateInferenceBackendUrl() });
          return token.length > 0 ? token : null;
        } catch {
          return null;
        }
      },
      getMachineId: deps.auth.getMachineId,
      accountServersProvider: () => fetchAccountMcpServers(accountMcpDeps),
      accountMcpWriter: accountWriterPorts.accountWriter,
      catalogInstallPort: accountWriterPorts.catalogInstallPort,
      effectivePluginsProvider: () => fetchEffectiveUserPlugins(accountMcpDeps),
      backendMcpExec,
      boxMcpExec: createBoxSlateMcpExec(deps.foreverBox.box),
      settingsStore: deps.settings,
      ...(deps.onDiscoveryFailed === undefined ? {} : { onDiscoveryFailed: deps.onDiscoveryFailed }),
      ...(deps.onConnectorAuth === undefined ? {} : { onConnectorAuth: deps.onConnectorAuth }),
    });
    this.api = {
      mcp: this.hostMcp.mcp,
      management: this.hostMcp.management,
      listBoxServers: (ids: readonly string[]) => this.listBoxServers(ids),
      subscribeToAuthCompletion: (listener: (event: unknown) => void) => {
        this.authCompletionListeners.add(listener);
        return () => this.authCompletionListeners.delete(listener);
      },
      noteAuthCompletedElsewhere: (serverId: string, accountKey: string) => this.hostMcp.noteAuthCompletedElsewhere(serverId, accountKey),
      subscribeToServersUpdated: (listener: (event: { servers: unknown[] }) => void) => {
        this.serversUpdatedListeners.add(listener);
        return () => this.serversUpdatedListeners.delete(listener);
      },
      syncPluginSkills: async () => (await deps.pluginSkills?.sync("desktop")) ?? [],
      pluginSyncStatus: () => deps.pluginSkills?.status() ?? { authBlocked: [] },
    };
  }

  setSettingsStore(settings: McpManagerSettingsPort): void {
    this.hostMcp.setSettingsStore(settings);
  }

  setBoxMcpExec(exec: BoxMcpExecPort): void {
    this.hostMcp.setBoxMcpExec(exec);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.authCompletionListeners.clear();
    this.serversUpdatedListeners.clear();
    this.statusFollowUps.clear();
    await this.hostMcp.dispose();
  }

  async listBoxServers(ids: readonly string[]) {
    const servers = await this.hostMcp.listBoxServers(ids, { kickOnly: true });
    this.scheduleStatusFollowUps(servers);
    return servers.map(({ serverIdentifier, status, statusDetail, toolCount }) => ({ serverIdentifier, status, ...(statusDetail == null ? {} : { statusDetail }), toolCount }));
  }

  /** A server still starting or in error is asked about again once, and the host hears what changed. */
  scheduleStatusFollowUps(servers: readonly { serverIdentifier: string; status: string }[]): void {
    if (this.disposed) return;
    for (const server of servers) {
      if ((server.status !== "loading" && server.status !== "error") || this.statusFollowUps.has(server.serverIdentifier)) continue;
      const id = server.serverIdentifier;
      const followUp = (async () => {
        try {
          const [updated] = await this.hostMcp.listBoxServers([id]);
          if (!this.disposed && updated != null)
            this.emitServersUpdated({
              servers: [{ serverIdentifier: updated.serverIdentifier, status: updated.status, ...(updated.statusDetail == null ? {} : { statusDetail: updated.statusDetail }), toolCount: updated.toolCount }],
            });
        } catch (error) {
          if (!this.disposed) this.deps.log(`[slate:mcp] box MCP status follow-up failed for ${id}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          this.statusFollowUps.delete(id);
        }
      })();
      this.statusFollowUps.set(id, followUp);
    }
  }

  emitAuthCompletion(event: unknown): void {
    if (!this.disposed) for (const listener of this.authCompletionListeners) listener(event);
  }

  emitServersUpdated(event: { servers: unknown[] }): void {
    if (!this.disposed) for (const listener of this.serversUpdatedListeners) listener(event);
  }
}

export function createMcpService(deps: McpHostServiceDeps): McpHostService {
  return new McpHostService(deps);
}
