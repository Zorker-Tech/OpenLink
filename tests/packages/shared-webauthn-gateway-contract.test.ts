import assert from "node:assert/strict"
import { test } from "node:test"

import {
  GATEWAY_WEBAUTHN_REQUESTS_PATH,
  GATEWAY_WEBAUTHN_RESPONSES_PATH,
  SLATE_ORIGIN_DOMAIN,
  SLATE_WEBAUTHN_CEREMONY_TIMEOUT_MS,
  SLATE_WEBAUTHN_HEARTBEAT_INTERVAL_MS,
  SLATE_WEBAUTHN_LIVENESS_WINDOW_MS,
  slateWebAuthnOriginClass,
  type WebAuthnRequestFrame,
  type WebAuthnResponseFrame,
} from "../../source/shared/webauthn-gateway.ts"

test("the security-key gateway keeps one Slate-owned frame contract and its routing values", () => {
  const requests: WebAuthnRequestFrame[] = [
    { kind: "welcome", providerId: "provider-1" },
    { kind: "ceremony", requestId: "request-1", ceremony: { kind: "create", origin: "https://slate.invalid" } },
    { kind: "cancel", requestId: "request-1" },
  ]
  const responses: WebAuthnResponseFrame[] = [
    { kind: "hello", computerId: "computer-1", label: "Main" },
    { kind: "ping" },
    { kind: "stage", requestId: "request-1", stage: "grant", outcome: "ok" },
    { kind: "result", requestId: "request-1", credentialJson: { id: "credential-1" } },
    { kind: "error", requestId: "request-1", name: "NotAllowedError", message: "declined", code: "cancelled" },
  ]

  assert.deepEqual(requests.map(frame => frame.kind), ["welcome", "ceremony", "cancel"])
  assert.deepEqual(responses.map(frame => frame.kind), ["hello", "ping", "stage", "result", "error"])
  assert.deepEqual([
    GATEWAY_WEBAUTHN_REQUESTS_PATH,
    GATEWAY_WEBAUTHN_RESPONSES_PATH,
    SLATE_ORIGIN_DOMAIN,
    SLATE_WEBAUTHN_HEARTBEAT_INTERVAL_MS,
    SLATE_WEBAUTHN_LIVENESS_WINDOW_MS,
    SLATE_WEBAUTHN_CEREMONY_TIMEOUT_MS,
  ], ["/webauthn/requests", "/webauthn/responses", "slate.invalid", 10_000, 30_000, 120_000])
})

test("an origin is classified by the exact Slate host and its subdomains", () => {
  assert.equal(slateWebAuthnOriginClass("https://slate.invalid"), "apex")
  assert.equal(slateWebAuthnOriginClass("https://account.slate.invalid"), "subdomain")
  assert.equal(slateWebAuthnOriginClass("https://nested.account.slate.invalid"), "subdomain")
  assert.equal(slateWebAuthnOriginClass("https://slate.invalid.attacker.test"), "external")
  assert.equal(slateWebAuthnOriginClass("https://unrelated.test"), "external")
  assert.equal(slateWebAuthnOriginClass("not an origin"), "external")
})
