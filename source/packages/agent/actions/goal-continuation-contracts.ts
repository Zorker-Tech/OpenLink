import { DataClassification } from "../../redaction/classification.ts"
import { createRedactedString } from "../../redaction/create.ts"
import type { PrivacyMode } from "../../redaction/privacy-mode.ts"
import type { SlateUserMessageActionPayload } from "../agent-action-state.ts"
import {
  createSlateUserMessageInput,
  SlateSimulatedMessageReason,
} from "../user-message-state.ts"
import { SlateMode, type SlateMode as SlateModeValue } from "../mode-processing.ts"

/** The internal trigger for advancing an active goal by one conversation turn. */
export interface SlateGoalContinuationActionPayload {
  readonly schema: "slate.agent-action.goal-continuation"
  readonly version: 1
}

export function createSlateGoalContinuationActionPayload(): SlateGoalContinuationActionPayload {
  return { schema: "slate.agent-action.goal-continuation", version: 1 }
}

export function isSlateGoalContinuationActionPayload(value: unknown): value is SlateGoalContinuationActionPayload {
  if (value === null || typeof value !== "object") return false
  const payload = value as Record<string, unknown>
  return payload.schema === "slate.agent-action.goal-continuation" && payload.version === 1
}

/** Builds the Slate user-message turn that carries a goal continuation into the ordinary turn handler. */
export function createSlateGoalContinuationWakeUserMessageAction(input: {
  readonly text: string
  readonly messageId: string
  readonly mode?: SlateModeValue | undefined
  readonly privacyMode: PrivacyMode
}): SlateUserMessageActionPayload {
  const message = createSlateUserMessageInput({
    text: createRedactedString(input.text, DataClassification.CODE, "text", input.privacyMode),
    messageId: input.messageId,
    mode: input.mode ?? SlateMode.AGENT,
    isSimulatedMsg: true,
    simulatedMsgReason: SlateSimulatedMessageReason.GOAL_CONTINUATION,
  })
  return {
    schema: "slate.agent-action.user-message",
    version: 1,
    message,
    earlierMessages: [],
    notifyUser: true,
  }
}
