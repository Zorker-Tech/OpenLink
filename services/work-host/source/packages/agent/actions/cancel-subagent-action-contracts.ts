function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Slate's route value for a request to stop a subagent run. */
export interface SlateCancelSubagentActionPayload {
  readonly schema: "slate.agent-action.cancel-subagent"
  readonly version: 1
  readonly subagentId: string
  readonly compatibility?: { readonly legacyPayload?: Readonly<Record<string, unknown>> }
}

export function createSlateCancelSubagentActionPayload(
  subagentId: string,
  legacyPayload?: Readonly<Record<string, unknown>>,
): SlateCancelSubagentActionPayload {
  return {
    schema: "slate.agent-action.cancel-subagent",
    version: 1,
    subagentId,
    ...(legacyPayload === undefined ? {} : { compatibility: { legacyPayload } }),
  }
}

export function isSlateCancelSubagentActionPayload(value: unknown): value is SlateCancelSubagentActionPayload {
  if (!isRecord(value) || value.schema !== "slate.agent-action.cancel-subagent" || value.version !== 1 ||
      typeof value.subagentId !== "string") return false
  return value.compatibility === undefined || (isRecord(value.compatibility) &&
    (value.compatibility.legacyPayload === undefined || isRecord(value.compatibility.legacyPayload)))
}
