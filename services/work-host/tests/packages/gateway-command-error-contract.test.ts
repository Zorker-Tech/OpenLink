import assert from "node:assert/strict"
import { test } from "node:test"

import {
  classifyGatewayFailure,
  projectGatewayCommandFailure,
  projectGatewayCommandSuccess,
} from "../../source/gateway/gateway-command-error.ts"

test("gateway failures distinguish daemon states, network categories and application errors", () => {
  assert.deepEqual(classifyGatewayFailure(Object.assign(new Error("refused"), { code: "ECONNREFUSED" })), {
    reason: "refused", errorClass: "Error", errno: "ECONNREFUSED",
  })
  assert.equal(classifyGatewayFailure(Object.assign(new Error("lookup"), { code: "EAI_AGAIN" })).reason, "dns")
  assert.equal(classifyGatewayFailure(Object.assign(new Error("pipe"), { code: "EPIPE" })).reason, "network")
  assert.equal(classifyGatewayFailure(new Error("ordinary failure")).reason, "application")
  assert.equal(classifyGatewayFailure({ name: "BoxDaemonUnreachableError", outcome: "refused" }).reason, "daemon_refused")
  assert.equal(classifyGatewayFailure({ name: "BoxDaemonUnreachableError", outcome: "other" }).reason, "daemon_crash")
  assert.equal(classifyGatewayFailure({ name: "BoxNoMonitorAvailableError" }).reason, "no_monitor")
})

test("timeouts are found in nested causes and cyclic wrappers without losing the error code", () => {
  const wrapped = Object.assign(new Error("outer", { cause: Object.assign(new Error("inner"), { name: "SocketTimeoutError", code: "EHOSTUNREACH" }) }), { name: "WrapperError" })
  assert.deepEqual(classifyGatewayFailure(wrapped), {
    reason: "timeout",
    errorClass: "WrapperError",
    errno: "EHOSTUNREACH",
  })

  const cycle: { name: string; cause?: unknown } = { name: "AbortError" }
  cycle.cause = cycle
  assert.deepEqual(classifyGatewayFailure(cycle), {
    reason: "timeout",
    errorClass: "unknown",
    errno: undefined,
  })
})

test("command telemetry rounds duration and carries request trace identifiers", () => {
  assert.deepEqual(projectGatewayCommandFailure({
    method: "writeFile",
    reason: "refused",
    errorClass: "Error",
    errno: "ECONNREFUSED",
    durationMs: 1.6,
    requestId: "request-1",
    traceId: "trace-1",
    spanId: "span-1",
  }), {
    level: "error",
    metadata: {
      method: "writeFile",
      reason: "refused",
      error_class: "Error",
      errno: "ECONNREFUSED",
      duration_ms: "2",
      request_id: "request-1",
      trace_id: "trace-1",
      span_id: "span-1",
    },
  })
  assert.deepEqual(projectGatewayCommandSuccess({ method: "readFile", durationMs: 0.2 }), {
    level: "info",
    metadata: {
      method: "readFile",
      duration_ms: "0",
      request_id: undefined,
      trace_id: undefined,
      span_id: undefined,
    },
  })
})
