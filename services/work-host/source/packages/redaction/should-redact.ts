/**
 * The redaction decision, and how a redacted value looks when something prints it.
 *
 * `shouldRedact` is the policy half: given a mode and a classification, is this value redacted?
 * Credentials and unclassified values are always redacted, safe values never are, and everything
 * else follows the mode. `getRedactionAwareDisplayValue` is the presentation half, used by every
 * implicit serialization so `console.log(redacted)` shows the placeholder rather than the secret.
 */

import { DataClassification, SENSITIVE_CLASSIFICATIONS } from "./classification.ts"
import { PrivacyMode, type PrivacyMode as PrivacyModeValue } from "./privacy-mode.ts"
import { resolveEnforceRedaction } from "./privacy-context.ts"

type ClassificationRule = "always-mask" | "always-show" | "follow-mode"

const CLASSIFICATION_RULES: Readonly<Record<DataClassification, ClassificationRule>> = Object.freeze({
  [DataClassification.SAFE]: "always-show",
  [DataClassification.CODE]: "follow-mode",
  [DataClassification.CREDENTIALS]: "always-mask",
  [DataClassification.PATH]: "follow-mode",
  [DataClassification.PROVIDER_INFO]: "follow-mode",
  [DataClassification.UNSPECIFIED]: "always-mask",
})

const MODES_THAT_ALLOW_TRAINING = new Set<PrivacyModeValue>([
  PrivacyMode.USAGE_DATA_TRAINING_ALLOWED,
  PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED,
])

export function shouldRedact(
  privacyMode: PrivacyModeValue,
  classification: DataClassification,
): boolean {
  const rule = CLASSIFICATION_RULES[classification]
  if (rule === undefined || rule === "always-show") return false
  if (rule === "always-mask") return true
  return !MODES_THAT_ALLOW_TRAINING.has(privacyMode)
}

/** The placeholder that stands in for a redacted value, named so a log points at the field. */
export function formatRedacted(fieldName: string): string {
  return `[redacted:${fieldName}]`
}

export function getRedactionAwareDisplayValue(options: {
  readonly privacyMode: PrivacyModeValue
  readonly classification: DataClassification
  readonly fieldName: string
  readonly unredactedValue: string
  readonly enforceRedaction?: boolean | undefined
}): string {
  const { privacyMode, classification, fieldName, unredactedValue } = options
  const enforceRedaction = resolveEnforceRedaction(
    { privacyMode, enforceRedaction: options.enforceRedaction },
    classification,
  )
  if (!enforceRedaction) return unredactedValue
  return shouldRedact(privacyMode, classification) ? formatRedacted(fieldName) : unredactedValue
}
