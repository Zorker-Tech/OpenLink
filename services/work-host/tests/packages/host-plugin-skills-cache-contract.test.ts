import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { AGENT_READABLE_SKILL_DIR_MODE, AGENT_READABLE_SKILL_FILE_MODE } from "../../source/shared/workflow-model.ts";
import {
  PLUGIN_SKILLS_CACHE_FILENAME,
  PLUGIN_SKILLS_DIRNAME,
  getPluginSkillsCachePath,
  getPluginSkillsDir,
  getPluginsRootDir,
  isSafePluginSkillId,
  readPluginSkillsCache,
  writePluginSkillsCache,
  type PluginSkillRecord,
} from "../../source/host/skills/plugin-skills-cache.ts";

const scratch = mkdtempSync(join(tmpdir(), "slate-plugin-skills-cache-contract-"));
after(() => { rmSync(scratch, { recursive: true, force: true }); });

function cacheDir(name: string): string {
  return join(scratch, name);
}

function skill(overrides: Record<string, unknown> = {}): PluginSkillRecord {
  return {
    id: "code-review",
    pluginId: "plugin-1",
    pluginName: "Review tools",
    name: "Code review",
    description: "Reviews code",
    filePath: "/plugins/plugin-1/skills/code-review/SKILL.md",
    pluginVersion: "2.1.0",
    installPath: "/plugins/plugin-1",
    skillRelativePath: "skills/code-review/SKILL.md",
    publisherUserId: 7,
    marketplaceTeamId: 9,
    ...overrides,
  } as PluginSkillRecord;
}

function writeRaw(directory: string, value: unknown): void {
  const file = getPluginSkillsCachePath(directory);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

describe("plugin skills cache behavior contract", () => {
  it("keeps plugin and skill cache paths under their own roots", () => {
    assert.equal(PLUGIN_SKILLS_DIRNAME, "plugin-skills");
    assert.equal(PLUGIN_SKILLS_CACHE_FILENAME, "cache.json");
    assert.equal(getPluginsRootDir("/slate"), join("/slate", "plugins"));
    assert.equal(getPluginSkillsDir("/slate"), join("/slate", "plugin-skills"));
    assert.equal(getPluginSkillsCachePath("/cache"), join("/cache", "cache.json"));
  });

  it("accepts only lowercase hyphen-separated safe skill directory ids", () => {
    for (const id of ["a", "code-review", "skill2-for-team"]) assert.equal(isSafePluginSkillId(id), true, id);
    for (const id of ["", "Code-Review", "../escape", "-leading", "trailing-", "two--hyphens", "under_score", "with.dot"]) {
      assert.equal(isSafePluginSkillId(id), false, id);
    }
  });

  it("reads a valid record and fills legacy metadata defaults", () => {
    const directory = cacheDir("defaults");
    writeRaw(directory, {
      fetchedAt: 50,
      currentUserId: "not-an-id",
      skills: [{ ...skill(), pluginVersion: null, installPath: "relative/plugin", skillRelativePath: 7, publisherUserId: 1.5, marketplaceTeamId: 0 }],
    });

    assert.deepEqual(readPluginSkillsCache(directory), {
      fetchedAt: 50,
      currentUserId: null,
      skills: [{ ...skill(), pluginVersion: "", installPath: "", skillRelativePath: "", publisherUserId: null, marketplaceTeamId: null }],
      authBlocked: [],
    });
  });

  it("rejects the whole cache if its timestamp, skills list, or any skill record is invalid", () => {
    const directory = cacheDir("invalid");
    for (const value of [
      { fetchedAt: Number.NaN, skills: [] },
      { fetchedAt: 1, skills: {} },
      { fetchedAt: 1, skills: [skill(), { ...skill(), filePath: "relative/path" }] },
      { fetchedAt: 1, skills: [{ ...skill(), id: "../escape" }] },
      { fetchedAt: 1, skills: [{ ...skill(), pluginId: "" }] },
      { fetchedAt: 1, skills: [{ ...skill(), name: "" }] },
    ]) {
      writeRaw(directory, value);
      assert.equal(readPluginSkillsCache(directory), null);
    }
    assert.equal(readPluginSkillsCache(cacheDir("missing")), null);
  });

  it("keeps valid auth-block entries and resets the optional block list if any member is malformed", () => {
    const directory = cacheDir("auth-blocks");
    const base = { fetchedAt: 1, skills: [skill()] };
    writeRaw(directory, { ...base, authBlocked: [{ pluginId: "p1", pluginName: "One", marketplaceName: "Market" }] });
    assert.deepEqual(readPluginSkillsCache(directory)?.authBlocked, [{ pluginId: "p1", pluginName: "One", marketplaceName: "Market" }]);

    writeRaw(directory, { ...base, authBlocked: [{ pluginId: "p1", pluginName: "One" }, { pluginId: 2, pluginName: "bad" }] });
    assert.deepEqual(readPluginSkillsCache(directory)?.authBlocked, []);
  });

  it("writes the time, defaults and cache records atomically with agent-readable modes", () => {
    const directory = cacheDir("write");
    writePluginSkillsCache(directory, { currentUserId: 42, skills: [skill()], authBlocked: [] }, () => 123);
    const file = getPluginSkillsCachePath(directory);
    const raw = readFileSync(file, "utf8");
    assert.equal(raw.endsWith("\n"), true);
    assert.deepEqual(JSON.parse(raw), { fetchedAt: 123, authBlocked: [], currentUserId: 42, skills: [skill()] });
    assert.equal(statSync(directory).mode & 0o777, AGENT_READABLE_SKILL_DIR_MODE);
    assert.equal(statSync(file).mode & 0o777, AGENT_READABLE_SKILL_FILE_MODE);
    assert.deepEqual(readPluginSkillsCache(directory)?.skills, [skill()]);
    assert.equal(existsSync(`${file}.tmp`), false);
  });

  it("replaces the cache with the supplied pass and uses the current clock by default", () => {
    const directory = cacheDir("replace");
    writePluginSkillsCache(directory, { currentUserId: 1, skills: [skill()] }, () => 10);
    writePluginSkillsCache(directory, { currentUserId: 2, skills: [skill({ id: "new-skill" })] }, () => 20);
    const result = readPluginSkillsCache(directory);
    assert.deepEqual([result?.fetchedAt, result?.currentUserId, result?.skills.map((entry) => entry.id)], [20, 2, ["new-skill"]]);

    const before = Date.now();
    writePluginSkillsCache(directory, { skills: [] });
    const afterWrite = Date.now();
    const written = readPluginSkillsCache(directory);
    assert.equal(written?.currentUserId, null);
    assert.equal(typeof written?.fetchedAt, "number");
    assert.equal(written!.fetchedAt >= before && written!.fetchedAt <= afterWrite, true);
  });

  it("does not validate records while writing, so a later reader rejects invalid contents", () => {
    const directory = cacheDir("invalid-write");
    writePluginSkillsCache(directory, { skills: [{ ...skill(), filePath: "relative" }] }, () => 1);
    assert.equal(readPluginSkillsCache(directory), null);
  });
});
