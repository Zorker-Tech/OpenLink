/** Slate-owned policy categories used by redaction and persistence decisions. */
const PRIVACY_MODE_ENTRIES = [
  ["UNSPECIFIED", "unspecified"],
  ["NO_STORAGE", "no-storage"],
  ["NO_TRAINING", "no-training"],
  ["USAGE_DATA_TRAINING_ALLOWED", "usage-data-training-allowed"],
  ["USAGE_CODEBASE_TRAINING_ALLOWED", "usage-codebase-training-allowed"],
] as const

export const PrivacyMode = Object.fromEntries(PRIVACY_MODE_ENTRIES) as {
  readonly UNSPECIFIED: "unspecified"
  readonly NO_STORAGE: "no-storage"
  readonly NO_TRAINING: "no-training"
  readonly USAGE_DATA_TRAINING_ALLOWED: "usage-data-training-allowed"
  readonly USAGE_CODEBASE_TRAINING_ALLOWED: "usage-codebase-training-allowed"
}

export type PrivacyMode = (typeof PrivacyMode)[keyof typeof PrivacyMode]
