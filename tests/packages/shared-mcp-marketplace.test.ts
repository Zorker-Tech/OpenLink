/**
 * The marketplace's plugins as this platform reads them: what a plugin becomes, how a published config is normalised,
 * which private marketplaces an account sees, and where a plugin's servers are read from.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fetchMarketplaceMcpPlugins, fetchPluginServers, marketplacePluginToView, normalizePluginConfig, normalizeServer, resolvePublishedConfigSourceUrl, type MarketplaceDeps, type MarketplacePluginSource, type MarketplaceRemoteClient, type SlateMarketplacePlugin } from "../../source/shared/node/mcp/mcp-marketplace.ts";

/** A plugin as the marketplace sends it, with everything a plugin may carry. */
function wirePlugin(overrides: Partial<MarketplacePluginSource> = {}): MarketplacePluginSource {
  return {
    id: "7",
    slug: "plugin-name",
    title: "",
    summary: null,
    servers: [{ slug: "server-one", summary: null, configurationSource: "https://github.com/o/r/blob/main/mcp.json" }, { slug: "server-two" }],
    skills: [{ slug: "skill-one", summary: null, source: "" }, { slug: "skill-two", source: "https://example.test/skill" }],
    variableSchema: { properties: { token: { title: "Token", format: "password" } }, required: ["token"] },
    topicKeys: ["", "dev_tools"],
    homepage: "https://repo.test/p",
    icon: "https://logo.test/plugin.png",
    publisher: null,
    collection: null,
    ...overrides,
  };
}

function remoteClient(overrides: Partial<MarketplaceRemoteClient> = {}): MarketplaceRemoteClient {
  return {
    listPublicPlugins: async () => [],
    listOwnedCollections: async () => [],
    listPluginsInCollection: async () => [],
    readPluginServerConfig: async () => undefined,
    ...overrides,
  };
}

const account = { getAccessToken: async () => "token", getMachineId: async () => "machine" };

describe("a plugin as the marketplace sent it", () => {
  it("works out what it is called, where it is filed, and what it brings", async () => {
    const seen: string[] = [];
    const listed = await fetchMarketplaceMcpPlugins(account.getAccessToken, account.getMachineId, {
      bestEffortToken: async () => undefined,
      createClient: () => remoteClient({ listPublicPlugins: async () => [wirePlugin()] }),
      timeoutMs: 12_000,
      rememberLogoSource: (url) => void seen.push(url),
    });
    assert.deepEqual(seen, ["https://logo.test/plugin.png"]);
    assert.deepEqual(listed.plugins, [
      {
        pluginId: "7",
        name: "server-one",
        displayName: "plugin-name",
        description: "",
        category: "Dev Tools",
        logoUrl: "https://logo.test/plugin.png",
        homepage: "https://repo.test/p",
        sourceUrls: ["https://github.com/o/r/blob/main/mcp.json"],
        connectors: [{ name: "server-one", description: "" }, { name: "server-two", description: "" }],
        skills: [{ name: "skill-one", description: "" }, { name: "skill-two", description: "", sourceUrl: "https://example.test/skill" }],
        variableFields: [{ key: "token", label: "Token", placeholder: "token", isRequired: true, isSecret: true }],
      },
    ]);
    assert.equal(listed.includesPrivateMarketplaces, false);
  });

  it("takes a plugin with neither a server nor a skill as no plugin, and names one by what it calls itself", async () => {
    const listed = await fetchMarketplaceMcpPlugins(account.getAccessToken, account.getMachineId, {
      bestEffortToken: async () => undefined,
      createClient: () => remoteClient({
        listPublicPlugins: async () => [
          wirePlugin({ id: "1", servers: [], skills: [] }),
          wirePlugin({ id: "2", title: "Two", servers: [], skills: [{ slug: "s" }], topicKeys: [], slug: "fallback" }),
          wirePlugin({ id: "3", title: "One", publisher: { slug: "pub", title: "", isUserOwned: true, homepage: "https://pub.test", icon: "" }, collection: { id: "m", slug: "m", title: "", ownerType: "team" } }),
        ],
      }),
      timeoutMs: 12_000,
      rememberLogoSource: () => {},
    });
    assert.deepEqual(listed.plugins.map((plugin) => [plugin.pluginId, plugin.displayName, plugin.name, plugin.category, plugin.homepage]), [
      ["3", "One", "server-one", "Dev Tools", "https://repo.test/p"],
      ["2", "Two", "fallback", "MCP", "https://repo.test/p"],
    ]);
    assert.deepEqual(listed.plugins[0]!.publisher, { name: "pub", displayName: "pub", isUserOwned: true });
    assert.deepEqual(listed.plugins[0]!.marketplace, { name: "m", displayName: "m", ownership: "team" });
    // A plugin with no repository falls back to its publisher's site, and a marketplace a user owns says so.
    const fallbacks = await fetchMarketplaceMcpPlugins(account.getAccessToken, account.getMachineId, {
      bestEffortToken: async () => undefined,
      createClient: () => remoteClient({ listPublicPlugins: async () => [wirePlugin({ homepage: "", publisher: { slug: "pub", title: "Pub", isUserOwned: false, homepage: "https://pub.test" }, collection: { id: "m", slug: "m", title: "M", ownerType: "user" } })] }),
      timeoutMs: 12_000,
      rememberLogoSource: () => {},
    });
    assert.deepEqual([fallbacks.plugins[0]!.homepage, fallbacks.plugins[0]!.marketplace?.ownership], ["https://pub.test", "user"]);
    // A marketplace nobody owns is not one a plugin is in.
    const unowned = await fetchMarketplaceMcpPlugins(account.getAccessToken, account.getMachineId, {
      bestEffortToken: async () => undefined,
      createClient: () => remoteClient({ listPublicPlugins: async () => [wirePlugin({ collection: { id: "m", slug: "m", title: "M" } })] }),
      timeoutMs: 12_000,
      rememberLogoSource: () => {},
    });
    assert.equal("marketplace" in unowned.plugins[0]!, false);
    // The view leaves the fields a user can fill in and the two maybes out when there are none.
    const withoutVariables = marketplacePluginToView({ ...listed.plugins[1]!, variableFields: [] } as SlateMarketplacePlugin);
    assert.deepEqual(Object.keys(withoutVariables).sort(), ["category", "connectors", "description", "displayName", "homepage", "iconUrl", "id", "name", "skills"]);
    assert.equal("fields" in withoutVariables, false);
    // A plugin that can be configured shows the fields a user fills in.
    assert.equal("fields" in marketplacePluginToView(listed.plugins[1]!), true);
  });

  it("adds what the account's private marketplaces offer, one unreadable marketplace at a time", async () => {
    const asked: unknown[] = [];
    const client = {
      listPublicPlugins: async (timeoutMs: number) => {
        asked.push({ scope: "public", timeoutMs });
        return [wirePlugin({ id: "8", title: "Alpha" })];
      },
      listOwnedCollections: async (timeoutMs: number) => {
        asked.push({ scope: "owned", timeoutMs });
        return [
          { id: "team-1", slug: "team-1", ownerType: "team" as const },
          { id: "bad", slug: "bad", ownerType: "user" as const },
        ];
      },
      listPluginsInCollection: async (collectionId: string, timeoutMs: number) => {
        asked.push({ scope: "collection", collectionId, timeoutMs });
        if (collectionId === "bad") throw new Error("the marketplace is down");
        if (collectionId === "team-1") return [wirePlugin({ id: "9", title: "Zed" })];
        return [wirePlugin({ id: "8", title: "Alpha" })];
      },
      readPluginServerConfig: async () => undefined,
    };
    const listed = await fetchMarketplaceMcpPlugins(account.getAccessToken, account.getMachineId, {
      bestEffortToken: async () => "token",
      createClient: () => client,
      timeoutMs: 5_000,
      rememberLogoSource: () => {},
    });
    assert.deepEqual(listed.plugins.map((plugin) => plugin.pluginId), ["8", "9"]);
    assert.equal(listed.includesPrivateMarketplaces, true);
    // The public listing, then the two owned marketplaces — never the one nobody owns, and both under the timeout.
    assert.deepEqual(asked, [
      { scope: "public", timeoutMs: 5_000 },
      { scope: "owned", timeoutMs: 5_000 },
      { scope: "collection", collectionId: "team-1", timeoutMs: 5_000 },
      { scope: "collection", collectionId: "bad", timeoutMs: 5_000 },
    ]);
    assert.deepEqual(listed.plugins.map((plugin) => plugin.displayName), ["Alpha", "Zed"]);
    // An account without a credential is not asked which marketplaces it has: there are none to read.
    let marketplaceReads = 0;
    await fetchMarketplaceMcpPlugins(account.getAccessToken, account.getMachineId, {
      bestEffortToken: async () => undefined,
      createClient: () => remoteClient({
        listPublicPlugins: async () => [wirePlugin()],
        listOwnedCollections: async () => {
          marketplaceReads += 1;
          return [];
        },
      }),
      timeoutMs: 12_000,
      rememberLogoSource: () => {},
    });
    assert.equal(marketplaceReads, 0);
  });
});

describe("a published server entry", () => {
  it("reads the transport as the type, and drops the transport it was named by", () => {
    assert.deepEqual(normalizeServer({ transport: "sse", url: "https://x" }), { url: "https://x", type: "sse" });
    assert.deepEqual(normalizeServer({ transport: "streamableHttp", url: "https://x" }), { url: "https://x", type: "http" });
    assert.deepEqual(normalizeServer({ transport: "http", url: "https://x" }), { url: "https://x", type: "http" });
    // A type the caller already had wins, and a transport nobody knows leaves no type behind.
    assert.deepEqual(normalizeServer({ transport: "http", url: "https://x", type: "sse" }), { url: "https://x", type: "sse" });
    assert.deepEqual(normalizeServer({ transport: "websocket", url: "https://x" }), { url: "https://x" });
    assert.deepEqual(normalizeServer({ command: "npx" }), { command: "npx" });
  });

  it("keeps only the entries that are really servers, under a wrapper or bare", () => {
    const safeParse = (value: unknown) => (typeof (value as { url?: unknown }).url === "string" ? { success: true, data: value as never } : { success: false });
    assert.deepEqual(normalizePluginConfig({ mcpServers: { one: { url: "https://x" }, two: "not an object", three: { command: "npx" } } }, safeParse), { one: { url: "https://x" } });
    assert.deepEqual(normalizePluginConfig({ one: { transport: "sse", url: "https://x" } }, safeParse), { one: { url: "https://x", type: "sse" } });
    assert.deepEqual([normalizePluginConfig(null, safeParse), normalizePluginConfig([], safeParse), normalizePluginConfig("nope", safeParse)], [{}, {}, {}]);
    // Even a parser that accepts anything does not turn a non-object entry into a server.
    const permissive = () => ({ success: true, data: { command: "x" } as never });
    assert.deepEqual(normalizePluginConfig({ one: "not an object", two: [1, 2], three: 3, four: { command: "x" } }, permissive), { four: { command: "x" } });
  });

  it("turns a published config location into the address the source adapter fetches", () => {
    assert.equal(resolvePublishedConfigSourceUrl("https://github.com/o/r/blob/main/dir/mcp.json"), "https://raw.githubusercontent.com/o/r/main/dir/mcp.json");
    assert.deepEqual(
      [resolvePublishedConfigSourceUrl("not a url"), resolvePublishedConfigSourceUrl("https://gitlab.com/o/r/blob/main/mcp.json"), resolvePublishedConfigSourceUrl("https://github.com/o/r"), resolvePublishedConfigSourceUrl("https://github.com/o/r/tree/main/dir")],
      [null, null, null, null],
    );
  });
});

describe("where a plugin's servers are read from", () => {
  const plugin: SlateMarketplacePlugin = {
    pluginId: "7",
    name: "n",
    displayName: "N",
    description: "",
    category: "MCP",
    logoUrl: undefined,
    homepage: undefined,
    sourceUrls: ["https://github.com/o/r/blob/main/mcp.json"],
    connectors: [],
    skills: [],
    variableFields: [],
  };
  const safeParse = (value: unknown) => (typeof (value as { url?: unknown }).url === "string" ? { success: true, data: value as never } : { success: false });
  const deps = (overrides: Partial<MarketplaceDeps> = {}): MarketplaceDeps => ({
    bestEffortToken: async () => "token",
    createClient: () => remoteClient({ readPluginServerConfig: async () => JSON.stringify({ mcpServers: { one: { url: "https://from.test" } } }) }),
    timeoutMs: 12_000,
    rememberLogoSource: () => {},
    safeParseServer: safeParse,
    fetch: async () => ({ ok: true, text: async () => "{}" }) as never,
    fetchTimeoutMs: 12_000,
    ...overrides,
  });

  it("takes the backend's answer when there is one, and never goes to the plugin's own sources", async () => {
    const fetched: string[] = [];
    const servers = await fetchPluginServers(plugin, account.getAccessToken, account.getMachineId, deps({ fetch: async (url) => { fetched.push(url); return { ok: true, text: async () => "{}" } as never; } }));
    assert.deepEqual(servers, { one: { url: "https://from.test" } });
    assert.deepEqual(fetched, []);
    // An answer that holds no config is no answer: the published config is read instead.
    const fromSource = await fetchPluginServers(plugin, account.getAccessToken, account.getMachineId, deps({
      createClient: () => remoteClient({ readPluginServerConfig: async () => "{}" }),
      fetch: async (url) => ({ ok: true, text: async () => JSON.stringify({ mcpServers: { two: { url: url.toString() } } }) }) as never,
    }));
    assert.deepEqual(fromSource, { two: { url: "https://raw.githubusercontent.com/o/r/main/mcp.json" } });
  });

  it("reads the plugin's own config when there is no credential, under the fetch's own deadline", async () => {
    const signals: AbortSignal[] = [];
    const servers = await fetchPluginServers(plugin, account.getAccessToken, account.getMachineId, deps({
      bestEffortToken: async () => undefined,
      fetch: async (_url, signal) => {
        signals.push(signal);
        return { ok: true, text: async () => JSON.stringify({ mcpServers: { one: { transport: "sse", url: "https://x" } } }) } as never;
      },
    }));
    assert.deepEqual(servers, { one: { url: "https://x", type: "sse" } });
    assert.equal(signals[0]!.aborted, false);
  });

  it("passes over a source it cannot use, and answers nothing when none of them work", async () => {
    const asked: string[] = [];
    const servers = await fetchPluginServers(
      { ...plugin, sourceUrls: ["not a url", "https://github.com/o/r/tree/main", "https://github.com/o/r/blob/main/empty.json", "https://github.com/o/r/blob/main/not-ok.json", "https://github.com/o/r/blob/main/broken.json", "https://github.com/o/r/blob/main/good.json"] },
      account.getAccessToken,
      account.getMachineId,
      deps({
        bestEffortToken: async () => undefined,
        fetch: async (url) => {
          asked.push(url);
          if (url.endsWith("empty.json")) return { ok: true, text: async () => "{}" } as never;
          // A response that was not ok is skipped whatever its body says.
          if (url.endsWith("not-ok.json")) return { ok: false, text: async () => JSON.stringify({ mcpServers: { nope: { url: "https://nope.test" } } }) } as never;
          if (url.endsWith("broken.json")) return { ok: true, text: async () => "{not json" } as never;
          if (url.endsWith("good.json")) return { ok: true, text: async () => JSON.stringify({ mcpServers: { one: { url: "https://good.test" } } }) } as never;
          return { ok: false, text: async () => "" } as never;
        },
      }),
    );
    assert.deepEqual(servers, { one: { url: "https://good.test" } });
    // None of the unusable urls is fetched: only the three blob links are.
    assert.deepEqual(asked, [
      "https://raw.githubusercontent.com/o/r/main/empty.json",
      "https://raw.githubusercontent.com/o/r/main/not-ok.json",
      "https://raw.githubusercontent.com/o/r/main/broken.json",
      "https://raw.githubusercontent.com/o/r/main/good.json",
    ]);
    const nothing = await fetchPluginServers(plugin, account.getAccessToken, account.getMachineId, deps({ bestEffortToken: async () => undefined, fetch: async () => ({ ok: false, text: async () => "" }) as never }));
    assert.deepEqual(nothing, {});
    // A credential the backend refuses does not stop the published config being read.
    const refused = await fetchPluginServers(plugin, account.getAccessToken, account.getMachineId, deps({
      createClient: () => remoteClient({ readPluginServerConfig: async () => { throw new Error("no"); } }),
      fetch: async () => ({ ok: true, text: async () => JSON.stringify({ mcpServers: { one: { url: "https://fallback.test" } } }) }) as never,
    }));
    assert.deepEqual(refused, { one: { url: "https://fallback.test" } });
  });
});
