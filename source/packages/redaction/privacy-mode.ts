/**
 * Privacy modes, as reported by the account.
 *
 * The numeric values are the wire values: they are stored in redacted messages and sent with them,
 * so they are part of the contract and not just an internal ordering.
 */

export const PrivacyMode = {
  UNSPECIFIED: 0,
  NO_STORAGE: 1,
  NO_TRAINING: 2,
  USAGE_DATA_TRAINING_ALLOWED: 3,
  USAGE_CODEBASE_TRAINING_ALLOWED: 4,
} as const

export type PrivacyMode = (typeof PrivacyMode)[keyof typeof PrivacyMode]
