import { DataClassification, PrivacyCapability } from "../../redaction/classification.ts"
import { createRedactedString } from "../../redaction/create.ts"
import { PrivacyMode } from "../../redaction/privacy-mode.ts"
import { isRedactedString, type RedactedString } from "../../redaction/redacted-values.ts"

export type SlateShellCommandText = string | RedactedString

/** Slate's internal request for a user-entered shell command. */
export interface SlateShellCommandActionPayload {
  readonly schema: "slate.agent-action.shell-command"
  readonly version: 1
  readonly privacyMode: PrivacyMode
  readonly commandText?: SlateShellCommandText | undefined
  readonly resumeExecutionId?: string | undefined
  readonly compatibility?: {
    readonly legacyPayload?: Readonly<Record<string, unknown>>
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function createSlateShellCommandActionPayload(input: {
  readonly privacyMode: PrivacyMode
  readonly commandText?: SlateShellCommandText | undefined
  readonly resumeExecutionId?: string | undefined
  readonly compatibility?: SlateShellCommandActionPayload["compatibility"]
}): SlateShellCommandActionPayload {
  return {
    schema: "slate.agent-action.shell-command",
    version: 1,
    privacyMode: input.privacyMode,
    ...(input.commandText === undefined ? {} : { commandText: input.commandText }),
    ...(input.resumeExecutionId === undefined ? {} : { resumeExecutionId: input.resumeExecutionId }),
    ...(input.compatibility === undefined ? {} : { compatibility: input.compatibility }),
  }
}

export function isSlateShellCommandActionPayload(value: unknown): value is SlateShellCommandActionPayload {
  if (!isRecord(value) || value.schema !== "slate.agent-action.shell-command" || value.version !== 1 ||
      !Object.values(PrivacyMode).includes(value.privacyMode as PrivacyMode)) return false
  if (value.commandText !== undefined && typeof value.commandText !== "string" && !isRedactedString(value.commandText)) return false
  if (value.resumeExecutionId !== undefined && typeof value.resumeExecutionId !== "string") return false
  if (value.compatibility === undefined) return true
  return isRecord(value.compatibility) &&
    (value.compatibility.legacyPayload === undefined || isRecord(value.compatibility.legacyPayload))
}

/** Applies the current Slate privacy mode to the command before runner dispatch. */
export function redactSlateShellCommandActionPayload(
  payload: SlateShellCommandActionPayload,
  privacyMode: PrivacyMode,
): SlateShellCommandActionPayload {
  const command = payload.commandText
  if (command === undefined) return createSlateShellCommandActionPayload({ ...payload, privacyMode })
  const redactedCommand = isRedactedString(command) ? command : undefined
  const text = typeof command === "string"
    ? command
    : command.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
  return createSlateShellCommandActionPayload({
    ...payload,
    privacyMode,
    commandText: createRedactedString(
      text,
      redactedCommand?.__classification ?? DataClassification.CODE,
      redactedCommand?.__fieldName ?? "command",
      privacyMode,
    ),
  })
}
