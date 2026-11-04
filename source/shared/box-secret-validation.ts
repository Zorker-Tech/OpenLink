/** Validates the user-controlled portion of a box environment. */

import { isEnvironmentName } from "./env-file.ts"
import {
  MAX_BOX_SECRET_COUNT,
  MAX_BOX_SECRET_VALUE_LENGTH,
  MAX_BOX_SECRETS_TOTAL_LENGTH,
  RESERVED_BOX_SECRET_PREFIXES,
  RESERVED_EXACT_BOX_SECRET_NAMES,
} from "./box-secret-policy.ts"

const NO_ADDITIONAL_RESERVED_NAMES: ReadonlySet<string> = new Set()
const SANDBOX_REFERENCE = /SLATE_SANDBOX/i

export function validateBoxSecretKey(
  key: string,
  additionalReservedNames: ReadonlySet<string> = NO_ADDITIONAL_RESERVED_NAMES,
): string | null {
  if (!isEnvironmentName(key)) return `"${key}" is not a valid environment variable name`
  if (RESERVED_EXACT_BOX_SECRET_NAMES.has(key) || additionalReservedNames.has(key)) {
    return `${key} is reserved by the box runtime`
  }

  const reservedPrefix = RESERVED_BOX_SECRET_PREFIXES.find(prefix => key.startsWith(prefix))
  if (reservedPrefix !== undefined) return `Names starting with ${reservedPrefix} are reserved by the box runtime`
  return SANDBOX_REFERENCE.test(key) ? `${key} is reserved by the box runtime` : null
}

export function validateBoxSecrets(
  secrets: Readonly<Record<string, string>>,
  additionalReservedNames: ReadonlySet<string> = NO_ADDITIONAL_RESERVED_NAMES,
): string | null {
  const names = Object.keys(secrets)
  if (names.length > MAX_BOX_SECRET_COUNT) return `Too many secrets (max ${MAX_BOX_SECRET_COUNT})`

  let totalLength = 0
  for (const name of names) {
    const keyProblem = validateBoxSecretKey(name, additionalReservedNames)
    if (keyProblem !== null) return keyProblem

    const value = secrets[name] ?? ""
    if (value.length > MAX_BOX_SECRET_VALUE_LENGTH) {
      return `The value of ${name} is too large (max ${MAX_BOX_SECRET_VALUE_LENGTH.toLocaleString()} characters)`
    }
    totalLength += name.length + value.length
  }

  return totalLength > MAX_BOX_SECRETS_TOTAL_LENGTH
    ? "The combined size of all secrets is too large"
    : null
}
