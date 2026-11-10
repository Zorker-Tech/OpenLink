/**
 * The skills a plugin brings: how a plugin's skills become the platform's own records, what a set of records is
 * identified by, what a failed load asks of the user, and the service that loads plugins, writes down what it found and
 * reports every pass.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  CURRENT_USER_RPC_TIMEOUT_MS,
  EFFECTIVE_PLUGINS_RPC_TIMEOUT_MS,
  PLUGIN_SKILLS_REFRESH_INTERVAL_MS,
  pluginAuthBlocksFromFailures,
  pluginContentsToSkillRecords,
  pluginVersionOf,
  publisherFactsFromListing,
  skillNameFromPath,
  skillRecordsIdentity,
  pruneUninstalledPluginDirs,
  SlatePluginSkillsService,
  toPluginSkillInfo,
  type InstalledPlugin,
  type LoadedPlugins,
} from "../../source/host/skills/plugin-skills.ts";
import { getPluginSkillsDir, readPluginSkillsCache } from "../../source/host/skills/plugin-skills-cache.ts";
import { getPluginInstallCachePath } from "../../source/packages/plugin-install/marketplace.ts";

const firstParty = (pluginDbId: string, version = "1.0.0") => ({ source: "first-party", sourceInfo: { name: "plugin-name", pluginDbId, version } });

function plugin(overrides: Partial<InstalledPlugin> & { identifier?: InstalledPlugin["identifier"] } = {}): InstalledPlugin {
  return {
    identifier: firstParty("db-1"),
    displayName: "Nice Plugin",
    installPath: "/plugins/db-1",
    skills: [{ name: "write tests", description: "  how to write them  ", path: "skills/write-tests/SKILL.md" }],
    ...overrides,
  } as InstalledPlugin;
}

describe("a plugin's skills as the platform's own records", () => {
  it("names every skill, keeps the ones that are there, and gives a repeated name its own id", () => {
    const records = pluginContentsToSkillRecords([
      plugin(),
      plugin({ identifier: firstParty("db-2"), displayName: undefined, skills: [{ name: "Deploy helper", description: undefined, path: "skills/deploy/SKILL.md" }] }),
      plugin({ identifier: firstParty("db-3"), loadError: new Error("no"), skills: [{ name: "never", path: "skills/never/SKILL.md" }] }),
      plugin({ identifier: firstParty("db-4"), installPath: "", skills: [{ name: "never", path: "skills/never/SKILL.md" }] }),
      plugin({ identifier: { source: "someone-else", sourceInfo: { name: "elsewhere", pluginDbId: "db-5" } } }),
      plugin({ identifier: firstParty("db-1"), skills: [{ name: "write tests", description: "again", path: "skills/more/SKILL.md" }] }),
    ], new Map([["db-1", { publisherUserId: 7, marketplaceTeamId: 9 }]]));
    assert.deepEqual(records.map((record) => [record.id, record.name, record.pluginName, record.description]), [
      ["plugin-db-1-write-tests", "write tests", "Nice Plugin", "how to write them"],
      ["plugin-db-2-deploy-helper", "Deploy helper", "plugin-name", ""],
      ["plugin-db-1-write-tests-2", "write tests", "Nice Plugin", "again"],
    ]);
    assert.deepEqual(
      [records[0]?.filePath, records[0]?.pluginVersion, records[0]?.skillRelativePath, records[0]?.publisherUserId, records[0]?.marketplaceTeamId, records[1]?.publisherUserId],
      [join("/plugins/db-1", "skills/write-tests/SKILL.md"), "1.0.0", "skills/write-tests/SKILL.md", 7, 9, null],
    );
    assert.deepEqual(toPluginSkillInfo(records[0]!), { pluginId: "db-1", pluginName: "Nice Plugin", name: "write tests", description: "how to write them" });
  });

  it("identifies a set of records by what they are, whatever the order", () => {
    const records = pluginContentsToSkillRecords([plugin(), plugin({ identifier: firstParty("db-2"), skills: [{ name: "second", path: "skills/second/SKILL.md" }] })]);
    assert.equal(skillRecordsIdentity(records), skillRecordsIdentity([...records].reverse()));
    assert.equal(skillRecordsIdentity([]), "");
    assert.equal(skillRecordsIdentity(records).includes("plugin-db-1-write-tests@1.0.0"), true);
  });

  it("reads what the helpers can read of a plugin", () => {
    // A path's last segment falls back to the segment before it — a path that ends in a slash names its own last directory.
    assert.deepEqual([skillNameFromPath("skills/write-tests/SKILL.md"), skillNameFromPath("SKILL.md"), skillNameFromPath(""), skillNameFromPath("/a//b/")], ["write-tests", "SKILL.md", "", "a"]);
    assert.deepEqual([pluginVersionOf(firstParty("db-1", "2.0.0")), pluginVersionOf({ source: "x", sourceInfo: { name: "n" } })], ["2.0.0", ""]);
    const facts = publisherFactsFromListing({
      plugins: [
        { plugin: { id: 12n, publisher: { ownerUserId: 34 }, marketplace: { teamId: 56 } } },
        { plugin: { id: "13", publisher: { ownerUserId: 0 }, marketplace: { teamId: null } } },
        { plugin: {} },
        { plugin: null },
      ],
    });
    assert.deepEqual([...facts.entries()], [["12", { publisherUserId: 34, marketplaceTeamId: 56 }], ["13", { publisherUserId: null, marketplaceTeamId: null }]]);
    assert.deepEqual([...publisherFactsFromListing({}).entries()], [], "an absent listing does not invent publisher facts");
    // A clone that needed the user's own git access is the only one worth asking about, once each.
    const blocks = pluginAuthBlocksFromFailures([
      { pluginDbId: "db-1", pluginName: "Nice Plugin", marketplaceName: "team-market", errorMessage: "fatal: could not read Username for 'https://example': terminal prompts disabled" },
      { pluginDbId: "db-1", pluginName: "Nice Plugin", errorMessage: "permission denied" },
      { pluginId: "db-2", pluginName: "Other", errorMessage: "fatal: repository not found" },
      { pluginName: "Network", errorMessage: "the network is down" },
    ]);
    assert.deepEqual(blocks, [
      { pluginId: "db-1", pluginName: "Nice Plugin", marketplaceName: "team-market" },
      { pluginId: "db-2", pluginName: "Other" },
    ]);
    assert.deepEqual([EFFECTIVE_PLUGINS_RPC_TIMEOUT_MS, CURRENT_USER_RPC_TIMEOUT_MS, PLUGIN_SKILLS_REFRESH_INTERVAL_MS], [15_000, 10_000, 24 * 60 * 60 * 1_000]);
  });

  it("removes uninstalled cache folders but keeps listed and still-indexed installations", () => {
    const root = mkdtempSync(join(tmpdir(), "slate-plugin-prune-"));
    try {
      const keep = getPluginInstallCachePath(root, { marketplaceSlug: "team-market", pluginId: "listed" });
      const stillUsed = join(root, "team-market", "indexed");
      const remove = join(root, "team-market", "uninstalled");
      for (const directory of [keep, stillUsed, remove]) {
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, "marker"), "present", "utf8");
      }

      pruneUninstalledPluginDirs(
        root,
        [{ marketplaceSlug: "team-market", pluginId: "listed" }],
        [join(stillUsed, "skills", "one", "SKILL.md")],
      );
      assert.deepEqual([existsSync(keep), existsSync(stillUsed), existsSync(remove)], [true, true, false]);
      assert.doesNotThrow(() => pruneUninstalledPluginDirs(join(root, "missing"), [], []));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the service that loads plugins and writes down their skills", () => {
  function serviceWorld(loads: Array<LoadedPlugins | Error>) {
    const root = mkdtempSync(join(tmpdir(), "slate-plugin-skills-"));
    const logged: string[] = [];
    const reported: Array<Record<string, unknown>> = [];
    const pruned: Array<{ listed: number; paths: number }> = [];
    let index = 0;
    const service = new SlatePluginSkillsService({
      slateRootDir: root,
      load: async () => {
        const next = loads[Math.min(index, loads.length - 1)];
        index += 1;
        if (next instanceof Error) throw next;
        return next as LoadedPlugins;
      },
      log: (message: string) => logged.push(message),
      reportSync: (event: Record<string, unknown>) => reported.push(event),
      now: () => 1_000,
      prune: (_cacheRoot: string, listed: readonly unknown[], paths: readonly string[]) => pruned.push({ listed: listed.length, paths: paths.length }),
    });
    return { service, root, logged, reported, pruned, loads: () => index };
  }

  const loaded = (plugins: InstalledPlugin[]): LoadedPlugins => ({
    plugins,
    authBlocked: [],
    listedPluginIds: plugins.map((entry) => (entry.identifier.sourceInfo.pluginDbId ?? "")).filter((id) => id.length > 0),
    listedCacheKeys: [{ marketplaceSlug: "team-market", pluginId: "db-1" }],
    publisherFacts: new Map(),
    currentUserId: 42,
  });

  it("writes down what it loaded, keeps what was listed but not loaded, and reports the pass", async () => {
    // The second pass lists the plugin but loads nothing: what is listed stays, what is not is let go.
    const listedOnly = { ...loaded([]), listedPluginIds: ["db-1"] };
    const world = serviceWorld([loaded([plugin()]), listedOnly, loaded([plugin()])]);
    const first = await world.service.sync("startup");
    assert.deepEqual(first.map((record) => record.id), ["plugin-db-1-write-tests"]);
    const written = readPluginSkillsCache(getPluginSkillsDir(world.root));
    assert.deepEqual([written?.currentUserId, written?.skills.length, world.pruned[0]?.listed], [42, 1, 1]);
    assert.deepEqual(world.reported[0], { trigger: "startup", outcome: "ok", changed: true, skillCount: 1, durationMs: 0 });
    // A pass that loaded nothing still keeps the plugin that is listed, and reports no change.
    const second = await world.service.sync("auth_change");
    assert.deepEqual([second.map((record) => record.id), world.reported[1]?.changed, world.reported[1]?.trigger], [["plugin-db-1-write-tests"], false, "auth_change"]);
    // A plugin that is no longer listed is let go.
    const third = await world.service.sync("startup");
    void third;
    assert.deepEqual(world.service.current().map((record) => record.id), ["plugin-db-1-write-tests"]);
    // A load that failed is said so, reports the failure and is thrown on.
    const failing = serviceWorld([new Error("the marketplace is down")]);
    await assert.rejects(() => failing.service.sync("startup"), /the marketplace is down/);
    assert.deepEqual(
      [failing.logged[0]?.includes("sync (startup) failed"), failing.reported[0]],
      [true, { trigger: "startup", outcome: "failed", errorClass: "Error", durationMs: 0 }],
    );
  });

  it("shares a pass between concurrent syncs, and keeps one more for what arrived during it", async () => {
    const world = serviceWorld([loaded([plugin()])]);
    // What arrives while a pass is running is served by exactly one more pass, whatever the newest trigger was.
    const both = await Promise.all([world.service.sync("startup"), world.service.sync("auth_change"), world.service.sync("startup")]);
    assert.deepEqual([world.loads(), both.length], [2, 3]);
    assert.deepEqual(world.reported.map((event) => event.trigger), ["startup", "startup"]);
    // Once it was let go it does nothing but answer with what it has.
    world.service.dispose();
    assert.deepEqual((await world.service.sync("startup")).map((record) => record.id), ["plugin-db-1-write-tests"]);
    assert.deepEqual(world.loads(), 2);
  });
});
