/**
 * The shape every hook response validator returns.
 *
 * A hook is written by a user and read by a machine that then has to act on it — allow a command,
 * deny it, add context — so a response that does not parse is a response that cannot be obeyed. The
 * validators therefore collect every problem instead of stopping at the first, because a hook author
 * fixing a file wants the whole list.
 */

export interface ValidationResult {
  isValid: boolean
  errors: string[]
}

export const isString = (value: unknown): value is string => typeof value === "string"

export const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

export const createValidationResult = (isValid: boolean, errors: string[] = []): ValidationResult =>
  ({ isValid, errors })

export function validateOptionalString(value: unknown, fieldName: string, errors: string[]): void {
  if (value !== undefined && !isString(value)) errors.push(`${fieldName} must be a string if provided`)
}
