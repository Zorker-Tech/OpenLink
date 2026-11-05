import { PrivacyCapability } from "../../../packages/redaction/classification.ts"
import { RedactedBytes, RedactedString } from "../../../packages/redaction/redacted-values.ts"

/** Reads text from a legacy selection only at the adapter boundary that feeds Slate processing. */
export function readSelectedContextText(value: unknown, fieldName: string): string {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  if (value instanceof RedactedString) return value.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
  throw new TypeError(`Selected-context ${fieldName} must be text`)
}

/** Reads media bytes without treating a redaction wrapper as a typed-array-like object. */
export function copySelectedContextBytes(value: unknown, fieldName: string): Uint8Array {
  if (value === undefined || value === null) return new Uint8Array(0)
  if (value instanceof RedactedBytes) {
    return new Uint8Array(value.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED))
  }
  if (value instanceof Uint8Array) return new Uint8Array(value)
  throw new TypeError(`Selected-context ${fieldName} must be bytes`)
}
