import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

import { synthesizeSkillPluginDir } from "../../source/packages/plugin-install/skill-plugin-synthesizer.ts"
import { isSparseCheckoutRepo, materializeSpecForGitPaths, serverIgnoredFilter } from "../../source/packages/plugin-install/git-sparse-clone.ts"
import {
  PLUGIN_MCP_CONFIG_FILE_NAMES,
  resolvePluginMcpConfigFromReader,
  resolvePluginMcpConfigPaths,
  resolvePluginMcpConfigWithManifestLookup,
} from "../../source/packages/plugin-install/mcp-parser.ts"

// ---------------------------------------------------------------------------------------------
// Skills written out as a plugin
// ---------------------------------------------------------------------------------------------

function withTempDir(prefix: string, run: (dir: string) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  return run(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }))
}

test("the skills a workspace holds are written out as one plugin", async () => {
  await withTempDir("slate-skill-plugin-", async (root) => {
    const skillDir = path.join(root, "skills", "review")
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# review")

    const target = path.join(root, "plugin")
    const written = await synthesizeSkillPluginDir({
      skills: [{ dir: skillDir, relativePath: "review" }],
      targetDir: target,
      pluginName: "My Skills",
      displayName: "My Skills",
    })

    assert.equal(typeof written, "string")
    // The plugin is written under a directory named after it.
    const pluginDir = path.join(target, "my-skills")
    assert.equal(fs.existsSync(path.join(pluginDir, "skills", "review", "SKILL.md")), true)
    assert.equal(fs.readFileSync(path.join(pluginDir, "skills", "review", "SKILL.md"), "utf8"), "# review")
    // The manifest names the plugin the way a name is spelled, and lists the skills it packs.
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, "plugin.json"), "utf8")) as { name: string; displayName?: string; skills?: string[] }
    assert.equal(manifest.name, "my-skills")
    assert.equal(manifest.displayName, "My Skills")
    assert.deepEqual(manifest.skills, ["skills/review"])
  })
})

test("a skill path that would leave the plugin is refused", async () => {
  await withTempDir("slate-skill-plugin-", async (root) => {
    const skillDir = path.join(root, "skills", "review")
    fs.mkdirSync(skillDir, { recursive: true })
    const target = path.join(root, "plugin")

    await assert.rejects(
      () => synthesizeSkillPluginDir({ skills: [{ dir: skillDir, relativePath: "/etc" }], targetDir: target, pluginName: "mine" }),
      /must be relative to the skills root/,
    )
    await assert.rejects(
      () => synthesizeSkillPluginDir({ skills: [{ dir: skillDir, relativePath: "../elsewhere" }], targetDir: target, pluginName: "mine" }),
      /resolves to an unsafe path/,
    )
    await assert.rejects(
      () => synthesizeSkillPluginDir({ skills: [], targetDir: target, pluginName: "mine" }),
      /At least one skill directory is required/,
    )
    // A name that has nothing a name can hold is refused rather than written as something else.
    await assert.rejects(
      () => synthesizeSkillPluginDir({ skills: [{ dir: skillDir, relativePath: "review" }], targetDir: target, pluginName: "!!!" }),
      /has no usable characters/,
    )
  })
})

// ---------------------------------------------------------------------------------------------
// Fetching only what a plugin needs
// ---------------------------------------------------------------------------------------------

test("what to fetch is the paths a plugin named, or the whole repository", () => {
  assert.deepEqual(materializeSpecForGitPaths(["skills", "rules"]), ["skills", "rules"])
  // Nothing named is nothing to materialize; naming the root is the whole tree.
  assert.deepEqual(materializeSpecForGitPaths([]), [])
  assert.equal(materializeSpecForGitPaths(["."]), "all")
  assert.equal(materializeSpecForGitPaths(["/"]), "all")
})

test("a server that cannot filter is noticed from what git says", () => {
  assert.equal(serverIgnoredFilter("warning: filtering not recognized by server"), true)
  assert.equal(serverIgnoredFilter("remote: Filtering not recognized by server, ignoring"), true)
  assert.equal(serverIgnoredFilter("fatal: repository not found"), false)
})

test("a repository that is already sparse is recognized as one", async () => {
  await withTempDir("slate-sparse-", async (root) => {
    const repo = path.join(root, "repo")
    fs.mkdirSync(path.join(repo, "skills"), { recursive: true })
    fs.mkdirSync(path.join(repo, "docs"), { recursive: true })
    fs.writeFileSync(path.join(repo, "skills", "a.md"), "a")
    fs.writeFileSync(path.join(repo, "docs", "b.md"), "b")
    execFileSync("git", ["init", "--quiet"], { cwd: repo })
    execFileSync("git", ["-C", repo, "add", "."])
    execFileSync("git", ["-C", repo, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "--quiet", "-m", "first"])

    // An ordinary clone is not sparse.
    assert.equal(await isSparseCheckoutRepo(repo), false)
    execFileSync("git", ["-C", repo, "sparse-checkout", "set", "skills"])
    assert.equal(await isSparseCheckoutRepo(repo), true)
  })
})

// ---------------------------------------------------------------------------------------------
// The MCP configuration a plugin brings
// ---------------------------------------------------------------------------------------------

test("a plugin's MCP servers are read from its own files, and the manifest wins", async () => {
  const files: Record<string, string> = {
    ".mcp.json": JSON.stringify({ mcpServers: { fromFile: { command: "node" }, shared: { command: "file" }, both: { command: "first" } } }),
    "mcp.json": JSON.stringify({ mcpServers: { ignored: { command: "later" }, both: { command: "second" } } }),
  }
  const readFileContent = async (candidate: string) => files[candidate] ?? null

  const resolved = await resolvePluginMcpConfigFromReader(readFileContent, { fromManifest: { command: "manifest" }, shared: { command: "manifest" } }, ".cursor-plugin/plugin.json")
  assert.deepEqual(Object.keys(resolved?.mcpServers ?? {}).sort(), ["both", "fromFile", "fromManifest", "ignored", "shared"])
  // A server named by the first file that declares it keeps that declaration.
  assert.equal(resolved?.mcpServers.both?.command, "first")
  // The manifest's own server wins over the file's, and where each came from is kept.
  assert.equal(resolved?.mcpServers.shared?.command, "manifest")
  assert.equal(resolved?.mcpServerSourcePaths?.fromFile, ".mcp.json")
  assert.equal(resolved?.mcpServerSourcePaths?.fromManifest, ".cursor-plugin/plugin.json")
  // Every place a plugin keeps its configuration is read, and a server already named is not replaced.
  assert.equal(resolved?.mcpServers.ignored?.command, "later")
  assert.equal(resolved?.mcpServerSourcePaths?.ignored, "mcp.json")

  // Nothing anywhere is nothing, rather than an empty configuration.
  assert.equal(await resolvePluginMcpConfigFromReader(async () => null, undefined, undefined), null)
})

test("a plugin's MCP configuration is found by looking where a plugin keeps it", async () => {
  assert.deepEqual(PLUGIN_MCP_CONFIG_FILE_NAMES, [".mcp.json", "mcp.json"])
  const paths = resolvePluginMcpConfigPaths("/plugins/mine")
  assert.equal(paths.length > 0, true)
  assert.equal(paths.every(candidate => candidate.startsWith("/plugins/mine")), true)

  const manifest = JSON.stringify({ name: "mine", mcpServers: { fromManifest: { command: "node" } } })
  const resolved = await resolvePluginMcpConfigWithManifestLookup(async candidate => (candidate.endsWith("plugin.json") ? manifest : null))
  assert.deepEqual(Object.keys(resolved?.mcpServers ?? {}), ["fromManifest"])
  assert.equal(resolved?.mcpServerSourcePaths?.fromManifest, ".cursor-plugin/plugin.json")

  // A manifest that is not there, or not readable, is no configuration at all.
  assert.equal(await resolvePluginMcpConfigWithManifestLookup(async () => null), null)
  assert.equal(await resolvePluginMcpConfigWithManifestLookup(async () => "{ not json"), null)
})
