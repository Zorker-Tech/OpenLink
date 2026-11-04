import { CATALOG_CACHE_TTL_MS } from "./mcp-catalog-cache.ts"
import { SlateMcpConfigError } from "./mcp-config-error.ts"
import { findMissingRequiredCatalogFields, type PluginVariableField } from "./mcp-plugin-variables.ts"
import type { SlateMarketplacePlugin } from "./mcp-marketplace.ts"

export interface McpCatalogInstallPort {
  installPlugin(request: { readonly pluginId: string; readonly values?: Readonly<Record<string, string>> }): Promise<unknown>
  updatePluginInstall(request: { readonly pluginId: string; readonly values: Readonly<Record<string, string>> }): Promise<unknown>
}

export interface McpCatalogCore {
  getMachineId: () => Promise<string> | string
  listEffectivePlugins?: () => Promise<Array<{ pluginId: string; hasTeamConfiguredVariables?: boolean }>>
  catalogInstallPort?: McpCatalogInstallPort
  reloadServers(): Promise<unknown>
  bestEffortToken?(getAccessToken: () => Promise<string | null | undefined>): Promise<string | undefined>
  fetchMarketplace?(getAccessToken: () => Promise<string | null | undefined>, getMachineId: () => Promise<string>): Promise<{ plugins: SlateMarketplacePlugin[]; includesPrivateMarketplaces: boolean }>
  resolveLogo?(url: string): Promise<unknown>
  now?: () => number
}

interface CatalogSnapshot {
  readonly pluginById: ReadonlyMap<string, SlateMarketplacePlugin>
  readonly views: unknown[]
  readonly receivedAtMs: number
  readonly includesPrivateMarketplaces: boolean
}

export class SlateMcpCatalogFlow {
  private snapshot: CatalogSnapshot | undefined

  constructor(private readonly core: McpCatalogCore) {}

  private clock(): number {
    return this.core.now?.() ?? Date.now()
  }

  async getCatalog(
    getAccessToken: () => Promise<string | null | undefined>,
    options?: { forceRefresh?: boolean },
  ): Promise<unknown[]> {
    const marketplace = await import("./mcp-marketplace.ts")
    const readToken = this.core.bestEffortToken ?? marketplace.bestEffortToken
    const fetchCatalog = this.core.fetchMarketplace ?? marketplace.fetchMarketplaceMcpPlugins
    const accountHasCredential = (await readToken(getAccessToken)) != null
    const previous = this.snapshot
    const sameAudience = previous?.includesPrivateMarketplaces === accountHasCredential
    const shouldReuse = options?.forceRefresh !== true && sameAudience && this.clock() - previous.receivedAtMs < CATALOG_CACHE_TTL_MS
    if (shouldReuse) return previous.views

    let result: Awaited<ReturnType<typeof fetchCatalog>>
    try {
      result = await fetchCatalog(getAccessToken, async () => await this.core.getMachineId())
    } catch (error) {
      if (!sameAudience || previous === undefined) throw error
      return previous.views
    }

    const pluginById = new Map<string, SlateMarketplacePlugin>()
    const views = result.plugins.map((plugin) => {
      pluginById.set(plugin.pluginId, plugin)
      return marketplace.marketplacePluginToView(plugin)
    })
    views.sort((left, right) => left.displayName.localeCompare(right.displayName))
    this.snapshot = {
      pluginById,
      views,
      receivedAtMs: this.clock(),
      includesPrivateMarketplaces: result.includesPrivateMarketplaces,
    }
    return views
  }

  async resolvePluginLogo(url: string): Promise<unknown> {
    if (this.core.resolveLogo !== undefined) return await this.core.resolveLogo(url)
    return await (await import("./mcp-marketplace.ts")).resolvePluginLogo(url)
  }

  private async requirePlugin(id: string, token: () => Promise<string | null | undefined>): Promise<SlateMarketplacePlugin> {
    let plugin = this.snapshot?.pluginById.get(id)
    if (plugin === undefined) {
      await this.getCatalog(token, { forceRefresh: true })
      plugin = this.snapshot?.pluginById.get(id)
    }
    if (plugin === undefined) {
      throw new SlateMcpConfigError(`Unknown marketplace plugin "${id}". Reopen settings and try again.`)
    }
    return plugin
  }

  private requirePluginValues(plugin: SlateMarketplacePlugin, values: Record<string, string | undefined>): void {
    const missing = findMissingRequiredCatalogFields(plugin.variableFields, values)
    if (missing.length === 0) return
    const labels = missing.map(({ label }) => label).join(", ")
    const keys = missing.map(({ key }) => key).join(", ")
    const suffix = missing.length === 1 ? "key" : "keys"
    throw new SlateMcpConfigError(`"${plugin.displayName}" needs a value for ${labels} before it can be installed. Ask the user for it and pass it in "values" (${suffix}: ${keys}), then try again.`)
  }

  private requireCatalogInstallPort(): McpCatalogInstallPort {
    const port = this.core.catalogInstallPort
    if (port == null) throw new SlateMcpConfigError("Managing MCP servers requires a signed-in Slate account.")
    return port
  }

  private async teamHasVariables(plugin: SlateMarketplacePlugin, alreadyKnown: boolean | undefined): Promise<boolean> {
    if (alreadyKnown === true) return true
    const listEffectivePlugins = this.core.listEffectivePlugins
    if (listEffectivePlugins === undefined) return false
    try {
      const installed = await listEffectivePlugins()
      return installed.some((entry) => entry.pluginId === plugin.pluginId && entry.hasTeamConfiguredVariables === true)
    } catch {
      return false
    }
  }

  async installEntry(
    request: { entryId: string; values?: Record<string, string>; hasTeamConfiguredVariables?: boolean },
    token: () => Promise<string | null | undefined>,
  ): Promise<unknown> {
    const plugin = await this.requirePlugin(request.entryId, token)
    const teamAlreadyHasValues = await this.teamHasVariables(plugin, request.hasTeamConfiguredVariables)
    if (!teamAlreadyHasValues) this.requirePluginValues(plugin, request.values ?? {})
    await this.requireCatalogInstallPort().installPlugin({
      pluginId: plugin.pluginId,
      ...(request.values === undefined ? {} : { values: request.values }),
    })
    return this.core.reloadServers()
  }

  async updatePluginInstall(
    request: { pluginId: string; values: Record<string, string> },
    token: () => Promise<string | null | undefined>,
  ): Promise<unknown> {
    const plugin = await this.requirePlugin(request.pluginId, token)
    this.requirePluginValues(plugin, request.values)
    await this.requireCatalogInstallPort().updatePluginInstall({ pluginId: plugin.pluginId, values: request.values })
    return this.core.reloadServers()
  }
}

export type { PluginVariableField }
