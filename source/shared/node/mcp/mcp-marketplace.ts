/**
 * The marketplace's plugins, as the platform reads them.
 *
 * Two reads live here. The listing is what the marketplace offers: the plugins everyone can see, and — when the account
 * has a credential — the ones in its private marketplaces, merged by plugin id and answered sorted by name. A plugin's
 * servers are read for the plugin the caller picked: from the backend when there is a credential, and otherwise from
 * the plugin's own published config, fetched from the raw address behind each of its source urls.
 *
 * What a plugin is, is worked out from what the marketplace sent: its name is the first server's, its category is the
 * first curated key it has, its homepage falls back to its publisher's site, and the two things it may not have — a
 * private marketplace and a publisher — are only mentioned when they are really there.
 */

import type { McpServerConfig } from "./mcp-display-runtime.ts";
import { bestEffortToken, createDashboardClient, CURSOR_MARKETPLACE_REQUEST_TIMEOUT_MS } from "../marketplace/cursor-marketplace-client.ts";
import { rememberPluginLogoUrl } from "../marketplace/cursor-marketplace-logo-registry.ts";
import { pluginVariablesSchemaToFields, type PluginVariableField } from "./mcp-plugin-variables.ts";
import { createDeadlinePolicy, realClock, type DeadlinePolicy } from "../../../host/extensions/scheduling.ts";

export { bestEffortToken } from "../marketplace/cursor-marketplace-client.ts";
export { resolvePluginLogo } from "./mcp-marketplace-logo.ts";

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

/** The plugin as a surface shows it: the fields a user can fill in only when there are any. */
export function marketplacePluginToView(plugin: SlateMarketplacePlugin) {
  return {
    id: plugin.pluginId,
    name: plugin.name,
    displayName: plugin.displayName,
    description: plugin.description,
    category: plugin.category,
    homepage: plugin.homepage,
    iconUrl: plugin.logoUrl,
    connectors: plugin.connectors,
    skills: plugin.skills,
    ...(plugin.variableFields.length > 0 ? { fields: plugin.variableFields } : {}),
    ...(plugin.marketplace == null ? {} : { marketplace: plugin.marketplace }),
    ...(plugin.publisher == null ? {} : { publisher: plugin.publisher }),
  };
}

/** The raw address behind a github blob link, which is what a config can be fetched from. */
export function toRawGithubUrl(blobUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(blobUrl);
  } catch {
    return null;
  }
  if (parsed.hostname !== "github.com") return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 5 || parts[2] !== "blob") return null;
  const [owner, repo, , ref, ...rest] = parts;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${rest.join("/")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

/** What a published server entry means: the transport it names is the type this platform runs it as. */
export function normalizeServer(value: Record<string, unknown>): Record<string, unknown> {
  const { transport, ...rest } = value;
  if (typeof transport === "string" && rest.type == null) {
    if (transport === "sse") rest.type = "sse";
    else if (transport === "http" || transport === "streamableHttp") rest.type = "http";
  }
  return rest;
}

/** The servers a published config file holds, keeping only the entries that are really servers. */
export function normalizePluginConfig(raw: unknown, safeParse: (value: unknown) => { success: boolean; data?: McpServerConfig }): Record<string, McpServerConfig> {
  if (!isRecord(raw)) return {};
  // A config file wraps its servers under `mcpServers`; one that does not is already the map.
  const candidate = isRecord(raw.mcpServers) ? raw.mcpServers : raw;
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(candidate)) {
    if (!isRecord(value)) continue;
    const parsed = safeParse(normalizeServer(value));
    if (parsed.success && parsed.data != null) servers[name] = parsed.data;
  }
  return servers;
}

export interface MarketplaceDeps {
  bestEffortToken(getAccessToken: () => Promise<string | null | undefined>): Promise<string | undefined>;
  createClient(getAccessToken: () => Promise<string | null | undefined>, getMachineId: () => Promise<string>): any;
  timeoutMs: number;
  rememberPluginLogoUrl(url: string): void;
  safeParseServer(value: unknown): { success: boolean; data?: McpServerConfig };
  fetch(url: string, signal: AbortSignal): Promise<Response>;
  fetchTimeoutMs: number;
  fetchDeadline?: DeadlinePolicy;
}

export type MarketplaceListingDeps = Pick<MarketplaceDeps, "bestEffortToken" | "createClient" | "timeoutMs" | "rememberPluginLogoUrl">;

const defaultMarketplaceListingDependencies: MarketplaceListingDeps = {
  bestEffortToken,
  createClient: createDashboardClient,
  timeoutMs: CURSOR_MARKETPLACE_REQUEST_TIMEOUT_MS,
  rememberPluginLogoUrl,
};

/** The category a plugin is filed under: its first curated key in title case, and MCP when it has none. */
function categoryLabel(curatedCategoryKeys: unknown): string {
  const key = Array.isArray(curatedCategoryKeys) ? curatedCategoryKeys.find((value): value is string => typeof value === "string" && value.length > 0) : undefined;
  if (key == null) return "MCP";
  return key
    .toLowerCase()
    .split("_")
    .map((word) => (word.length > 0 ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(" ");
}

/** One plugin as the marketplace sent it, or nothing when it brings neither a server nor a skill. */
function toMarketplacePlugin(plugin: any, deps: Pick<MarketplaceDeps, "rememberPluginLogoUrl">): SlateMarketplacePlugin | null {
  const skills = plugin.skills.map((skill: any) => ({
    name: skill.name,
    description: skill.description ?? "",
    ...(skill.sourceUrl != null && skill.sourceUrl.length > 0 ? { sourceUrl: skill.sourceUrl } : {}),
  }));
  if (plugin.mcpServers.length === 0 && skills.length === 0) return null;
  const publisher = plugin.publisher;
  const logoUrl = publisher?.logoUrl || plugin.logoUrl || undefined;
  if (logoUrl != null) deps.rememberPluginLogoUrl(logoUrl);
  const marketplace = plugin.marketplace;
  return {
    pluginId: plugin.id.toString(),
    name: plugin.mcpServers[0]?.name ?? plugin.name,
    displayName: plugin.displayName.length > 0 ? plugin.displayName : plugin.name,
    description: plugin.description ?? "",
    category: categoryLabel(plugin.curatedCategoryKeys),
    logoUrl,
    homepage: plugin.repositoryUrl || publisher?.websiteUrl || undefined,
    sourceUrls: plugin.mcpServers.map((server: any) => server.sourceUrl ?? "").filter((url: string) => url.length > 0),
    connectors: plugin.mcpServers.map((server: any) => ({ name: server.name, description: server.description ?? "" })),
    skills,
    variableFields: pluginVariablesSchemaToFields(plugin.variables?.toJson()),
    // A plugin is in a marketplace only when the marketplace says whose it is.
    ...(marketplace != null && (marketplace.teamId != null || marketplace.userId != null)
      ? {
          marketplace: {
            name: marketplace.name,
            displayName: marketplace.displayName != null && marketplace.displayName.length > 0 ? marketplace.displayName : marketplace.name,
            ownership: marketplace.teamId != null ? ("team" as const) : ("user" as const),
          },
        }
      : {}),
    ...(publisher == null
      ? {}
      : {
          publisher: {
            name: publisher.name,
            displayName: publisher.displayName.length > 0 ? publisher.displayName : publisher.name,
            isUserOwned: publisher.isUserOwned,
          },
        }),
  };
}

/**
 * The plugins the marketplace offers. An account with a credential also sees the plugins in its private
 * marketplaces: one marketplace that could not be read costs its own plugins, not the listing.
 */
export async function fetchMarketplaceMcpPlugins(
  getAccessToken: () => Promise<string | null | undefined>,
  getMachineId: () => Promise<string>,
  deps: MarketplaceListingDeps = defaultMarketplaceListingDependencies,
): Promise<{ plugins: SlateMarketplacePlugin[]; includesPrivateMarketplaces: boolean }> {
  const client = deps.createClient(getAccessToken, getMachineId);
  const response = await client.listMarketplacePlugins({ excludeCloudAgentPlugins: true }, { timeoutMs: deps.timeoutMs });
  const byId = new Map<string, SlateMarketplacePlugin>();
  const add = (plugin: any): void => {
    const converted = toMarketplacePlugin(plugin, deps);
    if (converted != null) byId.set(converted.pluginId, converted);
  };
  response.plugins.forEach(add);

  const includesPrivateMarketplaces = (await deps.bestEffortToken(getAccessToken)) != null;
  if (includesPrivateMarketplaces) {
    let marketplaces: any[] = [];
    try {
      marketplaces = (await client.listMarketplaces({}, { timeoutMs: deps.timeoutMs })).marketplaces.filter((item: any) => item.teamId != null || item.userId != null);
    } catch {}
    const lists = await Promise.all(
      marketplaces.map(async (marketplace) => {
        try {
          return (await client.listMarketplacePlugins({ marketplaceId: marketplace.id, excludeCloudAgentPlugins: true }, { timeoutMs: deps.timeoutMs })).plugins;
        } catch {
          return [];
        }
      }),
    );
    lists.flat().forEach(add);
  }

  return {
    plugins: [...byId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    includesPrivateMarketplaces,
  };
}

/** A published config file's text, or nothing when it does not hold a config. */
function parseConfigText(text: string, deps: MarketplaceDeps): Record<string, McpServerConfig> {
  try {
    return normalizePluginConfig(JSON.parse(text), deps.safeParseServer);
  } catch {
    return {};
  }
}

/**
 * One plugin's servers: the backend's answer when the account has a credential, and the plugin's own published config
 * otherwise. A source that cannot be read — not a github blob link, not ok, not a config — is passed over.
 */
export async function fetchPluginServers(
  plugin: SlateMarketplacePlugin,
  getAccessToken: () => Promise<string | null | undefined>,
  getMachineId: () => Promise<string>,
  deps: MarketplaceDeps,
): Promise<Record<string, McpServerConfig>> {
  if ((await deps.bestEffortToken(getAccessToken)) != null) {
    try {
      const response = await deps.createClient(getAccessToken, getMachineId).getPluginMcpConfig({ pluginId: BigInt(plugin.pluginId) }, { timeoutMs: deps.timeoutMs });
      const parsed = parseConfigText(response.configJson ?? "", deps);
      if (Object.keys(parsed).length > 0) return parsed;
    } catch {}
  }
  const fetchDeadline = deps.fetchDeadline ?? createDeadlinePolicy(realClock, { name: "mcp-marketplace-fetch", timeoutMs: deps.fetchTimeoutMs });
  for (const sourceUrl of plugin.sourceUrls) {
    const raw = toRawGithubUrl(sourceUrl);
    if (raw == null) continue;
    try {
      const response = await fetchDeadline.run((signal) => deps.fetch(raw, signal));
      if (!response.ok) continue;
      const servers = parseConfigText(await response.text(), deps);
      if (Object.keys(servers).length > 0) return servers;
    } catch {}
  }
  return {};
}
