/**
 * Builders for redacted values.
 *
 * `safeString` exists for the many places that need the redaction-aware string API but are handling
 * something that is not secret — a label, a model id, a tool name — so they get a value that is
 * still comparable and printable without a privacy context threaded through.
 */

import { DataClassification } from "./classification.ts"
import { PrivacyMode, type PrivacyMode as PrivacyModeValue } from "./privacy-mode.ts"
import type { PrivacyContext } from "./privacy-context.ts"
import { RedactedBytes, RedactedString } from "./redacted-values.ts"

export function createRedactedString(
  value: string,
  classification: DataClassification,
  fieldName: string,
  modeOrContext: PrivacyModeValue | PrivacyContext,
): RedactedString {
  return new RedactedString(value, classification, fieldName, modeOrContext)
}

export function createRedactedBytes(
  value: Uint8Array,
  classification: DataClassification,
  fieldName: string,
  modeOrContext: PrivacyModeValue | PrivacyContext,
): RedactedBytes {
  return new RedactedBytes(value, classification, fieldName, modeOrContext)
}

export function safeString(value: string): RedactedString {
  return createRedactedString(
    value,
    DataClassification.SAFE,
    "safe",
    PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED,
  )
}
