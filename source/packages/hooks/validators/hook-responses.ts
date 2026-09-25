/**
 * What each hook step's response may say.
 *
 * A step's response is small and step-specific: a permission decision belongs to the steps that gate
 * an action, added context belongs to the steps that feed the model, and the steps that only observe
 * accept any object at all. Validating per step rather than with one loose schema is what lets a typo
 * in a hook file be reported as the mistake it is instead of being silently ignored.
 */

import { validateOptionalString, createValidationResult, isObject, isString, type ValidationResult } from "./validation.ts"
import { validateBaseHookResponse } from "./base-hook-response.ts"

const ALLOW_DENY = ["allow", "deny"] as const
const ALLOW_DENY_ASK = ["allow", "deny", "ask"] as const

function validatePermission(value: unknown, allowed: readonly string[], errors: string[]): void {
  if (value === undefined) return
  if (!allowed.includes(value as string)) {
    errors.push(`Invalid permission value. Expected one of: ${allowed.join(", ")}, or undefined`)
  }
}

function validateUserMessage(value: unknown, errors: string[]): void {
  if (value !== undefined && typeof value !== "string") errors.push("user_message must be a string if provided")
}

function validateAgentMessage(value: unknown, errors: string[]): void {
  if (value !== undefined && typeof value !== "string") errors.push("agent_message must be a string if provided")
}

/**
 * A step that only observes its outcome. Anything that is an object is acceptable and there is
 * nothing inside it to check, because the step's result is reported elsewhere.
 */
export const validateObservedResponse = validateBaseHookResponse

/** The steps that gate an action can allow it, deny it, or ask — and can word both sides. */
export function validateGatedActionResponse(value: unknown): ValidationResult {
  const base = validateBaseHookResponse(value)
  if (!base.isValid || !isObject(value)) return base
  const errors: string[] = []
  validatePermission(value.permission, ALLOW_DENY_ASK, errors)
  validateUserMessage(value.user_message, errors)
  validateAgentMessage(value.agent_message, errors)
  return createValidationResult(errors.length === 0, errors)
}

/** Reading a file is gated too, but refusing it is the only decision worth explaining to the user. */
export function validateReadFileResponse(value: unknown): ValidationResult {
  const base = validateBaseHookResponse(value)
  if (!base.isValid || !isObject(value)) return base
  const errors: string[] = []
  validatePermission(value.permission, ALLOW_DENY, errors)
  validateUserMessage(value.user_message, errors)
  return createValidationResult(errors.length === 0, errors)
}

/** A subagent can be refused before it starts, and the user can be told why. */
export function validateSubagentStartResponse(value: unknown): ValidationResult {
  const base = validateBaseHookResponse(value)
  if (!base.isValid || !isObject(value)) return base
  const errors: string[] = []
  validatePermission(value.permission, ALLOW_DENY_ASK, errors)
  validateUserMessage(value.user_message, errors)
  return createValidationResult(errors.length === 0, errors)
}

/** The tool steps: a decision, the two messages, and the arguments the call may be rewritten with. */
export function validatePreToolUseResponse(value: unknown): ValidationResult {
  const base = validateBaseHookResponse(value)
  if (!base.isValid || !isObject(value)) return base
  const errors: string[] = []
  validatePermission(value.permission, ALLOW_DENY_ASK, errors)
  validateUserMessage(value.user_message, errors)
  validateAgentMessage(value.agent_message, errors)
  if (value.updated_input !== undefined && !isObject(value.updated_input)) {
    errors.push("Invalid updated_input value. Expected a plain object if provided")
  }
  validateOptionalString(value.additional_context, "additional_context", errors)
  return createValidationResult(errors.length === 0, errors)
}

/** After a tool call the only thing left to add is context; the call has already happened. */
export function validatePostToolUseResponse(value: unknown): ValidationResult {
  const base = validateBaseHookResponse(value)
  if (!base.isValid || !isObject(value)) return base
  const errors: string[] = []
  validateOptionalString(value.additional_context, "additional_context", errors)
  return createValidationResult(errors.length === 0, errors)
}

export function validateBeforePromptSubmitResponse(value: unknown): ValidationResult {
  const base = validateBaseHookResponse(value)
  if (!base.isValid || !isObject(value)) return base
  const errors: string[] = []
  if (value.continue !== undefined && typeof value.continue !== "boolean") {
    errors.push("continue must be a boolean if provided")
  }
  validateUserMessage(value.user_message, errors)
  if (value.additional_context !== undefined && !isString(value.additional_context)) {
    errors.push("additional_context must be a string if provided")
  }
  return createValidationResult(errors.length === 0, errors)
}

/** A session start may also set environment variables for the session it is starting. */
export function validateSessionStartResponse(value: unknown): ValidationResult {
  const base = validateBaseHookResponse(value)
  if (!base.isValid || !isObject(value)) return base
  const errors: string[] = []
  if (value.env !== undefined) {
    if (!isObject(value.env)) errors.push("env must be an object if provided")
    else {
      for (const [key, item] of Object.entries(value.env)) {
        if (!isString(item)) errors.push(`env value for "${key}" must be a string`)
      }
    }
  }
  if (value.additional_context !== undefined && !isString(value.additional_context)) {
    errors.push("additional_context must be a string if provided")
  }
  if (value.continue !== undefined && typeof value.continue !== "boolean") {
    errors.push("continue must be a boolean if provided")
  }
  validateUserMessage(value.user_message, errors)
  return createValidationResult(errors.length === 0, errors)
}

/** Stopping is the one step whose response can ask the agent to keep going. */
export function validateStopResponse(value: unknown): ValidationResult {
  const base = validateBaseHookResponse(value)
  if (!base.isValid || !isObject(value)) return base
  const errors: string[] = []
  if (value.followup_message !== undefined && typeof value.followup_message !== "string") {
    errors.push("followup_message must be a string if provided")
  }
  return createValidationResult(errors.length === 0, errors)
}

/** Before a compaction there is nothing to decide; a response may only say something to the user. */
export function validatePreCompactResponse(value: unknown): ValidationResult {
  const base = validateBaseHookResponse(value)
  if (!base.isValid) return base
  if (!isObject(value) || Object.keys(value).length === 0) return createValidationResult(true)
  const errors: string[] = []
  if (value.user_message !== undefined && typeof value.user_message !== "string") {
    errors.push("user_message must be a string")
  }
  return createValidationResult(errors.length === 0, errors)
}

/** Opening a workspace may name plugin paths to load, each of which has to be a usable string. */
export function validateWorkspaceOpenResponse(value: unknown): ValidationResult {
  const base = validateBaseHookResponse(value)
  if (!base.isValid || !isObject(value)) return base
  const errors: string[] = []
  if (value.pluginPaths !== undefined) {
    if (!Array.isArray(value.pluginPaths)) errors.push("pluginPaths must be an array of strings if provided")
    else {
      value.pluginPaths.forEach((entry, index) => {
        if (!isString(entry)) errors.push(`pluginPaths[${index}] must be a string`)
        else if (entry.trim().length === 0) errors.push(`pluginPaths[${index}] must be a non-empty string`)
      })
    }
  }
  return createValidationResult(errors.length === 0, errors)
}
