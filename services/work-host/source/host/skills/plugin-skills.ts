/** Public loading, cache-record and synchronization surface for installed plugin skills. */

export {
  CURRENT_USER_RPC_TIMEOUT_MS,
  EFFECTIVE_PLUGINS_RPC_TIMEOUT_MS,
  PLUGIN_SKILLS_REFRESH_INTERVAL_MS,
} from "./plugin-skills-contracts.ts";
export type {
  InstalledPlugin,
  ListedCacheKey,
  LoadedPlugins,
  MarketplaceListEntry,
  PluginIdentifier,
  PluginLoadFailure,
  PluginSkillsServiceOptions,
  PublisherFacts,
  SharedInstalledPluginsLoaderDeps,
} from "./plugin-skills-contracts.ts";
export {
  pluginAuthBlocksFromFailures,
  pluginContentsToSkillRecords,
  pluginVersionOf,
  pruneUninstalledPluginDirs,
  publisherFactsFromListing,
  skillNameFromPath,
  skillRecordsIdentity,
  toPluginSkillInfo,
} from "./plugin-skill-records.ts";
export { createSharedInstalledPluginsLoader } from "./plugin-skills-loader.ts";
export { SlatePluginSkillsService } from "./plugin-skills-service.ts";
