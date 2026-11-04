import assert from "node:assert/strict"
import test from "node:test"
import {
  EXPERIMENTS_DIAGNOSTIC_EVENT,
  experimentsDiagnosticTelemetry,
  levelFor,
} from "../../source/host/telemetry/experiments-diagnostic-telemetry.ts"

test("each known experiment diagnostic kind has its intended severity", () => {
  assert.equal(EXPERIMENTS_DIAGNOSTIC_EVENT, "slate.experiments.diagnostic")
  assert.equal(levelFor({ kind: "bootstrap_resolved" }), "info")
  assert.equal(levelFor({ kind: "bootstrap_anonymous" }), "info")
  assert.equal(levelFor({ kind: "bootstrap_discarded_auth_changed" }), "info")
  assert.equal(levelFor({ kind: "exposure_flush_failed" }), "info")
  assert.equal(levelFor({ kind: "shutdown_failed" }), "info")
  assert.equal(levelFor({ kind: "bootstrap_config_unparseable" }), "warn")
  assert.equal(levelFor({ kind: "bootstrap_cache_read_failed" }), "warn")
  assert.equal(levelFor({ kind: "unregistered-kind" }), "error")
})

test("a config not applied for a missing identity is informational; other causes warn", () => {
  assert.equal(levelFor({ kind: "config_not_applied", reason: "identity_unhydrated" }), "info")
  assert.equal(levelFor({ kind: "config_not_applied", reason: "service_unavailable" }), "warn")
  assert.equal(levelFor({ kind: "config_not_applied" }), "warn")
})

test("telemetry keeps numeric zero and false while leaving absent tags unset", () => {
  const result = experimentsDiagnosticTelemetry({
    kind: "bootstrap_cache_read_failed",
    stage: "read",
    reason: "bad-cache",
    errorClass: "SyntaxError",
    gatesOnCount: 0,
    authenticated: false,
  })

  assert.equal(result.level, "warn")
  assert.equal(result.event, EXPERIMENTS_DIAGNOSTIC_EVENT)
  assert.deepEqual(result.metadata, {
    kind: "bootstrap_cache_read_failed",
    stage: "read",
    reason: "bad-cache",
    error_class: "SyntaxError",
    gates_on_count: "0",
    authenticated: "false",
  })
  assert.deepEqual(experimentsDiagnosticTelemetry({ kind: "bootstrap_resolved" }).metadata, {
    kind: "bootstrap_resolved",
    stage: undefined,
    reason: undefined,
    error_class: undefined,
    gates_on_count: undefined,
    authenticated: undefined,
  })
})
