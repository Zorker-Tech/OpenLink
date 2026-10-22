import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { FOCUS_RETRY_MINIMUM_COOLDOWN_MS } from "../../source/packages/mcp-core/config/mcp-focus-retry-cooldown.ts"
import { DEFAULT_KEEPALIVE_PROBE_DELAY_MS } from "../../source/packages/mcp-core/config/mcp-fsm-timing-config.ts"
import { DEFAULT_INLINE_RECONNECT_COOLDOWN_MS } from "../../source/packages/mcp-core/config/mcp-inline-reconnect-cooldown.ts"
import {
  DEFAULT_MCP_TOOL_CALL_MAX_TOTAL_TIMEOUT_MS,
  LEGACY_MCP_TOOL_CALL_TIMEOUT_MS,
} from "../../source/packages/mcp-core/config/mcp-tool-call-timeout.ts"
import { isSecretPluginVariableName } from "../../source/packages/plugin-install/secret-variable-names.ts"
import { CapabilitiesSchema } from "../../source/packages/plugin-install/capabilities.ts"
import { expandPluginVariables } from "../../source/packages/plugin-install/plugin-variables.ts"
import { getPluginDbId, type PluginIdentifier } from "../../source/packages/plugin-install/identifiers.ts"
import {
  extractSchemaVersion,
  readSchemaId,
  resolveSchemaVersion,
  schemaVersionsDisagree,
  SUPPORTED_SCHEMA_IDS,
} from "../../source/packages/plugin-install/schema-version.ts"
import { validateAndResolveSubpath } from "../../source/packages/plugin-install/validate-subpath.ts"
import { expandEnvVarsWithLookup, recordToCaseInsensitiveLookup } from "../../source/packages/plugin-install/env-expansion.ts"
import { packPluginArtifact } from "../../source/packages/plugin-install/tarball.ts"
import { buildOriginTokenGitConfig, PREFER_ORIGIN_READS_HEADER } from "../../source/packages/plugin-install/origin-git-auth.ts"
import { mcpConfigSchema, noopPluginMetricsLogger } from "../../source/packages/plugin-install/types.ts"
import { execGitNonInteractive, resolveExtraGitConfig } from "../../source/packages/plugin-install/git-subprocess-env.ts"
import { synthesizeInlinePluginDir } from "../../source/packages/plugin-install/inline-plugin-synthesizer.ts"
import { restoreSkillsFromPluginDir } from "../../source/packages/plugin-install/skill-plugin-restore.ts"
import { canonicalRepoHost, parseAndValidateScmUrl, parseGitUrl, toScmSshUrl } from "../../source/packages/plugin-install/git-url-parsing.ts"
import {
  getPluginInstallCachePath,
  PLUGIN_CACHE_SENTINEL,
  PLUGINS_CACHE_ROOT,
} from "../../source/packages/plugin-install/marketplace.ts"

// ---------------------------------------------------------------------------------------------
// The numbers the MCP core waits by
// ---------------------------------------------------------------------------------------------

test("the waits the MCP core uses are the ones it promises", () => {
  assert.equal(FOCUS_RETRY_MINIMUM_COOLDOWN_MS, 5 * 60_000)
  assert.equal(DEFAULT_KEEPALIVE_PROBE_DELAY_MS, 5 * 60_000)
  assert.equal(DEFAULT_INLINE_RECONNECT_COOLDOWN_MS, 5 * 60_000)
  assert.equal(DEFAULT_MCP_TOOL_CALL_MAX_TOTAL_TIMEOUT_MS, 60 * 60_000)
  // The name earlier callers were written against is the same limit, not a different one.
  assert.equal(LEGACY_MCP_TOOL_CALL_TIMEOUT_MS, DEFAULT_MCP_TOOL_CALL_MAX_TOTAL_TIMEOUT_MS)
})

// ---------------------------------------------------------------------------------------------
// Reading a plugin
// ---------------------------------------------------------------------------------------------

test("a variable is a secret when its name says so, not when it merely contains the letters", () => {
  assert.equal(isSecretPluginVariableName("MY_API_KEY"), true)
  assert.equal(isSecretPluginVariableName("apiKey"), true)
  assert.equal(isSecretPluginVariableName("github_token"), true)
  assert.equal(isSecretPluginVariableName("PASSWORD"), true)
  assert.equal(isSecretPluginVariableName("KEYCHAIN"), false)
  assert.equal(isSecretPluginVariableName("monkey"), false)
})

test("a plugin's capabilities are the ones it may ask for, each of them once", () => {
  assert.deepEqual(CapabilitiesSchema.parse(["canvas", "canvas"]), ["canvas"])
  assert.deepEqual(CapabilitiesSchema.parse([]), [])
  assert.throws(() => CapabilitiesSchema.parse(["telepathy"]))
})

test("a plugin's files can name where the plugin is installed, in either spelling", () => {
  assert.equal(expandPluginVariables("run ${CLAUDE_PLUGIN_ROOT}/bin/tool", "/plugins/mine"), "run /plugins/mine/bin/tool")
  assert.equal(expandPluginVariables("run ${CURSOR_PLUGIN_ROOT}/bin/tool", "/plugins/mine"), "run /plugins/mine/bin/tool")
  // A variable the format does not define is left as it was written.
  assert.equal(expandPluginVariables("${SOMETHING_ELSE}", "/plugins/mine"), "${SOMETHING_ELSE}")
  assert.equal(expandPluginVariables("${CLAUDE_PLUGIN_ROOT}:${CURSOR_PLUGIN_ROOT}", "/p"), "/p:/p", "both spellings are expanded")
  assert.equal(expandPluginVariables("${CLAUDE_PLUGIN_ROOT}${CLAUDE_PLUGIN_ROOT}", "/p"), "/p/p", "every occurrence is expanded")
  assert.equal(expandPluginVariables("${claude_plugin_root}", "/p"), "${claude_plugin_root}", "the spelling is exact")
  assert.equal(expandPluginVariables("${CLAUDE_PLUGIN_ROOT }", "/p"), "${CLAUDE_PLUGIN_ROOT }", "a space makes it another variable")
  assert.equal(expandPluginVariables("", "/p"), "")
  assert.equal(expandPluginVariables("$&", "/p"), "$&", "a value with no variable is untouched")
  assert.equal(expandPluginVariables("${CLAUDE_PLUGIN_ROOT}", "$&"), "$&", "the path is inserted as it is, not as a replacement pattern")
  assert.equal(expandPluginVariables("${CLAUDE_PLUGIN_ROOT}", "X${CURSOR_PLUGIN_ROOT}Y"), "XX${CURSOR_PLUGIN_ROOT}YY", "the spellings are expanded in the order the format lists them, so a path carrying the second one is expanded in its turn")
})

test("a plugin is identified by its source, and only the published ones carry an id", () => {
  const firstParty: PluginIdentifier = { source: "cursor-first-party", sourceInfo: { pluginDbId: "db-1" } }
  const thirdParty: PluginIdentifier = { source: "cursor-third-party", sourceInfo: { pluginDbId: "db-2" } }
  const local: PluginIdentifier = { source: "user-local" }
  assert.equal(getPluginDbId(firstParty), "db-1")
  assert.equal(getPluginDbId(thirdParty), "db-2")
  assert.equal(getPluginDbId(local), undefined)
})

test("a manifest's schema is read, and a version that is not ours is said to be unsupported", () => {
  assert.equal(readSchemaId({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json" }), "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json")
  assert.equal(readSchemaId({}), undefined)
  assert.equal(readSchemaId([]), undefined)
  assert.equal(readSchemaId(null), undefined)

  assert.equal(extractSchemaVersion("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"), "1.0.0")
  assert.equal(extractSchemaVersion("schemas/v2.1/mcp.schema.json"), "2.1")
  assert.equal(extractSchemaVersion("https://agent-plugins.org/schemas/plugin.schema.json"), undefined)

  assert.deepEqual(resolveSchemaVersion(undefined), { kind: "absent" })
  const supported = [...SUPPORTED_SCHEMA_IDS][0]!
  assert.equal(resolveSchemaVersion(supported).kind, "supported")
  assert.equal(resolveSchemaVersion("https://example.com/2.0.0/plugin.schema.json").kind, "unsupported")

  // Two declarations of the same schema that name different versions disagree about the format.
  assert.equal(schemaVersionsDisagree("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", "https://agent-plugins.org/schemas/2.0.0/mcp.schema.json"), true)
  assert.equal(schemaVersionsDisagree("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"), false)
  assert.equal(schemaVersionsDisagree(undefined, "https://agent-plugins.org/schemas/2.0.0/mcp.schema.json"), false)
})

test("a path inside a plugin is resolved, and one that leaves it is refused", () => {
  assert.equal(validateAndResolveSubpath("/plugins/mine", "rules/a.md"), path.join("/plugins/mine", "rules/a.md"))
  assert.equal(validateAndResolveSubpath("/plugins/mine", "."), "/plugins/mine")
  assert.throws(() => validateAndResolveSubpath("/plugins/mine", "../elsewhere/a.md"), /path traversal not allowed/)
  assert.throws(() => validateAndResolveSubpath("/plugins/mine", "/etc/passwd"), /path traversal not allowed/)
})

test("the variables a plugin's configuration refers to are expanded, defaults included", () => {
  const lookup = recordToCaseInsensitiveLookup({ API_URL: "https://api.example", Empty: "" })
  assert.equal(expandEnvVarsWithLookup("${API_URL}/v1", lookup), "https://api.example/v1")
  // The lookup does not care how the name was written, and a default is used when nothing defines it.
  assert.equal(expandEnvVarsWithLookup("${api_url}", lookup), "https://api.example")
  assert.equal(expandEnvVarsWithLookup("${MISSING:-fallback}", lookup), "fallback")
  // A variable that nothing defines and that has no default is left as it was written.
  assert.equal(expandEnvVarsWithLookup("${MISSING}", lookup), "${MISSING}")

  // A configuration is walked whole: lists and nested objects are expanded too.
  assert.deepEqual(
    expandEnvVarsWithLookup({ args: ["--url", "${API_URL}"], env: { URL: "${API_URL}" }, count: 3 }, lookup),
    { args: ["--url", "https://api.example"], env: { URL: "https://api.example" }, count: 3 },
  )
})

test("a plugin directory is packed into one artifact, without its symlinks", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slate-plugin-pack-"))
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "slate-plugin-unpack-"))
  try {
    fs.mkdirSync(path.join(dir, "rules"))
    fs.writeFileSync(path.join(dir, "rules", "a.md"), "# a rule")
    fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name: "mine" }))
    fs.symlinkSync(path.join(dir, "plugin.json"), path.join(dir, "link.json"))

    const artifact = await packPluginArtifact(dir)
    // A gzipped tar, which is what the artifact is.
    assert.equal(artifact[0], 0x1f)
    assert.equal(artifact[1], 0x8b)

    const { extract } = await import("tar")
    fs.writeFileSync(path.join(out, "plugin.tgz"), artifact)
    await extract({ file: path.join(out, "plugin.tgz"), cwd: out })
    assert.equal(fs.readFileSync(path.join(out, "rules", "a.md"), "utf8"), "# a rule")
    // A link points at something that is not part of the plugin, so it is left out.
    assert.equal(fs.existsSync(path.join(out, "link.json")), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(out, { recursive: true, force: true })
  }
})

test("the git configuration carries a token to the hosts the caller names", () => {
  assert.equal(buildOriginTokenGitConfig(undefined), undefined)
  assert.equal(buildOriginTokenGitConfig(""), undefined)

  // The platform's own origin is not defined yet, so the hosts come from the caller.
  assert.deepEqual(buildOriginTokenGitConfig("token-1"), {})
  const config = buildOriginTokenGitConfig("token-1", ["origin.example"])
  const header = `Authorization: Basic ${Buffer.from("x-access-token:token-1").toString("base64")}`
  assert.deepEqual(config, {
    "http.https://origin.example/.extraheader": [header, PREFER_ORIGIN_READS_HEADER],
  })
})

test("a plugin's MCP configuration is read against the shape it has", () => {
  const parsed = mcpConfigSchema.parse({
    mcpServers: {
      mine: { command: "node", args: ["server.js"], env: { PORT: "1" }, enabledTools: ["search"] },
      remote: { url: "https://mcp.example/sse", headers: { Authorization: "Bearer x" } },
    },
  })
  assert.equal(parsed.mcpServers?.mine?.command, "node")
  assert.deepEqual(parsed.mcpServers?.mine?.enabledTools, ["search"])
  assert.equal(parsed.mcpServers?.remote?.url, "https://mcp.example/sse")
  assert.deepEqual(parsed.mcpServers, { mine: parsed.mcpServers?.mine, remote: parsed.mcpServers?.remote })

  // A configuration that does not match the shape is refused rather than half-read.
  assert.throws(() => mcpConfigSchema.parse({ mcpServers: { mine: { args: "not a list" } } }))

  // The logger a loader is handed says nothing until a caller gives it somewhere to say it.
  noopPluginMetricsLogger.log("error", "ignored")
  noopPluginMetricsLogger.increment("ignored", 1)
  noopPluginMetricsLogger.distribution("ignored", 1)
  noopPluginMetricsLogger.captureException(new Error("ignored"))
})

test("git is run without a prompt, with whatever extra configuration the caller adds", async () => {
  assert.equal(resolveExtraGitConfig(undefined), undefined)
  assert.deepEqual(resolveExtraGitConfig({ "http.proxy": "http://proxy" }), { "http.proxy": "http://proxy" })
  // A provider that is a function is asked at the moment of the call, since a token may be read fresh.
  assert.deepEqual(resolveExtraGitConfig(() => ({ "http.extraheader": "x" })), { "http.extraheader": "x" })

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slate-git-"))
  try {
    await execGitNonInteractive(["init", "--quiet"], { cwd: dir })
    const inside = await execGitNonInteractive(["rev-parse", "--is-inside-work-tree"], { cwd: dir })
    assert.equal(inside.stdout.trim(), "true")
    // A git command that fails is reported as a failure rather than as output.
    await assert.rejects(() => execGitNonInteractive(["rev-parse", "--verify", "no-such-ref"], { cwd: dir }))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a plugin that arrived as a manifest is written out as a directory", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slate-inline-plugin-"))
  try {
    await synthesizeInlinePluginDir({
      targetDir: dir,
      pluginName: "mine",
      inlineContentJson: JSON.stringify({
        rules: [{ name: "always test", content: "run the tests", globs: ["**/*.ts"], isRequired: true }],
        commands: [{ name: "deploy", content: "deploy it", description: "Deploy the thing" }],
        hooks: [
          { hookStep: "afterAgentThought", hookType: "prompt", promptContent: "think again", operatingSystems: ["Windows"] },
          { hookStep: "afterAgentThought", hookType: "command", scriptContent: "echo hi" },
        ],
        mcpServers: [{ name: "mine", config: { command: "node" } }],
      }),
    })

    // A rule becomes a file with the frontmatter the format uses.
    const ruleName = fs.readdirSync(path.join(dir, "rules"))[0]!
    const rule = fs.readFileSync(path.join(dir, "rules", ruleName), "utf8")
    // A value that needs no quoting is written as it is; one with characters YAML would read differently is quoted.
    assert.match(rule, /^---\ndescription: always test\nglobs: "\*\*\/\*\.ts"\nalwaysApply: true\n---/)
    assert.match(rule, /run the tests/)
    assert.equal(fs.existsSync(path.join(dir, "commands", "deploy.md")), true)
    assert.equal(fs.readFileSync(path.join(dir, ".mcp.json"), "utf8").includes("mine"), true)

    // A hook written for another system is left out rather than run where it does not belong.
    const hooks = JSON.parse(fs.readFileSync(path.join(dir, "hooks", "hooks.json"), "utf8")) as { hooks: Record<string, unknown[]> }
    assert.deepEqual(hooks.hooks.afterAgentThought, [{ type: "command", command: "echo hi" }])

    const manifest = JSON.parse(fs.readFileSync(path.join(dir, ".cursor-plugin", "plugin.json"), "utf8")) as { name: string; rules?: string[] }
    assert.equal(manifest.name, "mine")
    assert.deepEqual(manifest.rules, [`rules/${ruleName}`])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a plugin's skills are put back where the workspace reads them, and nothing is overwritten", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slate-skills-"))
  try {
    const pluginSkills = path.join(root, "plugin", "skills")
    const skillsRoot = path.join(root, "workspace", "skills")
    fs.mkdirSync(path.join(pluginSkills, "review"), { recursive: true })
    fs.writeFileSync(path.join(pluginSkills, "review", "SKILL.md"), "from the plugin")
    fs.mkdirSync(path.join(skillsRoot, "review"), { recursive: true })
    fs.writeFileSync(path.join(skillsRoot, "review", "SKILL.md"), "the user's own")

    // The copy in the workspace is the one the user may have edited, so a skill that is already there is
    // refused rather than overwritten.
    await assert.rejects(
      () => restoreSkillsFromPluginDir({
        skillDirs: [path.join(pluginSkills, "review")],
        pluginSkillsRoot: pluginSkills,
        skillsRoot,
      }),
      /that path already exists/,
    )
    assert.equal(fs.readFileSync(path.join(skillsRoot, "review", "SKILL.md"), "utf8"), "the user's own")

    // With nothing in the way, the skill is put back where the workspace reads it.
    fs.rmSync(path.join(skillsRoot, "review"), { recursive: true, force: true })
    const restored = await restoreSkillsFromPluginDir({
      skillDirs: [path.join(pluginSkills, "review")],
      pluginSkillsRoot: pluginSkills,
      skillsRoot,
    })
    assert.deepEqual(restored, [path.join(skillsRoot, "review")])
    assert.equal(fs.readFileSync(path.join(skillsRoot, "review", "SKILL.md"), "utf8"), "from the plugin")

    // A folder that is not inside the plugin's skills is refused.
    await assert.rejects(
      () => restoreSkillsFromPluginDir({ skillDirs: [path.join(root, "elsewhere")], pluginSkillsRoot: pluginSkills, skillsRoot }),
      /not inside the plugin's skills directory/,
    )
    await assert.rejects(
      () => restoreSkillsFromPluginDir({ skillDirs: [], pluginSkillsRoot: pluginSkills, skillsRoot }),
      /At least one skill directory is required/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("a repository URL is read in the spellings it comes in", () => {
  assert.deepEqual(parseGitUrl("https://github.com/acme/widgets.git"), { provider: "github", owner: "acme", repo: "widgets", host: "github.com" })
  assert.deepEqual(parseGitUrl("git@github.com:acme/widgets.git"), { provider: "github", owner: "acme", repo: "widgets", host: "github.com" })
  assert.deepEqual(parseGitUrl("gitlab.com/acme/widgets"), { provider: "gitlab", owner: "acme", repo: "widgets", host: "gitlab.com" })
  // A host that is nobody in particular is still read, and a URL that names no repository is not.
  assert.equal(parseGitUrl("https://git.example/acme/widgets")?.provider, "generic")
  assert.equal(parseGitUrl("https://github.com/acme"), null)

  const scm = parseAndValidateScmUrl("https://github.com/acme/widgets")
  assert.equal("error" in scm, false)
  assert.equal((scm as { host?: string }).host, "github.com")
  // Something that is not a repository URL is refused with a reason rather than read as one.
  const refused = parseAndValidateScmUrl("not a url at all")
  assert.equal("error" in refused, true)

  assert.equal(toScmSshUrl("https://github.com/acme/widgets.git"), "git@github.com:acme/widgets.git")
  assert.equal(canonicalRepoHost("WWW.GitHub.com"), "github.com")
})

test("a cached plugin lives under a path built from names a path may hold", () => {
  assert.equal(PLUGINS_CACHE_ROOT, "plugins/cache")
  assert.equal(PLUGIN_CACHE_SENTINEL, ".cache-complete")

  const cachePath = getPluginInstallCachePath("/home/.slate/plugins/cache", {
    marketplaceSlug: "my/marketplace",
    pluginId: "acme/widgets",
    version: "1.0.0",
  })
  // A name with a slash in it cannot escape the cache.
  assert.equal(cachePath, path.join("/home/.slate/plugins/cache", "my_marketplace", "acme_widgets", "1.0.0"))
  assert.equal(cachePath.startsWith("/home/.slate/plugins/cache"), true)

  const withoutVersion = getPluginInstallCachePath("/cache", { marketplaceSlug: "m", pluginId: "p" })
  assert.equal(withoutVersion, path.join("/cache", "m", "p"))
})
