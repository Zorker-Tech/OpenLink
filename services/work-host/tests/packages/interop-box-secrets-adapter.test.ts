import { test } from "node:test"
import assert from "node:assert/strict"

import {
  BOX_SECRET_REDACTION_NAMES_ENV_VAR,
  buildBoxSecretsEnv,
  validateBoxSecretKeyAtInterop,
  validateBoxSecretsAtInterop,
} from "../../source/adapters/interop/agent/box-secrets-adapter.ts"
import { validateBoxSecretKey } from "../../source/shared/box-secrets.ts"

test("the box runtime's redaction key is reserved from user values", () => {
  assert.equal(BOX_SECRET_REDACTION_NAMES_ENV_VAR, "CLOUD_AGENT_INJECTED_SECRET_NAMES")
  assert.equal(validateBoxSecretKey(BOX_SECRET_REDACTION_NAMES_ENV_VAR), null)
  assert.equal(
    validateBoxSecretKeyAtInterop(BOX_SECRET_REDACTION_NAMES_ENV_VAR),
    `${BOX_SECRET_REDACTION_NAMES_ENV_VAR} is reserved by the box runtime`,
  )
  assert.equal(
    validateBoxSecretsAtInterop({ [BOX_SECRET_REDACTION_NAMES_ENV_VAR]: "ATTACKER_VALUE" }),
    `${BOX_SECRET_REDACTION_NAMES_ENV_VAR} is reserved by the box runtime`,
  )
})

test("the box environment lists secret names in stable order and omits metadata for an empty set", () => {
  assert.deepEqual(buildBoxSecretsEnv({ B: "two", A: "one" }), {
    A: "one",
    B: "two",
    [BOX_SECRET_REDACTION_NAMES_ENV_VAR]: "A,B",
  })
  assert.deepEqual(buildBoxSecretsEnv({}), {})
})
