/** First-party import surface for plugin installation and its external manifest adapter. */
export {
  MAX_MANIFEST_SIZE_BYTES,
  MARKETPLACE_MANIFEST_PATHS,
  PLUGIN_MANIFEST_PATHS,
  PLUGIN_ROOT_DIR_NAMES,
  containsPluginRootDir,
  normalizeMarketplaceName,
  parseAndClassifyManifestEntries,
  parseMarketplaceManifest,
  parsePluginManifest,
  parsePluginVariablesJsonSchema,
  preferredPluginManifestRootDirectory,
  resolvePluginSourcePath,
} from "../../adapters/interop/plugin-marketplace/plugin-manifest-adapter.ts";
export type {
  ClassifiedMarketplaceEntry,
  MarketplaceManifest,
  MarketplacePluginEntry,
  PluginManifest,
  PluginSource,
  PluginVariableSchema,
} from "../../adapters/interop/plugin-marketplace/plugin-manifest-adapter.ts";
export { isPathSafe } from "./plugin-path-policy.ts";
