import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { create as createArchive } from "tar";

import {
  BackendMarketplaceClient,
  createBackendMarketplaceClient,
  normalizeEffectiveUserPluginsResponse,
  type BackendPluginEntry,
  type EffectivePlugin,
  type EffectivePluginsResponse,
} from "../../source/packages/plugin-install/backend-marketplace-client.ts";
import type { PluginMetricsLogger } from "../../source/packages/plugin-install/types.ts";

// ---------------------------------------------------------------------------------------------
// A logger that records what it was asked to say
// ---------------------------------------------------------------------------------------------

interface RecordedCall { method: string; args: unknown[] }

function recordingLogger(): { calls: RecordedCall[]; logger: PluginMetricsLogger } {
  const calls: RecordedCall[] = [];
  const logger: PluginMetricsLogger = {
    log(level, message, metadata) { calls.push({ method: "log", args: [level, message, metadata] }); },
    increment(name, value, tags) { calls.push({ method: "increment", args: [name, value, tags] }); },
    distribution(name, value, tags) { calls.push({ method: "distribution", args: [name, typeof value, tags] }); },
    captureException(error, tags) { calls.push({ method: "exception", args: [error instanceof Error ? error.message : String(error), tags] }); },
  };
  return { calls, logger };
}

function loggedMessages(calls: RecordedCall[], level?: string): string[] {
  return calls
    .filter(call => call.method === "log" && (level === undefined || call.args[0] === level))
    .map(call => String(call.args[1]));
}

function clientFor(response: EffectivePluginsResponse, logger: PluginMetricsLogger, options: ConstructorParameters<typeof BackendMarketplaceClient>[1] = {}): BackendMarketplaceClient {
  const settings = typeof options === "string" ? { marketplaceCacheRoot: options } : options ?? {};
  return new BackendMarketplaceClient(async () => response, { ...settings, pluginLogger: logger });
}

// ---------------------------------------------------------------------------------------------
// The answer the backend gave
// ---------------------------------------------------------------------------------------------

test("a configured variable is serialized only when it says how, and a row that cannot be read is left alone", () => {
  const untouched: { plugins?: unknown } = {};
  assert.equal(normalizeEffectiveUserPluginsResponse(untouched), untouched, "an answer without plugins is the same answer");
  const empty = { plugins: [], marketplaces: [] };
  assert.equal(normalizeEffectiveUserPluginsResponse(empty), empty, "an empty list is not rebuilt either");

  const plainRow = { plugin: { name: "a" } };
  const withoutSerializer = normalizeEffectiveUserPluginsResponse({ plugins: [plainRow] as unknown[] });
  assert.equal((withoutSerializer.plugins as unknown[])[0], plainRow, "a row with nothing to serialize is the same row");
  const withValue = normalizeEffectiveUserPluginsResponse({ plugins: [{ configuredVariables: 7 }, "text"] as unknown[] });
  assert.deepEqual((withValue.plugins as unknown[])[0], { configuredVariables: 7 }, "a primitive is not a serializer");
  assert.equal((withValue.plugins as unknown[])[1], "text");
  assert.throws(() => normalizeEffectiveUserPluginsResponse({ plugins: [null] as unknown[] }), TypeError, "a row that is not an object cannot be read");

  const serialized = normalizeEffectiveUserPluginsResponse({ plugins: [{ configuredVariables: { toJson() { return { a: 1 }; } } }] as unknown[] });
  assert.deepEqual((serialized.plugins as unknown[])[0], { configuredVariables: { a: 1 } }, "an object answer replaces the serializer");
  const serializedArray = normalizeEffectiveUserPluginsResponse({ plugins: [{ configuredVariables: { toJson() { return [1, 2]; } } }] as unknown[] });
  assert.deepEqual((serializedArray.plugins as unknown[])[0], { configuredVariables: undefined }, "an array is not a configured-variable record");
  const serializedNull = normalizeEffectiveUserPluginsResponse({ plugins: [{ configuredVariables: { toJson() { return null; } } }] as unknown[] });
  assert.deepEqual((serializedNull.plugins as unknown[])[0], { configuredVariables: undefined });

  const throwingGetter = { plugins: [{ configuredVariables: { get toJson(): () => unknown { throw new Error("cannot read the serializer"); } } }] as unknown[] };
  assert.throws(() => normalizeEffectiveUserPluginsResponse(throwingGetter), { message: "cannot read the serializer" }, "reading whether a serializer exists is not inside the guard");

  const throwingRow = { configuredVariables: { toJson() { throw new Error("cannot serialize"); } } };
  const throwing = normalizeEffectiveUserPluginsResponse({ plugins: [throwingRow] as unknown[] });
  assert.equal((throwing.plugins as unknown[])[0], throwingRow, "a serializer that throws leaves its row untouched");

  const untouchedField = normalizeEffectiveUserPluginsResponse({ plugins: [plainRow] as unknown[], marker: "kept" });
  assert.equal((untouchedField as { marker: string }).marker, "kept");
});

// ---------------------------------------------------------------------------------------------
// What a listing answers
// ---------------------------------------------------------------------------------------------

test("a marketplace allow-list skips every plugin it does not name, and says so", async () => {
  const { calls, logger } = recordingLogger();
  const response: EffectivePluginsResponse = {
    plugins: [
      { isEnabled: false, plugin: { name: "disabled", gitUrl: "/x" } },
      { isEnabled: true, plugin: { name: "unlisted" } },
      { isEnabled: true, inlineContentJson: "{}", plugin: { name: "listed", marketplace: { name: "market", id: 2 } } },
    ],
  };
  const client = clientFor(response, logger, { listOptions: { allowedMarketplaceNames: ["market"], enableInlinePlugins: true } });
  const listed = await client.listEnabledPlugins();
  assert.deepEqual(listed.plugins.map(plugin => plugin.pluginId), ["listed"], "only the listed marketplace's plugin is answered");
  assert.deepEqual(listed.listFailures, []);
  assert.deepEqual(listed.plugins[0]!.marketplace, { id: "market-2", name: "market" });
  const skip = calls.find(call => call.method === "log" && String(call.args[1]).includes("is not allowed"));
  assert.deepEqual(skip?.args[2], { pluginId: "unlisted", marketplaceName: undefined, allowedMarketplaceNames: ["market"] }, "the skip names who was allowed");
  const emptyAllowed = clientFor(response, logger, { listOptions: { allowedMarketplaceNames: [] } });
  assert.deepEqual((await emptyAllowed.listEnabledPlugins()).plugins, [], "an empty allow-list allows nothing");

  const allAllowed = clientFor(response, recordingLogger().logger, { listOptions: { enableInlinePlugins: true } });
  assert.equal((await allAllowed.listEnabledPlugins()).plugins.length, 1, "no allow-list means every marketplace is allowed");
});

test("an inline plugin is listed with a version hashed from its own identity", async () => {
  const { calls, logger } = recordingLogger();
  const response: EffectivePluginsResponse = {
    plugins: [
      { isEnabled: true, inlineContentJson: "{}", plugin: { name: "without-id", updatedAt: 5 } },
      { isEnabled: true, inlineContentJson: "{}", plugin: { name: "with-id", id: 11, updatedAt: 99, marketplace: { name: "market" } } },
      { isEnabled: true, plugin: { name: "no-content" } },
      { isEnabled: true, inlineContentJson: "{}", plugin: { name: "named", id: "db-2" }, configuredVariables: { a: 1 }, isTeamRequired: true },
    ],
  };
  const client = clientFor(response, logger, { listOptions: { enableInlinePlugins: true } });
  const listed = await client.listEnabledPlugins();
  const expectedWithoutId = createHash("sha256").update("0:5").digest("hex").slice(0, 40);
  const expectedWithId = createHash("sha256").update("11:99").digest("hex").slice(0, 40);
  assert.deepEqual(listed.plugins.map(plugin => [plugin.pluginId, plugin.version, plugin.downloadUrl]), [
    ["without-id", expectedWithoutId, "inline://without-id"],
    ["with-id", expectedWithId, "inline://11"],
    ["named", createHash("sha256").update("db-2:0").digest("hex").slice(0, 40), "inline://db-2"],
  ]);
  assert.deepEqual(listed.plugins[0]!.marketplace, undefined, "a plugin without a marketplace has no descriptor");
  assert.deepEqual(listed.plugins[1]!.marketplace, { id: "market-inline", name: "market" });
  assert.equal(listed.plugins[2]!.configuredVariables && JSON.stringify(listed.plugins[2]!.configuredVariables), JSON.stringify({ a: 1 }));
  assert.equal(listed.plugins[2]!.isTeamRequired, true);
  assert.deepEqual(listed.plugins[2]!.pluginDbId, "db-2");
  assert.match(loggedMessages(calls, "info").join("\n"), /Skipping DB-inline plugin no-content: no inline content provided/);

  const withoutInline = clientFor(response, recordingLogger().logger);
  assert.deepEqual((await withoutInline.listEnabledPlugins()).plugins, [], "inline plugins are off unless the client is told to list them");
});

test("a release plugin is listed at its tag, with the source an install would download", async () => {
  const { logger } = recordingLogger();
  const listed = await clientFor({
    plugins: [
      { isEnabled: true, pinnedGitRef: "pinned", plugin: { name: "tagged", gitUrl: "https://github.com/owner/repo", releaseRepo: "owner/repo", releaseAsset: "plugin.tar.gz", releaseTag: "v2", marketplace: { name: "market", id: 3, gitRef: "mref" } } },
      { isEnabled: true, plugin: { name: "tag-from-ref", gitUrl: "https://github.com/owner/repo", gitRef: "v3", releaseRepo: "owner/repo", releaseAsset: "release.zip", marketplace: { name: "market" } } },
    ],
  }, logger).listEnabledPlugins();
  assert.deepEqual(listed.plugins.map(plugin => [plugin.pluginId, plugin.version, plugin.downloadUrl]), [
    ["tagged", "release/v2", "backend-release://owner%2Frepo#plugin.tar.gz@v2"],
    ["tag-from-ref", "release/v3", "backend-release://owner%2Frepo#release.zip@v3"],
  ]);
  assert.deepEqual(listed.plugins[0]!.marketplace, { id: "market-3", name: "market" }, "a release marketplace carries no clone");
  assert.deepEqual(listed.plugins[1]!.marketplace, { id: "market-project", name: "market" }, "without an id the project name goes in it");
  assert.equal(listed.plugins[0]!.isOriginBacked, undefined, "a release is not an origin-distribution install");
});

test("a commit a listing cannot resolve is a failure of that plugin alone", async () => {
  const { calls, logger } = recordingLogger();
  const listed = await clientFor({
    plugins: [
      { isEnabled: true, plugin: { name: "broken", gitUrl: "/no/such/repository-here", gitRef: "main" } },
      { isEnabled: true, inlineContentJson: "{}", plugin: { name: "still-listed" } },
    ],
  }, logger, { listOptions: { enableInlinePlugins: true } }).listEnabledPlugins();
  assert.deepEqual(listed.plugins.map(plugin => plugin.pluginId), ["still-listed"], "the rest of the listing survives one failure");
  assert.equal(listed.listFailures.length, 1);
  assert.equal(listed.listFailures[0]!.pluginName, "broken");
  assert.equal(listed.listFailures[0]!.errorType, "clone");
  assert.match(listed.listFailures[0]!.errorMessage, /Failed to resolve git ref "main" for \/no\/such\/repository-here/);
  assert.equal(calls.filter(call => call.method === "exception").length, 1, "the failure is reported once");
  assert.match(loggedMessages(calls, "error").join("\n"), /Failed to resolve version for plugin broken@main, skipping plugin/);
});

// ---------------------------------------------------------------------------------------------
// A repository a listing actually asked for
// ---------------------------------------------------------------------------------------------

const git = (args: string[], cwd?: string): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function createRepository(files: Record<string, string>, tag = "v1"): { root: string; repo: string; sha: string } {
  const root = mkdtempSync(join(tmpdir(), "marketplace-client-repo-"));
  const work = join(root, "work");
  const repo = join(root, "remote.git");
  mkdirSync(work, { recursive: true });
  git(["init", "--bare", "--quiet", repo]);
  git(["init", "--quiet", work]);
  for (const [relativePath, content] of Object.entries(files)) {
    mkdirSync(dirname(join(work, relativePath)), { recursive: true });
    writeFileSync(join(work, relativePath), content);
  }
  git(["-C", work, "add", "."]);
  git(["-C", work, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "--quiet", "-m", "first"]);
  git(["-C", work, "branch", "-M", "main"]);
  git(["-C", work, "tag", tag]);
  git(["-C", work, "remote", "add", "origin", repo]);
  git(["-C", work, "push", "--quiet", "origin", "main", "--tags"]);
  git(["-C", repo, "symbolic-ref", "HEAD", "refs/heads/main"]);
  return { root, repo, sha: git(["-C", work, "rev-parse", "HEAD"]) };
}

test("a git plugin is listed at the commit its ref resolves to, and a mirror is tried before the source", async () => {
  const sourceRepository = createRepository({ "readme.txt": "plain" });
  const mirrorRepository = createRepository({ "mirror.txt": "mirrored" }, "v2");
  try {
    const { calls, logger } = recordingLogger();
    const listed = await clientFor({
      plugins: [
        { isEnabled: true, plugin: { name: "plain", gitUrl: sourceRepository.repo, gitRef: "main" } },
        { isEnabled: true, plugin: { name: "mirrored", gitUrl: sourceRepository.repo, marketplace: { name: "market", id: "m1", gitUrl: sourceRepository.repo, gitRef: "main", distributionGitUrl: mirrorRepository.repo } } },
        { isEnabled: true, plugin: { name: "unreachable-mirror", gitUrl: sourceRepository.repo, marketplace: { name: "market", id: "m2", gitUrl: sourceRepository.repo, gitRef: "main", distributionGitUrl: "/no/such/mirror-repository" } } },
        { isEnabled: true, pinnedGitRef: "v1", plugin: { name: "pinned", gitUrl: sourceRepository.repo, gitRef: "main" } },
      ],
    }, logger).listEnabledPlugins();
    assert.deepEqual(listed.plugins.map(plugin => plugin.pluginId), ["plain", "mirrored", "unreachable-mirror", "pinned"]);
    assert.equal(listed.plugins[0]!.version, sourceRepository.sha, "the version is the commit the ref points at");
    assert.equal(listed.plugins[0]!.downloadUrl, "backend-git://" + encodeURIComponent(sourceRepository.repo) + "@main");
    assert.equal(listed.plugins[0]!.isOriginBacked, undefined, "a direct clone did not come from a mirror");
    assert.equal(listed.plugins[1]!.version, mirrorRepository.sha, "the mirror answered with its own commit");
    assert.equal(listed.plugins[1]!.isOriginBacked, true, "the mirror is the repository the install fetches");
    assert.deepEqual(listed.plugins[1]!.marketplace, { id: "market-m1", name: "market", gitUrl: mirrorRepository.repo, gitRef: mirrorRepository.sha });
    assert.equal(listed.plugins[2]!.isOriginBacked, undefined, "a mirror that could not answer fell back to the source");
    assert.equal(listed.plugins[3]!.version, sourceRepository.sha);
    assert.equal(listed.plugins[3]!.downloadUrl, "backend-git://" + encodeURIComponent(sourceRepository.repo) + "@v1", "a pinned ref is the one an install fetches");
    const increments = calls.filter(call => call.method === "increment").map(call => call.args[0]);
    assert.deepEqual(increments, ["marketplace.origin_distribution.fetch", "marketplace.origin_distribution.fetch", "marketplace.origin_distribution.fetch.error"], "each mirror attempt and every fallback is reported");
    assert.match(loggedMessages(calls, "info").join("\n"), /Resolved plugin mirrored from Origin distribution mirror/);
    assert.match(loggedMessages(calls, "warn").join("\n"), /Distribution mirror \/no\/such\/mirror-repository@main unavailable \(not synced yet or unreachable\); falling back to source/);
  } finally {
    rmSync(sourceRepository.root, { recursive: true, force: true });
    rmSync(mirrorRepository.root, { recursive: true, force: true });
  }
});


function targetDirectory(): string {
  return mkdtempSync(join(tmpdir(), "marketplace-client-target-"));
}

test("installing an inline plugin writes out what its manifest describes", async () => {
  const target = targetDirectory();
  try {
    const entry: BackendPluginEntry = {
      pluginId: "inline", name: "inline-plugin", version: "v", downloadUrl: "inline://1",
      inlineContentJson: JSON.stringify({
        rules: [{ name: "Rule One", content: "rule body" }],
        commands: [{ name: "command-one", content: "command body", description: "does things" }],
        hooks: [{ hookStep: "after", hookType: "command", scriptContent: "echo done" }],
        mcpServers: [{ name: "server", config: { command: "node" } }],
      }),
    };
    await clientFor({}, recordingLogger().logger).installPlugin(entry, target);
    assert.equal(readFileSync(join(target, "rules", "Rule_One.md"), "utf8"), "---\ndescription: Rule One\nalwaysApply: false\n---\n\nrule body", "a filename is made safe but its manifest keeps its display name");
    assert.equal(readFileSync(join(target, "commands", "command-one.md"), "utf8"), "---\ndescription: does things\n---\n\ncommand body");
    assert.deepEqual(JSON.parse(readFileSync(join(target, "hooks", "hooks.json"), "utf8")), { version: 1, hooks: { after: [{ type: "command", command: "echo done" }] } });
    assert.deepEqual(JSON.parse(readFileSync(join(target, ".mcp.json"), "utf8")), { mcpServers: { server: { command: "node" } } });
    assert.deepEqual(JSON.parse(readFileSync(join(target, ".cursor-plugin", "plugin.json"), "utf8")), { name: "inline-plugin", rules: ["rules/Rule_One.md"], commands: ["commands/command-one.md"] });
    await assert.rejects(() => clientFor({}, recordingLogger().logger).installPlugin({ ...entry, inlineContentJson: "{not json" }, target), /Unexpected token|Expected property name|JSON/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

interface FakeFetchResponse { json?: unknown; body?: Buffer; ok: boolean; status?: number; statusText?: string; url?: string }

function stubFetch(responses: FakeFetchResponse[]): { calls: string[]; headers: unknown[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: string[] = [];
  const headers: unknown[] = [];
  globalThis.fetch = (async (input: unknown, init?: { headers?: unknown }) => {
    calls.push(String(input));
    headers.push(init?.headers);
    const response = responses.shift();
    if (response === undefined) throw new Error("unexpected fetch: " + String(input));
    return {
      ok: response.ok,
      status: response.status ?? 200,
      statusText: response.statusText ?? "OK",
      url: response.url ?? "",
      json: async () => response.json,
      arrayBuffer: async () => response.body ?? Buffer.alloc(0),
    };
  }) as unknown as typeof fetch;
  return { calls, headers, restore: () => { globalThis.fetch = original; } };
}

async function releaseArchive(files: Record<string, string>): Promise<Buffer> {
  const staging = mkdtempSync(join(tmpdir(), "marketplace-client-archive-"));
  const content = join(staging, "content");
  const output = join(staging, "asset.tar.gz");
  try {
    mkdirSync(content, { recursive: true });
    for (const [relativePath, fileContent] of Object.entries(files)) {
      mkdirSync(dirname(join(content, relativePath)), { recursive: true });
      writeFileSync(join(content, relativePath), fileContent);
    }
    await createArchive({ gzip: true, cwd: content, file: output }, ["."]);
    return readFileSync(output);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function releaseEntry(overrides: Partial<BackendPluginEntry> = {}): BackendPluginEntry {
  return { pluginId: "release", name: "release-plugin", version: "release/v1", downloadUrl: "backend-release://owner%2Frepo#plugin.tar.gz@v1", ...overrides };
}

test("installing a release asset verifies it before writing the plugin out", async () => {
  const target = targetDirectory();
  const archive = await releaseArchive({ "wrapper/.claude-plugin/plugin.json": JSON.stringify({ name: "wrapped" }), "wrapper/rule.md": "# rule" });
  const sha = createHash("sha256").update(archive).digest("hex");
  const assetUrl = "https://github.com/owner/repo/releases/download/v1/plugin.tar.gz";
  const release = (assetName: string, size: number, downloadUrl: string): unknown => ({ assets: [{ name: assetName, size, browser_download_url: downloadUrl }] });
  try {
    const fetchStub = stubFetch([
      { ok: true, json: release("plugin.tar.gz", archive.byteLength, assetUrl) },
      { ok: true, body: archive, url: assetUrl },
    ]);
    try {
      await clientFor({}, recordingLogger().logger).installPlugin(releaseEntry(), target);
    } finally {
      fetchStub.restore();
    }
    assert.deepEqual(fetchStub.calls, ["https://api.github.com/repos/owner/repo/releases/tags/v1", assetUrl], "the release, then its asset");
    assert.deepEqual(fetchStub.headers[0], { Accept: "application/vnd.github.v3+json", "User-Agent": "SlatePluginInstaller" });
    assert.equal(readFileSync(join(target, "rule.md"), "utf8"), "# rule", "the wrapper directory is not copied");
    assert.deepEqual(JSON.parse(readFileSync(join(target, ".claude-plugin", "plugin.json"), "utf8")), { name: "wrapped" });

    const untrusted = stubFetch([{ ok: true, json: release("plugin.tar.gz", archive.byteLength, "http://example.com/asset.tar.gz") }]);
    try {
      await assert.rejects(() => clientFor({}, recordingLogger().logger).installPlugin(releaseEntry(), target), { message: "Refusing to download release asset from untrusted host: example.com" });
    } finally {
      untrusted.restore();
    }

    const tooLarge = stubFetch([{ ok: true, json: release("plugin.tar.gz", 200 * 1024 * 1024, assetUrl) }]);
    try {
      await assert.rejects(() => clientFor({}, recordingLogger().logger).installPlugin(releaseEntry(), target), { message: 'Release asset "plugin.tar.gz" exceeds maximum size of 104857600 bytes (actual: 209715200)' });
    } finally {
      tooLarge.restore();
    }

    const missing = stubFetch([{ ok: true, json: release("other.tar.gz", 10, assetUrl) }]);
    try {
      await assert.rejects(() => clientFor({}, recordingLogger().logger).installPlugin(releaseEntry(), target), { message: 'Release asset "plugin.tar.gz" not found. Available assets: other.tar.gz' });
    } finally {
      missing.restore();
    }
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("installing a repository entry clones it and copies the plugin directory out", async () => {
  const repository = createRepository({ "plugins/one/rule.md": "# one", "plugins/one/.claude-plugin/plugin.json": JSON.stringify({ name: "one" }) });
  const target = targetDirectory();
  try {
    const entry: BackendPluginEntry = { pluginId: "repo", name: "repo", version: repository.sha, downloadUrl: "backend-git://" + encodeURIComponent(repository.repo) + "@" + encodeURIComponent(repository.sha) + "#" + encodeURIComponent("plugins/one") };
    await clientFor({}, recordingLogger().logger).installPlugin(entry, target);
    assert.deepEqual(readdirSync(target).sort(), [".claude-plugin", "rule.md"], "only the plugin directory lands, not the clone");
    assert.equal(readFileSync(join(target, "rule.md"), "utf8"), "# one");

    await assert.rejects(() => clientFor({}, recordingLogger().logger).installPlugin({ ...entry, downloadUrl: "nonsense://source" }, target), { message: "Invalid download URL format for plugin repo: nonsense://source" });
    await assert.rejects(() => clientFor({}, recordingLogger().logger).installPlugin({ ...entry, downloadUrl: "backend-git://" + encodeURIComponent("/no/such/repository-here") + "@main" }, target), /does not exist|Command failed: git/);
  } finally {
    rmSync(repository.root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});


test("installing through a marketplace cache falls back to a direct install and says why", async () => {
  const repository = createRepository({ "plugins/one/rule.md": "# one" });
  const cacheRoot = mkdtempSync(join(tmpdir(), "marketplace-client-cache-"));
  const target = targetDirectory();
  const downloadUrl = "backend-git://" + encodeURIComponent(repository.repo) + "@main#" + encodeURIComponent("plugins/one");
  const marketplace = { id: "m1", name: "market", gitUrl: repository.repo, gitRef: "main" };
  try {
    const { calls, logger } = recordingLogger();
    const client = new BackendMarketplaceClient(async () => ({}), { marketplaceCacheRoot: cacheRoot, pluginLogger: logger });
    await client.installPlugin({ pluginId: "repo", name: "repo", version: "v", downloadUrl, marketplace }, target);
    assert.equal(readFileSync(join(target, "rule.md"), "utf8"), "# one");
    assert.match(loggedMessages(calls, "info").join("\n"), /Ensuring cloned m1/, "the cache was consulted");

    const failing = recordingLogger();
    const failingClient = new BackendMarketplaceClient(async () => ({}), { marketplaceCacheRoot: cacheRoot, pluginLogger: failing.logger });
    const failingEntry: BackendPluginEntry = { pluginId: "repo", name: "repo", version: "v", downloadUrl, marketplace: { id: "m2", name: "market", gitUrl: "/no/such/cache-repository", gitRef: "main" } };
    await failingClient.installPlugin(failingEntry, target);
    assert.equal(readFileSync(join(target, "rule.md"), "utf8"), "# one", "a failed cache is followed by the direct install");
    const warns = loggedMessages(failing.calls, "warn");
    assert.match(warns.join("\n"), /Failed to install plugin repo from marketplace cache, falling back to direct install/, "the fallback is announced");

    const noCache = recordingLogger();
    await clientFor({}, noCache.logger).installPlugin({ pluginId: "repo", name: "repo", version: "v", downloadUrl }, target);
    assert.match(loggedMessages(noCache.calls, "info").join("\n"), /No marketplace cache or marketplace metadata, skipping cache check/);
  } finally {
    rmSync(repository.root, { recursive: true, force: true });
    rmSync(cacheRoot, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});


test("prewarming fetches each marketplace clone once for all the plugin directories in it", async () => {
  const repository = createRepository({ "plugins/one/rule.md": "# one", "plugins/two/rule.md": "# two" });
  const cacheRoot = mkdtempSync(join(tmpdir(), "marketplace-client-prewarm-"));
  try {
    const { calls, logger } = recordingLogger();
    const client = new BackendMarketplaceClient(async () => ({}), { marketplaceCacheRoot: cacheRoot, pluginLogger: logger });
    const marketplace = { id: "m1", name: "market", gitUrl: repository.repo, gitRef: "main" };
    await client.prewarmMarketplaceClones([
      { pluginId: "a", name: "a", version: "v", downloadUrl: "x", gitPath: "plugins/one", marketplace },
      { pluginId: "b", name: "b", version: "v", downloadUrl: "x", gitPath: "plugins/two", marketplace },
      { pluginId: "c", name: "c", version: "v", downloadUrl: "x" },
    ]);
    const prewarmed = loggedMessages(calls, "info").find(message => message.startsWith("Prewarmed marketplace clone"));
    assert.match(prewarmed ?? "", /for 2 plugin directories/, "both directories are requested in one clone");
    assert.deepEqual(calls.filter(call => call.method === "increment" && call.args[0] === "marketplace_cache_manager.prewarm.success").map(call => call.args), [["marketplace_cache_manager.prewarm.success", 1, { materialize: "dirs" }]]);

    const noCacheCalls = recordingLogger();
    await clientFor({}, noCacheCalls.logger).prewarmMarketplaceClones([{ pluginId: "a", name: "a", version: "v", downloadUrl: "x", gitPath: "plugins/one", marketplace }]);
    assert.deepEqual(noCacheCalls.calls, [], "a client without a cache has nothing to prewarm");
  } finally {
    rmSync(repository.root, { recursive: true, force: true });
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test("discovering marketplace plugins needs a cache to discover from", async () => {
  await assert.rejects(() => clientFor({}, recordingLogger().logger).discoverMarketplacePlugins("m", "/no/such/repo", "main"), { message: "discoverMarketplacePlugins requires a MarketplaceCacheManager (marketplaceCacheRoot)" });
});

test("the client can be built from a cache root and the older positional options", async () => {
  const { logger } = recordingLogger();
  const shorthand = createBackendMarketplaceClient(async () => ({ plugins: [{ isEnabled: true, inlineContentJson: "{}", plugin: { name: "shorthand" } }] }), undefined, logger, undefined, { enableInlinePlugins: true });
  assert.ok(shorthand instanceof BackendMarketplaceClient);
  assert.deepEqual((await shorthand.listEnabledPlugins()).plugins.map(plugin => plugin.pluginId), ["shorthand"]);

  const withRoot = new BackendMarketplaceClient(async () => ({}), "/tmp/marketplace-client-cache-root", logger);
  await assert.rejects(() => withRoot.discoverMarketplacePlugins("m", "/no/such/repo", "main"));
});