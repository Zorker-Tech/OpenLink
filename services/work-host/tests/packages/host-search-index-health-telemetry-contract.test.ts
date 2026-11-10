import assert from "node:assert/strict"
import test from "node:test"

import {
  SEARCH_INDEX_HEALTH_EVENT,
  SEARCH_INDEX_WARN_KINDS,
  searchIndexHealthTelemetry,
} from "../../source/host/telemetry/search-index-health-telemetry.ts"

test("known retry and shutdown conditions warn while other health events error", () => {
  assert.equal(SEARCH_INDEX_HEALTH_EVENT, "slate.search_index.health")
  assert.deepEqual([...SEARCH_INDEX_WARN_KINDS], ["dispose_drain_cut", "worker_terminate_failed", "job_retry"])
  for (const kind of SEARCH_INDEX_WARN_KINDS) assert.equal(searchIndexHealthTelemetry({ kind }).level, "warn")
  assert.equal(searchIndexHealthTelemetry({ kind: "index_write" }).level, "error")
})

test("health metadata preserves optional fields and stringifies zero counts", () => {
  assert.deepEqual(searchIndexHealthTelemetry({ kind: "index_write", stage: "flush", errorClass: "ENOSPC", count: 0 }), {
    level: "error",
    event: "slate.search_index.health",
    metadata: { kind: "index_write", stage: "flush", error_class: "ENOSPC", count: "0" },
  })
  assert.deepEqual(searchIndexHealthTelemetry({ kind: "index_read", count: null }).metadata, {
    kind: "index_read",
    stage: undefined,
    error_class: undefined,
    count: undefined,
  })
})
