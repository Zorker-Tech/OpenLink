/**
 * What every hook response has to be before its own fields mean anything: an object.
 *
 * Each step's validator runs this first and returns its result unchanged when it fails, so a
 * response that is not an object is reported once, as itself, rather than once per expected field.
 */

import { createValidationResult, isObject, type ValidationResult } from "./validation.ts"

export function validateBaseHookResponse(value: unknown): ValidationResult {
  return isObject(value) ? createValidationResult(true) : createValidationResult(false, ["Expected an object"])
}
