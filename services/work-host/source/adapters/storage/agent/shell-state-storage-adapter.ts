/** Slate's versioned durable format for shell turns. */
import { DataClassification, PrivacyCapability } from "../../../packages/redaction/classification.ts"
import { createRedactedString } from "../../../packages/redaction/create.ts"
import type { PrivacyMode } from "../../../packages/redaction/privacy-mode.ts"
import { RedactedString } from "../../../packages/redaction/redacted-values.ts"
import { utf8Serde } from "../../../packages/agent-kv/serde.ts"
import type { Serde } from "../../../packages/agent-kv/serde-contracts.ts"
import {
  cloneSlateStoredShellInvocation,
  cloneSlateStoredShellResult,
  type SlateStoredShellInvocation,
  type SlateStoredShellResult,
} from "../../../packages/agent/shell-state.ts"

const INVOCATION_HEADER = utf8Serde.serialize("SLATE-AGENT-SHELL-INVOCATION\n")
const INVOCATION_FORMAT = "slate.agent-shell-invocation"
const RESULT_HEADER = utf8Serde.serialize("SLATE-AGENT-SHELL-RESULT\n")
const RESULT_FORMAT = "slate.agent-shell-result"
const CLASSIFICATIONS = new Set<string>(Object.values(DataClassification))

type StoredText = { readonly text: string; readonly classification: string; readonly fieldName: string }

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}

function beginsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false
  return prefix.every((byte, index) => bytes[index] === byte)
}

function isStoredText(value: unknown): value is StoredText {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const text = value as Record<string, unknown>
  return hasOnlyKeys(text, ["text", "classification", "fieldName"]) &&
    typeof text.text === "string" && typeof text.classification === "string" &&
    CLASSIFICATIONS.has(text.classification) && typeof text.fieldName === "string"
}

function isStoredInvocation(value: unknown): value is {
  readonly format: typeof INVOCATION_FORMAT
  readonly version: 1
  readonly invocation: { readonly commandText: StoredText }
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const envelope = value as Record<string, unknown>
  if (!hasOnlyKeys(envelope, ["format", "version", "invocation"]) ||
      envelope.format !== INVOCATION_FORMAT || envelope.version !== 1 ||
      envelope.invocation === null || typeof envelope.invocation !== "object" || Array.isArray(envelope.invocation)) return false
  const invocation = envelope.invocation as Record<string, unknown>
  return hasOnlyKeys(invocation, ["commandText"]) && isStoredText(invocation.commandText)
}

function isStoredResult(value: unknown): value is {
  readonly format: typeof RESULT_FORMAT
  readonly version: 1
  readonly result: { readonly standardOutput: StoredText; readonly standardError: StoredText; readonly exitCode: number }
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const envelope = value as Record<string, unknown>
  if (!hasOnlyKeys(envelope, ["format", "version", "result"]) ||
      envelope.format !== RESULT_FORMAT || envelope.version !== 1 ||
      envelope.result === null || typeof envelope.result !== "object" || Array.isArray(envelope.result)) return false
  const result = envelope.result as Record<string, unknown>
  return hasOnlyKeys(result, ["standardOutput", "standardError", "exitCode"]) &&
    isStoredText(result.standardOutput) && isStoredText(result.standardError) &&
    typeof result.exitCode === "number" && Number.isInteger(result.exitCode) &&
    result.exitCode >= -2_147_483_648 && result.exitCode <= 2_147_483_647
}

function serializeText(value: string | RedactedString, fallbackFieldName: string): StoredText {
  if (value instanceof RedactedString) {
    return {
      text: value.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
      classification: value.__classification,
      fieldName: value.__fieldName,
    }
  }
  if (typeof value !== "string") throw new TypeError("Slate shell stored text must be a string")
  return { text: value, classification: DataClassification.CODE, fieldName: fallbackFieldName }
}

function deserializeText(value: StoredText, privacyMode: PrivacyMode): RedactedString {
  return createRedactedString(
    value.text,
    value.classification as typeof DataClassification[keyof typeof DataClassification],
    value.fieldName,
    privacyMode,
  )
}

function parseJson(bytes: Uint8Array, header: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(utf8Serde.deserialize(bytes.subarray(header.length)))
  } catch (error) {
    throw new TypeError(`Stored Slate shell ${label} is not valid JSON`, { cause: error })
  }
}

export function createSlateShellInvocationSerde(privacyMode: PrivacyMode): Serde<SlateStoredShellInvocation> {
  return {
    serialize(value) {
      const invocation = cloneSlateStoredShellInvocation(value)
      if (typeof invocation.commandText !== "string" && !(invocation.commandText instanceof RedactedString)) {
        throw new TypeError("Slate shell command must be text")
      }
      const envelope = {
        format: INVOCATION_FORMAT,
        version: 1,
        invocation: { commandText: serializeText(invocation.commandText, "command") },
      }
      return utf8Serde.serialize(`SLATE-AGENT-SHELL-INVOCATION\n${JSON.stringify(envelope)}`)
    },
    deserialize(bytes) {
      if (!beginsWith(bytes, INVOCATION_HEADER)) {
        throw new TypeError("Stored Slate shell invocation envelope is unsupported")
      }
      const parsed = parseJson(bytes, INVOCATION_HEADER, "invocation")
      if (!isStoredInvocation(parsed)) throw new TypeError("Stored Slate shell invocation envelope is invalid")
      return { commandText: deserializeText(parsed.invocation.commandText, privacyMode) }
    },
    getBlobType() {
      return { kind: "json", typeName: INVOCATION_FORMAT }
    },
  }
}

export function createSlateShellResultSerde(privacyMode: PrivacyMode): Serde<SlateStoredShellResult> {
  return {
    serialize(value) {
      const result = cloneSlateStoredShellResult(value)
      if ((typeof result.standardOutput !== "string" && !(result.standardOutput instanceof RedactedString)) ||
          (typeof result.standardError !== "string" && !(result.standardError instanceof RedactedString)) ||
          !Number.isInteger(result.exitCode) || result.exitCode < -2_147_483_648 || result.exitCode > 2_147_483_647) {
        throw new TypeError("Slate shell result is invalid")
      }
      const envelope = {
        format: RESULT_FORMAT,
        version: 1,
        result: {
          standardOutput: serializeText(result.standardOutput, "stdout"),
          standardError: serializeText(result.standardError, "stderr"),
          exitCode: result.exitCode,
        },
      }
      return utf8Serde.serialize(`SLATE-AGENT-SHELL-RESULT\n${JSON.stringify(envelope)}`)
    },
    deserialize(bytes) {
      if (!beginsWith(bytes, RESULT_HEADER)) {
        throw new TypeError("Stored Slate shell result envelope is unsupported")
      }
      const parsed = parseJson(bytes, RESULT_HEADER, "result")
      if (!isStoredResult(parsed)) throw new TypeError("Stored Slate shell result envelope is invalid")
      return {
        standardOutput: deserializeText(parsed.result.standardOutput, privacyMode),
        standardError: deserializeText(parsed.result.standardError, privacyMode),
        exitCode: parsed.result.exitCode,
      }
    },
    getBlobType() {
      return { kind: "json", typeName: RESULT_FORMAT }
    },
  }
}
