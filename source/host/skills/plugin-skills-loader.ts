import { join } from "node:path";
import { createSlatePluginDashboardPort } from "../../adapters/interop/plugin-marketplace/installed-plugin-dashboard-adapter.ts";
import { DefaultPluginCacheManager } from "../../packages/plugin-install/marketplace.ts";
import { createBackendMarketplaceClient, normalizeEffectiveUserPluginsResponse } from "../../packages/plugin-install/backend-marketplace-client.ts";
import { buildOriginTokenGitConfig } from "../../adapters/interop/git/origin-auth-config-adapter.ts";
import { loadFromMarketplaceSource } from "../../packages/plugin-install/loader.ts";
import { getPluginsRootDir } from "./plugin-skills-cache.ts";
import type { PluginAuthBlock } from "./plugin-skills-cache.ts";
import {
  CURRENT_USER_RPC_TIMEOUT_MS,
  EFFECTIVE_PLUGINS_RPC_TIMEOUT_MS,
  type ListedCacheKey,
  type LoadedPlugins,
  type PublisherFacts,
  type SharedInstalledPluginsLoaderDeps,
} from "./plugin-skills-contracts.ts";
import { pluginAuthBlocksFromFailures, publisherFactsFromListing } from "./plugin-skill-records.ts";

export function createSharedInstalledPluginsLoader(dependencies: SharedInstalledPluginsLoaderDeps): () => Promise<LoadedPlugins> {
  const pluginsRoot = getPluginsRootDir(dependencies.slateRootDir);
  const dashboard = dependencies.dashboardReaderForTesting ?? createSlatePluginDashboardPort(dependencies.auth);

  let signedInUserId: number | null = null;
  const readSignedInUserId = async (): Promise<number | null> => {
    if (signedInUserId != null) return signedInUserId;
    try {
      const response = await dashboard.readCurrentUser({ timeoutMs: CURRENT_USER_RPC_TIMEOUT_MS });
      signedInUserId = response.userId > 0 ? response.userId : null;
    } catch (error) {
      dependencies.log(`[slate:plugin-skills] could not resolve the signed-in user: ${error instanceof Error ? error.message : String(error)}`);
    }
    return signedInUserId;
  };

  return async () => {
    const listedCacheKeys: ListedCacheKey[] = [];
    const listedPluginIds = new Set<string>();
    let publisherFacts: Map<string, PublisherFacts> = new Map();
    let passUserId: number | null = null;

    const marketplace = createBackendMarketplaceClient(async () => {
      const response = await dashboard.listEffectivePlugins({ timeoutMs: EFFECTIVE_PLUGINS_RPC_TIMEOUT_MS });
      publisherFacts = publisherFactsFromListing(response);
      passUserId = await readSignedInUserId();
      return normalizeEffectiveUserPluginsResponse(response);
    }, {
      marketplaceCacheRoot: join(pluginsRoot, "marketplaces"),
      listOptions: { enableInlinePlugins: true },
      sparsePluginClones: dependencies.isSparsePluginClonesEnabled(),
      extraGitConfig: () => buildOriginTokenGitConfig(dependencies.auth.peekAccessToken() ?? undefined),
    });

    const loaded = await loadFromMarketplaceSource({
      client: marketplace,
      userId: "slate",
      cacheManager: new DefaultPluginCacheManager(undefined, { cacheRoot: join(pluginsRoot, "cache") }),
      pruneOldVersions: true,
      onPluginsListed: async (entries) => {
        for (const entry of entries) {
          if (entry.pluginDbId != null && entry.pluginDbId.length > 0) listedPluginIds.add(entry.pluginDbId);
          const marketplaceSlug = entry.marketplace?.name;
          if (marketplaceSlug != null && marketplaceSlug.length > 0) {
            listedCacheKeys.push({ marketplaceSlug, pluginId: entry.pluginId });
          }
        }
      },
    });

    for (const plugin of loaded.plugins) {
      const pluginDbId = plugin.identifier.sourceInfo.pluginDbId;
      if ((plugin.identifier.source === "first-party" || plugin.identifier.source === "third-party")
        && pluginDbId != null && pluginDbId.length > 0) {
        listedPluginIds.add(pluginDbId);
      }
    }
    for (const failure of loaded.failures) {
      dependencies.log(`[slate:plugin-skills] plugin ${failure.pluginName} failed to load: ${failure.errorMessage}`);
    }

    const authBlocked: PluginAuthBlock[] = pluginAuthBlocksFromFailures(loaded.failures);
    return {
      plugins: loaded.plugins,
      authBlocked,
      listedPluginIds: [...listedPluginIds],
      listedCacheKeys,
      publisherFacts,
      currentUserId: passUserId,
    };
  };
}
