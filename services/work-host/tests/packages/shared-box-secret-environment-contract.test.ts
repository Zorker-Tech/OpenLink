import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  SLATE_BOX_SECRET_NAMES_ENV,
  buildSlateBoxSecretsEnv,
} from "../../source/shared/box-secret-policy.ts"
import { validateBoxSecretKey } from "../../source/shared/box-secret-validation.ts"

describe("Slate box secret environment", () => {
  it("uses a Slate-owned reserved marker", () => {
    assert.equal(SLATE_BOX_SECRET_NAMES_ENV, "SLATE_BOX_SECRET_NAMES")
    assert.equal(
      validateBoxSecretKey(SLATE_BOX_SECRET_NAMES_ENV),
      "Names starting with SLATE_ are reserved by the box runtime",
    )
  })

  it("emits names in stable order and normalizes a missing value", () => {
    const sparse = { ZED: "last", ALPHA: undefined } as unknown as Readonly<Record<string, string>>
    assert.deepEqual(buildSlateBoxSecretsEnv(sparse), {
      ALPHA: "",
      ZED: "last",
      [SLATE_BOX_SECRET_NAMES_ENV]: "ALPHA,ZED",
    })
  })

  it("does not manufacture an environment update for an empty map", () => {
    assert.deepEqual(buildSlateBoxSecretsEnv({}), {})
  })
})
