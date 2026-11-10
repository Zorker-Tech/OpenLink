import assert from "node:assert/strict"
import { test } from "node:test"

import {
  KNOWN_DOM_ERROR_NAMES,
  WEBAUTHN_PROXY_EVENT,
  webauthnProxyTelemetry,
} from "../../source/host/telemetry/webauthn-proxy-telemetry.ts"

test("WebAuthn telemetry exposes only bounded failure tags from the registered error taxonomy", () => {
  assert.equal(WEBAUTHN_PROXY_EVENT, "slate.webauthn_proxy")
  assert.equal(KNOWN_DOM_ERROR_NAMES.includes("NotAllowedError"), true)
  const report = webauthnProxyTelemetry({
    outcome: "failed",
    stage: "sign",
    originClass: "box",
    ceremonyKind: "assertion",
    requestId: "request-1",
    elapsedMs: 12.4,
    cause: "sign_failed",
    rawDomErrorName: "NotAllowedError",
    rawSignErrorClass: "no_credentials",
  })

  assert.equal(report.level, "warn")
  assert.equal(report.event, WEBAUTHN_PROXY_EVENT)
  assert.deepEqual(report.metadata, {
    stage: "sign",
    outcome: "failed",
    origin_class: "box",
    ceremony_kind: "assertion",
    request_id: "request-1",
    elapsed_ms: "12",
    provider_count: undefined,
    live_provider_count: undefined,
    error_code: "SLATE-E0211",
    error_domain: "auth",
    error_retryable: "true",
    dom_error: "NotAllowedError",
    sign_error_class: "no_credentials",
  })
})

test("unknown error names collapse to bounded fallback values and zero counts are preserved", () => {
  const report = webauthnProxyTelemetry({
    outcome: "success",
    stage: "dispatch",
    originClass: "desktop",
    ceremonyKind: "registration",
    requestId: "request-2",
    elapsedMs: 0,
    providerCount: 0,
    liveProviderCount: 1,
    cause: "desktop_failed",
    rawDomErrorName: "arbitrary free text with a secret",
    rawSignErrorClass: "unregistered class",
  })

  assert.equal(report.level, "info")
  assert.deepEqual(report.metadata, {
    stage: "dispatch",
    outcome: "success",
    origin_class: "desktop",
    ceremony_kind: "registration",
    request_id: "request-2",
    elapsed_ms: "0",
    provider_count: "0",
    live_provider_count: "1",
    error_code: "SLATE-E0212",
    error_domain: "auth",
    error_retryable: "true",
    dom_error: "OtherError",
    sign_error_class: "other",
  })
})
