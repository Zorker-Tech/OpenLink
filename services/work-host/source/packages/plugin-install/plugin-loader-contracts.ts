import type { BackendPluginEntry, BackendPluginListFailure } from "./backend-marketplace-client.ts";
import type { DefaultPluginCacheManager } from "./marketplace.ts";
import type { PluginVariableSchema } from "./manifest-parser.ts";
import type { ResolvedMcpConfig } from "./mcp-parser.ts";
import type { PluginMetricsLogger } from "./types.ts";
import type { PluginOrigin } from "./plugin-origin.ts";

export type { PluginOrigin } from "./plugin-origin.ts";

export interface MarketplacePluginSourceInfo {
  readonly name: string;
  readonly version: string;
  readonly pluginDbId?: string | undefined;
  readonly configuredVariables?: unknown;
  readonly marketplace?: string | undefined;
  readonly marketplaceDbId?: string | undefined;
  readonly isTeamRequired?: boolean | undefined;
}

export interface LoadedSkill {
  readonly path: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly globs?: string[] | undefined;
  readonly alwaysApply: boolean;
  readonly content: string;
  readonly environments?: string[] | undefined;
  readonly disabledEnvironments?: string[] | undefined;
}

export interface LoadedAgent {
  readonly path: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly tools?: string[] | undefined;
  readonly model: string;
  readonly prompt: string;
  readonly permissionMode: "readonly" | "default";
}

export interface LoadedCommand {
  readonly path: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly argumentHint?: string | undefined;
  readonly content: string;
}

export type PluginHooksResult =
  | { readonly config: import("../hooks/hook-config.ts").HookConfig; readonly sourcePath?: string | undefined }
  | { readonly error: { readonly source: "plugin-manifest"; readonly message: string } };

export interface LoadedPlugin {
  readonly identifier: { readonly source: PluginOrigin; readonly sourceInfo: MarketplacePluginSourceInfo };
  readonly installPath: string;
  readonly displayName?: string | undefined;
  readonly description?: string | undefined;
  readonly authorName?: string | undefined;
  readonly variablesSchema?: PluginVariableSchema | undefined;
  readonly skills: LoadedSkill[];
  readonly rules: LoadedSkill[];
  readonly agents: LoadedAgent[];
  readonly commands: LoadedCommand[];
  readonly mcpConfig?: ResolvedMcpConfig | undefined;
  readonly capabilities: string[];
  readonly hooks?: PluginHooksResult | undefined;
  readonly loadError?: string | undefined;
}

export interface MarketplaceLoaderClient {
  listEnabledPlugins(userId: string, teamId?: string): Promise<{
    readonly plugins: BackendPluginEntry[];
    readonly listFailures?: BackendPluginListFailure[];
  }>;
  installPlugin(entry: BackendPluginEntry, targetDir: string): Promise<void>;
}

export interface MarketplaceLoadFailure {
  readonly pluginName: string;
  readonly pluginId: string;
  readonly pluginDbId?: string | undefined;
  readonly marketplaceName?: string | undefined;
  readonly errorMessage: string;
  readonly errorType: "timeout" | "clone" | "manifest" | "parse" | "install" | "unknown";
}

export interface MarketplaceLoadOptions {
  readonly client: MarketplaceLoaderClient;
  readonly userId: string;
  readonly teamId?: string | undefined;
  readonly userHomeDir?: string | undefined;
  readonly cacheManager?: DefaultPluginCacheManager | undefined;
  readonly log?: PluginMetricsLogger | undefined;
  readonly pruneOldVersions?: boolean | undefined;
  readonly pluginFilter?: ((entry: BackendPluginEntry) => boolean) | undefined;
  readonly onPluginError?: ((entry: BackendPluginEntry, error: Error) => void) | undefined;
  readonly onPluginsListed?: ((entries: readonly BackendPluginEntry[]) => Promise<void>) | undefined;
}

export interface MarketplaceLoadResult {
  readonly plugins: LoadedPlugin[];
  readonly failures: MarketplaceLoadFailure[];
  readonly sourceUnavailable: boolean;
}

export interface PluginFileContent {
  readonly skills: LoadedSkill[];
  readonly rules: LoadedSkill[];
  readonly agents: LoadedAgent[];
  readonly commands: LoadedCommand[];
  readonly displayName?: string | undefined;
  readonly description?: string | undefined;
  readonly authorName?: string | undefined;
  readonly variablesSchema?: PluginVariableSchema | undefined;
  readonly mcpConfig: ResolvedMcpConfig | null;
  readonly capabilities: string[];
  readonly hooks?: PluginHooksResult | undefined;
}
