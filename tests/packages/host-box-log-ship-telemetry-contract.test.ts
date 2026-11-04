import assert from "node:assert/strict"
import test from "node:test"

import {
  BOX_LOG_SHIP_EVENT,
  boxLogShipTelemetry,
} from "../../source/host/telemetry/box-log-ship-telemetry.ts"

test("shipping progress maps counters and age into string metadata", () => {
  assert.equal(BOX_LOG_SHIP_EVENT, "slate.box.log_ship")
  assert.deepEqual(boxLogShipTelemetry({
    kind: "progress",
    bytesWritten: 320,
    bytesDelivered: 270,
    pendingWindowCount: 2,
    oldestPendingWindowAgeMs: 41,
  }), {
    level: "info",
    message: "slate.box.log_ship",
    metadata: {
      kind: "progress",
      bytes_written: "320",
      bytes_delivered: "270",
      pending_window_count: "2",
      oldest_pending_window_age_ms: "41",
    },
  })
})

test("save failures warn, while a recovered save is informational", () => {
  assert.deepEqual(boxLogShipTelemetry({
    kind: "save_failed",
    errorClass: "disk_full",
    failureCount: 3,
  }), {
    level: "warn",
    message: "slate.box.log_ship",
    metadata: {
      kind: "save_failed",
      error_class: "disk_full",
      failure_count: "3",
    },
  })
  assert.deepEqual(boxLogShipTelemetry({
    kind: "save_recovered",
    errorClass: "disk_full",
    failureCount: 3,
  }), {
    level: "info",
    message: "slate.box.log_ship",
    metadata: {
      kind: "save_recovered",
      error_class: "disk_full",
      failure_count: "3",
    },
  })
})
