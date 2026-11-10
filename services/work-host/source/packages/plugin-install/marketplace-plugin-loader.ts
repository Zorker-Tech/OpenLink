import { mkdir, rm } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { pluginOriginFromMarketplaceName } from "../../adapters/interop/plugin-marketplace/plugin-origin.ts";
import type { BackendPluginEntry, BackendPluginListFailure } from "./backend-marketplace-client.ts";
import { DefaultPluginCacheManager } from "./marketplace.ts";
import { noopPluginMetricsLogger } from "./types.ts";
import type { LoadedPlugin, MarketplaceLoadFailure, MarketplaceLoadOptions, MarketplaceLoadResult, MarketplacePluginSourceInfo } from "./plugin-loader-contracts.ts";
import { loadPluginFromPath } from "./plugin-document-loader.ts";

interface MarketplaceVersionGroup {
  readonly marketplaceSlug: string;
  readonly pluginId: string;
  readonly versions: string[];
}

function failureKindFrom(error: unknown): MarketplaceLoadFailure["errorType"] {
  const message = error instanceof Error ? error.message : String(error);
  const rules: ReadonlyArray<readonly [RegExp, MarketplaceLoadFailure["errorType"]]> = [
    [/timed?\s*out/i, "timeout"],
    [/clone|fetch|git/i, "clone"],
    [/manifest|marketplace\.json/i, "manifest"],
    [/parse|invalid|malformed/i, "parse"],
    [/install|download|copy/i, "install"],
  ];
  return rules.find(([pattern]) => pattern.test(message))?.[1] ?? "unknown";
}

function pluginForListFailure(failure: BackendPluginListFailure): LoadedPlugin {
  return {
    identifier: {
      source: pluginOriginFromMarketplaceName(failure.marketplaceName),
      sourceInfo: {
        name: failure.pluginName,
        version: "",
        ...(failure.pluginDbId === undefined ? {} : { pluginDbId: failure.pluginDbId }),
        marketplace: failure.marketplaceName,
      },
    },
    installPath: "",
    loadError: failure.errorMessage,
    skills: [],
    rules: [],
    agents: [],
    commands: [],
    capabilities: [],
  };
}

function newFailure(
  entry: BackendPluginEntry,
  message: string,
  error: unknown,
  errorType = failureKindFrom(error),
): MarketplaceLoadFailure {
  return {
    pluginName: entry.name,
    pluginId: entry.pluginId,
    marketplaceName: entry.marketplace?.name,
    errorMessage: message,
    errorType,
  };
}

function pluginForEntryFailure(entry: BackendPluginEntry, errorMessage: string): LoadedPlugin {
  const marketplaceName = entry.marketplace?.name;
  const sourceInfo: MarketplacePluginSourceInfo = {
    name: entry.name,
    version: entry.version,
    pluginDbId: entry.pluginDbId,
    configuredVariables: entry.configuredVariables,
    marketplace: marketplaceName,
    marketplaceDbId: entry.marketplaceDbId,
    isTeamRequired: entry.isTeamRequired,
  };
  return {
    identifier: { source: pluginOriginFromMarketplaceName(marketplaceName), sourceInfo },
    installPath: "",
    loadError: errorMessage || "Plugin load failed",
    skills: [],
    rules: [],
    agents: [],
    commands: [],
    capabilities: [],
  };
}

function noteVersion(groupedVersions: Map<string, MarketplaceVersionGroup>, entry: BackendPluginEntry): void {
  const marketplaceSlug = entry.marketplace?.name;
  if (marketplaceSlug === undefined || marketplaceSlug.length === 0) return;
  const key = `${marketplaceSlug}/${entry.pluginId}`;
  let group = groupedVersions.get(key);
  if (group === undefined) {
    group = { marketplaceSlug, pluginId: entry.pluginId, versions: [] };
    groupedVersions.set(key, group);
  }
  group.versions.push(entry.version);
}

async function installOrReusePlugin(
  entry: BackendPluginEntry,
  client: MarketplaceLoadOptions["client"],
  cache: DefaultPluginCacheManager,
  logger: NonNullable<MarketplaceLoadOptions["log"]>,
): Promise<string> {
  const marketplaceSlug = entry.marketplace!.name;
  const cacheKey = { marketplaceSlug, pluginId: entry.pluginId, version: entry.version };
  if (await cache.isCached(cacheKey)) {
    const installPath = cache.getCacheDir(cacheKey);
    logger.log("info", `loadFromMarketplaceSource: Found cached plugin: ${entry.pluginId} at ${installPath}`, {
      marketplaceSlug,
      pluginId: entry.pluginId,
      gitRef: entry.version,
      marketplaceId: entry.marketplace?.id,
    });
    return installPath;
  }

  const installPath = cache.getCacheDir(cacheKey);
  logger.log("info", `loadFromMarketplaceSource: Plugin missing from cache, installing: ${entry.pluginId} at ${installPath}`, {
    marketplaceSlug,
    pluginId: entry.pluginId,
    gitRef: entry.version,
    marketplaceId: entry.marketplace?.id,
  });
  await mkdir(installPath, { recursive: true });
  try {
    await client.installPlugin(entry, installPath);
    await cache.markCacheComplete(cacheKey);
  } catch (error) {
    try {
      await rm(installPath, { recursive: true, force: true });
    } catch {
      // The original installation error is the one callers need to act on.
    }
    throw error;
  }
  return installPath;
}

async function sourceListingFailure(
  error: unknown,
  logger: NonNullable<MarketplaceLoadOptions["log"]>,
  listStartedAt: number,
): Promise<MarketplaceLoadResult> {
  const message = error instanceof Error ? error.message : String(error);
  logger.captureException(error, { error_type: "list_enabled_plugins" });
  logger.increment("marketplace.source_unavailable", 1);
  logger.log("error", `marketplace listEnabledPlugins failed after ${(performance.now() - listStartedAt).toFixed(1)}ms; treating source as unavailable: ${message}`);
  return { plugins: [], failures: [], sourceUnavailable: true };
}

async function loadOneMarketplaceEntry(
  entry: BackendPluginEntry,
  options: MarketplaceLoadOptions,
  cache: DefaultPluginCacheManager,
  logger: NonNullable<MarketplaceLoadOptions["log"]>,
): Promise<LoadedPlugin | undefined> {
  const marketplaceSlug = entry.marketplace?.name;
  if (marketplaceSlug === undefined || marketplaceSlug.length === 0) {
    const error = new Error(`Plugin ${entry.name} has no marketplace metadata — cannot determine cache path`);
    options.onPluginError?.(entry, error);
    return undefined;
  }

  const installPath = await installOrReusePlugin(entry, options.client, cache, logger);
  const sourceInfo: MarketplacePluginSourceInfo = {
    name: entry.name,
    version: entry.version,
    pluginDbId: entry.pluginDbId,
    configuredVariables: entry.configuredVariables,
    marketplace: marketplaceSlug,
    marketplaceDbId: entry.marketplaceDbId,
    isTeamRequired: entry.isTeamRequired,
  };
  const loadedPlugin = await loadPluginFromPath(
    installPath,
    pluginOriginFromMarketplaceName(marketplaceSlug),
    sourceInfo,
    { log: logger },
  );

  try {
    await cache.pruneOldVersions({ marketplaceSlug, pluginId: entry.pluginId, keepVersions: [entry.version] });
  } catch {
    // A cleanup failure does not make a successfully loaded plugin unavailable.
  }
  return loadedPlugin;
}

async function pruneVersionGroups(
  groups: Iterable<MarketplaceVersionGroup>,
  cache: DefaultPluginCacheManager,
): Promise<void> {
  for (const group of groups) {
    try {
      await cache.pruneOldVersions({
        marketplaceSlug: group.marketplaceSlug,
        pluginId: group.pluginId,
        keepVersions: group.versions,
      });
    } catch {
      // Pruning is best effort after the user's enabled versions have been loaded.
    }
  }
}

export async function loadFromMarketplaceSource(options: MarketplaceLoadOptions): Promise<MarketplaceLoadResult> {
  const logger = options.log ?? noopPluginMetricsLogger;
  const cache = options.cacheManager ?? new DefaultPluginCacheManager(options.userHomeDir);
  const overallStartedAt = performance.now();
  const listStartedAt = performance.now();

  let listing: Awaited<ReturnType<MarketplaceLoadOptions["client"]["listEnabledPlugins"]>>;
  try {
    listing = await options.client.listEnabledPlugins(options.userId, options.teamId);
  } catch (error) {
    return sourceListingFailure(error, logger, listStartedAt);
  }

  logger.log("info", `marketplace listEnabledPlugins completed in ${(performance.now() - listStartedAt).toFixed(1)}ms (${listing.plugins.length} plugins)`);
  await options.onPluginsListed?.(listing.plugins);

  const plugins: LoadedPlugin[] = [];
  const failures: MarketplaceLoadFailure[] = [];
  const versionsByPlugin = new Map<string, MarketplaceVersionGroup>();
  if (listing.listFailures !== undefined) {
    failures.push(...listing.listFailures);
    plugins.push(...listing.listFailures.map(pluginForListFailure));
  }

  for (const entry of listing.plugins) {
    if (options.pluginFilter !== undefined && !options.pluginFilter(entry)) continue;
    noteVersion(versionsByPlugin, entry);
    try {
      const loaded = await loadOneMarketplaceEntry(entry, options, cache, logger);
      if (loaded !== undefined) {
        plugins.push(loaded);
      } else {
        const error = new Error(`Plugin ${entry.name} has no marketplace metadata — cannot determine cache path`);
        failures.push(newFailure(entry, error.message, error, "manifest"));
      }
    } catch (error) {
      logger.captureException(error, { error_type: "load_plugin_from_marketplace" });
      const normalized = error instanceof Error ? error : new Error(String(error));
      failures.push(newFailure(entry, normalized.message, normalized));
      plugins.push(pluginForEntryFailure(entry, normalized.message));
      options.onPluginError?.(entry, normalized);
    }
  }

  if (options.pruneOldVersions === true) await pruneVersionGroups(versionsByPlugin.values(), cache);
  logger.log("info", `loadFromMarketplaceSource completed in ${(performance.now() - overallStartedAt).toFixed(1)}ms (${plugins.length} plugins loaded, ${failures.length} failures)`);
  return { plugins, failures, sourceUnavailable: false };
}
