import type { PrivacyMode } from "../../redaction/privacy-mode.ts"
import type { Context } from "../../context/context.ts"
import { SlateMode, type SlateMode as SlateModeValue } from "../mode-processing.ts"

/** The host-owned modes accepted by a plan execution request. */
export type PlanExecutionMode =
  | "agent"
  | "ask"
  | "multitask"
  | { readonly kind: "unrecognized"; readonly value: unknown }

/** Projects the plan action's own mode vocabulary into Slate's conversation modes. */
export function slateModeForPlanExecutionMode(mode: PlanExecutionMode): SlateModeValue {
  switch (mode) {
    case "agent": return SlateMode.AGENT
    case "ask": return SlateMode.CHAT
    case "multitask": return SlateMode.MULTITASK
    default: return SlateMode.UNSPECIFIED
  }
}

/** Inputs the plan handler needs after the action has crossed the protocol boundary. */
export interface PlanFileReference {
  readonly path?: string | undefined
  readonly id?: string | undefined
}

export interface PlanExecutionRequest extends PlanFileReference {
  readonly requestContext: unknown | undefined
  readonly planText: string | undefined
  readonly sourceUri: string | undefined
  readonly messageId: string | undefined
  readonly mode: PlanExecutionMode
  readonly privacyMode: PrivacyMode | undefined
}

export interface PlanExecutionMessageInput {
  readonly text: string
  readonly messageId: string
  readonly planContent: string
  readonly planPath: string
  readonly planTitle: string
  readonly executionMode: PlanExecutionMode
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
