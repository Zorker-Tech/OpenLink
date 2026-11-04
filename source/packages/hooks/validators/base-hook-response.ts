/**
 * What every hook response has to be before its own fields mean anything: an object.
 *
 * Each step's validator runs this first and returns its result unchanged when it fails, so a
 * response that is not an object is reported once, as itself, rather than once per expected field.
 */

import { isObject, type ValidationResult } from "./validation.ts"

export function validateHookResponseEnvelope(candidate: unknown): ValidationResult {
  const valid = isObject(candidate)
  return { isValid: valid, errors: valid ? [] : ["Expected an object"] }
}
