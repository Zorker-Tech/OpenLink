import assert from "node:assert/strict"
import { test } from "node:test"

import { boundedConnectorTag, OTHER_CONNECTOR_TAG, UNKNOWN_CONNECTOR_TAG } from "../../source/adapters/interop/mcp/connector-auth-tag-adapter.ts"
import { connectorAuthTelemetry } from "../../source/shared/observability/connector-auth-telemetry.ts"
import { SlateError } from "../../source/shared/errors/registry.ts"

test("connector names are reduced to an allowlisted tag without emitting arbitrary names", () => {
  assert.equal(boundedConnectorTag("GitHub"), "github")
  assert.equal(boundedConnectorTag("Google Calendar"), "googlecalendar")
  assert.equal(boundedConnectorTag(" private server 2 "), OTHER_CONNECTOR_TAG)
  assert.equal(boundedConnectorTag(" \t"), UNKNOWN_CONNECTOR_TAG)
  assert.equal(boundedConnectorTag(undefined), UNKNOWN_CONNECTOR_TAG)
})

test("telemetry bounds identifiers and keeps only registered error tags", () => {
  const event = connectorAuthTelemetry({
    phase: "callback",
    outcome: "failed",
    serverName: "private connector",
    serverId: "not a safe id",
    reauth: false,
    error: SlateError.gatewayRefused({ errno: "ECONNREFUSED", message: "secret detail" }),
  }, "desktop")

  assert.equal(event.level, "warn")
  assert.deepEqual(event.metadata, {
    phase: "callback",
    connector: OTHER_CONNECTOR_TAG,
    outcome: "failed",
    surface: "desktop",
    server_id: undefined,
    reauth: "false",
    error_code: "SLATE-E0101",
    error_domain: "transport",
    error_retryable: "true",
    errno: "ECONNREFUSED",
  })
  assert.equal(JSON.stringify(event.metadata).includes("private connector"), false)
  assert.equal(JSON.stringify(event.metadata).includes("secret detail"), false)
})

test("only failures and timeouts are warnings", () => {
  assert.equal(connectorAuthTelemetry({ phase: "watch", outcome: "timeout" }, "box").level, "warn")
  assert.equal(connectorAuthTelemetry({ phase: "watch", outcome: "connected" }, "box").level, "info")
})
