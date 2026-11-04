import assert from "node:assert/strict"
import { test } from "node:test"

import {
  BOX_STORE_HYDRATION_HANDOFF_MANIFEST_PATH,
  INCOMPLETE_LEGACY_HYDRATE_REASON,
  isBoxStoreFullyHydrated,
  isHydrationHandoffManifestPath,
} from "../../source/host/boxes/box-store-sync/box-store-hydration.ts"

test("handoff marker matching allows the marker and its temporary sibling files only", () => {
  assert.equal(INCOMPLETE_LEGACY_HYDRATE_REASON, "incomplete_legacy_hydrate")
  assert.equal(isHydrationHandoffManifestPath(BOX_STORE_HYDRATION_HANDOFF_MANIFEST_PATH), true)
  assert.equal(isHydrationHandoffManifestPath(`${BOX_STORE_HYDRATION_HANDOFF_MANIFEST_PATH}.pid.tmp`), true)
  assert.equal(isHydrationHandoffManifestPath(`${BOX_STORE_HYDRATION_HANDOFF_MANIFEST_PATH}.tmp.bak`), false)
  assert.equal(isHydrationHandoffManifestPath(`${BOX_STORE_HYDRATION_HANDOFF_MANIFEST_PATH}-other`), false)
})

test("complete hydration requires clean counts and exact manifest coverage", () => {
  assert.equal(isBoxStoreFullyHydrated({ failures: [], manifestEntries: 3, files: 3, verified: 3 }), true)
  assert.equal(isBoxStoreFullyHydrated({ failures: [], manifestEntries: 3, files: 2, verified: 3 }), false)
  assert.equal(isBoxStoreFullyHydrated({ failures: [], manifestEntries: 3, files: 3, verified: 2 }), false)
  assert.equal(isBoxStoreFullyHydrated({ failures: [], manifestEntries: 3.5, files: 3, verified: 3 }), false)
  assert.equal(isBoxStoreFullyHydrated({ failures: ["failed"], manifestEntries: 0, files: 0, verified: 0 }), false)
  assert.equal(isBoxStoreFullyHydrated({ manifestEntries: 0, files: 0, verified: 0 }), false)
})

test("legacy completion is based on restored database coverage after counts validate", () => {
  assert.equal(isBoxStoreFullyHydrated({
    failures: [],
    manifestEntries: 10,
    files: 0,
    verified: 0,
    hydrateSource: "legacy",
    authoritativeStoreDbEntries: 4,
    restoredStoreDbEntries: 4,
  }), true)
  assert.equal(isBoxStoreFullyHydrated({
    failures: [],
    manifestEntries: 10,
    files: 10,
    verified: 10,
    hydrateSource: "legacy",
    authoritativeStoreDbEntries: 5,
    restoredStoreDbEntries: 4,
  }), false)
})
