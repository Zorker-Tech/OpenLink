/**
 * Retiring the live references to plugin skills that are no longer live: how a source is compared, which records are
 * pointers at all, and what a sweep does when it cannot run.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { getPluginSkillsDir, writePluginSkillsCache } from "../../source/host/skills/plugin-skills-cache.ts";
import {
  collectMaterializedSkillSourceUrls,
  isLiveReferencePointerBody,
  normalizePluginSkillSourceUrl,
  removeWorkflowLiveReferences,
  skillPathTail,
  sweepLegacyPluginSkillReferences,
  type MaterializedPluginSkill,
  type PluginCatalogEntry,
} from "../../source/host/mcp/legacy-live-references.ts";

const scratch = mkdtempSync(join(tmpdir(), "slate-legacy-references-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const materialized = (pluginId: string, filePath: string): MaterializedPluginSkill => ({ pluginId, filePath });
const catalog = (pluginId: string, skills: readonly { sourceUrl?: string | null }[]): PluginCatalogEntry => ({ pluginId, skills });

describe("how a skill's source is compared", () => {
  it("keeps the host and path of a github link, and drops the revision it was read at", () => {
    assert.equal(normalizePluginSkillSourceUrl("https://github.com/Owner/Repo/blob/main/skills/one/SKILL.md"), "github.com/Owner/Repo/skills/one/SKILL.md");
    // The same skill at another revision, or with the host spelled differently, is the same skill.
    assert.equal(normalizePluginSkillSourceUrl("https://GitHub.com/Owner/Repo/blob/v2.0.0/skills/one/SKILL.md"), "github.com/Owner/Repo/skills/one/SKILL.md");
    assert.equal(normalizePluginSkillSourceUrl("https://github.com/Owner/Repo/blob/v2.0.0/skills/one/SKILL.md"), normalizePluginSkillSourceUrl("https://github.com/Owner/Repo/blob/main/skills/one/SKILL.md"));
    // Anything that is not a blob path — or not a url at all — is itself.
    for (const raw of ["https://github.com/Owner/Repo", "https://github.com/Owner/Repo/tree/main/skills/one", "https://example.test/raw/skill.md", "not a url", "https://github.com/Owner/blob/main"]) {
      assert.equal(normalizePluginSkillSourceUrl(raw), raw, raw);
    }
  });

  it("reads the part of a path that sits under the skills root", () => {
    assert.equal(skillPathTail("/plugins/one/skills/skill-one/SKILL.md"), "skills/skill-one/SKILL.md");
    assert.equal(skillPathTail("C:\\plugins\\one\\skills\\skill-one\\SKILL.md"), "skills/skill-one/SKILL.md");
    assert.equal(skillPathTail("/plugins/one/skills/one/skills/two/SKILL.md"), "skills/two/SKILL.md");
    assert.deepEqual([skillPathTail("/plugins/one/skills"), skillPathTail("/plugins/one/SKILL.md"), skillPathTail("")], [null, null, null]);
  });

  it("recognises a pointer by what its body says, and nothing else", () => {
    assert.equal(isLiveReferencePointerBody("## Skill\n\nThis is a live reference to the skill at github.com/o/r/x.\n"), true);
    assert.equal(isLiveReferencePointerBody("is a live reference to the skill at"), true);
    assert.equal(isLiveReferencePointerBody("## A skill of its own\n\nDo the thing.\n"), false);
    assert.equal(isLiveReferencePointerBody(""), false);
  });
});

describe("which pointers a sweep retires", () => {
  it("takes the sources of the skills that are really materialized, plugin by plugin", () => {
    const records = [materialized("p1", "/plugins/one/skills/skill-one/SKILL.md"), materialized("p2", "/plugins/two/skills/skill-two/SKILL.md")];
    const plugins = [
      catalog("p1", [{ sourceUrl: "https://github.com/o/r/blob/main/skills/skill-one/SKILL.md" }, { sourceUrl: "https://github.com/o/r/blob/main/skills/other/SKILL.md" }, { sourceUrl: null }, {}]),
      catalog("p2", [{ sourceUrl: "https://github.com/o/r/blob/main/skills/skill-two/SKILL.md" }]),
      // The same tail under a plugin that never brought it is not this machine's skill.
      catalog("p3", [{ sourceUrl: "https://github.com/o/r/blob/main/skills/skill-one/SKILL.md" }]),
    ];
    assert.deepEqual(collectMaterializedSkillSourceUrls(plugins, records), [
      "https://github.com/o/r/blob/main/skills/skill-one/SKILL.md",
      "https://github.com/o/r/blob/main/skills/skill-two/SKILL.md",
    ]);
    // A record whose path says nothing about skills is not one to match on.
    assert.deepEqual(collectMaterializedSkillSourceUrls([catalog("p1", [{ sourceUrl: "https://github.com/o/r/blob/main/skills/one/SKILL.md" }])], [materialized("p1", "/plugins/one/SKILL.md")]), []);
    assert.deepEqual(collectMaterializedSkillSourceUrls([], records), []);
  });

  it("retires only the pointers, only to materialized skills, and counts them", () => {
    const removed: string[] = [];
    const library = {
      list: () => [
        // A pointer to a skill that was materialized: this is the one a sweep retires.
        { id: "pointer-retired", sourceRef: "https://github.com/o/r/blob/v1/skills/skill-one/SKILL.md", body: "This is a live reference to the skill at github.com/o/r/skills/skill-one." },
        // A pointer to a skill nobody materialized stays.
        { id: "pointer-kept", sourceRef: "https://github.com/o/r/blob/main/skills/other/SKILL.md", body: "is a live reference to the skill at …" },
        // A skill of its own that happens to point at the same place stays: it is not a pointer.
        { id: "own-skill", sourceRef: "https://github.com/o/r/blob/main/skills/skill-one/SKILL.md", body: "## A skill of its own\n\nDo the thing." },
        // A record with no source at all stays.
        { id: "local-skill", sourceRef: null, body: "is a live reference to the skill at …" },
      ],
      remove: (id: string) => (removed.push(id), true),
    };
    assert.equal(removeWorkflowLiveReferences("/root", ["https://github.com/o/r/blob/main/skills/skill-one/SKILL.md"], library), 1);
    assert.deepEqual(removed, ["pointer-retired"]);
    // Nothing to retire at all is answered before the library is ever read.
    assert.equal(removeWorkflowLiveReferences("/root", [], { list: () => { throw new Error("never read"); }, remove: () => true }), 0);
    // A library that would not remove the record counts nothing.
    assert.equal(removeWorkflowLiveReferences("/root", ["https://github.com/o/r/blob/main/skills/skill-one/SKILL.md"], { list: library.list, remove: () => false }), 0);
  });
});

describe("the sweep itself", () => {
  function sweepWorld(options: { records?: boolean; fetchFails?: boolean; removed?: number; emptyToken?: boolean } = {}) {
    const slateRootDir = join(scratch, `root-${Math.round(Math.random() * 1e9)}`);
    if (options.records !== false) {
      writePluginSkillsCache(getPluginSkillsDir(slateRootDir), { currentUserId: 5, skills: [{ id: "skill-one", pluginId: "p1", pluginName: "plugin-one", name: "Skill One", description: "d", filePath: join(slateRootDir, "plugins", "one", "skills", "skill-one", "SKILL.md") }] });
      assert.equal(getPluginSkillsDir(slateRootDir).startsWith(slateRootDir), true);
      mkdirSync(slateRootDir, { recursive: true });
    }
    const logs: string[] = [];
    const asked: string[] = [];
    return {
      logs,
      asked,
      deps: {
        slateRootDir,
        auth: { getAccessToken: async () => (options.emptyToken === true ? "" : "token"), getMachineId: async () => "machine" },
        backendUrl: "https://backend.test",
        fetchMarketplace: async (getAccessToken: () => Promise<string | null>, getMachineId: () => Promise<string>) => {
          asked.push(`${await getAccessToken()}/${await getMachineId()}`);
          if (options.fetchFails === true) throw new Error("the marketplace is down");
          return { plugins: [catalog("p1", [{ sourceUrl: "https://github.com/o/r/blob/main/skills/skill-one/SKILL.md" }])] };
        },
        log: (message: string) => void logs.push(message),
        removeReferences: (_root: string, urls: readonly string[]) => (options.removed === undefined ? urls.length : options.removed),
      },
    };
  }

  it("asks the marketplace with the account's own credential, and says how many pointers it retired", async () => {
    const world = sweepWorld();
    assert.equal(await sweepLegacyPluginSkillReferences(world.deps), 1);
    assert.deepEqual(world.asked, ["token/machine"]);
    assert.deepEqual(world.logs, ["[slate:plugin-skills] retired 1 legacy live-reference record(s)"]);
    // Nothing retired is nothing to say.
    const quiet = sweepWorld({ removed: 0 });
    assert.deepEqual([await sweepLegacyPluginSkillReferences(quiet.deps), quiet.logs], [0, []]);
    // No plugin skills installed means nothing could have been materialized, so the marketplace is not asked at all.
    const empty = sweepWorld({ records: false });
    assert.deepEqual([await sweepLegacyPluginSkillReferences(empty.deps), empty.asked], [0, []]);
    // An account with no credential asks as one that has none, rather than with an empty token.
    const anonymous = sweepWorld({ emptyToken: true });
    assert.deepEqual([await sweepLegacyPluginSkillReferences(anonymous.deps), anonymous.asked], [1, ["null/machine"]]);
  });

  it("reports a sweep that could not run, and answers that nothing was retired", async () => {
    const world = sweepWorld({ fetchFails: true });
    assert.equal(await sweepLegacyPluginSkillReferences(world.deps), 0);
    assert.deepEqual(world.logs, ["[slate:plugin-skills] legacy live-reference sweep failed: the marketplace is down"]);
    // A failure that is not an error at all is still described.
    const odd = sweepWorld();
    odd.deps.fetchMarketplace = async () => { throw "not an error"; };
    assert.deepEqual([await sweepLegacyPluginSkillReferences(odd.deps), odd.logs], [0, ["[slate:plugin-skills] legacy live-reference sweep failed: not an error"]]);
  });

  it("retires the records the platform really keeps, given a library of its own", async () => {
    const slateRootDir = join(scratch, "real-library");
    mkdirSync(join(slateRootDir, "workflows"), { recursive: true });
    const logs: string[] = [];
    const removed = await sweepLegacyPluginSkillReferences({
      slateRootDir,
      auth: { getAccessToken: async () => "token", getMachineId: async () => "machine" },
      backendUrl: "https://backend.test",
      fetchMarketplace: async () => ({ plugins: [catalog("p1", [{ sourceUrl: "https://github.com/o/r/blob/main/skills/skill-one/SKILL.md" }])] }),
      log: (message: string) => void logs.push(message),
    });
    assert.deepEqual([removed, logs], [0, []]);
  });
});
