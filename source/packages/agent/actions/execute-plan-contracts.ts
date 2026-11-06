import { PrivacyMode, type PrivacyMode as PrivacyModeValue } from "../../redaction/privacy-mode.ts"
import type { Context } from "../../context/context.ts"
import { SlateMode, type SlateMode as SlateModeValue } from "../mode-processing.ts"

/** Slate's plan-run vocabulary; chat owns the interaction previously called ask mode. */
export type PlanExecutionMode = "agent" | "chat" | "multitask" | "unspecified"

/** Projects the plan action's own mode vocabulary into Slate's conversation modes. */
export function slateModeForPlanExecutionMode(mode: PlanExecutionMode): SlateModeValue {
  switch (mode) {
    case "agent": return SlateMode.AGENT
    case "chat": return SlateMode.CHAT
    case "multitask": return SlateMode.MULTITASK
    case "unspecified": return SlateMode.UNSPECIFIED
  }
}

/** Inputs the plan handler needs after the action has crossed the protocol boundary. */
export interface PlanFileReference {
  readonly path?: string | undefined
  readonly id?: string | undefined
}

export interface SlateExecutePlanActionPayload extends PlanFileReference {
  readonly schema: "slate.agent-action.execute-plan"
  readonly version: 1
  readonly planText?: string
  readonly sourceUri?: string
  readonly messageId?: string
  readonly mode: PlanExecutionMode
  readonly privacyMode?: PrivacyModeValue
  /** Historical request context and numeric modes remain isolated until their ports migrate. */
  readonly compatibility?: {
    readonly requestContext?: unknown
    readonly legacyModeCode?: number
    readonly legacyPayload?: Readonly<Record<string, unknown>>
  }
}

export type PlanExecutionRequest = SlateExecutePlanActionPayload

export function isSlateExecutePlanActionPayload(value: unknown): value is SlateExecutePlanActionPayload {
  if (value === null || typeof value !== "object") return false
  const payload = value as Record<string, unknown>
  if (payload.schema !== "slate.agent-action.execute-plan" || payload.version !== 1 ||
      !["agent", "chat", "multitask", "unspecified"].includes(String(payload.mode))) return false
  for (const field of ["path", "id", "planText", "sourceUri", "messageId"] as const) {
    if (payload[field] !== undefined && typeof payload[field] !== "string") return false
  }
  if (payload.privacyMode !== undefined && !Object.values(PrivacyMode).includes(payload.privacyMode as PrivacyModeValue)) return false
  if (payload.compatibility === undefined) return true
  if (payload.compatibility === null || typeof payload.compatibility !== "object") return false
  const compatibility = payload.compatibility as Record<string, unknown>
  return (compatibility.requestContext === undefined || typeof compatibility.requestContext === "object") &&
    (compatibility.legacyModeCode === undefined || (
      Number.isInteger(compatibility.legacyModeCode) &&
      Number(compatibility.legacyModeCode) >= -2_147_483_648 && Number(compatibility.legacyModeCode) <= 2_147_483_647
    )) &&
    (compatibility.legacyPayload === undefined || (
      typeof compatibility.legacyPayload === "object" && compatibility.legacyPayload !== null && !Array.isArray(compatibility.legacyPayload)
    ))
}

export interface PlanExecutionMessageInput {
  readonly text: string
  readonly messageId: string
  readonly planContent: string
  readonly planPath: string
  readonly planTitle: string
  readonly executionMode: PlanExecutionMode
  readonly legacyModeCode?: number
  readonly rootProject: boolean
  readonly planId: string | undefined
  readonly listenerPrivacyMode: PrivacyMode
}

export interface PlanTodo {
  readonly id: string
  readonly content: string
  readonly status: unknown
  readonly dependencies: unknown
}

export interface ExecutePlanPlanFileIO {
  exists(context: Context, path: string): Promise<boolean>
  restoreFile(context: Context, path: string, content: string): Promise<boolean>
}
