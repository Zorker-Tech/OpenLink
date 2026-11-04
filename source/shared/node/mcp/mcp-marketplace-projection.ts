import { resolvePublishedConfigSourceUrl } from "../../../adapters/interop/plugin-marketplace/mcp-marketplace-adapter.ts";
import type {
  MarketplacePluginSource,
  PluginVariableField,
  SlateMarketplacePlugin,
} from "./mcp-marketplace-contracts.ts";
import type { SlateMcpServerConfig } from "./mcp-display-runtime.ts";
import { pluginVariablesSchemaToFields } from "./mcp-plugin-variables.ts";

export interface MarketplacePresentation {
  readonly rememberLogoSource: (url: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The first useful topic, written as words; a catalog without one belongs to the general MCP category. */
function categoryFor(keys: readonly string[]): string {
  const key = keys.find((value) => value.length > 0);
  if (key == null) return "MCP";
  return key
    .toLowerCase()
    .split("_")
    .map((word) => (word.length > 0 ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(" ");
}

/** Converts the external-source projection into the record Slate stores in its catalog. */
export function toSlateMarketplacePlugin(
  source: MarketplacePluginSource,
  presentation: MarketplacePresentation,
): SlateMarketplacePlugin | null {
  const skills = source.skills.map((skill) => ({
    name: skill.slug,
    description: skill.summary ?? "",
    ...(skill.source != null && skill.source.length > 0 ? { sourceUrl: skill.source } : {}),
  }));
  if (source.servers.length === 0 && skills.length === 0) return null;

  const logoUrl = source.publisher?.icon || source.icon || undefined;
  if (logoUrl != null) presentation.rememberLogoSource(logoUrl);

  return {
    pluginId: source.id,
    name: source.servers[0]?.slug ?? source.slug,
    displayName: source.title.length > 0 ? source.title : source.slug,
    description: source.summary ?? "",
    category: categoryFor(source.topicKeys),
    logoUrl,
    homepage: source.homepage || source.publisher?.homepage || undefined,
    sourceUrls: source.servers
      .map((server) => server.configurationSource ?? "")
      .filter((url) => url.length > 0),
    connectors: source.servers.map((server) => ({
      name: server.slug,
      description: server.summary ?? "",
    })),
    skills,
    variableFields: pluginVariablesSchemaToFields(source.variableSchema),
    ...(source.collection?.ownerType === undefined
      ? {}
      : {
          marketplace: {
            name: source.collection.slug,
            displayName: source.collection.title != null && source.collection.title.length > 0
              ? source.collection.title
              : source.collection.slug,
            ownership: source.collection.ownerType,
          },
        }),
    ...(source.publisher == null
      ? {}
      : {
          publisher: {
            name: source.publisher.slug,
            displayName: source.publisher.title.length > 0
              ? source.publisher.title
              : source.publisher.slug,
            isUserOwned: source.publisher.isUserOwned,
          },
        }),
  };
}

/** What the catalog surface shows, omitting configuration controls that do not apply. */
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

/** The server's declared transport becomes the shape the runtime uses, unless that shape is explicit already. */
export function normalizeServer(value: Record<string, unknown>): Record<string, unknown> {
  const { transport, ...config } = value;
  if (typeof transport === "string" && config.type == null) {
    if (transport === "sse") config.type = "sse";
    else if (transport === "http" || transport === "streamableHttp") config.type = "http";
  }
  return config;
}

/** A config may be a direct server map or carry one under its conventional wrapper. */
export function normalizePluginConfig(
  raw: unknown,
  safeParse: (value: unknown) => { success: boolean; data?: SlateMcpServerConfig },
): Record<string, SlateMcpServerConfig> {
  if (!isRecord(raw)) return {};
  const candidates = isRecord(raw.mcpServers) ? raw.mcpServers : raw;
  const servers: Record<string, SlateMcpServerConfig> = {};
  for (const [name, value] of Object.entries(candidates)) {
    if (!isRecord(value)) continue;
    const parsed = safeParse(normalizeServer(value));
    if (parsed.success && parsed.data != null) servers[name] = parsed.data;
  }
  return servers;
}

export type { PluginVariableField };
export { resolvePublishedConfigSourceUrl };
