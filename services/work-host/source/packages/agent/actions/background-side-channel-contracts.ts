function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export interface SlateBackgroundShellActionPayload {
  readonly schema: "slate.agent-action.background-shell"
  readonly version: 1
  readonly toolCallId: string
  readonly compatibility?: { readonly legacyPayload?: Readonly<Record<string, unknown>> }
}

export interface SlateBackgroundSubagentActionPayload {
  readonly schema: "slate.agent-action.background-subagent"
  readonly version: 1
  readonly toolCallId: string
  readonly compatibility?: { readonly legacyPayload?: Readonly<Record<string, unknown>> }
}

export function createSlateBackgroundShellActionPayload(
  toolCallId: string,
  legacyPayload?: Readonly<Record<string, unknown>>,
): SlateBackgroundShellActionPayload {
  return {
    schema: "slate.agent-action.background-shell",
    version: 1,
    toolCallId,
    ...(legacyPayload === undefined ? {} : { compatibility: { legacyPayload } }),
  }
}

export function createSlateBackgroundSubagentActionPayload(
  toolCallId: string,
  legacyPayload?: Readonly<Record<string, unknown>>,
): SlateBackgroundSubagentActionPayload {
  return {
    schema: "slate.agent-action.background-subagent",
    version: 1,
    toolCallId,
    ...(legacyPayload === undefined ? {} : { compatibility: { legacyPayload } }),
  }
}

export function isSlateBackgroundShellActionPayload(value: unknown): value is SlateBackgroundShellActionPayload {
  if (!isRecord(value) || value.schema !== "slate.agent-action.background-shell" || value.version !== 1 ||
      typeof value.toolCallId !== "string") return false
  return value.compatibility === undefined || (isRecord(value.compatibility) &&
    (value.compatibility.legacyPayload === undefined || isRecord(value.compatibility.legacyPayload)))
}

export function isSlateBackgroundSubagentActionPayload(value: unknown): value is SlateBackgroundSubagentActionPayload {
  if (!isRecord(value) || value.schema !== "slate.agent-action.background-subagent" || value.version !== 1 ||
      typeof value.toolCallId !== "string") return false
  return value.compatibility === undefined || (isRecord(value.compatibility) &&
    (value.compatibility.legacyPayload === undefined || isRecord(value.compatibility.legacyPayload)))
}
