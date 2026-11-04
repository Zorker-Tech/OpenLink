/**
 * The catalog an MCP install flow works from: what it keeps, when it re-reads, and what installing from it enforces.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CATALOG_CACHE_TTL_MS } from "../../source/shared/node/mcp/mcp-catalog-cache.ts";
import { SlateMcpConfigError } from "../../source/shared/node/mcp/mcp-config-error.ts";
import { SlateMcpCatalogFlow } from "../../source/shared/node/mcp/mcp-catalog-flow.ts";
import type { SlateMarketplacePlugin } from "../../source/shared/node/mcp/mcp-marketplace.ts";

const plugin = (pluginId: string, overrides: Partial<SlateMarketplacePlugin> = {}): SlateMarketplacePlugin => ({
  pluginId,
  name: `plugin-${pluginId}`,
  displayName: `Plugin ${pluginId}`,
  description: "does things",
  category: "MCP",
  logoUrl: undefined,
  homepage: undefined,
  sourceUrls: [],
  connectors: [],
  skills: [],
  variableFields: [],
  ...overrides,
});

const required = (key: string, label: string) => ({ key, label, placeholder: key, isRequired: true, isSecret: false });

/** What a caller hands in is a reader for the credential, not the credential itself. */
const token = async () => "token";

function flowWorld(options: { plugins?: SlateMarketplacePlugin[]; includesPrivate?: boolean; fetchFails?: boolean; token?: string | undefined; effectivePlugins?: Array<{ pluginId: string; hasTeamConfiguredVariables?: boolean }> | "throws"; now?: () => number } = {}) {
  const fetches: unknown[] = [];
  const installs: unknown[] = [];
  const updates: unknown[] = [];
  const reloads: string[] = [];
  const answered = options.plugins ?? [plugin("2", { displayName: "Beta" }), plugin("10", { displayName: "Alpha" })];
  const flow = new SlateMcpCatalogFlow({
    getMachineId: async () => "machine-1",
    ...(options.effectivePlugins === undefined ? {} : {
      listEffectivePlugins: async () => {
        if (options.effectivePlugins === "throws") throw new Error("the plugin listing is down");
        return options.effectivePlugins as Array<{ pluginId: string; hasTeamConfiguredVariables?: boolean }>;
      },
    }),
    bestEffortToken: async () => ("token" in options ? options.token : "token"),
    fetchMarketplace: async (readToken: () => Promise<string | null | undefined>, machine: () => Promise<string>) => {
      fetches.push([await readToken(), await machine()]);
      if (options.fetchFails === true) throw new Error("the marketplace is down");
      return { plugins: answered, includesPrivateMarketplaces: options.includesPrivate ?? true };
    },
    catalogInstallPort: {
      installPlugin: async (request: unknown) => void installs.push(request),
      updatePluginInstall: async (request: unknown) => void updates.push(request),
    },
    reloadServers: async () => void reloads.push("reloaded"),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { flow, fetches, installs, updates, reloads };
}

describe("the catalog the flow keeps", () => {
  it("fetches once, answers sorted by what the plugins call themselves, and keeps it for a while", async () => {
    let now = 1_000;
    const world = flowWorld({ now: () => now });
    const views = (await world.flow.getCatalog(token)) as { id: string; displayName: string }[];
    assert.deepEqual(views.map((view) => view.displayName), ["Alpha", "Beta"]);
    assert.deepEqual(world.fetches, [["token", "machine-1"]]);
    // Within the catalog's own window, the same answer is handed back without asking again.
    now += CATALOG_CACHE_TTL_MS - 1;
    assert.deepEqual((await world.flow.getCatalog(token)) as { displayName: string }[], views);
    assert.equal(world.fetches.length, 1);
    // Once it is old, it is fetched again.
    now += 1;
    await world.flow.getCatalog(token);
    assert.equal(world.fetches.length, 2);
    // A caller that says so gets a fresh one whatever the window says.
    await world.flow.getCatalog(token, { forceRefresh: true });
    assert.equal(world.fetches.length, 3);
    assert.equal(CATALOG_CACHE_TTL_MS, 30_000);
  });

  it("does not hand a listing fetched while signed out to one fetched while signed in", async () => {
    // What the account has is what decides the question, so the flow is driven through it.
    let credential: string | undefined = undefined;
    const asked: string[] = [];
    const flow = new SlateMcpCatalogFlow({
      getMachineId: async () => "machine-1",
      bestEffortToken: async () => credential,
      fetchMarketplace: async () => {
        asked.push(credential ?? "signed out");
        return { plugins: [plugin("1")], includesPrivateMarketplaces: credential != null };
      },
      catalogInstallPort: { installPlugin: async () => {}, updatePluginInstall: async () => {} },
      reloadServers: async () => {},
    });
    // Signed out: the private marketplaces are not part of the answer, and the listing is kept.
    await flow.getCatalog(token);
    assert.deepEqual(asked, ["signed out"]);
    // The same flow asked again with a credential is a different question, so it is asked again even inside the window.
    credential = "a-credential";
    await flow.getCatalog(token);
    // Signed in and signed out again is another question again.
    credential = undefined;
    await flow.getCatalog(token);
    assert.deepEqual(asked, ["signed out", "a-credential", "signed out"]);
    // Asked once more while still signed out, the listing that answers this question stands.
    await flow.getCatalog(token);
    assert.equal(asked.length, 3);
  });

  it("falls back to what it holds when a re-fetch fails, and reports the failure when it holds nothing", async () => {
    const failing = flowWorld({ fetchFails: true });
    await assert.rejects(failing.flow.getCatalog(token), /the marketplace is down/);
    // A first fetch that failed leaves nothing to answer with, so the caller hears it.
    const world = flowWorld();
    await world.flow.getCatalog(token);
    const flaky = new SlateMcpCatalogFlow({
      getMachineId: async () => "machine-1",
      bestEffortToken: async () => "token",
      fetchMarketplace: async () => {
        throw new Error("the marketplace went away");
      },
      catalogInstallPort: { installPlugin: async () => {}, updatePluginInstall: async () => {} },
      reloadServers: async () => {},
    });
    assert.equal(await flaky.getCatalog(token).then(() => "answered", () => "refused"), "refused");
    // What the caller already had is still answered when the refresh is the thing that failed.
    const held = new SlateMcpCatalogFlow({
      getMachineId: async () => "machine-1",
      bestEffortToken: async () => "token",
      fetchMarketplace: async () => ({ plugins: [plugin("1")], includesPrivateMarketplaces: true }),
      catalogInstallPort: { installPlugin: async () => {}, updatePluginInstall: async () => {} },
      reloadServers: async () => {},
    });
    const first = await held.getCatalog(token);
    (held as unknown as { core: { fetchMarketplace: () => Promise<never> } }).core.fetchMarketplace = async () => {
      throw new Error("the marketplace went away");
    };
    assert.deepEqual(await held.getCatalog(token, { forceRefresh: true }), first);
    assert.equal(world.fetches.length, 1);
  });
});

describe("installing from the catalog", () => {
  it("refuses a plugin nobody listed, and one whose required settings have no value", async () => {
    const world = flowWorld({ plugins: [plugin("7", { displayName: "Needs Things", variableFields: [required("token", "Access token"), required("team", "Team name")] })] });
    await assert.rejects(world.flow.installEntry({ entryId: "missing" }, token), (error: Error) => error instanceof SlateMcpConfigError && error.message === 'Unknown marketplace plugin "missing". Reopen settings and try again.');
    // The message says what to ask for: the labels first, then the keys to pass them under.
    await assert.rejects(world.flow.installEntry({ entryId: "7" }, token), (error: Error) => error instanceof SlateMcpConfigError && error.message === '"Needs Things" needs a value for Access token, Team name before it can be installed. Ask the user for it and pass it in "values" (keys: token, team), then try again.');
    // A value that is only whitespace is no value; a field that has one is not asked for again, and one field is
    // named in the singular.
    await assert.rejects(world.flow.installEntry({ entryId: "7", values: { token: "t", team: "  " } }, token), (error: Error) => error.message.includes("(key: team)") && error.message.includes("needs a value for Team name") && !error.message.includes("Access token"));
    assert.deepEqual([world.installs, world.reloads], [[], []]);
    // A value for each is an install: the plugin id as the backend takes it, the values as they were given.
    assert.equal(await world.flow.installEntry({ entryId: "7", values: { token: "t", team: "T" } }, token), undefined);
    assert.deepEqual(world.installs, [{ pluginId: "7", values: { token: "t", team: "T" } }]);
    assert.deepEqual(world.reloads, ["reloaded"]);
    // An install with no values at all asks for none.
    const plain = flowWorld({ plugins: [plugin("3")] });
    await plain.flow.installEntry({ entryId: "3" }, token);
    assert.deepEqual(plain.installs, [{ pluginId: "3" }]);
  });

  it("installs without the values when the plugin's team already carries them", async () => {
    const needsValues = [plugin("7", { variableFields: [required("token", "Access token")] })];
    // The caller says the team has them.
    const told = flowWorld({ plugins: needsValues });
    await told.flow.installEntry({ entryId: "7", hasTeamConfiguredVariables: true }, token);
    assert.deepEqual(told.installs, [{ pluginId: "7" }]);
    // Or the account's own listing says so, which is the same answer from further away.
    const listed = flowWorld({ plugins: needsValues, effectivePlugins: [{ pluginId: "7", hasTeamConfiguredVariables: true }] });
    await listed.flow.installEntry({ entryId: "7" }, token);
    assert.deepEqual(listed.installs, [{ pluginId: "7" }]);
    // A plugin the listing does not cover, and a listing that could not be read, both ask for the values.
    const other = flowWorld({ plugins: needsValues, effectivePlugins: [{ pluginId: "99", hasTeamConfiguredVariables: true }] });
    await assert.rejects(other.flow.installEntry({ entryId: "7" }, token), /needs a value for Access token/);
    const broken = flowWorld({ plugins: needsValues, effectivePlugins: "throws" });
    await assert.rejects(broken.flow.installEntry({ entryId: "7" }, token), /needs a value for Access token/);
    const unflagged = flowWorld({ plugins: needsValues, effectivePlugins: [{ pluginId: "7" }] });
    await assert.rejects(unflagged.flow.installEntry({ entryId: "7" }, token), /needs a value for Access token/);
  });

  it("updates an install only for a plugin it can see, with the values it needs", async () => {
    const world = flowWorld({ plugins: [plugin("7", { variableFields: [required("token", "Access token")] })] });
    await assert.rejects(world.flow.updatePluginInstall({ pluginId: "99", values: {} }, token), /Unknown marketplace plugin "99"/);
    await assert.rejects(world.flow.updatePluginInstall({ pluginId: "7", values: {} }, token), /needs a value for Access token/);
    await assert.doesNotReject(world.flow.updatePluginInstall({ pluginId: "7", values: { token: "t" } }, token));
    assert.deepEqual(world.updates, [{ pluginId: "7", values: { token: "t" } }]);
    assert.deepEqual(world.reloads, ["reloaded"]);
  });

  it("reads a plugin that was not in the catalog it held, once", async () => {
    let plugins = [plugin("1")];
    const world = new SlateMcpCatalogFlow({
      getMachineId: async () => "machine-1",
      bestEffortToken: async () => "token",
      fetchMarketplace: async () => ({ plugins, includesPrivateMarketplaces: true }),
      catalogInstallPort: { installPlugin: async () => {}, updatePluginInstall: async () => {} },
      reloadServers: async () => {},
    });
    await world.getCatalog(token);
    // The catalog moved on: a plugin the caller named is looked for in a fresh listing before it is refused.
    plugins = [plugin("1"), plugin("2", { variableFields: [required("token", "Access token")] })];
    await assert.doesNotReject(world.updatePluginInstall({ pluginId: "2", values: { token: "t" } }, token));
  });

  it("takes the logo resolver it was handed, and the marketplace's own when it was handed none", async () => {
    const handed = flowWorld();
    const withResolver = new SlateMcpCatalogFlow({
      getMachineId: async () => "machine-1",
      catalogInstallPort: { installPlugin: async () => {}, updatePluginInstall: async () => {} },
      reloadServers: async () => {},
      resolveLogo: async (url: string) => `resolved:${url}`,
    });
    assert.equal(await withResolver.resolvePluginLogo("https://logo.test/x.png"), "resolved:https://logo.test/x.png");
    // Without one it is the marketplace's own, which answers nothing for a logo nobody showed us.
    assert.equal(await handed.flow.resolvePluginLogo("https://logo.test/never-seen.png"), null);
  });
});
