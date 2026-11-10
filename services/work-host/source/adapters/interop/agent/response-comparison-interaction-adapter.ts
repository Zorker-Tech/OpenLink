import {
  InteractionUpdate,
  ResponseComparisonCompleted,
  ResponseComparisonDisplayOrder,
  ResponseComparisonSkipped,
  ResponseComparisonSkipReason,
  ResponseComparisonStarted,
  ResponseComparisonTextDelta,
  ResponseComparisonUpdate,
} from "../proto/generated/agent/v1/agent_pb.ts"
import { toRedactedInteractionUpdate } from "../redacted-protos/generated/agent/v1/agent_redacted.ts"
import type { PrivacyMode } from "../../../packages/redaction/privacy-mode.ts"

export type ResponseComparisonEventInterop =
  | {
      readonly kind: "started"
      readonly displayOrder: "parent-first" | "alternate-first"
      readonly parentInvocationId: string
      readonly alternateInvocationId: string
      readonly parentResponse: string
      readonly comparisonConfigId: string
      readonly alternateModelId: string
    }
  | { readonly kind: "text-delta"; readonly text: string }
  | { readonly kind: "completed" }
  | { readonly kind: "skipped"; readonly reason: "cancelled" | "timeout" | "inference-error" | "alternate-tool-call" }

export function createRedactedResponseComparisonUpdateInterop(input: {
  readonly comparisonId: string
  readonly event: ResponseComparisonEventInterop
  readonly privacyMode: PrivacyMode
}): unknown {
  const event = input.event.kind === "started"
    ? {
        case: "started" as const,
        value: new ResponseComparisonStarted({
          displayOrder: input.event.displayOrder === "parent-first"
            ? ResponseComparisonDisplayOrder.PARENT_FIRST
            : ResponseComparisonDisplayOrder.ALTERNATE_FIRST,
          parentInvocationId: input.event.parentInvocationId,
          alternateInvocationId: input.event.alternateInvocationId,
          parentResponse: input.event.parentResponse,
          comparisonConfigId: input.event.comparisonConfigId,
          alternateModelId: input.event.alternateModelId,
        }),
      }
    : input.event.kind === "text-delta"
      ? { case: "textDelta" as const, value: new ResponseComparisonTextDelta({ text: input.event.text }) }
      : input.event.kind === "completed"
        ? { case: "completed" as const, value: new ResponseComparisonCompleted() }
        : {
            case: "skipped" as const,
            value: new ResponseComparisonSkipped({
              reason: skipReasonToInterop(input.event.reason),
            }),
          }
  return toRedactedInteractionUpdate(
    new InteractionUpdate({
      message: {
        case: "responseComparison",
        value: new ResponseComparisonUpdate({ comparisonId: input.comparisonId, event }),
      },
    }),
    input.privacyMode,
  )
}

function skipReasonToInterop(
  reason: Extract<ResponseComparisonEventInterop, { readonly kind: "skipped" }>["reason"],
): ResponseComparisonSkipReason {
  switch (reason) {
    case "cancelled": return ResponseComparisonSkipReason.CANCELLED
    case "timeout": return ResponseComparisonSkipReason.TIMEOUT
    case "inference-error": return ResponseComparisonSkipReason.INFERENCE_ERROR
    case "alternate-tool-call": return ResponseComparisonSkipReason.ALTERNATE_TOOL_CALL
  }
}
