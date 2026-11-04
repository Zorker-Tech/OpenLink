/** Decodes stored interrupted-call resolutions and renders them into Slate recovery text. */
import { fromRedactedInterruptedPendingToolCallResolution } from "../redacted-protos/generated/agent/v1/agent_redacted.ts"
import { PrivacyCapability } from "../../../packages/redaction/classification.ts"
import { renderTaskResultToString } from "../../../packages/agent/tools/task-client.ts"
import { renderInteropShellResultToString } from "./shell-result-format-adapter.ts"

export interface InterruptedToolOutcome {
  readonly result: string
  readonly isError: boolean
}

/** Index a stored list by call id without exposing the redacted record shape to the recovery policy. */
export function indexInterruptedToolResolutions(value: unknown): ReadonlyMap<string, unknown> {
  if (value === null || typeof value !== "object") return new Map()
  const resolutions = (value as { readonly resolutions?: unknown }).resolutions
  if (!Array.isArray(resolutions)) return new Map()
  const indexed = new Map<string, unknown>()
  for (const resolution of resolutions) {
    if (resolution === null || typeof resolution !== "object") continue
    const toolCallId = (resolution as { readonly toolCallId?: unknown }).toolCallId
    if (typeof toolCallId === "string") indexed.set(toolCallId, resolution)
  }
  return indexed
}

/** Decode one recorded resolution only when the recovery policy actually needs its result. */
export function renderInterruptedToolResolution(
  value: unknown,
  terminalsFolder: string | undefined,
): InterruptedToolOutcome | undefined {
  if (value === undefined) return undefined
  const resolution = fromRedactedInterruptedPendingToolCallResolution(
    value as never,
    PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
    undefined,
  ).resolution
  switch (resolution.case) {
    case "shellResult": {
      const recordedShell = resolution.value
      if (recordedShell.result.case === undefined) return { result: "Unknown error", isError: true }
      recordedShell.terminalsFolder = recordedShell.terminalsFolder ?? terminalsFolder!
      return {
        result: renderInteropShellResultToString(recordedShell, { autoBackgroundedForInterruption: true }),
        isError: recordedShell.result.case !== "success",
      }
    }
    case "taskResult":
      return {
        result: renderTaskResultToString(resolution.value),
        isError: resolution.value.result.case === "error",
      }
    case undefined:
      return undefined
    default: {
      const exhaustive: never = resolution
      return exhaustive
    }
  }
}
