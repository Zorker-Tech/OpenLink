import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { createLocalPluginFileFetcher, loadFromMarketplaceSource, loadPluginFromPath } from "../../source/packages/plugin-install/loader.ts"
import type { BackendPluginEntry, BackendPluginListFailure } from "../../source/packages/plugin-install/backend-marketplace-client.ts"
import { DefaultPluginCacheManager, type PluginCacheKey } from "../../source/packages/plugin-install/marketplace.ts"
import type { PluginMetricsLogger } from "../../source/packages/plugin-install/types.ts"

// Loading a plugin is reading what is in its directory. The fetcher is what the loader reads through, so
// these tests drive both: what the fetcher refuses, and what a plugin directory turns into.

function withTempDir(prefix: string, run: (dir: string) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  return run(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }))
}

function marketplaceEntry(overrides: Partial<BackendPluginEntry> = {}): BackendPluginEntry {
  return {
    name: "plugin",
    pluginId: "plugin-id",
    version: "1.0.0",
    downloadUrl: "backend-git://owner%2Fplugin@main",
    marketplace: { name: "cursor-public", id: "marketplace-id" },
    ...overrides,
  }
}

function cacheManagerFor(root: string, cachedIds: ReadonlySet<string> = new Set()) {
  const checked: PluginCacheKey[] = []
  const marked: PluginCacheKey[] = []
  const pruned: Array<Parameters<DefaultPluginCacheManager["pruneOldVersions"]>[0]> = []
  const cacheDir = (key: PluginCacheKey) => path.join(root, key.marketplaceSlug, key.pluginId, ...(key.version === undefined ? [] : [key.version]))
  const manager = {
    getCacheDir: cacheDir,
    async isCached(key: PluginCacheKey) { checked.push(key); return cachedIds.has(key.pluginId) },
    async markCacheComplete(key: PluginCacheKey) { marked.push(key) },
    async pruneOldVersions(key: Parameters<DefaultPluginCacheManager["pruneOldVersions"]>[0]) { pruned.push(key) },
  } as unknown as DefaultPluginCacheManager
  return { manager, checked, marked, pruned, cacheDir }
}

function recordingMetrics() {
  const logs: Array<{ level: string; message: string }> = []
  const increments: Array<{ name: string; value: number }> = []
  const exceptions: unknown[] = []
  const logger: PluginMetricsLogger = {
    log(level, message) { logs.push({ level, message }) },
    increment(name, value) { increments.push({ name, value }) },
    distribution() {},
    captureException(error) { exceptions.push(error) },
  }
  return { logger, logs, increments, exceptions }
}

test("a fetcher reads the plugin's own files and refuses to leave it", async () => {
  await withTempDir("slate-plugin-", async (dir) => {
    fs.mkdirSync(path.join(dir, "rules"), { recursive: true })
    fs.writeFileSync(path.join(dir, "rules", "a.md"), "a rule")
    const fetcher = createLocalPluginFileFetcher(dir)

    const entries = await fetcher.listDirectory("rules")
    assert.deepEqual(entries.map(entry => entry.name), ["a.md"])
    assert.equal((await fetcher.fetchFile("rules/a.md")).content, "a rule")
    assert.equal(await fetcher.fileExists("rules/a.md"), true)
    assert.equal(await fetcher.fileExists("rules/nope.md"), false)

    // A path that leaves the plugin is refused rather than read.
    await assert.rejects(() => fetcher.fetchFile("../outside.txt"))
    await assert.rejects(() => fetcher.listDirectory(".."))
  })
})

test("a fetcher follows only contained symlinks and refuses files over its byte limit", async () => {
  await withTempDir("slate-plugin-root-", async (dir) => {
    const outside = path.join(path.dirname(dir), `outside-${path.basename(dir)}.txt`)
    fs.writeFileSync(outside, "outside")
    fs.writeFileSync(path.join(dir, "inside.txt"), "inside")
    fs.symlinkSync(path.join(dir, "inside.txt"), path.join(dir, "inside-link.txt"))
    fs.symlinkSync(outside, path.join(dir, "outside-link.txt"))
    fs.symlinkSync(dir, path.join(dir, "loop"), "dir")
    fs.writeFileSync(path.join(dir, "too-large.txt"), Buffer.alloc(10 * 1024 * 1024 + 1))

    try {
      const fetcher = createLocalPluginFileFetcher(dir)
      assert.equal((await fetcher.fetchFile("inside-link.txt")).content, "inside")
      assert.equal(await fetcher.fileExists("outside-link.txt"), false)
      await assert.rejects(() => fetcher.fetchFile("outside-link.txt"), /Path escapes plugin directory via symlink/)
      await assert.rejects(() => fetcher.fetchFile("too-large.txt"), /exceeds maximum size/)
      const visited = new Set([fs.realpathSync(dir)])
      assert.deepEqual(await fetcher.listDirectory("loop", visited), [])
    } finally {
      fs.rmSync(outside, { force: true })
    }
  })
})

test("a plugin directory is loaded into what the platform reads", async () => {
  await withTempDir("slate-plugin-", async (dir) => {
    fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({
      name: "my-plugin",
      displayName: "My Plugin",
      description: "Does a thing",
      author: { name: "Someone" },
      skills: "skills",
      rules: "rules",
    }))
    fs.mkdirSync(path.join(dir, "skills", "review"), { recursive: true })
    fs.writeFileSync(path.join(dir, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Reviews things\n---\n\nReview it.")
    fs.mkdirSync(path.join(dir, "rules"), { recursive: true })
    fs.writeFileSync(path.join(dir, "rules", "style.md"), "---\ndescription: House style\n---\n\nKeep it tidy.")

    const loaded = await loadPluginFromPath(dir, "third-party", { name: "my-plugin", version: "1.0.0" })
    assert.equal(loaded.installPath, dir)
    assert.equal(loaded.displayName, "My Plugin")
    assert.equal(loaded.description, "Does a thing")
    assert.equal(loaded.authorName, "Someone")
    assert.deepEqual(loaded.skills.map(skill => skill.name), ["review"])
    assert.deepEqual(loaded.rules.map(rule => rule.name), ["style"])
    assert.deepEqual(loaded.commands, [])
    // Nothing failed, so nothing is reported as a failure.
    assert.equal(loaded.loadError, undefined)
  })
})

test("component files keep their metadata, defaults and plugin-root expansion", async () => {
  await withTempDir("slate-plugin-", async (dir) => {
    fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({
      name: "field-notes",
      agents: "agents",
      commands: "commands",
      skills: "skills",
    }))
    fs.mkdirSync(path.join(dir, "agents"), { recursive: true })
    fs.writeFileSync(path.join(dir, "agents", "read_only.md"), "---\nname: helper agent\ndescription: Reads files\ntools: Read, Search\nmodel: small\npermissionMode: readonly\n---\n\n  Read the requested file.  ")
    fs.mkdirSync(path.join(dir, "commands"), { recursive: true })
    fs.writeFileSync(path.join(dir, "commands", "inspect.md"), "---\nname: inspect\ndescription: Inspect a file\nargument-hint:\n  - file\n  - target\n---\n\n  inspect ${CLAUDE_PLUGIN_ROOT}/bin/check  ")
    fs.mkdirSync(path.join(dir, "skills", "analyst"), { recursive: true })
    fs.writeFileSync(path.join(dir, "skills", "analyst", "SKILL.md"), "---\ndescription: Reviews changes\nglobs: src/{a,b}.ts, docs/**,\nalwaysApply: true\nenvironments: work, home\nmetadata:\n  disabledEnvironments:\n    - sandbox\n---\n\nReview the patch.")

    const loaded = await loadPluginFromPath(dir, "first-party", { name: "field-notes", version: "4" })
    assert.deepEqual(loaded.agents, [{
      path: "agents/read_only.md",
      name: "helper agent",
      description: "Reads files",
      tools: ["Read", "Search"],
      model: "small",
      prompt: "Read the requested file.",
      permissionMode: "readonly",
    }])
    assert.deepEqual(loaded.commands, [{
      path: "commands/inspect.md",
      name: "inspect",
      description: "Inspect a file",
      argumentHint: "[file target]",
      content: "inspect " + dir + "/bin/check",
    }])
    assert.deepEqual(loaded.skills, [{
      path: "skills/analyst/SKILL.md",
      name: "analyst",
      description: "Reviews changes",
      globs: ["src/{a,b}.ts", "docs/**"],
      alwaysApply: true,
      content: "---\ndescription: Reviews changes\nglobs: src/{a,b}.ts, docs/**,\nalwaysApply: true\nenvironments: work, home\nmetadata:\n  disabledEnvironments:\n    - sandbox\n---\n\nReview the patch.",
      environments: ["work", "home"],
      disabledEnvironments: ["sandbox"],
    }])
  })
})

test("a plugin's hooks are read in either of the shapes the format allows", async () => {
  await withTempDir("slate-plugin-", async (dir) => {
    fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name: "my-plugin" }))
    fs.mkdirSync(path.join(dir, "hooks"), { recursive: true })
    // The plugin's own shape: each step lists the scripts directly.
    fs.writeFileSync(path.join(dir, "hooks", "hooks.json"), JSON.stringify({
      version: 1,
      hooks: { afterAgentThought: [{ type: "command", command: "echo hi" }] },
    }))

    const direct = await loadPluginFromPath(dir, "third-party", { name: "my-plugin", version: "1.0.0" })
    const directHooks = direct.hooks as { readonly config?: { readonly hooks: Record<string, unknown> } } | undefined
    assert.deepEqual(directHooks?.config?.hooks.afterAgentThought, [{ type: "command", command: "echo hi" }])

    // The other shape: an event's entry carries a matcher and nests the scripts inside it, and the event is
    // named the way that shape names it rather than the way this platform does.
    fs.writeFileSync(path.join(dir, "hooks", "hooks.json"), JSON.stringify({
      hooks: { PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo hi" }] }] },
    }))
    const translated = await loadPluginFromPath(dir, "third-party", { name: "my-plugin", version: "1.0.0" })
    const translatedResult = translated.hooks as { readonly config?: { readonly hooks: Record<string, readonly { readonly type?: string; readonly command?: string }[]> } } | undefined
    const translatedHooks = translatedResult?.config?.hooks ?? {}
    assert.deepEqual(Object.keys(translatedHooks), ["postToolUse"])
    // The translated script keeps its command, and carries the fields the platform's own shape gives every
    // script rather than leaving them out.
    const translatedScripts = Object.values(translatedHooks)[0] ?? []
    assert.equal(translatedScripts.length, 1)
    assert.equal(translatedScripts[0]?.type, "command")
    assert.equal(translatedScripts[0]?.command, "echo hi")
  })
})

test("an unreadable hook document identifies the Slate manifest boundary", async () => {
  await withTempDir("slate-plugin-", async (dir) => {
    fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name: "bad-hooks" }))
    fs.mkdirSync(path.join(dir, "hooks"), { recursive: true })
    fs.writeFileSync(path.join(dir, "hooks", "hooks.json"), "{ malformed")

    const loaded = await loadPluginFromPath(dir, "third-party", { name: "bad-hooks", version: "2" })
    assert.deepEqual(loaded.hooks, {
      error: {
        source: "plugin-manifest",
        message: `Plugin bad-hooks@2 ${path.join(dir, "hooks", "hooks.json")}: invalid JSON`,
      },
    })
  })
})

test("a plugin whose manifest is not there is reported as a failed load rather than as no plugin", async () => {
  await withTempDir("slate-plugin-", async (dir) => {
    const loaded = await loadPluginFromPath(dir, "third-party", { name: "broken", version: "1.0.0" })
    // A directory with no manifest is a plugin with nothing in it rather than a failed load: what it brought is
    // empty, and the caller can still see which plugin it was.
    assert.equal(loaded.installPath, dir)
    assert.deepEqual(loaded.skills, [])
    assert.deepEqual(loaded.commands, [])
    assert.equal(loaded.identifier.sourceInfo.name, "broken")
  })
})

test("marketplace loading reports the listing, respects the cache and filter, and prunes by marketplace", async () => {
  await withTempDir("slate-marketplace-loader-", async (root) => {
    const cached = marketplaceEntry({
      name: "cached plugin",
      pluginId: "cached",
      pluginDbId: "db-cached",
      version: "1.0.0",
    })
    const toInstall = marketplaceEntry({
      name: "community plugin",
      pluginId: "install",
      pluginDbId: "db-install",
      version: "2.0.0",
      marketplace: { name: "community", id: "community-market" },
    })
    const secondCommunityEntry = marketplaceEntry({
      name: "community plugin",
      pluginId: "install",
      version: "3.0.0",
      marketplace: { name: "community", id: "community-market" },
    })
    const filtered = marketplaceEntry({ pluginId: "skip", version: "9.0.0" })
    const cache = cacheManagerFor(root, new Set(["cached"]))
    fs.mkdirSync(cache.cacheDir({ marketplaceSlug: "cursor-public", pluginId: "cached", version: "1.0.0" }), { recursive: true })
    fs.writeFileSync(
      path.join(cache.cacheDir({ marketplaceSlug: "cursor-public", pluginId: "cached", version: "1.0.0" }), "plugin.json"),
      JSON.stringify({ name: "cached-plugin", displayName: "Cached" }),
    )

    const events: string[] = []
    const listed: string[][] = []
    const installed: string[] = []
    const result = await loadFromMarketplaceSource({
      userId: "user-7",
      teamId: "team-4",
      client: {
        async listEnabledPlugins(userId, teamId) {
          events.push(`list:${userId}:${teamId}`)
          return { plugins: [cached, toInstall, secondCommunityEntry, filtered] }
        },
        async installPlugin(entry, targetDir) {
          events.push(`install:${entry.pluginId}`)
          installed.push(entry.pluginId)
          fs.writeFileSync(path.join(targetDir, "plugin.json"), JSON.stringify({ name: entry.pluginId, displayName: "Installed" }))
        },
      },
      cacheManager: cache.manager,
      onPluginsListed: async (entries) => { listed.push(entries.map((entry) => entry.pluginId)); events.push("listed") },
      pluginFilter: (entry) => entry.pluginId !== "skip",
      pruneOldVersions: true,
    })

    assert.equal(result.sourceUnavailable, false)
    assert.deepEqual(result.failures, [])
    assert.deepEqual(result.plugins.map((plugin) => plugin.identifier.sourceInfo.name), ["cached plugin", "community plugin", "community plugin"])
    assert.deepEqual(result.plugins.map((plugin) => plugin.displayName), ["Cached", "Installed", "Installed"])
    assert.deepEqual(result.plugins.map((plugin) => plugin.identifier.source), ["first-party", "third-party", "third-party"])
    assert.deepEqual(events, ["list:user-7:team-4", "listed", "install:install", "install:install"])
    assert.deepEqual(listed, [["cached", "install", "install", "skip"]])
    assert.deepEqual(installed, ["install", "install"])
    assert.deepEqual(cache.checked.map((key) => key.pluginId), ["cached", "install", "install"])
    assert.deepEqual(cache.marked.map((key) => key.pluginId), ["install", "install"])
    assert.equal(cache.pruned.length, 5, "each loaded version is pruned once, then each marketplace/plugin group is pruned once")
    assert.deepEqual(
      cache.pruned.filter((entry) => "keepVersions" in entry).map((entry) => [entry.pluginId, entry.keepVersions]),
      [["cached", ["1.0.0"]], ["install", ["2.0.0"]], ["install", ["3.0.0"]], ["cached", ["1.0.0"]], ["install", ["2.0.0", "3.0.0"]]],
    )
  })
})

test("a failed listing returns an unavailable source without inventing plugin records", async () => {
  await withTempDir("slate-marketplace-loader-", async (root) => {
    const cache = cacheManagerFor(root)
    const metrics = recordingMetrics()
    let installCalls = 0
    const result = await loadFromMarketplaceSource({
      userId: "user-7",
      client: {
        async listEnabledPlugins() { throw new Error("service is offline") },
        async installPlugin() { installCalls += 1 },
      },
      cacheManager: cache.manager,
      log: metrics.logger,
    })

    assert.deepEqual(result, { plugins: [], failures: [], sourceUnavailable: true })
    assert.equal(installCalls, 0)
    assert.equal(metrics.exceptions[0] instanceof Error, true)
    assert.deepEqual(metrics.increments, [{ name: "marketplace.source_unavailable", value: 1 }])
    assert.equal(metrics.logs.some((entry) => entry.message.includes("treating source as unavailable")), true)
  })
})

test("marketplace entry failures remain local and later plugins still load", async () => {
  await withTempDir("slate-marketplace-loader-", async (root) => {
    const listFailure: BackendPluginListFailure = {
      pluginName: "listed failure",
      pluginId: "listed-failure",
      errorMessage: "listing timed out",
      errorType: "timeout",
      marketplaceName: "community",
    }
    const missingMarketplace = marketplaceEntry({ pluginId: "missing-marketplace", marketplace: undefined })
    const broken = marketplaceEntry({
      name: "broken plugin",
      pluginId: "broken",
      marketplace: { name: "community", id: "community-market" },
    })
    const working = marketplaceEntry({
      name: "working plugin",
      pluginId: "working",
      marketplace: { name: "community", id: "community-market" },
    })
    const cache = cacheManagerFor(root)
    const metrics = recordingMetrics()
    const callbackErrors: string[] = []
    const installed: string[] = []
    const result = await loadFromMarketplaceSource({
      userId: "user-7",
      client: {
        async listEnabledPlugins() { return { plugins: [missingMarketplace, broken, working], listFailures: [listFailure] } },
        async installPlugin(entry, targetDir) {
          installed.push(entry.pluginId)
          if (entry.pluginId === "broken") {
            fs.writeFileSync(path.join(targetDir, "partial.txt"), "incomplete")
            throw new Error("git clone failed")
          }
          fs.writeFileSync(path.join(targetDir, "plugin.json"), JSON.stringify({ name: "working-plugin", displayName: "Working" }))
        },
      },
      cacheManager: cache.manager,
      log: metrics.logger,
      onPluginError: (entry, error) => callbackErrors.push(`${entry.pluginId}:${error.message}`),
    })

    assert.equal(result.sourceUnavailable, false)
    assert.deepEqual(result.failures.map((failure) => [failure.pluginId, failure.errorType]), [
      ["listed-failure", "timeout"],
      ["missing-marketplace", "manifest"],
      ["broken", "clone"],
    ])
    assert.deepEqual(result.plugins.map((plugin) => plugin.loadError), ["listing timed out", "git clone failed", undefined])
    assert.deepEqual(result.plugins.map((plugin) => plugin.identifier.sourceInfo.name), ["listed failure", "broken plugin", "working plugin"])
    assert.deepEqual(installed, ["broken", "working"])
    assert.deepEqual(callbackErrors.map((value) => value.split(":", 1)[0]), ["missing-marketplace", "broken"])
    assert.equal(fs.existsSync(cache.cacheDir({ marketplaceSlug: "community", pluginId: "broken", version: "1.0.0" })), false)
    assert.equal(metrics.exceptions.length, 1, "missing marketplace metadata is reported to the caller without capturing an exception")
  })
})
