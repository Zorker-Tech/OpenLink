/**
 * Redaction violations.
 *
 * A field that *would* have been redacted but is being read anyway is a privacy event, not a crash:
 * it is reported through the process's redaction logger and the caller continues. The one exception
 * is development, where the same event throws — a field that leaks in a developer's terminal is a
 * field that will leak in production, and the only way to catch it is to refuse to be quiet about it.
 *
 * The logger has to be installed by the process (see `setRedactionLogger`): a module that quietly
 * picked its own sink would decide a product-wide policy.
 */

import { DataClassification, type DataClassification as DataClassificationValue } from "./classification.ts"
import { PrivacyMode, type PrivacyMode as PrivacyModeValue } from "./privacy-mode.ts"

export const REDACTION_MESSAGES = {
  UNSPECIFIED_FIELD: "[PRIVACY REDACTION] unwrapping UNSPECIFIED field — classify this field",
  UNSPECIFIED_PRIVACY_MODE: "[PRIVACY REDACTION] unwrapping with PrivacyMode.UNSPECIFIED — resolve privacy mode",
  LOGGER_NOT_INITIALIZED: "[PRIVACY REDACTION] logger not initialized — call setRedactionLogger() at process startup",
  ENFORCEMENT_SKIPPED: "[PRIVACY REDACTION] would have been redacted but enforceRedaction is false",
  LOGGING_ERROR: "[PRIVACY REDACTION] error logging violation",
  IMPLICIT_SERIALIZATION: "[PRIVACY REDACTION] implicit serialization of would-be-redacted field",
  IMPLICIT_SERIALIZATION_DEV: "[PRIVACY REDACTION] ERROR: Redaction via implicit serialization caught in test, please call unwrap() explicitly",
} as const

export interface RedactionLogger {
  info(attributes: Record<string, unknown>, message: string): void
}

export interface RedactionInfo {
  readonly fieldName: string
  readonly classification: DataClassificationValue
  readonly privacyMode: PrivacyModeValue
}

let redactionLogger: RedactionLogger | undefined

/** Installs the process's violation sink; `undefined` clears it (shutdown, tests). */
export function setRedactionLogger(logger: RedactionLogger | undefined): void {
  redactionLogger = logger
}

function report(attributes: Record<string, unknown>, message: string): void {
  try {
    redactionLogger?.info(attributes, message)
  } catch (error) {
    console.error(REDACTION_MESSAGES.LOGGING_ERROR, error)
  }
}

/** A field without a classification, or a context without a resolved mode, is worth reporting. */
export function logUnspecifiedWarnings(info: RedactionInfo): void {
  if (info.classification === DataClassification.UNSPECIFIED) {
    report({
      redaction_field_name: info.fieldName,
      redaction_classification: info.classification,
    }, REDACTION_MESSAGES.UNSPECIFIED_FIELD)
  }
  if (info.privacyMode === PrivacyMode.UNSPECIFIED) {
    report({
      redaction_field_name: info.fieldName,
      redaction_classification: info.classification,
      redaction_privacy_mode: info.privacyMode,
    }, REDACTION_MESSAGES.UNSPECIFIED_PRIVACY_MODE)
  }
}

/** Enforcement was off, so a value that policy would have redacted is being read. */
export function logEnforcementSkipped(info: RedactionInfo): void {
  if (redactionLogger === undefined) {
    console.error(REDACTION_MESSAGES.LOGGER_NOT_INITIALIZED)
    return
  }
  report({
    redaction_field_name: info.fieldName,
    redaction_classification: info.classification,
    redaction_privacy_mode: info.privacyMode,
    redaction_enforcement_skipped: true,
  }, REDACTION_MESSAGES.ENFORCEMENT_SKIPPED)
}

export function logImplicitSerialization(info: RedactionInfo, serializationPath: string): void {
  report({
    redaction_field_name: info.fieldName,
    redaction_classification: info.classification,
    redaction_privacy_mode: info.privacyMode,
    redaction_serialization_path: serializationPath,
  }, REDACTION_MESSAGES.IMPLICIT_SERIALIZATION)
}
