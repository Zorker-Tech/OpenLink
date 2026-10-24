/**
 * The plugin install cache: paths, the completion sentinel, extraction, version listing and cleanup.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DefaultPluginCacheManager,
  PLUGINS_CACHE_ROOT,
  PLUGIN_CACHE_SENTINEL,
  getPluginInstallCachePath,
} from "../../source/packages/plugin-install/marketplace.ts";

const temporaryDirectory = () => mkdtempSync(join(tmpdir(), "plugin-default-cache-"));
const key = { marketplaceSlug: "acme", pluginId: "formatter", version: "1.0.0" };
const managerIn = (root: string) => new DefaultPluginCacheManager("/home/someone", { cacheRoot: root });

function tarballOf(root: string): Uint8Array {
  const staging = join(root, "staging");
  mkdirSync(join(staging, "plugin-install", "bin"), { recursive: true });
  writeFileSync(join(staging, "plugin-install", "manifest.json"), JSON.stringify({ name: "formatter" }));
  writeFileSync(join(staging, "plugin-install", "bin", "run.js"), "console.log('hi')\n");
  const tarball = join(root, "payload.tgz");
  execFileSync("tar", ["-czf", tarball, "-C", staging, "plugin-install"]);
  return Buffer.from(readFileSync(tarball));
}

test("cache paths sanitize every part and include the version only when given", () => {
  assert.equal(PLUGINS_CACHE_ROOT, "plugins/cache");
  assert.equal(PLUGIN_CACHE_SENTINEL, ".cache-complete");
  assert.equal(getPluginInstallCachePath("/cache", key), "/cache/acme/formatter/1.0.0");
  assert.equal(getPluginInstallCachePath("/cache", { marketplaceSlug: "m", pluginId: "p" }), "/cache/m/p");
  assert.equal(getPluginInstallCachePath("/cache", { marketplaceSlug: "m", pluginId: "p", version: "" }), "/cache/m/p");
  assert.equal(getPluginInstallCachePath("/cache", { marketplaceSlug: "Acme Co/evil", pluginId: "../sneaky", version: "v1 / 2" }), "/cache/Acme_Co_evil/___sneaky/v1___2");
});

test("the cache root defaults under the user home and follows an explicit override", () => {
  assert.equal(new DefaultPluginCacheManager("/home/someone").cacheRoot, join("/home/someone", ".slate", PLUGINS_CACHE_ROOT));
  assert.equal(new DefaultPluginCacheManager("/home/someone", { cacheRoot: "/elsewhere/cache" }).cacheRoot, "/elsewhere/cache");
});

test("a version is cached only when its sentinel file is present", async () => {
  const root = temporaryDirectory();
  try {
    const manager = managerIn(root);
    assert.equal(manager.getCacheDir(key), join(root, "acme", "formatter", "1.0.0"));
    assert.equal(await manager.isCached(key), false);
    mkdirSync(manager.getCacheDir(key), { recursive: true });
    assert.equal(await manager.isCached(key), false, "a directory without the sentinel is half-finished");
    mkdirSync(join(manager.getCacheDir(key), PLUGIN_CACHE_SENTINEL));
    assert.equal(await manager.isCached(key), false, "a directory is not a valid file sentinel");
    rmSync(join(manager.getCacheDir(key), PLUGIN_CACHE_SENTINEL), { recursive: true });
    await manager.markCacheComplete(key);
    assert.equal(await manager.isCached(key), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a tarball is unpacked into the cache and marked complete", async () => {
  const root = temporaryDirectory();
  try {
    const manager = managerIn(root);
    const cacheDir = await manager.extractToCache({ ...key, tarball: tarballOf(root) });
    assert.equal(cacheDir, manager.getCacheDir(key));
    assert.equal(await manager.isCached(key), true);
    assert.equal(readFileSync(join(cacheDir, "manifest.json"), "utf8"), JSON.stringify({ name: "formatter" }));
    assert.equal(readFileSync(join(cacheDir, "bin", "run.js"), "utf8"), "console.log('hi')\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cached versions are listed as directories under the plugin", async () => {
  const root = temporaryDirectory();
  try {
    const manager = managerIn(root);
    mkdirSync(join(root, "acme", "formatter", "1.0.0"), { recursive: true });
    mkdirSync(join(root, "acme", "formatter", "2.0.0"), { recursive: true });
    writeFileSync(join(root, "acme", "formatter", "notes.txt"), "not a version");
    assert.deepEqual((await manager.listCachedVersions({ marketplaceSlug: "acme", pluginId: "formatter" })).sort(), ["1.0.0", "2.0.0"]);
    assert.deepEqual(await manager.listCachedVersions({ marketplaceSlug: "missing", pluginId: "missing" }), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("removing one version deletes its tree, and removing all deletes every version", async () => {
  const root = temporaryDirectory();
  try {
    const manager = managerIn(root);
    for (const version of ["1.0.0", "2.0.0"]) {
      mkdirSync(manager.getCacheDir({ ...key, version }), { recursive: true });
      await manager.markCacheComplete({ ...key, version });
    }
    await manager.removeVersion({ ...key, version: "1.0.0" });
    assert.deepEqual(await manager.listCachedVersions({ marketplaceSlug: "acme", pluginId: "formatter" }), ["2.0.0"]);
    await manager.removeAllVersions({ marketplaceSlug: "acme", pluginId: "formatter" });
    assert.deepEqual(await manager.listCachedVersions({ marketplaceSlug: "acme", pluginId: "formatter" }), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("removing an absent tree is best effort for both removers", async () => {
  const root = temporaryDirectory();
  try {
    const manager = managerIn(root);
    await manager.removeVersion(key);
    await manager.removeAllVersions({ marketplaceSlug: "none", pluginId: "none" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pruning keeps the named versions (sanitized) and removes the rest", async () => {
  const root = temporaryDirectory();
  try {
    const manager = managerIn(root);
    for (const version of ["1.0.0", "2.0.0", "3.0.0"]) {
      mkdirSync(manager.getCacheDir({ ...key, version }), { recursive: true });
      await manager.markCacheComplete({ ...key, version });
    }
    await manager.pruneOldVersions({ marketplaceSlug: "acme", pluginId: "formatter", keepVersions: ["3.0.0"] });
    assert.deepEqual(await manager.listCachedVersions({ marketplaceSlug: "acme", pluginId: "formatter" }), ["3.0.0"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
