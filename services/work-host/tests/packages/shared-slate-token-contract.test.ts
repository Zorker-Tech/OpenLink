import assert from "node:assert/strict"
import { test } from "node:test"

import {
  ACCESS_TOKEN_REFRESH_LEEWAY_MS,
  SLATE_DEFAULT_BACKEND_URL,
  configuredSlateBackendUrl,
  decodeSlateTokenClaims,
  isSlateAccessTokenNearExpiry,
  shouldRefreshSlateAccessToken,
  slateAccessTokenExpiresAtMs,
  slateAccountCacheScope,
  slateAuthClientId,
  usesSlateDevelopmentAuth,
} from "../../source/shared/node/slate-token.ts"

function accessToken(payload: unknown): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`
}

test("access-token claims accept object payloads with supported claim types", () => {
  assert.deepEqual(decodeSlateTokenClaims(accessToken({ sub: "account-1", email: "person@example.test", exp: 7, custom: true })), {
    sub: "account-1",
    email: "person@example.test",
    exp: 7,
    custom: true,
  })
  for (const invalid of ["not-a-token", "header.%%%", accessToken(null), accessToken([]), accessToken({ email: 2 }), accessToken({ exp: "7" }), accessToken({ sub: false })]) {
    assert.equal(decodeSlateTokenClaims(invalid), null)
  }
})

test("account cache scopes hash a stable subject and never return the raw identity", () => {
  const first = accessToken({ sub: "account-1", exp: 100 })
  const refreshed = accessToken({ sub: "account-1", exp: 200 })
  const scope = slateAccountCacheScope(first)

  assert.equal(scope, slateAccountCacheScope(refreshed))
  assert.equal(scope.length, 64)
  assert.equal(scope.includes("account-1"), false)
  assert.notEqual(slateAccountCacheScope("opaque-a"), slateAccountCacheScope("opaque-b"))
})

test("expiry helpers use seconds, a strict five-minute boundary and fail closed for unknown claims", () => {
  const now = 1_000_000
  assert.equal(ACCESS_TOKEN_REFRESH_LEEWAY_MS, 300_000)
  assert.equal(isSlateAccessTokenNearExpiry(accessToken({ exp: 1_300 }), now), false)
  assert.equal(isSlateAccessTokenNearExpiry(accessToken({ exp: 1_299 }), now), true)
  assert.equal(isSlateAccessTokenNearExpiry(accessToken({}), now), true)
  assert.equal(slateAccessTokenExpiresAtMs(accessToken({ exp: 1_234 })), 1_234_000)
  assert.equal(slateAccessTokenExpiresAtMs(accessToken({ exp: Number.POSITIVE_INFINITY })), null)
})

test("backend settings normalize URLs and allow an explicit auth client override", () => {
  assert.equal(SLATE_DEFAULT_BACKEND_URL, "https://api.slate.invalid")
  assert.equal(configuredSlateBackendUrl({ SLATE_BACKEND_URL: "HTTP://LOCALHOST:3000" }), "http://localhost:3000/")
  assert.equal(configuredSlateBackendUrl({}), "https://api.slate.invalid/")
  assert.equal(slateAuthClientId("http://localhost:3000", { SLATE_AUTH_CLIENT_ID: "slate-dev-client" }), "slate-dev-client")
  assert.throws(() => configuredSlateBackendUrl({ SLATE_BACKEND_URL: "not a url" }))
})

test("token refresh policy combines expiry with the configured backend classification", () => {
  const validForLonger = accessToken({ exp: Math.floor(Date.now() / 1_000) + 60 * 60 })
  const soon = accessToken({ exp: Math.floor(Date.now() / 1_000) + 60 })

  assert.equal(usesSlateDevelopmentAuth("https://api.slate.invalid"), false)
  assert.equal(shouldRefreshSlateAccessToken("https://api.slate.invalid", validForLonger), false)
  assert.equal(shouldRefreshSlateAccessToken("https://api.slate.invalid", soon), true)
})
