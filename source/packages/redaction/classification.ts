/**
 * What a value *is*, and what may be done with it.
 *
 * A classification is attached where a value enters the platform; the purposes below are what a
 * consumer asks for when it wants the value out. Everything between the two is decided by
 * `allowedPurpose` and `shouldRedact`, so no call site invents its own privacy rule.
 */

import { PrivacyMode, type PrivacyMode as PrivacyModeValue } from "./privacy-mode.ts"

export const DataClassification = {
  SAFE: "safe",
  CODE: "code",
  CREDENTIALS: "credentials",
  PATH: "path",
  PROVIDER_INFO: "provider_info",
  UNSPECIFIED: "unspecified",
} as const

export type DataClassification = (typeof DataClassification)[keyof typeof DataClassification]

/** Everything except `safe`: what a redaction decision actually has to consider. */
export const SENSITIVE_CLASSIFICATIONS: readonly DataClassification[] = [
  DataClassification.CODE,
  DataClassification.CREDENTIALS,
  DataClassification.PATH,
  DataClassification.PROVIDER_INFO,
  DataClassification.UNSPECIFIED,
]

export const PrivacyCapability = {
  STORAGE_FOR_TRAINING: "storage_for_training",
  STORAGE_FOR_LOGGING: "storage_for_logging",
  STORAGE_FOR_USAGE: "storage_for_usage",
  /** For the paths that must read a value regardless — an explicit, greppable escape hatch. */
  UNSAFE_ALWAYS_ALLOWED: "unsafe_always_allowed",
} as const

export type PrivacyCapability = (typeof PrivacyCapability)[keyof typeof PrivacyCapability]

const STORAGE_PURPOSES: readonly PrivacyCapability[] = [
  PrivacyCapability.STORAGE_FOR_TRAINING,
  PrivacyCapability.STORAGE_FOR_LOGGING,
  PrivacyCapability.STORAGE_FOR_USAGE,
]

/**
 * Whether reading a value of this classification for this purpose is allowed under this mode.
 *
 * Two classifications are absolute: credentials and unclassified values are never read for storage
 * purposes, whatever the mode says. Safe values are always readable. Everything else depends on the
 * mode: a mode that allows training is meaningless if it does not also allow logging and usage.
 */
export function allowedPurpose(
  privacyMode: PrivacyModeValue,
  purpose: PrivacyCapability,
  classification: DataClassification,
): boolean {
  if (classification === DataClassification.SAFE) return true
  if (purpose === PrivacyCapability.UNSAFE_ALWAYS_ALLOWED) return true
  if (
    classification === DataClassification.CREDENTIALS ||
    classification === DataClassification.UNSPECIFIED
  ) return false
  if (!STORAGE_PURPOSES.includes(purpose)) throw new Error(`Unknown purpose: ${purpose}`)
  switch (privacyMode) {
    case PrivacyMode.NO_STORAGE:
    case PrivacyMode.UNSPECIFIED:
      return false
    case PrivacyMode.NO_TRAINING:
      if (purpose === PrivacyCapability.STORAGE_FOR_LOGGING) {
        return classification === DataClassification.PATH ||
          classification === DataClassification.PROVIDER_INFO
      }
      if (purpose === PrivacyCapability.STORAGE_FOR_TRAINING) return false
      return true
    case PrivacyMode.USAGE_DATA_TRAINING_ALLOWED:
    case PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED:
      return true
    default:
      throw new Error(`Unknown privacy mode: ${privacyMode}`)
  }
}
