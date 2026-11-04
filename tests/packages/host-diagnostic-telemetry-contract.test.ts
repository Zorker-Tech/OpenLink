import assert from "node:assert/strict"
import test from "node:test"

import {
  HOST_DIAGNOSTIC_EVENT,
  hostDiagnosticTelemetry,
} from "../../source/host/telemetry/host-diagnostic-telemetry.ts"

test("send-ledger degradation is an error with the complete diagnostic projection", () => {
  assert.equal(HOST_DIAGNOSTIC_EVENT, "slate.host.diagnostic")
  assert.deepEqual(hostDiagnosticTelemetry({
    kind: "send_ledger_degraded",
    stage: "append",
    agentId: "agent-4",
    reason: "busy",
    errorClass: "SQLiteBusyError",
  }), {
    level: "error",
    event: "slate.host.diagnostic",
    metadata: {
      kind: "send_ledger_degraded",
      stage: "append",
      agent_id: "agent-4",
      reason: "busy",
      error_class: "SQLiteBusyError",
    },
  })
})

test("other diagnostics warn and retain undefined optional metadata keys", () => {
  assert.deepEqual(hostDiagnosticTelemetry({ kind: "wake_dropped" }), {
    level: "warn",
    event: "slate.host.diagnostic",
    metadata: {
      kind: "wake_dropped",
      stage: undefined,
      agent_id: undefined,
      reason: undefined,
      error_class: undefined,
    },
  })
})
