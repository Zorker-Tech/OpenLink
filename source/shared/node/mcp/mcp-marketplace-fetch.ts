import {
  bestEffortToken,
  MARKETPLACE_REQUEST_TIMEOUT_MS,
} from "../../../adapters/interop/plugin-marketplace/dashboard-client-adapter.ts";
import { createMarketplaceRemoteClient } from "../../../adapters/interop/plugin-marketplace/mcp-marketplace-adapter.ts";
import { createDeadlinePolicy, realClock } from "../../../host/extensions/scheduling.ts";
import { rememberMarketplaceLogoSource } from "../marketplace/marketplace-logo-registry.ts";
import type {
  MarketplaceDeps,
  MarketplaceListingDeps,
  SlateMarketplacePlugin,
} from "./mcp-marketplace-contracts.ts";
import { normalizePluginConfig, toSlateMarketplacePlugin } from "./mcp-marketplace-projection.ts";
import { resolvePublishedConfigSourceUrl } from "../../../adapters/interop/plugin-marketplace/mcp-marketplace-adapter.ts";

const defaultListingDependencies: MarketplaceListingDeps = {
  bestEffortToken,
  createClient: createMarketplaceRemoteClient,
  timeoutMs: MARKETPLACE_REQUEST_TIMEOUT_MS,
  rememberLogoSource: rememberMarketplaceLogoSource,
};

function parseConfigText(text: string, deps: MarketplaceDeps) {
  try {
    return normalizePluginConfig(JSON.parse(text), deps.safeParseServer);
  } catch {
    return {};
  }
}

/** Lists the public catalog and, when available, adds owned collections independently. */
export async function fetchMarketplaceMcpPlugins(
  getAccessToken: () => Promise<string | null | undefined>,
  getMachineId: () => Promise<string>,
  deps: MarketplaceListingDeps = defaultListingDependencies,
): Promise<{ plugins: SlateMarketplacePlugin[]; includesPrivateMarketplaces: boolean }> {
  const client = deps.createClient(getAccessToken, getMachineId);
  const byId = new Map<string, SlateMarketplacePlugin>();
  const add = (source: Parameters<typeof toSlateMarketplacePlugin>[0]): void => {
    const plugin = toSlateMarketplacePlugin(source, { rememberLogoSource: deps.rememberLogoSource });
    if (plugin != null) byId.set(plugin.pluginId, plugin);
  };

  (await client.listPublicPlugins(deps.timeoutMs)).forEach(add);
  const includesPrivateMarketplaces = (await deps.bestEffortToken(getAccessToken)) != null;
  if (includesPrivateMarketplaces) {
    let collections;
    try {
      collections = await client.listOwnedCollections(deps.timeoutMs);
    } catch {
      collections = [];
    }
    const listings = await Promise.all(collections.map(async (collection) => {
      try {
        return await client.listPluginsInCollection(collection.id, deps.timeoutMs);
      } catch {
        return [];
      }
    }));
    listings.flat().forEach(add);
  }

  return {
    plugins: [...byId.values()].sort((left, right) => left.displayName.localeCompare(right.displayName)),
    includesPrivateMarketplaces,
  };
}

/** Uses the backend config when available, then checks each usable published source in order. */
export async function fetchPluginServers(
  plugin: SlateMarketplacePlugin,
  getAccessToken: () => Promise<string | null | undefined>,
  getMachineId: () => Promise<string>,
  deps: MarketplaceDeps,
): Promise<Record<string, import("./mcp-display-runtime.ts").SlateMcpServerConfig>> {
  if ((await deps.bestEffortToken(getAccessToken)) != null) {
    try {
      const client = deps.createClient(getAccessToken, getMachineId);
      const config = await client.readPluginServerConfig(plugin.pluginId, deps.timeoutMs);
      const servers = parseConfigText(config ?? "", deps);
      if (Object.keys(servers).length > 0) return servers;
    } catch {
      // A backend read that failed or contained no usable servers falls through to the published sources.
    }
  }

  const deadline = deps.fetchDeadline ?? createDeadlinePolicy(realClock, {
    name: "mcp-marketplace-fetch",
    timeoutMs: deps.fetchTimeoutMs,
  });
  for (const sourceUrl of plugin.sourceUrls) {
    const address = resolvePublishedConfigSourceUrl(sourceUrl);
    if (address == null) continue;
    try {
      const response = await deadline.run((signal) => deps.fetch(address, signal));
      if (!response.ok) continue;
      const servers = parseConfigText(await response.text(), deps);
      if (Object.keys(servers).length > 0) return servers;
    } catch {
      // A bad source is skipped so the next published source can answer.
    }
  }
  return {};
}
