import assert from "node:assert/strict"
import test from "node:test"

import {
  buildSecretProvidedAck,
  clampSecretDescription,
  clampSecretLabel,
  SECRET_REQUEST_MAX_DESCRIPTION_LENGTH,
  SECRET_REQUEST_MAX_LABEL_LENGTH,
  summarizeSecretRequest,
} from "../../source/host/runner/tools/slate-secret-request.ts"

test("secret labels are one line and descriptions retain their paragraph spacing", () => {
  assert.equal(SECRET_REQUEST_MAX_LABEL_LENGTH, 120)
  assert.equal(SECRET_REQUEST_MAX_DESCRIPTION_LENGTH, 400)
  assert.equal(clampSecretLabel("  first\nsecond  "), "first second")
  assert.equal(clampSecretLabel("x".repeat(140)).length, SECRET_REQUEST_MAX_LABEL_LENGTH)
  assert.equal(clampSecretDescription("  first\n\n\nsecond  "), "first\n\n\nsecond")
  assert.equal(clampSecretDescription("y".repeat(430)).length, SECRET_REQUEST_MAX_DESCRIPTION_LENGTH)
})

test("secret request summaries and acknowledgments never include a credential value", () => {
  assert.equal(summarizeSecretRequest({ label: "API token" }), "Secure secret input requested: API token")
  assert.equal(buildSecretProvidedAck({ label: "API token", target: { kind: "connector" } }), [
    "[API token was supplied through the secure input and saved directly to connector; the value is not available here and was not added to the conversation.]",
    "Tell the user it is set and continue. For connector credentials, wait briefly for the connection to appear, then check its status.",
  ].join("\n"))
})
