import { DataClassification, PrivacyCapability } from "../../redaction/classification.ts"
import { createRedactedString } from "../../redaction/create.ts"
import { isRedactedString, type RedactedString } from "../../redaction/redacted-values.ts"
import type { PrivacyMode } from "../../redaction/privacy-mode.ts"

export type SlateCancelReason = string | RedactedString

export interface SlateCancelActionPayload {
  readonly schema: "slate.agent-action.cancel"
  readonly version: 1
  readonly reason: SlateCancelReason
  readonly compatibility?: {
    readonly interruptedToolResolutions?: unknown
    readonly legacyPayload?: Readonly<Record<string, unknown>>
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function createSlateCancelActionPayload(
  reason: SlateCancelReason,
  compatibility?: SlateCancelActionPayload["compatibility"],
): SlateCancelActionPayload {
  return {
    schema: "slate.agent-action.cancel",
    version: 1,
    reason,
    ...(compatibility === undefined ? {} : { compatibility }),
  }
}

export function isSlateCancelActionPayload(value: unknown): value is SlateCancelActionPayload {
  if (!isRecord(value) || value.schema !== "slate.agent-action.cancel" || value.version !== 1) return false
  if (typeof value.reason !== "string" && !isRedactedString(value.reason)) return false
  if (value.compatibility === undefined) return true
  if (!isRecord(value.compatibility)) return false
  const legacyPayload = value.compatibility.legacyPayload
  return legacyPayload === undefined || isRecord(legacyPayload)
}

/** Rebinds the reason's redaction policy when a Slate action enters a runner with a newer mode. */
export function redactSlateCancelActionPayload(
  payload: SlateCancelActionPayload,
  privacyMode: PrivacyMode,
): SlateCancelActionPayload {
  const reason = isRedactedString(payload.reason) ? payload.reason : undefined
  const value = typeof payload.reason === "string"
    ? payload.reason
    : payload.reason.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
  return createSlateCancelActionPayload(
    createRedactedString(
      value,
      reason?.__classification ?? DataClassification.CODE,
      reason?.__fieldName ?? "reason",
      privacyMode,
    ),
    payload.compatibility,
  )
}
