import { PrivacyCapability } from "../../redaction/classification.ts"
import { RedactedString } from "../../redaction/redacted-values.ts"
import { DataClassification } from "../../redaction/classification.ts"
import { createRedactedString } from "../../redaction/create.ts"
import { PrivacyMode } from "../../redaction/privacy-mode.ts"
import {
  createSlateAssistantMessageStep,
  createSlateToolCallStep,
  type SlateConversationStep,
} from "../conversation-step-state.ts"

export const SlateTaskBackgroundReason = {
  UNSPECIFIED: "unspecified",
  AGENT_REQUEST: "agent-request",
  USER_REQUEST: "user-request",
  QUEUED_FOLLOW_UP: "queued-follow-up",
  UNKNOWN: "unknown",
} as const

export type SlateTaskBackgroundReason =
  (typeof SlateTaskBackgroundReason)[keyof typeof SlateTaskBackgroundReason]
  | `unknown-${number}`

export interface SlateTaskSuccessResult {
  readonly kind: "success"
  readonly conversationSteps: readonly SlateConversationStep[]
  readonly agentId?: string
  readonly isBackground: boolean
  readonly durationMs?: bigint
  readonly resultSuffix?: string
  readonly backgroundReason: SlateTaskBackgroundReason
  readonly transcriptUri?: string
}

export type SlateTaskResult =
  | SlateTaskSuccessResult
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "unknown" }

export type SlateTaskResultView =
  | {
      readonly kind: "success"
      readonly agentId?: string
      readonly resultSuffix?: string
      readonly backgroundReason: SlateTaskBackgroundReason
      readonly transcriptUri?: string
      readonly finalAssistantText?: string
      readonly chosenSummary?: string
    }
  | { readonly kind: "error"; readonly error: string }
  | { readonly kind: "unknown" }

export function createSlateTaskSuccessResult(input: Omit<SlateTaskSuccessResult, "kind">): SlateTaskSuccessResult {
  return {
    kind: "success",
    ...input,
    conversationSteps: [...input.conversationSteps],
  }
}

/** Creates the answer step returned by a completed client-side subagent. */
export function createSlateTaskAssistantStep(text: string): SlateConversationStep {
  return createSlateAssistantMessageStep(createRedactedString(
    text,
    DataClassification.SAFE,
    "text",
    PrivacyMode.UNSPECIFIED,
  ))
}

/** Creates the summary step shape read from a subagent's final-summary tool call. */
export function createSlateTaskSummaryStep(finalSummary: string): SlateConversationStep {
  return createSlateToolCallStep({
    tool: {
      case: "sendFinalSummaryToolCall",
      value: { args: { finalSummary } },
    },
  })
}

/** Creates a Slate error result while preserving non-Error failures as readable text. */
export function createSlateTaskErrorResult(error: unknown): SlateTaskResult {
  return { kind: "error", message: error instanceof Error ? error.message : String(error) }
}

/** Projects only the task result fields needed for rendering; the full Slate steps remain on the result. */
export function projectSlateTaskResult(result: SlateTaskResult): SlateTaskResultView {
  if (result.kind !== "success") {
    return result.kind === "error" ? { kind: "error", error: result.message } : { kind: "unknown" }
  }

  let finalAssistantText: string | undefined
  let chosenSummary: string | undefined
  for (let index = result.conversationSteps.length - 1; index >= 0; index -= 1) {
    const step = result.conversationSteps[index]
    if (step === undefined) continue
    if (finalAssistantText === undefined && step.kind === "assistant-message") {
      finalAssistantText = unredactedText(step.text)
    }
    if (chosenSummary === undefined) chosenSummary = finalSummaryFromStep(step)
    if (finalAssistantText !== undefined && chosenSummary !== undefined) break
  }

  return {
    kind: "success",
    ...(result.agentId === undefined ? {} : { agentId: result.agentId }),
    ...(result.resultSuffix === undefined ? {} : { resultSuffix: result.resultSuffix }),
    backgroundReason: result.backgroundReason,
    ...(result.transcriptUri === undefined ? {} : { transcriptUri: result.transcriptUri }),
    ...(finalAssistantText === undefined ? {} : { finalAssistantText }),
    ...(chosenSummary === undefined || chosenSummary.length === 0 ? {} : { chosenSummary }),
  }
}

function unredactedText(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (value instanceof RedactedString) return value.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
  return undefined
}

function finalSummaryFromStep(step: SlateConversationStep): string | undefined {
  if (step.kind !== "tool-call") return undefined
  if (step.tool.case !== "sendFinalSummaryToolCall" && step.tool.case !== "communicateUpdateToolCall") return undefined
  const toolValue = step.tool.value
  if (toolValue === null || typeof toolValue !== "object" || Array.isArray(toolValue)) return undefined
  const args = (toolValue as { readonly args?: unknown }).args
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined
  const summary = (args as { readonly finalSummary?: unknown }).finalSummary
  return typeof summary === "string" ? summary.trim() : undefined
}
