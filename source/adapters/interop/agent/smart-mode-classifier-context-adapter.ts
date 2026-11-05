import { SimulatedMsgReason } from "../proto/generated/agent/v1/agent_pb.ts"
import type { SelectedContext } from "../proto/generated/agent/v1/selected_context_pb.ts"
import { SmartModeClassifierConversationMessage } from "../proto/generated/agent/v1/smart_mode_classifier_exec_pb.ts"
import { fromRedactedUserMessage } from "../redacted-protos/generated/agent/v1/agent_redacted.ts"
import {
  fromRedactedAskQuestionArgs,
  fromRedactedAskQuestionResult,
} from "../redacted-protos/generated/agent/v1/ask_question_tool_redacted.ts"
import { fromRedactedComputerUseToolCall } from "../redacted-protos/generated/agent/v1/computer_use_tool_redacted.ts"
import {
  SlateSimulatedMessageReason,
  type SlateSimulatedMessageReason as SlateSimulatedMessageReasonValue,
} from "../../../packages/agent/user-message-state.ts"
import { toInteropSimulatedMessageReason } from "./user-message-action-protocol-adapter.ts"
import { RedactedString } from "../../../packages/redaction/redacted-values.ts"
import { PrivacyCapability } from "../../../packages/redaction/classification.ts"
import {
  isSlateSelectedContextForProcessing,
  type SlateSelectedContextForProcessing,
} from "../../../packages/agent/context/selected-context-processing-contracts.ts"
import { projectSelectedContextForProcessing } from "./selected-context-processing-adapter.ts"

/** Decodes a redacted user message into fields consumed by Slate's classifier policy. */
export function readClassifierUserMessageInterop(
  value: unknown,
  capability: PrivacyCapability,
): {
  readonly text: string
  readonly isSimulatedMsg: boolean
  readonly simulatedMsgReason: unknown
  readonly selectedContext?: SlateSelectedContextForProcessing
} {
  if (value !== null && typeof value === "object" && typeof (value as { mode?: unknown }).mode === "string") {
    const slate = value as {
      readonly text: string | RedactedString
      readonly isSimulatedMsg?: boolean | undefined
      readonly simulatedMsgReason?: SlateSimulatedMessageReasonValue | undefined
      readonly selectedContext?: unknown
    }
    const selectedContext = slate.selectedContext === undefined
      ? undefined
      : isSlateSelectedContextForProcessing(slate.selectedContext)
        ? slate.selectedContext
        : projectSelectedContextForProcessing(slate.selectedContext as SelectedContext, {
            simulatedMsgReason: slate.simulatedMsgReason === undefined
              ? SimulatedMsgReason.UNSPECIFIED
              : typeof slate.simulatedMsgReason === "string"
                ? toInteropSimulatedMessageReason(slate.simulatedMsgReason)
                : slate.simulatedMsgReason as SimulatedMsgReason,
          })
    return {
      text: typeof slate.text === "string" ? slate.text : slate.text.unwrap(capability),
      isSimulatedMsg: slate.isSimulatedMsg === true,
      simulatedMsgReason: slate.simulatedMsgReason,
      ...(selectedContext === undefined ? {} : { selectedContext }),
    }
  }
  const message = fromRedactedUserMessage(value as never, capability, {})
  const selectedContext = message.selectedContext === undefined
    ? undefined
    : projectSelectedContextForProcessing(message.selectedContext, {
        simulatedMsgReason: message.simulatedMsgReason,
      })
  return {
    text: message.text,
    isSimulatedMsg: message.isSimulatedMsg === true,
    simulatedMsgReason: message.simulatedMsgReason,
    ...(selectedContext === undefined ? {} : { selectedContext }),
  }
}

export function isAutomaticClassifierContextMessageInterop(reason: unknown): boolean {
  return reason === SlateSimulatedMessageReason.BACKGROUND_TASK_COMPLETION
    || reason === SlateSimulatedMessageReason.GOAL_CONTINUATION
    || reason === SimulatedMsgReason.BACKGROUND_TASK_COMPLETION
    || reason === SimulatedMsgReason.GOAL_CONTINUATION
}

/** Converts the selected-context fields used by classifier policy into plain Slate path lists. */
export function selectedWorkflowPathsForClassifierInterop(value: unknown): {
  readonly skillPaths: readonly string[]
  readonly commandPaths: readonly string[]
} {
  if (value === undefined || value === null) return { skillPaths: [], commandPaths: [] }
  if (!isSlateSelectedContextForProcessing(value)) return { skillPaths: [], commandPaths: [] }
  const pathOf = (path: unknown): string | undefined => path instanceof RedactedString
    ? path.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
    : typeof path === "string" ? path : undefined
  return {
    skillPaths: (value.skillAttachments.explicitSkills ?? []).flatMap(skill => {
      const path = pathOf(skill.path)
      return path === undefined ? [] : [path]
    }),
    commandPaths: value.nonMedia.attachedCommands.flatMap(command => {
      const path = pathOf(command.sourcePath)
      return path === undefined ? [] : [path]
    }),
  }
}

export function readClassifierAskQuestionArgsInterop(value: unknown, capability: PrivacyCapability): unknown {
  return fromRedactedAskQuestionArgs(value as never, capability, {})
}

export function readClassifierAskQuestionResultInterop(value: unknown, capability: PrivacyCapability): unknown {
  return fromRedactedAskQuestionResult(value as never, capability, {})
}

export function readClassifierComputerUseCallInterop(value: unknown, capability: PrivacyCapability): unknown {
  return fromRedactedComputerUseToolCall(value as never, capability, {})
}

/** Builds counterpart classifier conversation messages from Slate's role/content records. */
export function toSmartModeClassifierConversationMessagesInterop(
  messages: readonly { readonly role: string; readonly content: string }[],
): Array<{ readonly role: string; readonly content: string }> {
  return messages.map((message) => new SmartModeClassifierConversationMessage({
    role: message.role,
    content: message.content,
  }))
}
