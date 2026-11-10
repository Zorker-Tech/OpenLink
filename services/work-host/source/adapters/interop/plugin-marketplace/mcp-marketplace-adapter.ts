import {
  Marketplace,
  Plugin,
} from "../proto/generated/aiserver/v1/dashboard_pb.ts";
import { createDashboardClient } from "./dashboard-client-adapter.ts";
import type {
  MarketplaceCollectionSource,
  MarketplacePluginSource,
  MarketplaceRemoteClient,
} from "../../../shared/node/mcp/mcp-marketplace-contracts.ts";

export type MarketplaceDashboardClient = Pick<
  ReturnType<typeof createDashboardClient>,
  "listMarketplacePlugins" | "listMarketplaces" | "getPluginMcpConfig"
>;

type DashboardMarketplaceClientFactory = (
  getAccessToken: () => Promise<string | null | undefined>,
  getMachineId: () => Promise<string>,
) => MarketplaceDashboardClient;

/** Projects one external listing into the fields the Slate catalog understands. */
export function projectDashboardPlugin(plugin: Plugin): MarketplacePluginSource {
  const publisher = plugin.publisher;
  const marketplace = plugin.marketplace;
  const ownerType = marketplace?.teamId != null
    ? "team"
    : marketplace?.userId != null
      ? "user"
      : undefined;

  return {
    id: plugin.id.toString(),
    slug: plugin.name,
    title: plugin.displayName,
    ...(plugin.description === undefined ? {} : { summary: plugin.description }),
    servers: plugin.mcpServers.map((server) => ({
      slug: server.name,
      ...(server.description === undefined ? {} : { summary: server.description }),
      ...(server.sourceUrl === undefined ? {} : { configurationSource: server.sourceUrl }),
    })),
    skills: plugin.skills.map((skill) => ({
      slug: skill.name,
      ...(skill.description === undefined ? {} : { summary: skill.description }),
      ...(skill.sourceUrl === undefined ? {} : { source: skill.sourceUrl }),
    })),
    ...(plugin.variables == null ? {} : { variableSchema: plugin.variables.toJson() }),
    topicKeys: [...plugin.curatedCategoryKeys],
    ...(plugin.repositoryUrl === undefined ? {} : { homepage: plugin.repositoryUrl }),
    ...(plugin.logoUrl === undefined ? {} : { icon: plugin.logoUrl }),
    ...(publisher == null
      ? {}
      : {
          publisher: {
            slug: publisher.name,
            title: publisher.displayName,
            isUserOwned: publisher.isUserOwned,
            ...(publisher.websiteUrl === undefined ? {} : { homepage: publisher.websiteUrl }),
            ...(publisher.logoUrl === undefined ? {} : { icon: publisher.logoUrl }),
          },
        }),
    ...(marketplace == null
      ? {}
      : {
          collection: {
            id: marketplace.id.toString(),
            slug: marketplace.name,
            ...(marketplace.displayName === undefined ? {} : { title: marketplace.displayName }),
            ...(ownerType === undefined ? {} : { ownerType }),
          },
        }),
  };
}

function projectOwnedMarketplace(marketplace: Marketplace): MarketplaceCollectionSource | undefined {
  const ownerType = marketplace.teamId != null
    ? "team"
    : marketplace.userId != null
      ? "user"
      : undefined;
  if (ownerType === undefined) return undefined;
  return {
    id: marketplace.id.toString(),
    slug: marketplace.name,
    ...(marketplace.displayName === undefined ? {} : { title: marketplace.displayName }),
    ownerType,
  };
}

/** The marketplace-facing operations needed by Slate, backed by the external dashboard service. */
export function createMarketplaceRemoteClient(
  getAccessToken: () => Promise<string | null | undefined>,
  getMachineId: () => Promise<string>,
  createClient: DashboardMarketplaceClientFactory = createDashboardClient,
): MarketplaceRemoteClient {
  const dashboard = createClient(getAccessToken, getMachineId);
  return {
    async listPublicPlugins(timeoutMs) {
      const response = await dashboard.listMarketplacePlugins(
        { excludeCloudAgentPlugins: true },
        { timeoutMs },
      );
      return response.plugins.map(projectDashboardPlugin);
    },
    async listOwnedCollections(timeoutMs) {
      const response = await dashboard.listMarketplaces({}, { timeoutMs });
      return response.marketplaces.flatMap((marketplace) => {
        const projected = projectOwnedMarketplace(marketplace);
        return projected === undefined ? [] : [projected];
      });
    },
    async listPluginsInCollection(collectionId, timeoutMs) {
      const response = await dashboard.listMarketplacePlugins(
        { marketplaceId: BigInt(collectionId), excludeCloudAgentPlugins: true },
        { timeoutMs },
      );
      return response.plugins.map(projectDashboardPlugin);
    },
    async readPluginServerConfig(pluginId, timeoutMs) {
      const response = await dashboard.getPluginMcpConfig(
        { pluginId: BigInt(pluginId) },
        { timeoutMs },
      );
      return response.configJson;
    },
  };
}

/** Maps a published source location to the address the interop client can fetch. */
export function resolvePublishedConfigSourceUrl(sourceUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    return null;
  }
  if (parsed.hostname !== "github.com") return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 5 || parts[2] !== "blob") return null;
  const [owner, repository, , revision, ...filePath] = parts;
  return `https://raw.githubusercontent.com/${owner}/${repository}/${revision}/${filePath.join("/")}`;
}
