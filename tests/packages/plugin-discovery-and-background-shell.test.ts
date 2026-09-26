import { test } from "node:test"
import assert from "node:assert/strict"

import { PluginComponentDiscovery } from "../../source/packages/plugin-install/component-discovery.ts"
import { classifyCloneError, getCanonicalMarketplacePathSegments, isKilledSubprocessError, LS_REMOTE_TIMEOUT_MS, REMOTE_GIT_TIMEOUT_MS } from "../../source/packages/plugin-install/marketplace-cache.ts"
import { CoreShellFactory } from "../../source/packages/local-exec/background-shell.ts"

// ---------------------------------------------------------------------------------------------
// What a plugin brings
// ---------------------------------------------------------------------------------------------

function createFetcher(files: Record<string, string>) {
  return {
    async listDirectory(dir: string) {
      const entries = Object.entries(files)
        .filter(([candidate]) => candidate.startsWith(`${dir}/`) && !candidate.slice(dir.length + 1).includes("/"))
        .map(([candidate]) => ({ name: candidate.slice(dir.length + 1), path: candidate, type: "file" as const }))
      if (entries.length === 0) throw new Error(`no such directory: ${dir}`)
      return entries
    },
    async fetchFile(candidate: string) {
      const content = files[candidate]
      if (content === undefined) throw new Error(`no such file: ${candidate}`)
      return { content }
    },
    async fileExists(candidate: string) {
      return files[candidate] !== undefined
    },
  }
}

test("the components a manifest names are read from the plugin's own files", async () => {
  const fetcher = createFetcher({
    "commands/deploy.md": "---\nname: Deploy\ndescription: Ship it\n---\n\nDeploy the thing.",
    "rules/style.md": "---\ndescription: House style\n---\n\nKeep it tidy.",
  })
  const discovery = new PluginComponentDiscovery(fetcher)
  const found = await discovery.discoverComponents({
    // A list names the files themselves; a single path names a directory to scan.
    manifest: { commands: ["commands/deploy.md", "commands/missing.md"], rules: "rules" },
  })

  assert.deepEqual(found.commands.map(command => command.name), ["deploy"])
  assert.equal(found.commands[0]?.description, "Ship it")
  assert.equal(found.commands[0]?.path, "commands/deploy.md")
  // A directory named as one path has its files scanned, and a rule's name is derived from its file name.
  assert.deepEqual(found.rules.map(rule => rule.name), ["style"])
  assert.equal(found.rules[0]?.description, "House style")
  // Nothing was named for the other kinds, so nothing is reported for them.
  assert.deepEqual(found.agents, [])
  assert.deepEqual(found.skills, [])
})

test("two components with the same name are one", async () => {
  const fetcher = createFetcher({
    "commands/deploy.md": "---\nname: Deploy\n---\n\nThe one that counts.",
    "commands/extra/deploy.md": "---\nname: deploy\n---\n\nA second one.",
  })
  const discovery = new PluginComponentDiscovery(fetcher)
  const found = await discovery.discoverComponents({ manifest: { commands: ["commands/deploy.md", "commands/extra/deploy.md"] } })

  assert.deepEqual(found.commands.map(command => command.name), ["deploy"])
  assert.equal(found.commands[0]?.path, "commands/deploy.md")
})

test("a manifest that names nothing discovers nothing", async () => {
  const discovery = new PluginComponentDiscovery(createFetcher({}))
  const found = await discovery.discoverComponents({})
  assert.deepEqual(found.commands, [])
  assert.deepEqual(found.mcpServers, [])
  assert.equal(found.mcpVariables, undefined)
})

// ---------------------------------------------------------------------------------------------
// A marketplace's cache
// ---------------------------------------------------------------------------------------------

test("a clone failure is classified by who has to act", () => {
  assert.equal(classifyCloneError(new Error("fatal: could not read Username for 'https://github.com': terminal prompts disabled")), "user_git_access")
  assert.equal(classifyCloneError(new Error("fatal: unable to get password from user")), "user_git_access")
  // A cache that two processes raced over is not the user's problem, and neither is a pinned ref that is gone.
  const raced = classifyCloneError(new Error("fatal: destination path 'x' already exists and is not an empty directory"))
  assert.equal(["local_cache_race", "infrastructure"].includes(raced), true)
  assert.equal(classifyCloneError(new Error("fatal: remote error: upload-pack: not our ref")), "stale_pinned_ref")
  // A spelling the platform does not know is infrastructure rather than a guess at who is at fault.
  assert.equal(classifyCloneError(new Error("fatal: could not read Password for 'https://github.com'")), "infrastructure")
  assert.equal(classifyCloneError(new Error("something nobody has seen before")), "infrastructure")
  assert.equal(LS_REMOTE_TIMEOUT_MS, 30_000)
  assert.equal(REMOTE_GIT_TIMEOUT_MS, 30 * 60_000)
})

test("a subprocess that was killed is told from one that failed on its own", () => {
  assert.equal(isKilledSubprocessError({ killed: true }), true)
  assert.equal(isKilledSubprocessError({ killed: false }), false)
  assert.equal(isKilledSubprocessError({ cause: { killed: true } }), true)
  assert.equal(isKilledSubprocessError(new Error("nope")), false)
  assert.equal(isKilledSubprocessError(null), false)
})

test("a marketplace's cache path is the same however its URL was spelled", () => {
  const https = getCanonicalMarketplacePathSegments("https://github.com/acme/Plugins.git")
  assert.deepEqual(https, { host: "github.com", pathSegments: ["acme", "plugins"] })
  const ssh = getCanonicalMarketplacePathSegments("git@github.com:acme/plugins.git")
  assert.deepEqual(ssh, https)
  const www = getCanonicalMarketplacePathSegments("https://www.github.com/acme/plugins")
  assert.deepEqual(www, https)
  // A gitlab project may be nested, so its own path is what identifies it.
  const gitlab = getCanonicalMarketplacePathSegments("https://gitlab.com/group/sub/plugins")
  assert.deepEqual(gitlab, { host: "gitlab.com", pathSegments: ["group", "sub", "plugins"] })
  // Something that is not a repository URL at all is refused rather than cached under a guess.
  assert.throws(() => getCanonicalMarketplacePathSegments("not a url"), /Invalid git URL/)
})

// ---------------------------------------------------------------------------------------------
// A shell that outlives its command
// ---------------------------------------------------------------------------------------------

function createCoreExecutor(events: readonly Record<string, unknown>[]) {
  return {
    execute: () => ({
      async *[Symbol.asyncIterator]() {
        for (const event of events) yield event
      },
    }),
    getCwd: async () => "/repo",
  }
}

test("starting a background shell waits only until it can be written to", async () => {
  const factory = new CoreShellFactory()
  const shell = await factory.spawn(
    { shellId: 7, command: "npm run dev", workingDirectory: "/repo", conversationId: "c1" } as never,
    createCoreExecutor([
      { type: "stdout", data: Buffer.from("starting") },
      { type: "stdin_ready", stdin: { write: () => true }, pid: 4242 },
      { type: "exit", code: 0, aborted: false },
    ]) as never,
  )

  assert.equal(shell.id, 7)
  assert.equal(shell.pid, 4242)
  assert.equal(shell.stdin !== undefined, true)
  // The shell is handed back while it is still running rather than after its command ended.
  assert.equal(shell.signal.aborted, false)
  shell.dispose()
})

test("an executor that is not a background executor is refused", async () => {
  const factory = new CoreShellFactory()
  await assert.rejects(
    () => factory.spawn({ shellId: 8, command: "ls" } as never, {} as never),
    /Background shell core executor is not configured/,
  )
})
