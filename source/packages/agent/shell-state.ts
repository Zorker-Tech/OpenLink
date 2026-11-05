/** Slate-owned domain values for a shell turn. */
import { DataClassification, PrivacyCapability } from "../redaction/classification.ts"
import { createRedactedString } from "../redaction/create.ts"
import type { PrivacyMode } from "../redaction/privacy-mode.ts"
import { RedactedString } from "../redaction/redacted-values.ts"
import type { SlateCheckpointUnknownField } from "./conversation-checkpoint-state.ts"

export interface SlateShellStateCompatibility {
  /** Historical protobuf fields kept only while supported old turns need lossless restoration. */
  readonly legacyUnknownFields?: readonly SlateCheckpointUnknownField[]
}

/** A command the user asked Slate to run. */
export interface SlateShellInvocation {
  readonly commandText: string
  readonly compatibility?: SlateShellStateCompatibility
}

/** Output captured from one completed shell invocation. */
export interface SlateShellResult {
  readonly standardOutput: string
  readonly standardError: string
  readonly exitCode: number
  readonly compatibility?: SlateShellStateCompatibility
}

export type SlateStoredShellText = string | RedactedString

/** Durable shell values after the active privacy policy has been applied. */
export interface SlateStoredShellInvocation extends Omit<SlateShellInvocation, "commandText"> {
  readonly commandText: SlateStoredShellText
}

export interface SlateStoredShellResult extends Omit<SlateShellResult, "standardOutput" | "standardError"> {
  readonly standardOutput: SlateStoredShellText
  readonly standardError: SlateStoredShellText
}

function copyCompatibility(
  compatibility: SlateShellStateCompatibility | undefined,
): SlateShellStateCompatibility | undefined {
  const fields = compatibility?.legacyUnknownFields
  if (compatibility === undefined) return undefined
  return {
    ...(fields === undefined
      ? {}
      : {
          legacyUnknownFields: fields.map(field => ({
            ...field,
            path: field.path.map(step => ({ ...step })),
          })),
        }),
  }
}

function storedText(value: string | RedactedString, fieldName: string, privacyMode: PrivacyMode): RedactedString {
  if (value instanceof RedactedString) {
    return createRedactedString(
      value.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
      value.__classification,
      value.__fieldName,
      privacyMode,
    )
  }
  if (typeof value !== "string") throw new TypeError(`Slate shell ${fieldName} must be text`)
  return createRedactedString(value, DataClassification.CODE, fieldName, privacyMode)
}

export function createSlateShellInvocation(commandText: string): SlateShellInvocation {
  if (typeof commandText !== "string") throw new TypeError("Slate shell command must be text")
  return { commandText }
}

export function createSlateShellResult(input: {
  readonly standardOutput: string
  readonly standardError: string
  readonly exitCode: number
}): SlateShellResult {
  if (typeof input.standardOutput !== "string" || typeof input.standardError !== "string") {
    throw new TypeError("Slate shell output streams must be text")
  }
  if (!Number.isInteger(input.exitCode) || input.exitCode < -2_147_483_648 || input.exitCode > 2_147_483_647) {
    throw new TypeError("Slate shell exit code must be a signed 32-bit integer")
  }
  return {
    standardOutput: input.standardOutput,
    standardError: input.standardError,
    exitCode: input.exitCode,
  }
}

export function storeSlateShellInvocation(
  invocation: SlateShellInvocation,
  privacyMode: PrivacyMode,
): SlateStoredShellInvocation {
  const compatibility = copyCompatibility(invocation.compatibility)
  return {
    commandText: storedText(invocation.commandText, "command", privacyMode),
    ...(compatibility === undefined ? {} : { compatibility }),
  }
}

export function storeSlateShellResult(
  result: SlateShellResult,
  privacyMode: PrivacyMode,
): SlateStoredShellResult {
  const validated = createSlateShellResult(result)
  const compatibility = copyCompatibility(result.compatibility)
  return {
    standardOutput: storedText(validated.standardOutput, "stdout", privacyMode),
    standardError: storedText(validated.standardError, "stderr", privacyMode),
    exitCode: validated.exitCode,
    ...(compatibility === undefined ? {} : { compatibility }),
  }
}

export function createEmptyStoredSlateShellResult(privacyMode: PrivacyMode): SlateStoredShellResult {
  return storeSlateShellResult({ standardOutput: "", standardError: "", exitCode: 0 }, privacyMode)
}

export function cloneSlateStoredShellInvocation(
  invocation: SlateStoredShellInvocation,
): SlateStoredShellInvocation {
  const compatibility = copyCompatibility(invocation.compatibility)
  return {
    commandText: invocation.commandText,
    ...(compatibility === undefined ? {} : { compatibility }),
  }
}

export function cloneSlateStoredShellResult(result: SlateStoredShellResult): SlateStoredShellResult {
  const compatibility = copyCompatibility(result.compatibility)
  return {
    standardOutput: result.standardOutput,
    standardError: result.standardError,
    exitCode: result.exitCode,
    ...(compatibility === undefined ? {} : { compatibility }),
  }
}
