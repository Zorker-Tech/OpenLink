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

/** Whether a value is text. */
export const isString = (candidate: unknown): candidate is string => typeof candidate === "string"

/** Whether a value is a record: an object that is not a list. */
const isRecord = (candidate: unknown): candidate is Record<string, unknown> =>
  candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)

export const isObject = (candidate: unknown): candidate is Record<string, unknown> => isRecord(candidate)

export const createValidationResult = (valid: boolean, errors: string[] = []): ValidationResult =>
  ({ isValid: valid, errors })

/** Adds the problem a provided-but-not-text field is; an absent field is no problem at all. */
export function validateOptionalString(provided: unknown, fieldName: string, problems: string[]): void {
  if (provided === undefined || isString(provided)) return
  problems.push(`${fieldName} must be a string if provided`)
}
