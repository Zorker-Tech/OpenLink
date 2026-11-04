import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BROWSER_PROFILE_CACHE_EXCLUSIONS,
  REGENERABLE_WORKSPACE_PATH_PATTERNS,
} from "../../source/adapters/interop/box/workspace-archive-layout-adapter.ts";

test("counterpart workspace paths stay at the archive interop boundary", () => {
  assert.deepEqual(BROWSER_PROFILE_CACHE_EXCLUSIONS, [
    "home/box/chrome-profile/*/Cache",
    "home/box/chrome-profile/*/Code Cache",
    "home/box/chrome-profile/*/GPUCache",
    "home/box/chrome-profile/*/Service Worker/CacheStorage",
  ]);
  assert.ok(REGENERABLE_WORKSPACE_PATH_PATTERNS.includes("node_modules/"));
  assert.ok(REGENERABLE_WORKSPACE_PATH_PATTERNS.includes("dist/"));
  assert.ok(REGENERABLE_WORKSPACE_PATH_PATTERNS.includes("target/"));
  assert.ok(REGENERABLE_WORKSPACE_PATH_PATTERNS.includes(".venv/"));
  assert.equal(new Set(REGENERABLE_WORKSPACE_PATH_PATTERNS).size, REGENERABLE_WORKSPACE_PATH_PATTERNS.length);
});
