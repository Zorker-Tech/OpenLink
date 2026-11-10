import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Marketplace, Plugin } from "../../source/adapters/interop/proto/generated/aiserver/v1/dashboard_pb.ts";
import {
  createMarketplaceRemoteClient,
  projectDashboardPlugin,
  resolvePublishedConfigSourceUrl,
  type MarketplaceDashboardClient,
} from "../../source/adapters/interop/plugin-marketplace/mcp-marketplace-adapter.ts";

const plugin = {
  id: 7n,
  name: "plugin-slug",
  displayName: "Plugin title",
  description: "What it does",
  mcpServers: [
    { name: "search", description: "Search connector", sourceUrl: "https://github.com/org/repo/blob/main/mcp.json" },
  ],
  skills: [{ name: "review", description: "Review skill", sourceUrl: "https://example.test/review.md" }],
  variables: { toJson: () => ({ properties: { token: { format: "password" } }, required: ["token"] }) },
  curatedCategoryKeys: ["dev_tools"],
  repositoryUrl: "https://example.test/plugin",
  logoUrl: "https://example.test/logo.png",
  publisher: {
    name: "publisher-slug",
    displayName: "Publisher title",
    isUserOwned: true,
    websiteUrl: "https://example.test/publisher",
    logoUrl: "https://example.test/publisher.png",
  },
  marketplace: { id: 11n, name: "team-tools", displayName: "Team tools", teamId: 3, userId: undefined },
} as unknown as Plugin;

describe("projecting dashboard marketplace data", () => {
  it("converts one remote listing to the source record Slate uses", () => {
    assert.deepEqual(projectDashboardPlugin(plugin), {
      id: "7",
      slug: "plugin-slug",
      title: "Plugin title",
      summary: "What it does",
      servers: [{ slug: "search", summary: "Search connector", configurationSource: "https://github.com/org/repo/blob/main/mcp.json" }],
      skills: [{ slug: "review", summary: "Review skill", source: "https://example.test/review.md" }],
      variableSchema: { properties: { token: { format: "password" } }, required: ["token"] },
      topicKeys: ["dev_tools"],
      homepage: "https://example.test/plugin",
      icon: "https://example.test/logo.png",
      publisher: {
        slug: "publisher-slug",
        title: "Publisher title",
        isUserOwned: true,
        homepage: "https://example.test/publisher",
        icon: "https://example.test/publisher.png",
      },
      collection: { id: "11", slug: "team-tools", title: "Team tools", ownerType: "team" },
    });
  });

  it("keeps dashboard methods and protobuf identifiers behind the adapter", async () => {
    const calls: unknown[] = [];
    const dashboard = {
      async listMarketplacePlugins(request: unknown, options: { timeoutMs: number }) {
        calls.push({ method: "listMarketplacePlugins", request, timeoutMs: options.timeoutMs });
        return { plugins: [plugin] };
      },
      async listMarketplaces(request: unknown, options: { timeoutMs: number }) {
        calls.push({ method: "listMarketplaces", request, timeoutMs: options.timeoutMs });
        return { marketplaces: [
          new Marketplace({ id: 11n, name: "team-tools", displayName: "", teamId: 3 }),
          new Marketplace({ id: 12n, name: "public-tools" }),
        ] };
      },
      async getPluginMcpConfig(request: unknown, options: { timeoutMs: number }) {
        calls.push({ method: "getPluginMcpConfig", request, timeoutMs: options.timeoutMs });
        return { configJson: "{\"mcpServers\":{}}" };
      },
    } as unknown as MarketplaceDashboardClient;
    const client = createMarketplaceRemoteClient(
      async () => "token",
      async () => "machine",
      () => dashboard,
    );

    assert.equal((await client.listPublicPlugins(5_000))[0]?.id, "7");
    assert.deepEqual(await client.listOwnedCollections(6_000), [
      { id: "11", slug: "team-tools", title: "", ownerType: "team" },
    ]);
    assert.equal((await client.listPluginsInCollection("11", 7_000))[0]?.id, "7");
    assert.equal(await client.readPluginServerConfig("7", 8_000), "{\"mcpServers\":{}}");
    assert.deepEqual(calls, [
      { method: "listMarketplacePlugins", request: { excludeCloudAgentPlugins: true }, timeoutMs: 5_000 },
      { method: "listMarketplaces", request: {}, timeoutMs: 6_000 },
      { method: "listMarketplacePlugins", request: { marketplaceId: 11n, excludeCloudAgentPlugins: true }, timeoutMs: 7_000 },
      { method: "getPluginMcpConfig", request: { pluginId: 7n }, timeoutMs: 8_000 },
    ]);
  });

  it("maps only published repository config paths to their fetch address", () => {
    assert.equal(
      resolvePublishedConfigSourceUrl("https://github.com/org/repo/blob/main/config/mcp.json"),
      "https://raw.githubusercontent.com/org/repo/main/config/mcp.json",
    );
    assert.deepEqual([
      resolvePublishedConfigSourceUrl("not a url"),
      resolvePublishedConfigSourceUrl("https://example.test/org/repo/blob/main/mcp.json"),
      resolvePublishedConfigSourceUrl("https://github.com/org/repo/tree/main/mcp.json"),
    ], [null, null, null]);
  });
});
