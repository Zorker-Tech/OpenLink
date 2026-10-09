/**
 * The marketplace catalog an MCP install flow works from.
 *
 * The catalog is fetched once and kept for a while, but only for as long as it answers the question that was asked: a
 * listing fetched while signed out does not stand in for one fetched while signed in (the private marketplaces are
 * only there when there is a credential), so a change either way re-fetches. A re-fetch that failed falls back to what
 * is already held — unless there is nothing to fall back to, in which case the caller hears the failure.
 *
 * Installing from the catalog is where the platform's own rules are enforced: a plugin nobody listed is refused, a
 * plugin whose required settings have no value is refused with the labels to ask for, and only a plugin whose team
 * already carries those settings may be installed without them.
 */

import { CATALOG_CACHE_TTL_MS } from "./mcp-catalog-cache.ts";
import { SlateMcpConfigError } from "./mcp-config-error.ts";
import { findMissingRequiredCatalogFields, type PluginVariableField } from "./mcp-plugin-variables.ts";
import type { SlateMarketplacePlugin } from "./mcp-marketplace.ts";

export interface McpCatalogCore {
  getMachineId: () => Promise<string> | string;
  listEffectivePlugins?: () => Promise<Array<{ pluginId: string; hasTeamConfiguredVariables?: boolean }>>;
  requireAccountWriter(): any;
  reloadServers(): Promise<unknown>;
  bestEffortToken?(getAccessToken: () => Promise<string | null | undefined>): Promise<string | undefined>;
  fetchMarketplace?(getAccessToken: () => Promise<string | null | undefined>, getMachineId: () => Promise<string>): Promise<{ plugins: SlateMarketplacePlugin[]; includesPrivateMarketplaces: boolean }>;
  resolveLogo?(url: string): Promise<unknown>;
  now?: () => number;
}

export class SlateMcpCatalogFlow {
  private readonly catalog = new Map<string, SlateMarketplacePlugin>();
  private viewsCache: { views: unknown[]; atMs: number; includesPrivateMarketplaces: boolean } | null = null;

  constructor(private readonly core: McpCatalogCore) {}

  private now(): number {
    return this.core.now?.() ?? Date.now();
  }

  async getCatalog(getAccessToken: () => Promise<string | null | undefined>, options?: { forceRefresh?: boolean }): Promise<unknown[]> {
    const marketplace = await import("./mcp-marketplace.ts");
    const bestEffort = this.core.bestEffortToken ?? marketplace.bestEffortToken;
    const fetchMarketplace = this.core.fetchMarketplace ?? marketplace.fetchMarketplaceMcpPlugins;
    const authenticated = (await bestEffort(getAccessToken)) != null;
    const cached = this.viewsCache;
    // Views fetched for one answer about the account are not handed to the other.
    const usable = cached != null && cached.includesPrivateMarketplaces === authenticated;
    const now = this.now();
    if (options?.forceRefresh !== true && usable && now - cached.atMs < CATALOG_CACHE_TTL_MS) return cached.views;

    let listing: Awaited<ReturnType<typeof fetchMarketplace>>;
    try {
      listing = await fetchMarketplace(getAccessToken, async () => await this.core.getMachineId());
    } catch (error) {
      // Nothing held is not something to fall back to: the caller learns why the catalog is not there.
      if (!usable) throw error;
      return cached.views;
    }
    this.catalog.clear();
    const views = listing.plugins
      .map((plugin) => {
        this.catalog.set(plugin.pluginId, plugin);
        return marketplace.marketplacePluginToView(plugin);
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    this.viewsCache = { views, atMs: this.now(), includesPrivateMarketplaces: listing.includesPrivateMarketplaces };
    return views;
  }

  async resolvePluginLogo(url: string): Promise<unknown> {
    if (this.core.resolveLogo != null) return await this.core.resolveLogo(url);
    return await (await import("./mcp-marketplace.ts")).resolvePluginLogo(url);
  }

  /** The plugin a caller named, re-reading the catalog once if it is not the one that was held. */
  private async requirePlugin(id: string, token: () => Promise<string | null | undefined>): Promise<SlateMarketplacePlugin> {
    let plugin = this.catalog.get(id);
    if (plugin == null) {
      await this.getCatalog(token, { forceRefresh: true });
      plugin = this.catalog.get(id);
    }
    if (plugin == null) throw new SlateMcpConfigError(`Unknown marketplace plugin "${id}". Reopen settings and try again.`);
    return plugin;
  }

  /** What the plugin needs before it can be installed, said as what to ask the user for. */
  private assertRequired(plugin: SlateMarketplacePlugin, values: Record<string, string | undefined>): void {
    const missing = findMissingRequiredCatalogFields(plugin.variableFields, values);
    if (missing.length === 0) return;
    const labels = missing.map((field) => field.label).join(", ");
    const keys = missing.map((field) => field.key).join(", ");
    throw new SlateMcpConfigError(`"${plugin.displayName}" needs a value for ${labels} before it can be installed. Ask the user for it and pass it in "values" (key${missing.length > 1 ? "s" : ""}: ${keys}), then try again.`);
  }

  /** Whether the plugin's team already carries the settings this install would otherwise have to ask for. */
  private async teamConfiguredVariables(plugin: SlateMarketplacePlugin, given: boolean | undefined): Promise<boolean> {
    if (given === true) return true;
    if (this.core.listEffectivePlugins == null) return false;
    try {
      return (await this.core.listEffectivePlugins()).some((item) => item.pluginId === plugin.pluginId && item.hasTeamConfiguredVariables === true);
    } catch {
      // A listing that could not be read is not a reason to skip the check.
      return false;
    }
  }

  async installEntry(request: { entryId: string; values?: Record<string, string>; hasTeamConfiguredVariables?: boolean }, token: () => Promise<string | null | undefined>): Promise<unknown> {
    const plugin = await this.requirePlugin(request.entryId, token);
    if (!(await this.teamConfiguredVariables(plugin, request.hasTeamConfiguredVariables))) this.assertRequired(plugin, request.values ?? {});
    await this.core.requireAccountWriter().installPlugin({
      pluginId: BigInt(plugin.pluginId),
      ...(request.values == null ? {} : { variables: request.values }),
    });
    return this.core.reloadServers();
  }

  async updatePluginInstall(request: { pluginId: string; values: Record<string, string> }, token: () => Promise<string | null | undefined>): Promise<unknown> {
    const plugin = await this.requirePlugin(request.pluginId, token);
    this.assertRequired(plugin, request.values);
    await this.core.requireAccountWriter().updatePluginInstall({ pluginId: BigInt(plugin.pluginId), variables: request.values });
    return this.core.reloadServers();
  }
}

export type { PluginVariableField };
