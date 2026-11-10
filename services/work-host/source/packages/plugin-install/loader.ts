/** Public loading surface for installed plugins and marketplace entries. */
export { loadPluginFromPath } from "./plugin-document-loader.ts";
export { createLocalPluginFileFetcher } from "./plugin-file-fetcher.ts";
export { loadFromMarketplaceSource } from "./marketplace-plugin-loader.ts";
export type {
  LoadedAgent,
  LoadedCommand,
  LoadedPlugin,
  LoadedSkill,
  MarketplaceLoadFailure,
  MarketplaceLoaderClient,
  MarketplaceLoadOptions,
  MarketplaceLoadResult,
  MarketplacePluginSourceInfo,
  PluginHooksResult,
  PluginOrigin,
} from "./plugin-loader-contracts.ts";
