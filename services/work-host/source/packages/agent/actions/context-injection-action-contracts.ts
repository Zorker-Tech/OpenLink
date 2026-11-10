import { isRedactedString, type RedactedString } from "../../redaction/redacted-values.ts"
import type { SlateUserMessage } from "../user-message-state.ts"

export type SlateContextInjectionText = string | RedactedString

export type SlateContextInjectionValue =
  | { readonly kind: "user"; readonly message?: SlateUserMessage | undefined }
  | { readonly kind: "system"; readonly producer: string; readonly content: SlateContextInjectionText }
  | { readonly kind: "missing" }
  | { readonly kind: "unsupported"; readonly sourceCase: string }

/** The Slate-owned envelope for context attached to an active run. */
export interface SlateContextInjectionActionPayload {
  readonly schema: "slate.agent-action.context-injection"
  readonly version: 1
  readonly injectionId: string
  readonly expectedRunId: string
  readonly context: SlateContextInjectionValue
  readonly compatibility?: {
    readonly legacyRequestContext?: unknown
    readonly legacyPayload?: Readonly<Record<string, unknown>>
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isSlateUserMessage(value: unknown): value is SlateUserMessage {
  if (!isRecord(value)) return false
  return typeof value.text === "string" || isRedactedString(value.text)
}

function isContextValue(value: unknown): value is SlateContextInjectionValue {
  if (!isRecord(value)) return false
  switch (value.kind) {
    case "user": return value.message === undefined || isSlateUserMessage(value.message)
    case "system": return typeof value.producer === "string" &&
      (typeof value.content === "string" || isRedactedString(value.content))
    case "missing": return true
    case "unsupported": return typeof value.sourceCase === "string"
    default: return false
  }
}

export function createSlateContextInjectionActionPayload(input: {
  readonly injectionId: string
  readonly expectedRunId: string
  readonly context: SlateContextInjectionValue
  readonly compatibility?: SlateContextInjectionActionPayload["compatibility"]
}): SlateContextInjectionActionPayload {
  return {
    schema: "slate.agent-action.context-injection",
    version: 1,
    injectionId: input.injectionId,
    expectedRunId: input.expectedRunId,
    context: input.context,
    ...(input.compatibility === undefined ? {} : { compatibility: input.compatibility }),
  }
}

export function isSlateContextInjectionActionPayload(value: unknown): value is SlateContextInjectionActionPayload {
  if (!isRecord(value) || value.schema !== "slate.agent-action.context-injection" || value.version !== 1 ||
      typeof value.injectionId !== "string" || typeof value.expectedRunId !== "string" ||
      !isContextValue(value.context)) return false
  if (value.compatibility === undefined) return true
  if (!isRecord(value.compatibility)) return false
  return value.compatibility.legacyPayload === undefined || isRecord(value.compatibility.legacyPayload)
}
