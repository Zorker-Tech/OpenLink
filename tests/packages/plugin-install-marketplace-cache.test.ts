import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  LOCAL_GIT_TIMEOUT_MS,
  LS_REMOTE_TIMEOUT_MS,
  MarketplaceCacheManager,
  REMOTE_GIT_TIMEOUT_MS,
  classifyCloneError,
  getCanonicalMarketplacePathSegments,
  isKilledSubprocessError,
} from "../../source/packages/plugin-install/marketplace-cache.ts";

const temporaryDirectory = () => mkdtempSync(join(tmpdir(), "marketplace-cache-"));

describe("classifying a clone failure", () => {
  it("knows the timeouts it clones under", () => {
    assert.deepEqual([LS_REMOTE_TIMEOUT_MS, REMOTE_GIT_TIMEOUT_MS, LOCAL_GIT_TIMEOUT_MS], [30_000, 1_800_000, 600_000]);
    assert.deepEqual([MarketplaceCacheManager.STALE_STAGING_THRESHOLD_MS, MarketplaceCacheManager.STAGING_HEARTBEAT_INTERVAL_MS], [300_000, 60_000]);
  });

  it("says who has to act about a failure", () => {
    assert.equal(classifyCloneError(new Error("terminal prompts disabled")), "user_git_access");
    assert.equal(classifyCloneError(new Error("Host key verification failed.")), "user_git_access");
    assert.equal(classifyCloneError(new Error("ENOTEMPTY: directory not empty, rename '/cache/_staging/abc' -> '/cache/x'")), "local_cache_race");
    assert.equal(classifyCloneError(new Error("ENOTEMPTY: directory not empty, rename")), "infrastructure", "both cache-race signs are needed");
    assert.equal(classifyCloneError(new Error("upload-pack: not our ref abc")), "stale_pinned_ref");
    assert.equal(classifyCloneError(new Error("fatal: unable to access: Could not resolve host")), "infrastructure");
    assert.equal(classifyCloneError("spawn git ENOENT"), "user_git_access");
    assert.equal(classifyCloneError(null), "infrastructure");
  });

  it("tells a killed subprocess apart, at any depth", () => {
    assert.equal(isKilledSubprocessError({ killed: true }), true);
    assert.equal(isKilledSubprocessError({ killed: false }), false);
    assert.equal(isKilledSubprocessError({ cause: { cause: { killed: true } } }), true);
    assert.equal(isKilledSubprocessError(new Error("x")), false);
    assert.equal(isKilledSubprocessError("x"), false);
    assert.equal(isKilledSubprocessError(null), false);
  });
});

describe("canonical marketplace paths", () => {
  it("names the host and path segments of a git URL", () => {
    assert.deepEqual(getCanonicalMarketplacePathSegments("https://github.com/owner/repo"), { host: "github.com", pathSegments: ["owner", "repo"] });
    assert.deepEqual(getCanonicalMarketplacePathSegments("https://www.github.com/Owner/Repo.git"), { host: "github.com", pathSegments: ["owner", "repo"] });
    assert.deepEqual(getCanonicalMarketplacePathSegments("https://gitlab.com/group/sub/repo"), { host: "gitlab.com", pathSegments: ["group", "sub", "repo"] });
    assert.throws(() => getCanonicalMarketplacePathSegments("https://gitlab.com/group"), { message: "Invalid git URL: https://gitlab.com/group" });
    assert.throws(() => getCanonicalMarketplacePathSegments("not a url"), { message: "Invalid git URL: not a url" });
  });

  it("builds cache paths that are one entry per repository, with safe segments", () => {
    const manager = new MarketplaceCacheManager("/tmp/cache");
    assert.equal(manager.cacheRoot, "/tmp/cache");
    assert.equal(manager.getCanonicalCloneDir("https://github.com/owner/repo", "main"), "/tmp/cache/github.com/owner/repo/main");
    assert.equal(manager.getCanonicalRepoRootDir("https://github.com/owner/repo"), "/tmp/cache/github.com/owner/repo");
    assert.equal(manager.getLegacyCloneDir("marketplace id", "feature/branch"), "/tmp/cache/marketplace_id/feature_branch", "spaces and slashes are not path separators here");
    assert.equal(manager.getLegacyCloneDir("id", "con"), "/tmp/cache/id/_con", "a reserved Windows name is prefixed");
    assert.equal(manager.getLegacyCloneDir("id", "release. "), "/tmp/cache/id/release._", "the trailing space became an underscore, and only trailing dots are dropped");
    assert.equal(manager.getLegacyCloneDir("id", "release."), "/tmp/cache/id/release", "a trailing dot is dropped");
    assert.equal(manager.getLegacyCloneDir("id", "."), "/tmp/cache/id/_", "a dot-only segment is not a directory");
    assert.equal(manager.getLegacyCloneDir("id", ".."), "/tmp/cache/id/_");
    assert.equal(new MarketplaceCacheManager("/tmp/cache", { sparsePluginClones: true }).sparsePluginClones, true);
    assert.equal(new MarketplaceCacheManager("/tmp/cache").sparsePluginClones, false);
  });

  it("resolves a plugin subpath, refusing one that leaves the clone", () => {
    const manager = new MarketplaceCacheManager("/tmp/cache");
    assert.equal(manager.getPluginDir("/tmp/clone", "plugins/a"), "/tmp/clone/plugins/a");
    assert.throws(() => manager.getPluginDir("/tmp/clone", "../escape"), { message: /path traversal not allowed/ });
  });
});

describe("the clone cache itself", () => {
  it("knows a complete clone from an incomplete one", async () => {
    const root = temporaryDirectory();
    try {
      const manager = new MarketplaceCacheManager(root);
      assert.equal(await manager.isCloneComplete(root), false);
      mkdirSync(join(root, ".git"), { recursive: true });
      assert.equal(await manager.isCloneComplete(root), false, "a bare git directory is not a checked-out clone");
      mkdirSync(join(root, ".git", "info"), { recursive: true });
      writeFileSync(join(root, ".git", "info", "sparse-checkout"), "");
      assert.equal(await manager.isCloneComplete(root), true, "a sparse checkout is complete");
      writeFileSync(join(root, "file.txt"), "x");
      assert.equal(await manager.isCloneComplete(root), true, "a clone with a working file is complete");
      assert.equal(await manager.isCloneComplete(join(root, "missing")), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("answers nothing for a directory with no manifest, and caches that answer", async () => {
    const root = temporaryDirectory();
    try {
      const manager = new MarketplaceCacheManager(root);
      assert.equal(await manager.readManifest(root), null);
      assert.equal(await manager.readManifest(root, { repoName: "named" }), null);
      assert.equal(await manager.readManifest(root), null);
      assert.equal(manager.manifestCache.size, 2, "the two cache keys are remembered");
      assert.deepEqual(await manager.discoverPlugins(root), []);
      assert.equal(await manager.resolvePluginPath(root, "anything"), null);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("copies a plugin directory into its target", async () => {
    const root = temporaryDirectory();
    try {
      mkdirSync(join(root, "source", "nested"), { recursive: true });
      writeFileSync(join(root, "source", "a.txt"), "a");
      writeFileSync(join(root, "source", "nested", "b.txt"), "b");
      const manager = new MarketplaceCacheManager(root);
      await manager.copyPluginToDir(join(root, "source"), join(root, "target"));
      assert.equal(readFileSync(join(root, "target", "a.txt"), "utf8"), "a");
      assert.equal(readFileSync(join(root, "target", "nested", "b.txt"), "utf8"), "b");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});