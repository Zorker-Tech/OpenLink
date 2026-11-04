/** Encodes a Slate goal wakeup as the remote Agent message and redacted action. */
import { AgentMode, SimulatedMsgReason, UserMessage } from "../proto/generated/agent/v1/agent_pb.ts"
import {
  createRedactedUserMessageAction,
  toRedactedUserMessage,
} from "../redacted-protos/generated/agent/v1/agent_redacted.ts"
import { SlateMode, type SlateMode as SlateModeValue } from "../../../packages/agent/mode-processing.ts"
import { toInteropAgentMode } from "./mode-processing-adapter.ts"

type InteropPrivacyMode = Parameters<typeof createRedactedUserMessageAction>[0]

export function agentModeForGoalContinuation(mode: SlateModeValue | undefined): AgentMode {
  return toInteropAgentMode(mode ?? SlateMode.AGENT)
}

export function createGoalContinuationWakeAction(input: {
  readonly text: string
  readonly messageId: string
  readonly mode?: SlateModeValue | undefined
  readonly getActionPrivacyMode: () => InteropPrivacyMode
  readonly getMessagePrivacyMode: () => InteropPrivacyMode
}): unknown {
  const message = new UserMessage({
    text: input.text,
    messageId: input.messageId,
    // Continue in the existing mode; the Agent value is only the missing-field fallback.
    mode: agentModeForGoalContinuation(input.mode) as never,
    isSimulatedMsg: true,
    simulatedMsgReason: SimulatedMsgReason.GOAL_CONTINUATION,
  })
  return createRedactedUserMessageAction(input.getActionPrivacyMode(), {
    userMessage: toRedactedUserMessage(message, input.getMessagePrivacyMode()),
    sendToInteractionListener: true,
  })
}
