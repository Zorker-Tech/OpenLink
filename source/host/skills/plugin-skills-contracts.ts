import type { PluginAuthBlock, PluginSkillRecord, PluginSkillsCache } from "./plugin-skills-cache.ts";
import type { SlatePluginDashboardPort } from "../../packages/plugin-install/backend-marketplace-client.ts";

export const EFFECTIVE_PLUGINS_RPC_TIMEOUT_MS = 15_000;
export const CURRENT_USER_RPC_TIMEOUT_MS = 10_000;
export const PLUGIN_SKILLS_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export interface PluginIdentifier {
  readonly source: string;
  readonly sourceInfo: {
    readonly name: string;
    readonly pluginDbId?: string | undefined;
    readonly version?: string | undefined;
  };
}

export interface InstalledPlugin {
  readonly identifier: PluginIdentifier;
  readonly displayName?: string | null | undefined;
  readonly loadError?: unknown | undefined;
  readonly installPath: string;
  readonly skills: readonly {
    readonly name?: string | null | undefined;
    readonly description?: string | null | undefined;
    readonly path: string;
  }[];
}

export interface PublisherFacts {
  readonly publisherUserId: number | null;
  readonly marketplaceTeamId: number | null;
}

export interface PluginLoadFailure {
  readonly pluginDbId?: string | undefined;
  readonly pluginId?: string | undefined;
  readonly pluginName: string;
  readonly marketplaceName?: string | undefined;
  readonly errorMessage: string;
  readonly errorKind?: string | undefined;
}

export interface ListedCacheKey {
  readonly marketplaceSlug: string;
  readonly pluginId: string;
}

export interface LoadedPlugins {
  readonly plugins: readonly InstalledPlugin[];
  readonly authBlocked: PluginAuthBlock[];
  readonly listedPluginIds: string[];
  readonly listedCacheKeys: ListedCacheKey[];
  readonly publisherFacts: ReadonlyMap<string, PublisherFacts>;
  readonly currentUserId: number | null;
}

export interface MarketplaceListEntry {
  readonly pluginId: string;
  readonly pluginDbId?: string | null;
  readonly marketplace?: { readonly name?: string | null } | null;
}

export interface SharedInstalledPluginsLoaderDeps {
  readonly slateRootDir: string;
  readonly auth: {
    getAccessToken(args: { backendUrl: string }): Promise<string>;
    getMachineId(): Promise<string>;
    peekAccessToken(): string | null;
  };
  isSparsePluginClonesEnabled(): boolean;
  readonly dashboardReaderForTesting?: SlatePluginDashboardPort;
  log(message: string): void;
}

export interface PluginSkillsServiceOptions {
  readonly slateRootDir: string;
  readonly load: () => Promise<LoadedPlugins>;
  readonly log?: ((message: string) => void) | undefined;
  readonly reportSync?: ((event: Record<string, unknown>) => void) | undefined;
  readonly now?: (() => number) | undefined;
  readonly prune?: ((cacheRoot: string, listed: readonly ListedCacheKey[], paths: readonly string[]) => void) | undefined;
}
