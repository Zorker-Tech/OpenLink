/** Validates foreign hook-script response fields into Slate's hook validation result. */
import { isObject, isString, createValidationResult, type ValidationResult } from "../../../packages/hooks/validators/validation.ts"
import { validateHookResponseEnvelope } from "../../../packages/hooks/validators/base-hook-response.ts"

const ACTION_DECISIONS = ["allow", "deny"] as const
const DEFERABLE_DECISIONS = ["allow", "deny", "ask"] as const

type ResponseRecord = Record<string, unknown>
type ResponseCheck = (response: ResponseRecord, errors: string[]) => void

function validateDecision(value: unknown, allowed: readonly string[], errors: string[]): void {
  if (value === undefined) return
  if (!allowed.includes(value as string)) {
    errors.push(`Invalid permission value. Expected one of: ${allowed.join(", ")}, or undefined`)
  }
}

function optionalText(field: string, message = `${field} must be a string if provided`): ResponseCheck {
  return (response, errors) => {
    const value = response[field]
    if (value !== undefined && !isString(value)) errors.push(message)
  }
}

function optionalBoolean(field: string): ResponseCheck {
  return (response, errors) => {
    if (response[field] !== undefined && typeof response[field] !== "boolean") {
      errors.push(`${field} must be a boolean if provided`)
    }
  }
}

function permissionChoice(allowed: readonly string[]): ResponseCheck {
  return (response, errors) => validateDecision(response.permission, allowed, errors)
}

function rewrittenInput(response: ResponseRecord, errors: string[]): void {
  if (response.updated_input !== undefined && !isObject(response.updated_input)) {
    errors.push("Invalid updated_input value. Expected a plain object if provided")
  }
}

function environmentValues(response: ResponseRecord, errors: string[]): void {
  const environment = response.env
  if (environment === undefined) return
  if (!isObject(environment)) {
    errors.push("env must be an object if provided")
    return
  }
  for (const [key, value] of Object.entries(environment)) {
    if (!isString(value)) errors.push(`env value for "${key}" must be a string`)
  }
}

function pluginPathList(response: ResponseRecord, errors: string[]): void {
  const paths = response.pluginPaths
  if (paths === undefined) return
  if (!Array.isArray(paths)) {
    errors.push("pluginPaths must be an array of strings if provided")
    return
  }
  paths.forEach((path, index) => {
    if (!isString(path)) errors.push(`pluginPaths[${index}] must be a string`)
    else if (path.trim().length === 0) errors.push(`pluginPaths[${index}] must be a non-empty string`)
  })
}

function checkFields(response: ResponseRecord, checks: readonly ResponseCheck[]): ValidationResult {
  const errors: string[] = []
  for (const check of checks) check(response, errors)
  return createValidationResult(errors.length === 0, errors)
}

function validateResponse(value: unknown, checks: readonly ResponseCheck[]): ValidationResult {
  const base = validateHookResponseEnvelope(value)
  if (!base.isValid || !isObject(value)) return base
  return checkFields(value, checks)
}

/** A step that observes its outcome has no additional response fields to validate. */
export const validateObservedResponse = validateHookResponseEnvelope

/** Action gates may allow, deny, ask, and add a message for either side. */
export function validateGatedActionResponse(value: unknown): ValidationResult {
  return validateResponse(value, [permissionChoice(DEFERABLE_DECISIONS), optionalText("user_message"), optionalText("agent_message")])
}

/** File reads allow or deny; they do not defer. */
export function validateReadFileResponse(value: unknown): ValidationResult {
  return validateResponse(value, [permissionChoice(ACTION_DECISIONS), optionalText("user_message")])
}

/** A subagent may start, be denied, or wait for a decision. */
export function validateSubagentStartResponse(value: unknown): ValidationResult {
  return validateResponse(value, [permissionChoice(DEFERABLE_DECISIONS), optionalText("user_message")])
}

/** A tool hook may change the input before adding context for the model. */
export function validatePreToolUseResponse(value: unknown): ValidationResult {
  return validateResponse(value, [
    permissionChoice(DEFERABLE_DECISIONS),
    optionalText("user_message"),
    optionalText("agent_message"),
    rewrittenInput,
    optionalText("additional_context"),
  ])
}

/** Once a tool has run, a hook can only add context. */
export function validatePostToolUseResponse(value: unknown): ValidationResult {
  return validateResponse(value, [optionalText("additional_context")])
}

export function validateBeforePromptSubmitResponse(value: unknown): ValidationResult {
  return validateResponse(value, [optionalBoolean("continue"), optionalText("user_message"), optionalText("additional_context")])
}

/** A new session can also provide string-valued environment entries. */
export function validateSessionStartResponse(value: unknown): ValidationResult {
  return validateResponse(value, [environmentValues, optionalText("additional_context"), optionalBoolean("continue"), optionalText("user_message")])
}

/** A stop hook may ask the agent to continue with a follow-up message. */
export function validateStopResponse(value: unknown): ValidationResult {
  return validateResponse(value, [optionalText("followup_message")])
}

/** Before compaction, only a non-empty response's user message needs checking. */
export function validatePreCompactResponse(value: unknown): ValidationResult {
  const base = validateHookResponseEnvelope(value)
  if (!base.isValid || !isObject(value) || Object.keys(value).length === 0) return base
  return checkFields(value, [
    (response, errors) => {
      if (response.user_message !== undefined && !isString(response.user_message)) {
        errors.push("user_message must be a string")
      }
    },
  ])
}

/** A workspace-open response may name non-empty plugin paths. */
export function validateWorkspaceOpenResponse(value: unknown): ValidationResult {
  return validateResponse(value, [pluginPathList])
}
