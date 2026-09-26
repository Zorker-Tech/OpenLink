import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

import { inferMcpPlaceholderVariables } from "../../source/packages/plugin-install/mcp-placeholder-variables.ts"
import { resolveGitRemoteRef } from "../../source/packages/plugin-install/git-remote-ref-resolve.ts"
import {
  containsPluginRootDir,
  isPathSafe,
  MAX_MANIFEST_SIZE_BYTES,
  normalizeMarketplaceName,
  parseAndClassifyManifestEntries,
  parseMarketplaceManifest,
  parsePluginManifest,
  PLUGIN_MANIFEST_PATHS,
  PLUGIN_ROOT_DIR_NAMES,
  resolvePluginSourcePath,
} from "../../source/packages/plugin-install/manifest-parser.ts"

// ---------------------------------------------------------------------------------------------
// The values a plugin's MCP configuration asks for
// ---------------------------------------------------------------------------------------------

test("the placeholders a plugin asks for are collected from its own configuration", () => {
  assert.equal(inferMcpPlaceholderVariables(undefined), undefined)
  assert.equal(inferMcpPlaceholderVariables({ mcpServers: { mine: { command: "node" } } }), undefined)

  const inferred = inferMcpPlaceholderVariables({
    mcpServers: {
      mine: {
        command: "node",
        env: { API_URL: "${API_URL}", TOKEN: "${TOKEN:-abc}" },
        args: ["--root", "${CURSOR_PLUGIN_ROOT}", "${CLAUDE_PLUGIN_ROOT}"],
        nested: { deeper: ["${REGION}"] },
      },
    },
  })

  // The two variables the loader fills in itself are not the user's to provide.
  assert.deepEqual(Object.keys(inferred?.properties ?? {}), ["API_URL", "REGION", "TOKEN"])
  // A name is shown as words, and a default is said out loud.
  assert.equal(inferred?.properties.API_URL?.title, "API URL")
  assert.match(inferred?.properties.API_URL?.description ?? "", /Referenced as `\$\{API_URL\}`/)
  assert.match(inferred?.properties.TOKEN?.description ?? "", /Defaults to `abc` when left blank/)
  // A name that says it holds a secret is marked as one.
  assert.equal(inferred?.properties.TOKEN?.writeOnly, true)
  assert.equal(inferred?.properties.API_URL?.writeOnly, undefined)
})

// ---------------------------------------------------------------------------------------------
// Resolving the ref a manifest names
// ---------------------------------------------------------------------------------------------

function createRemoteRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slate-remote-"))
  const remote = path.join(root, "remote.git")
  const work = path.join(root, "work")
  execFileSync("git", ["init", "--bare", "--quiet", remote])
  execFileSync("git", ["init", "--quiet", work])
  fs.writeFileSync(path.join(work, "a.txt"), "a")
  execFileSync("git", ["-C", work, "add", "a.txt"])
  execFileSync("git", ["-C", work, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "--quiet", "-m", "first"])
  execFileSync("git", ["-C", work, "branch", "-M", "main"])
  execFileSync("git", ["-C", work, "tag", "v1"])
  // An annotated tag names its own object, so resolving it has to follow it to the commit underneath.
  execFileSync("git", ["-C", work, "-c", "user.email=t@example.com", "-c", "user.name=t", "tag", "-a", "abc1234", "-m", "hex-named"])
  execFileSync("git", ["-C", work, "remote", "add", "origin", remote])
  execFileSync("git", ["-C", work, "push", "--quiet", "origin", "main", "--tags"])
  // The remote's HEAD has to name the branch that is actually there.
  execFileSync("git", ["-C", remote, "symbolic-ref", "HEAD", "refs/heads/main"])
  const sha = execFileSync("git", ["-C", work, "rev-parse", "HEAD"]).toString().trim()
  return { root, remote, sha }
}

test("a ref a plugin named is resolved to the commit it points at", async () => {
  const { root, remote, sha } = createRemoteRepo()
  try {
    // A branch and a tag both resolve to the commit they point at.
    assert.deepEqual(await resolveGitRemoteRef(remote, "main"), { fullSha: sha })
    assert.deepEqual(await resolveGitRemoteRef(remote, "v1"), { fullSha: sha })
    assert.deepEqual(await resolveGitRemoteRef(remote, "refs/heads/main"), { fullSha: sha })
    // A ref that looks like a short hash is resolved against the branch and tag names it could be, and a tag
    // that points at its own object is followed to the commit underneath it.
    assert.deepEqual(await resolveGitRemoteRef(remote, "abc1234"), { fullSha: sha })
    // HEAD also reports what the remote said about it.
    const head = await resolveGitRemoteRef(remote, "HEAD")
    assert.equal(head.fullSha, sha)
    assert.equal(typeof head.headSymrefStdout, "string")
    // A full commit is taken as it is, without asking the remote.
    assert.deepEqual(await resolveGitRemoteRef("/no/such/remote", sha.toUpperCase()), { fullSha: sha })

    // A ref that is not there is reported as a failure with what was being resolved.
    await assert.rejects(() => resolveGitRemoteRef(remote, "no-such-branch"), /did not return a resolvable commit for ref "no-such-branch"/)
    // And a remote that cannot be reached is reported as the failure it was.
    await assert.rejects(() => resolveGitRemoteRef("/no/such/remote", "main"), /Failed to resolve git ref "main"/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------------------------
// Reading a manifest
// ---------------------------------------------------------------------------------------------

test("a manifest is read against the schema the format defines", () => {
  const read = parsePluginManifest(JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "my-plugin",
    displayName: "My Plugin",
    version: "1.2.3",
    author: { name: "Someone" },
    capabilities: ["canvas"],
    minClientVersions: { cursor: "1.0.0" },
    mcpServers: { mine: { command: "node" } },
    skills: ["./skills"],
  }))
  assert.equal(read.success, true)
  assert.equal(read.success && read.data.name, "my-plugin")
  assert.deepEqual(read.success && read.data.capabilities, ["canvas"])
  // A schema this platform does not know is reported rather than silently accepted.
  assert.equal(read.success && read.unrecognizedSchemaId, undefined)

  const unknownSchema = parsePluginManifest(JSON.stringify({ $schema: "https://example.com/9.9.9/plugin.schema.json", name: "my-plugin" }))
  assert.equal(unknownSchema.success && unknownSchema.unrecognizedSchemaId, "https://example.com/9.9.9/plugin.schema.json")

  // A name that is not kebab-case, and a manifest that is not JSON at all, are refused with a reason.
  const badName = parsePluginManifest(JSON.stringify({ name: "My Plugin" }))
  assert.equal(badName.success, false)
  assert.match(badName.success === false ? badName.error : "", /kebab-case/)
  assert.equal(parsePluginManifest("{ not json").success, false)
})

test("a marketplace manifest is read, with the name and the plugins it lists", () => {
  const read = parseMarketplaceManifest(JSON.stringify({
    name: "  My Marketplace  ",
    owner: { name: "Someone", email: "someone@example.com" },
    plugins: [{ name: "a-plugin", source: "github:acme/a-plugin" }],
  }), { repoName: "acme/plugins" })
  assert.equal(read.success, true)
  assert.equal(read.success && read.data.name, "my-marketplace")
  assert.equal(read.success && read.data.owner?.email, "someone@example.com")

  // A marketplace that names itself nothing falls back to the repository it came from.
  const unnamed = parseMarketplaceManifest(JSON.stringify({ plugins: [] }), { repoName: "acme/plugins" })
  assert.equal(unnamed.success && unnamed.data.name, "acme-plugins")

  assert.equal(normalizeMarketplaceName("  A  B  "), "a-b")
  assert.equal(parseMarketplaceManifest("not json").success, false)
})

test("a plugin's source is read into a path, and only a safe one is accepted", () => {
  // A source that names a directory is resolved inside the marketplace's own root.
  assert.equal(resolvePluginSourcePath("./plugins/mine", "/repo"), path.join("/repo", "plugins", "mine"))
  assert.equal(resolvePluginSourcePath("plugins/mine"), "plugins/mine")
  // A source that names a repository is not a path at all.
  assert.equal(resolvePluginSourcePath({ source: "github", repo: "acme/a-plugin" }), null)

  assert.equal(isPathSafe("plugins/mine"), true)
  assert.equal(isPathSafe("../outside"), false)
  assert.equal(isPathSafe("/etc/passwd"), false)
  assert.equal(isPathSafe("https://example.com/x"), false)

  assert.equal(containsPluginRootDir(["rules", ".cursor-plugin"]), true)
  assert.equal(containsPluginRootDir(["rules"]), false)
  assert.equal(PLUGIN_ROOT_DIR_NAMES.includes(".cursor-plugin"), true)
  assert.equal(PLUGIN_MANIFEST_PATHS.includes("plugin.json"), true)
  assert.equal(MAX_MANIFEST_SIZE_BYTES, 10 * 1024 * 1024)
})

test("the entries a marketplace lists are classified by what they are", () => {
  // The entries come from a marketplace manifest, which is what reads them into their shape.
  const marketplace = parseMarketplaceManifest(JSON.stringify({
    name: "acme",
    plugins: [
      { name: "from-a-repository", source: { source: "github", repo: "acme/a-plugin", ref: "main" } },
      { name: "local", source: "./plugins/local" },
      { name: "pinned", source: { source: "url", url: "https://example.com/x.git", sha: "a".repeat(40) } },
    ],
  }))
  assert.equal(marketplace.success, true)
  const classified = parseAndClassifyManifestEntries(marketplace.success ? marketplace.data.plugins : [], "/repo")

  assert.equal(classified.length, 3)
  // A repository source becomes the URL to fetch and the ref to fetch it at.
  assert.equal(classified[0]?.kind, "external-github")
  assert.equal(classified[0]?.kind === "external-github" && classified[0].externalUrl, "https://github.com/acme/a-plugin.git")
  assert.equal(classified[0]?.kind === "external-github" && classified[0].effectiveRef, "main")
  // A directory source becomes a path inside the marketplace.
  assert.equal(classified[1]?.kind, "local")
  assert.equal(classified[1]?.kind === "local" && classified[1].localPath, path.join("/repo", "plugins", "local"))
  // A pinned commit is what is fetched, rather than the ref beside it.
  assert.equal(classified[2]?.kind === "external-url" && classified[2].effectiveRef, "a".repeat(40))
})
