import type { SlateMcpServerConfig } from "./mcp-display-runtime.ts";
import type { DeadlinePolicy } from "../../../host/extensions/scheduling.ts";
import type { PluginVariableField } from "./mcp-plugin-variables.ts";

export type { PluginVariableField } from "./mcp-plugin-variables.ts";

export interface MarketplacePluginSource {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly summary?: string | null;
  readonly servers: readonly {
    readonly slug: string;
    readonly summary?: string | null;
    readonly configurationSource?: string | null;
  }[];
  readonly skills: readonly {
    readonly slug: string;
    readonly summary?: string | null;
    readonly source?: string | null;
  }[];
  readonly variableSchema?: unknown;
  readonly topicKeys: readonly string[];
  readonly homepage?: string | null;
  readonly icon?: string | null;
  readonly publisher?: {
    readonly slug: string;
    readonly title: string;
    readonly isUserOwned: boolean;
    readonly homepage?: string | null;
    readonly icon?: string | null;
  } | null;
  readonly collection?: {
    readonly id: string;
    readonly slug: string;
    readonly title?: string | null;
    readonly ownerType?: "team" | "user";
  } | null;
}

export interface MarketplaceCollectionSource {
  readonly id: string;
  readonly slug: string;
  readonly title?: string | null;
  readonly ownerType: "team" | "user";
}

/** The catalog's source port after the external dashboard response has been projected. */
export interface MarketplaceRemoteClient {
  listPublicPlugins(timeoutMs: number): Promise<readonly MarketplacePluginSource[]>;
  listOwnedCollections(timeoutMs: number): Promise<readonly MarketplaceCollectionSource[]>;
  listPluginsInCollection(collectionId: string, timeoutMs: number): Promise<readonly MarketplacePluginSource[]>;
  readPluginServerConfig(pluginId: string, timeoutMs: number): Promise<string | undefined>;
}

export interface SlateMarketplacePlugin {
  pluginId: string;
  name: string;
  displayName: string;
  description: string;
  category: string;
  logoUrl: string | undefined;
  homepage: string | undefined;
  sourceUrls: string[];
  connectors: Array<{ name: string; description: string }>;
  skills: Array<{ name: string; description: string; sourceUrl?: string }>;
  variableFields: PluginVariableField[];
  marketplace?: {
    name: string;
    displayName: string;
    ownership: "team" | "user";
  };
  publisher?: { name: string; displayName: string; isUserOwned: boolean };
}

export interface MarketplaceDeps {
  bestEffortToken(getAccessToken: () => Promise<string | null | undefined>): Promise<string | undefined>;
  createClient(
    getAccessToken: () => Promise<string | null | undefined>,
    getMachineId: () => Promise<string>,
  ): MarketplaceRemoteClient;
  timeoutMs: number;
  rememberLogoSource(url: string): void;
  safeParseServer(value: unknown): { success: boolean; data?: SlateMcpServerConfig };
  fetch(url: string, signal: AbortSignal): Promise<Response>;
  fetchTimeoutMs: number;
  fetchDeadline?: DeadlinePolicy;
}

export type MarketplaceListingDeps = Pick<
  MarketplaceDeps,
  "bestEffortToken" | "createClient" | "timeoutMs" | "rememberLogoSource"
>;
