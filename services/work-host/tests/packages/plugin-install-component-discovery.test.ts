import { test } from "node:test";
import assert from "node:assert/strict";

import { PluginComponentDiscovery, type PluginFileEntry } from "../../source/packages/plugin-install/component-discovery.ts";

type Tree = Record<string, string>;
// A directory is any path that is a prefix of a file path; entries are derived from the tree.
function treeFetcher(tree: Tree, options: { failList?: boolean } = {}) {
  const entries = new Set<string>();
  for (const path of Object.keys(tree)) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) entries.add(parts.slice(0, index).join("/"));
  }
  const discovery = new PluginComponentDiscovery({
    async listDirectory(path: string): Promise<PluginFileEntry[]> {
      if (options.failList === true) throw new Error("no listing");
      const prefix = path === "" ? "" : path + "/";
      const children = new Map<string, PluginFileEntry>();
      for (const entry of entries) {
        if (!entry.startsWith(prefix)) continue;
        const rest = entry.slice(prefix.length);
        if (rest.length === 0 || rest.includes("/")) continue;
        children.set(rest, { name: rest, path: entry, type: "dir" });
      }
      for (const filePath of Object.keys(tree)) {
        if (!filePath.startsWith(prefix)) continue;
        const rest = filePath.slice(prefix.length);
        if (rest.length === 0 || rest.includes("/")) continue;
        children.set(rest, { name: rest, path: filePath, type: "file" });
      }
      return [...children.values()].sort((left, right) => left.name.localeCompare(right.name));
    },
    async fetchFile(path: string) {
      if (!(path in tree)) throw new Error("no file " + path);
      return { content: tree[path]! };
    },
    async fileExists(path: string) {
      return path in tree || entries.has(path);
    },
  });
  return discovery;
}
const frontmatter = (fields: Record<string, string>) => "---\n" + Object.entries(fields).map(([key, value]) => key + ": " + value).join("\n") + "\n---\nbody";

test("an empty or unreadable root discovers nothing", async () => {
  assert.deepEqual(await treeFetcher({}).discoverComponents(), { skills: [], agents: [], hooks: [], commands: [], rules: [], mcpServers: [], mcpVariables: undefined });
  assert.deepEqual(await treeFetcher({}, { failList: true }).discoverComponents(), { skills: [], agents: [], hooks: [], commands: [], rules: [], mcpServers: [], mcpVariables: undefined });
});

test("folder-based components are named, described and deduplicated", async () => {
  const discovery = treeFetcher({
    "commands/build.md": frontmatter({ name: "Build It", description: "Builds the thing" }),
    "commands/ship.txt": "plain text",
    "agents/helper.md": frontmatter({ name: "Helper", description: "Helps" }),
    "agents/note.markdown": frontmatter({ name: "Note", description: "Markdown note" }),
    "rules/style.md": frontmatter({ description: "Style rules" }),
    "skills/writer/SKILL.md": frontmatter({ name: "Writer", description: "Writes", environments: "work, home", "disabled-environments": "sandbox" }),
    "skills/lister/SKILL.md": "---\nname: Lister\ndescription: Lists\nenvironments:\n  - work\n  - home\n---",
    "hooks/hooks.json": JSON.stringify({ hooks: { "pre-commit": {}, "post-commit": {} } }),
  });
  const found = await discovery.discoverComponents();
  assert.deepEqual(found.commands, [
    { name: "build-it", path: "commands/build.md", description: "Builds the thing" },
    { name: "ship", path: "commands/ship.txt" },
  ]);
  assert.deepEqual(found.agents, [
    { name: "helper", path: "agents/helper.md", description: "Helps" },
    { name: "note", path: "agents/note.markdown", description: "Markdown note" },
  ]);
  assert.deepEqual(found.rules, [{ name: "style", path: "rules/style.md", description: "Style rules" }]);
  assert.deepEqual(found.skills, [
    { disabledEnvironments: undefined, environments: ["work", "home"], name: "lister", path: "skills/lister/SKILL.md", description: "Lists" },
    { disabledEnvironments: ["sandbox"], environments: ["work", "home"], name: "writer", path: "skills/writer/SKILL.md", description: "Writes" },
  ]);
  assert.deepEqual(found.hooks, [
    { name: "pre-commit", path: "hooks/hooks.json", description: "Hook: pre-commit" },
    { name: "post-commit", path: "hooks/hooks.json", description: "Hook: post-commit" },
  ]);
});

test("a root SKILL.md joins the skills and wins the deduplication", async () => {
  const discovery = treeFetcher({
    "SKILL.md": frontmatter({ name: "Root", description: "The root skill" }),
    "skills/root/SKILL.md": frontmatter({ name: "Root", description: "Shadowed" }),
    "skills/other/SKILL.md": frontmatter({ name: "Other" }),
  });
  const found = await discovery.discoverComponents();
  assert.deepEqual(found.skills.map((skill) => skill.name), ["root", "other"]);
  assert.equal(found.skills[0]?.description, "The root skill");
});

test("manifest paths are read, unsafe and missing paths skipped", async () => {
  const discovery = treeFetcher({
    "agents/a.md": frontmatter({ name: "A", description: "Agent A" }),
    "commands/c.md": frontmatter({ name: "C" }),
    "skills/s/SKILL.md": frontmatter({ name: "S" }),
    "../evil.md": frontmatter({ name: "Evil", description: "Should never be read" }),
  });
  const found = await discovery.discoverComponents({ manifest: {
    agents: ["agents/a.md", "../evil.md", "agents/missing.md"],
    commands: ["commands/c.md"],
    skills: "skills",
  } as never });
  assert.deepEqual(found.agents, [{ name: "a", path: "agents/a.md", description: "Agent A" }]);
  assert.deepEqual(found.commands, [{ name: "c", path: "commands/c.md" }]);
  assert.deepEqual(found.skills, [{ disabledEnvironments: undefined, environments: undefined, name: "s", path: "skills/s/SKILL.md" }]);
});

test("metadata-only discovery names components without reading files", async () => {
  const discovery = treeFetcher({
    "commands/build.md": frontmatter({ name: "Build It", description: "Builds" }),
    "agents/helper.md": frontmatter({ name: "Helper", description: "Helps" }),
    "skills/writer/SKILL.md": frontmatter({ name: "Writer", description: "Writes" }),
  });
  const found = await discovery.discoverComponents({ metadataOnly: true });
  assert.deepEqual(found.commands, [{ name: "build", path: "commands/build.md", description: "" }]);
  assert.deepEqual(found.agents, [{ name: "helper", path: "agents/helper.md", description: "" }]);
  assert.deepEqual(found.skills, [{ name: "writer", path: "skills/writer/SKILL.md", description: "" }]);
});

test("manifest hooks and hook files are read through either path", async () => {
  const discovery = treeFetcher({ "hooks/hooks.json": JSON.stringify({ hooks: { commit: {} } }) });
  assert.deepEqual(await discovery.discoverComponents({ manifest: { hooks: "hooks/hooks.json" } as never }), {
    skills: [], agents: [], hooks: [{ name: "commit", path: "hooks/hooks.json", description: "Hook: commit" }], commands: [], rules: [], mcpServers: [], mcpVariables: undefined,
  });
  const inline = treeFetcher({});
  assert.deepEqual((await inline.discoverComponents({ manifest: { hooks: { hooks: { lint: {} } } } as never })).hooks, [{ name: "lint", path: "manifest", description: "Hook: lint" }]);
});

test("mcp servers come from the manifest and from config files", async () => {
  const discovery = treeFetcher({ "mcp.json": JSON.stringify({ mcpServers: { browser: { command: "browser" } } }) });
  const fromManifest = await discovery.discoverComponents({ manifest: { mcpServers: { browser: { command: "browser" } } } as never });
  assert.deepEqual(fromManifest.mcpServers, [{ name: "browser", path: "mcp.json" }]);
  const fromFiles = await discovery.discoverComponents();
  assert.deepEqual(fromFiles.mcpServers, [{ name: "browser", path: "mcp.json" }]);
});

test("nested folders are walked and unusable frontmatter falls back to lines", async () => {
  const discovery = treeFetcher({
    "commands/nested/deep.md": "---\nname: [bad yaml\ndescription: fallback text\n---",
    "agents/broken.md": frontmatter({ description: "No name" }),
  });
  const found = await discovery.discoverComponents();
  assert.deepEqual(found.commands, [{ name: "bad-yaml", path: "commands/nested/deep.md", description: "fallback text" }]);
  assert.deepEqual(found.agents, [{ name: "broken", path: "agents/broken.md", description: "No name" }]);
});

