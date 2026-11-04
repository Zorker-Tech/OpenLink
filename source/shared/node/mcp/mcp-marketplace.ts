/** Slate's marketplace catalog surface, assembled from owned policies and its interop adapter. */

export { bestEffortToken } from "../../../adapters/interop/plugin-marketplace/dashboard-client-adapter.ts";
export {
  fetchMarketplaceMcpPlugins,
  fetchPluginServers,
} from "./mcp-marketplace-fetch.ts";
export {
  marketplacePluginToView,
  normalizePluginConfig,
  normalizeServer,
  resolvePublishedConfigSourceUrl,
} from "./mcp-marketplace-projection.ts";
export { resolvePluginLogo } from "./mcp-marketplace-logo.ts";
export type {
  MarketplaceDeps,
  MarketplaceListingDeps,
  MarketplacePluginSource,
  MarketplaceRemoteClient,
  SlateMarketplacePlugin,
} from "./mcp-marketplace-contracts.ts";
