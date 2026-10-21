import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { restoreSkillsFromPluginDir } from "../../source/packages/plugin-install/skill-plugin-restore.ts";

let root = "";
before(async () => {
  root = await mkdtemp(join(tmpdir(), "slate-restore-"));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A fresh pair of directories for one case: the plugin's skills, and the workspace's. */
async function tree(name: string, skills: readonly string[] = []): Promise<{ plugin: string; workspace: string }> {
  const base = join(root, name);
  const plugin = join(base, "plugin-skills");
  const workspace = join(base, "workspace-skills");
  for (const skill of skills) {
    await mkdir(join(plugin, skill), { recursive: true });
    await writeFile(join(plugin, skill, "SKILL.md"), `# ${skill}`);
  }
  return { plugin, workspace };
}

/** Restores these skills, and hands back the answer and whatever it refused with. */
async function restore(options: { skillDirs: readonly string[]; plugin: string; workspace: string }): Promise<{ restored?: string[]; thrown?: string }> {
  try {
    return { restored: await restoreSkillsFromPluginDir({ skillDirs: options.skillDirs, pluginSkillsRoot: options.plugin, skillsRoot: options.workspace }) };
  } catch (error) {
    return { thrown: (error as Error).message };
  }
}

describe("putting a plugin's skills back", () => {
  it("copies a skill where the workspace reads it, and answers with the path it wrote", async () => {
    const { plugin, workspace } = await tree("one", ["alpha"]);
    const answer = await restore({ skillDirs: [join(plugin, "alpha")], plugin, workspace });
    assert.deepEqual(answer, { restored: [join(workspace, "alpha")] });
    assert.equal(await readFile(join(workspace, "alpha", "SKILL.md"), "utf8"), "# alpha");
  });

  it("keeps a skill's place inside the plugin, and makes the directories on the way", async () => {
    const { plugin, workspace } = await tree("nested", ["group/beta"]);
    const answer = await restore({ skillDirs: [join(plugin, "group", "beta")], plugin, workspace });
    assert.deepEqual(answer, { restored: [join(workspace, "group", "beta")] });
    assert.equal(await readFile(join(workspace, "group", "beta", "SKILL.md"), "utf8"), "# group/beta");
  });

  it("makes the workspace's own root, however deep it is", async () => {
    const { plugin } = await tree("deep", ["a"]);
    const workspace = join(root, "deep", "one", "two", "three");
    const answer = await restore({ skillDirs: [join(plugin, "a")], plugin, workspace });
    assert.deepEqual(answer, { restored: [join(workspace, "a")] });
  });

  it("restores several skills at once", async () => {
    const { plugin, workspace } = await tree("several", ["a", "b"]);
    const answer = await restore({ skillDirs: [join(plugin, "b"), join(plugin, "a")], plugin, workspace });
    assert.deepEqual(answer, { restored: [join(workspace, "b"), join(workspace, "a")] }, "in the order they were asked for");
    assert.deepEqual((await readdir(workspace)).sort(), ["a", "b"]);
  });
});

describe("refusing to restore", () => {
  it("refuses an empty list", async () => {
    const { plugin, workspace } = await tree("empty");
    assert.deepEqual(await restore({ skillDirs: [], plugin, workspace }), { thrown: "At least one skill directory is required" });
  });

  it("refuses a skill folder outside the plugin", async () => {
    const { plugin, workspace } = await tree("outside");
    await mkdir(join(root, "outside", "elsewhere"), { recursive: true });
    const outside = join(root, "outside", "elsewhere");
    assert.deepEqual(await restore({ skillDirs: [outside], plugin, workspace }), { thrown: `Skill folder "${outside}" is not inside the plugin's skills directory` });
  });

  it("refuses the plugin's own root, and a sibling whose name merely starts with it", async () => {
    const { plugin, workspace } = await tree("sibling");
    assert.deepEqual(await restore({ skillDirs: [plugin], plugin, workspace }), { thrown: `Skill folder "${plugin}" is not inside the plugin's skills directory` });
    const sibling = join(root, "sibling", "plugin-skills-2");
    await mkdir(sibling, { recursive: true });
    assert.deepEqual(await restore({ skillDirs: [sibling], plugin, workspace }), { thrown: `Skill folder "${sibling}" is not inside the plugin's skills directory` });
  });

  it("refuses a folder that is not a directory", async () => {
    const { plugin, workspace } = await tree("not-a-dir");
    await mkdir(plugin, { recursive: true });
    const file = join(plugin, "a-file");
    await writeFile(file, "x");
    assert.deepEqual(await restore({ skillDirs: [file], plugin, workspace }), { thrown: `Skill folder "${file}" is not a directory` });
  });

  it("refuses two skills that would land on one path, naming it each time it repeats", async () => {
    const { plugin, workspace } = await tree("duplicate", ["a"]);
    const target = join(workspace, "a");
    const answer = await restore({ skillDirs: [join(plugin, "a"), join(plugin, "a", "."), join(plugin, "a")], plugin, workspace });
    assert.deepEqual(answer, { thrown: `Multiple skill folders would restore to the same path: ${target}, ${target}` });
  });

  it("refuses to write over a skill the workspace already has, and leaves it as it was", async () => {
    const { plugin, workspace } = await tree("existing", ["a"]);
    await mkdir(join(workspace, "a"), { recursive: true });
    await writeFile(join(workspace, "a", "SKILL.md"), "# the user's own");
    assert.deepEqual(await restore({ skillDirs: [join(plugin, "a")], plugin, workspace }), { thrown: `Cannot restore skill to "${join(workspace, "a")}": that path already exists` });
    assert.equal(await readFile(join(workspace, "a", "SKILL.md"), "utf8"), "# the user's own");
  });

  it("checks the whole plan before copying anything, so a refusal restores nothing", async () => {
    const { plugin, workspace } = await tree("half", ["a", "b"]);
    // the second skill is refused, and the first must not have been written by then
    await mkdir(join(workspace, "b"), { recursive: true });
    const answer = await restore({ skillDirs: [join(plugin, "a"), join(plugin, "b")], plugin, workspace });
    assert.equal(answer.thrown, `Cannot restore skill to "${join(workspace, "b")}": that path already exists`);
    assert.deepEqual(await readdir(workspace), ["b"], "nothing else was written");
  });
});
