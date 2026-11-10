/**
 * The marketplace's own reads: the skills the platform manages, and the catalog built from what a marketplace lists
 * — what it keeps, what it skips, how it is named, and what happens when the read fails.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isMarketplaceLogoSourceKnown } from "../../source/shared/node/marketplace/marketplace-logo-registry.ts";
import { MARKETPLACE_REQUEST_TIMEOUT_MS } from "../../source/adapters/interop/plugin-marketplace/dashboard-client-adapter.ts";
import { fetchSkillCatalog, fetchSlateManagedSkills, type ManagedSkillsClient, type MarketplacePlugin } from "../../source/host/extensions/managed-setup/skills-marketplace.ts";

function plugin(overrides: Partial<MarketplacePlugin> & { id: MarketplacePlugin["id"] }): MarketplacePlugin {
  return { name: "plugin-name", displayName: "", logoUrl: null, publisher: null, skills: [], ...overrides };
}

function clientWorld(options: { plugins?: readonly MarketplacePlugin[]; skills?: readonly { id: string; description: string; content: string; enabled?: boolean | null }[]; managedFails?: boolean; catalogFails?: boolean } = {}) {
  const calls: { method: string; request: unknown; timeoutMs: number }[] = [];
  const client: ManagedSkillsClient = {
    getManagedSkills: async (request, given) => {
      calls.push({ method: "getManagedSkills", request, timeoutMs: given.timeoutMs });
      if (options.managedFails === true) throw new Error("the dashboard is down");
      return { skills: options.skills ?? [] };
    },
    listMarketplacePlugins: async (request, given) => {
      calls.push({ method: "listMarketplacePlugins", request, timeoutMs: given.timeoutMs });
      if (options.catalogFails === true) throw new Error("the dashboard is down");
      return { plugins: options.plugins ?? [] };
    },
  };
  return { client, calls };
}

describe("the skills the platform manages", () => {
  it("asks once, under the marketplace's timeout, and takes a skill it said nothing about as enabled", async () => {
    const world = clientWorld({ skills: [{ id: "one", description: "first", content: "body" }, { id: "two", description: "second", content: "body", enabled: false }] });
    assert.deepEqual(await fetchSlateManagedSkills({ client: world.client }), [
      { id: "one", description: "first", content: "body", enabled: true },
      { id: "two", description: "second", content: "body", enabled: false },
    ]);
    assert.deepEqual(world.calls, [{ method: "getManagedSkills", request: {}, timeoutMs: MARKETPLACE_REQUEST_TIMEOUT_MS }]);
  });
});

describe("the catalog a marketplace offers", () => {
  it("lists what can be installed, one entry per skill, sorted by name", async () => {
    const world = clientWorld({
      plugins: [
        plugin({ id: 7, displayName: "Two", logoUrl: "https://logo.test/two.png", skills: [{ name: "zeta", description: "last", sourceUrl: "https://install.test/zeta" }] }),
        plugin({ id: "8", name: "eight", displayName: "One", publisher: { logoUrl: "https://logo.test/one.png" }, skills: [{ name: "alpha", sourceUrl: "https://install.test/alpha" }, { name: "beta", description: null, sourceUrl: "https://install.test/beta" }] }),
      ],
    });
    assert.deepEqual(await fetchSkillCatalog(world.client), [
      { id: "plugin:8:alpha", name: "alpha", description: "", source: "marketplace", publisher: "One", iconUrl: "https://logo.test/one.png", install: { kind: "url", url: "https://install.test/alpha" } },
      { id: "plugin:8:beta", name: "beta", description: "", source: "marketplace", publisher: "One", iconUrl: "https://logo.test/one.png", install: { kind: "url", url: "https://install.test/beta" } },
      { id: "plugin:7:zeta", name: "zeta", description: "last", source: "marketplace", publisher: "Two", iconUrl: "https://logo.test/two.png", install: { kind: "url", url: "https://install.test/zeta" } },
    ]);
    // The read excludes the plugins that belong to cloud agents, and runs under the same timeout as the other one.
    assert.deepEqual(world.calls, [{ method: "listMarketplacePlugins", request: { excludeCloudAgentPlugins: true }, timeoutMs: MARKETPLACE_REQUEST_TIMEOUT_MS }]);
    // A logo the catalog showed is a logo the platform now knows.
    assert.equal(isMarketplaceLogoSourceKnown("https://logo.test/one.png"), true);
    assert.equal(isMarketplaceLogoSourceKnown("https://logo.test/two.png"), true);
  });

  it("skips what cannot be installed, keeps the first of a name, and names a plugin that calls itself nothing", async () => {
    const world = clientWorld({
      plugins: [
        plugin({ id: 1n, name: "big-int", skills: [{ name: "no-source" }, { name: "", sourceUrl: "" }, { name: "kept", sourceUrl: "https://install.test/kept" }] }),
        plugin({ id: 2, name: "second", skills: [{ name: "KEPT", sourceUrl: "https://install.test/other" }, { name: "another", sourceUrl: "https://install.test/another" }] }),
      ],
    });
    const catalog = await fetchSkillCatalog(world.client);
    assert.deepEqual(catalog.map((entry) => [entry.id, entry.name, entry.publisher, entry.install.url]), [
      ["plugin:2:another", "another", "second", "https://install.test/another"],
      ["plugin:1:kept", "kept", "big-int", "https://install.test/kept"],
    ]);
    // A plugin with no logo shows no icon, and says nothing about one.
    assert.equal("iconUrl" in catalog[0]!, false);
  });

  it("prefers the publisher's logo to the plugin's own, and remembers its own when there is no publisher", async () => {
    const world = clientWorld({
      plugins: [
        plugin({ id: 1, publisher: { logoUrl: "https://logo.test/publisher.png" }, logoUrl: "https://logo.test/plugin.png", skills: [{ name: "both", sourceUrl: "https://install.test/both" }] }),
        plugin({ id: 2, publisher: { logoUrl: null }, logoUrl: "https://logo.test/own.png", skills: [{ name: "own", sourceUrl: "https://install.test/own" }] }),
      ],
    });
    const catalog = await fetchSkillCatalog(world.client);
    assert.deepEqual(catalog.map((entry) => entry.iconUrl), ["https://logo.test/publisher.png", "https://logo.test/own.png"]);
    // Whichever logo was shown is a logo the platform now knows.
    assert.equal(isMarketplaceLogoSourceKnown("https://logo.test/publisher.png"), true);
    assert.equal(isMarketplaceLogoSourceKnown("https://logo.test/own.png"), true);
    assert.equal(isMarketplaceLogoSourceKnown("https://logo.test/plugin.png"), false);
  });

  it("reports a read that failed, and answers with what it had collected", async () => {
    const reported: { extension: string; kind: string; errorClass: string }[] = [];
    const failing = clientWorld({ catalogFails: true });
    assert.deepEqual(await fetchSkillCatalog(failing.client, (event) => void reported.push(event)), []);
    assert.deepEqual(reported, [{ extension: "managed_setup", kind: "skills_catalog", errorClass: "Error" }]);
    // An answer that went wrong halfway keeps what was already there — a plugin whose skills cannot be read costs
    // the catalog that plugin, not the entries before it.
    const half = clientWorld({
      plugins: [
        plugin({ id: 1, skills: [{ name: "kept", sourceUrl: "https://install.test/kept" }] }),
        // A plugin that cannot even be read: the catalog finds out while walking it.
        { id: 2, name: "broken", displayName: "Broken", logoUrl: null, publisher: null, get skills(): never { throw new Error("the plugin is malformed"); } } as unknown as MarketplacePlugin,
      ],
    });
    const collected: { extension: string; kind: string; errorClass: string }[] = [];
    assert.deepEqual((await fetchSkillCatalog(half.client, (event) => void collected.push(event))).map((entry) => entry.name), ["kept"]);
    assert.deepEqual(collected, [{ extension: "managed_setup", kind: "skills_catalog", errorClass: "Error" }]);
  });
});
