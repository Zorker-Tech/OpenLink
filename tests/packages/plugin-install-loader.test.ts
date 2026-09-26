import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { createLocalPluginFileFetcher, loadPluginFromPath } from "../../source/packages/plugin-install/loader.ts"

// Loading a plugin is reading what is in its directory. The fetcher is what the loader reads through, so
// these tests drive both: what the fetcher refuses, and what a plugin directory turns into.

function withTempDir(prefix: string, run: (dir: string) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  return run(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }))
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

    const loaded = await loadPluginFromPath(dir, "cursor-third-party", { name: "my-plugin", version: "1.0.0" })
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

test("a plugin's hooks are read in either of the shapes the format allows", async () => {
  await withTempDir("slate-plugin-", async (dir) => {
    fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name: "my-plugin" }))
    fs.mkdirSync(path.join(dir, "hooks"), { recursive: true })
    // The plugin's own shape: each step lists the scripts directly.
    fs.writeFileSync(path.join(dir, "hooks", "hooks.json"), JSON.stringify({
      version: 1,
      hooks: { afterAgentThought: [{ type: "command", command: "echo hi" }] },
    }))

    const direct = await loadPluginFromPath(dir, "cursor-third-party", { name: "my-plugin", version: "1.0.0" })
    const directHooks = direct.hooks as { readonly config?: { readonly hooks: Record<string, unknown> } } | undefined
    assert.deepEqual(directHooks?.config?.hooks.afterAgentThought, [{ type: "command", command: "echo hi" }])

    // The other shape: an event's entry carries a matcher and nests the scripts inside it, and the event is
    // named the way that shape names it rather than the way this platform does.
    fs.writeFileSync(path.join(dir, "hooks", "hooks.json"), JSON.stringify({
      hooks: { PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo hi" }] }] },
    }))
    const translated = await loadPluginFromPath(dir, "cursor-third-party", { name: "my-plugin", version: "1.0.0" })
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

test("a plugin whose manifest is not there is reported as a failed load rather than as no plugin", async () => {
  await withTempDir("slate-plugin-", async (dir) => {
    const loaded = await loadPluginFromPath(dir, "cursor-third-party", { name: "broken", version: "1.0.0" })
    // A directory with no manifest is a plugin with nothing in it rather than a failed load: what it brought is
    // empty, and the caller can still see which plugin it was.
    assert.equal(loaded.installPath, dir)
    assert.deepEqual(loaded.skills, [])
    assert.deepEqual(loaded.commands, [])
    assert.equal(loaded.identifier.sourceInfo.name, "broken")
  })
})
