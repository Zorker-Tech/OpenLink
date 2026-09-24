/**
 * The privacy context a redacted value was created under, and whether redaction is enforced.
 *
 * `enforceRedaction` is deliberately three-valued: unset means "ask the process gate" (the default
 * for values created in production), `false` means "this caller explicitly opted out" and `true`
 * means "this caller explicitly opted in". A value records the answer it was created with, so a
 * later change to the process gate cannot turn an existing redacted value into plain text.
 */

import { PrivacyMode, type PrivacyMode as PrivacyModeValue } from "./privacy-mode.ts"
import type { DataClassification } from "./classification.ts"

export interface PrivacyContext {
  readonly privacyMode: PrivacyModeValue
  readonly enforceRedaction?: boolean | undefined
}

/** Installed once at process startup by whichever process owns the privacy mode gate. */
let enforcementGate: (() => boolean | undefined) | undefined

export function setRedactionEnforcementGate(gate: () => boolean | undefined): void {
  enforcementGate = gate
}

export function resolveEnforceRedaction(
  context: PrivacyContext,
  classification: DataClassification,
): boolean {
  if (context.enforceRedaction === false) return false
  if (context.enforceRedaction === true) return true
  void classification
  return context.privacyMode !== PrivacyMode.UNSPECIFIED && enforcementGate?.() === true
}

export function privacyContextFromMode(
  privacyMode: PrivacyModeValue,
  enforceRedaction?: boolean,
): PrivacyContext {
  return enforceRedaction === undefined ? { privacyMode } : { privacyMode, enforceRedaction }
}

/** Accepts a bare privacy mode or a full context, and normalizes to the latter. */
export function toPrivacyContext(
  modeOrContext: PrivacyModeValue | PrivacyContext,
): PrivacyContext {
  if (
    typeof modeOrContext === "object" &&
    modeOrContext !== null &&
    "privacyMode" in modeOrContext
  ) return modeOrContext
  return privacyContextFromMode(modeOrContext)
}
