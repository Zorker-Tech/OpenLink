import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  allowedPurpose,
  DataClassification,
  PrivacyCapability,
  SENSITIVE_CLASSIFICATIONS,
} from "../../source/packages/redaction/classification.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"

const purposes = [
  PrivacyCapability.STORAGE_FOR_TRAINING,
  PrivacyCapability.STORAGE_FOR_LOGGING,
  PrivacyCapability.STORAGE_FOR_USAGE,
  PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
] as const

type AccessRow = readonly [boolean, boolean, boolean, boolean]
type ModeAccess = Readonly<Record<DataClassification, AccessRow>>

const accessByMode: Readonly<Record<PrivacyMode, ModeAccess>> = {
  [PrivacyMode.UNSPECIFIED]: {
    [DataClassification.SAFE]: [true, true, true, true],
    [DataClassification.CODE]: [false, false, false, true],
    [DataClassification.CREDENTIALS]: [false, false, false, true],
    [DataClassification.PATH]: [false, false, false, true],
    [DataClassification.PROVIDER_INFO]: [false, false, false, true],
    [DataClassification.UNSPECIFIED]: [false, false, false, true],
  },
  [PrivacyMode.NO_STORAGE]: {
    [DataClassification.SAFE]: [true, true, true, true],
    [DataClassification.CODE]: [false, false, false, true],
    [DataClassification.CREDENTIALS]: [false, false, false, true],
    [DataClassification.PATH]: [false, false, false, true],
    [DataClassification.PROVIDER_INFO]: [false, false, false, true],
    [DataClassification.UNSPECIFIED]: [false, false, false, true],
  },
  [PrivacyMode.NO_TRAINING]: {
    [DataClassification.SAFE]: [true, true, true, true],
    [DataClassification.CODE]: [false, false, true, true],
    [DataClassification.CREDENTIALS]: [false, false, false, true],
    [DataClassification.PATH]: [false, true, true, true],
    [DataClassification.PROVIDER_INFO]: [false, true, true, true],
    [DataClassification.UNSPECIFIED]: [false, false, false, true],
  },
  [PrivacyMode.USAGE_DATA_TRAINING_ALLOWED]: {
    [DataClassification.SAFE]: [true, true, true, true],
    [DataClassification.CODE]: [true, true, true, true],
    [DataClassification.CREDENTIALS]: [false, false, false, true],
    [DataClassification.PATH]: [true, true, true, true],
    [DataClassification.PROVIDER_INFO]: [true, true, true, true],
    [DataClassification.UNSPECIFIED]: [false, false, false, true],
  },
  [PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED]: {
    [DataClassification.SAFE]: [true, true, true, true],
    [DataClassification.CODE]: [true, true, true, true],
    [DataClassification.CREDENTIALS]: [false, false, false, true],
    [DataClassification.PATH]: [true, true, true, true],
    [DataClassification.PROVIDER_INFO]: [true, true, true, true],
    [DataClassification.UNSPECIFIED]: [false, false, false, true],
  },
}

describe("redaction classification policy", () => {
  it("applies the complete mode, classification, and purpose access matrix", () => {
    for (const [mode, classifications] of Object.entries(accessByMode) as Array<[PrivacyMode, ModeAccess]>) {
      for (const [classification, expected] of Object.entries(classifications) as Array<[DataClassification, AccessRow]>) {
        purposes.forEach((purpose, index) => {
          assert.equal(
            allowedPurpose(mode, purpose, classification),
            expected[index],
            `${mode} / ${classification} / ${purpose}`,
          )
        })
      }
    }
  })

  it("keeps the sensitive list exhaustive except for safe values", () => {
    assert.deepEqual(SENSITIVE_CLASSIFICATIONS, [
      DataClassification.CODE,
      DataClassification.CREDENTIALS,
      DataClassification.PATH,
      DataClassification.PROVIDER_INFO,
      DataClassification.UNSPECIFIED,
    ])
    assert.equal((SENSITIVE_CLASSIFICATIONS as readonly string[]).includes(DataClassification.SAFE), false)
  })
})
