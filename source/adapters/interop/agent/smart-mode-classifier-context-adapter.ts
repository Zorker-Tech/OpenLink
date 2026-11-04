import { SimulatedMsgReason } from "../proto/generated/agent/v1/agent_pb.ts"
import { SelectedContext, type SelectedContext as SelectedContextMessage } from "../proto/generated/agent/v1/selected_context_pb.ts"
import { SmartModeClassifierConversationMessage } from "../proto/generated/agent/v1/smart_mode_classifier_exec_pb.ts"
import { fromRedactedUserMessage } from "../redacted-protos/generated/agent/v1/agent_redacted.ts"
import {
  fromRedactedAskQuestionArgs,
  fromRedactedAskQuestionResult,
} from "../redacted-protos/generated/agent/v1/ask_question_tool_redacted.ts"
import { fromRedactedComputerUseToolCall } from "../redacted-protos/generated/agent/v1/computer_use_tool_redacted.ts"
import { renderInteropSimulatedMessagePrompts } from "./git-action-prompt-adapter.ts"
import {
  SlateSimulatedMessageReason,
  type SlateSimulatedMessageReason as SlateSimulatedMessageReasonValue,
} from "../../../packages/agent/user-message-state.ts"
import { toInteropSimulatedMessageReason } from "./user-message-action-protocol-adapter.ts"
import { RedactedString } from "../../../packages/redaction/redacted-values.ts"
import { PrivacyCapability } from "../../../packages/redaction/classification.ts"

/** Decodes a redacted user message into fields consumed by Slate's classifier policy. */
export function readClassifierUserMessageInterop(
  value: unknown,
  capability: PrivacyCapability,
): {
  readonly text: string
  readonly isSimulatedMsg: boolean
  readonly simulatedMsgReason: unknown
  readonly selectedContext?: unknown
} {
  if (value !== null && typeof value === "object" && typeof (value as { mode?: unknown }).mode === "string") {
    const slate = value as {
      readonly text: string | RedactedString
      readonly isSimulatedMsg?: boolean | undefined
      readonly simulatedMsgReason?: SlateSimulatedMessageReasonValue | undefined
      readonly selectedContext?: unknown
    }
    return {
      text: typeof slate.text === "string" ? slate.text : slate.text.unwrap(capability),
      isSimulatedMsg: slate.isSimulatedMsg === true,
      simulatedMsgReason: slate.simulatedMsgReason,
      ...(slate.selectedContext === undefined ? {} : { selectedContext: slate.selectedContext }),
    }
  }
  const message = fromRedactedUserMessage(value as never, capability, {})
  return {
    text: message.text,
    isSimulatedMsg: message.isSimulatedMsg === true,
    simulatedMsgReason: message.simulatedMsgReason,
    ...(message.selectedContext === undefined ? {} : { selectedContext: message.selectedContext }),
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
  readonly skillPaths: readonly unknown[]
  readonly commandPaths: readonly unknown[]
} {
  if (value === undefined || value === null) return { skillPaths: [], commandPaths: [] }
  const selectedContext = value as Partial<SelectedContextMessage>
  const paths = (items: unknown): unknown[] => Array.isArray(items)
    ? items.map(item => {
        if (item === null || typeof item !== "object") return undefined
        const fullPath = (item as { readonly fullPath?: unknown }).fullPath
        return fullPath instanceof RedactedString
          ? fullPath.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
          : fullPath
      })
    : []
  return {
    skillPaths: paths(selectedContext.selectedSkills),
    commandPaths: paths(selectedContext.cursorCommands),
  }
}

/** Renders the generated simulated-message dialect while leaving selection policy in Slate. */
export function renderSimulatedClassifierPromptsInterop(input: {
  readonly selectedContext?: unknown
  readonly simulatedMsgReason: unknown
}): string[] {
  const selectedContext = input.selectedContext === undefined
    ? new SelectedContext()
    : input.selectedContext instanceof SelectedContext
      ? input.selectedContext
      : new SelectedContext(input.selectedContext as never)
  const simulatedMsgReason = typeof input.simulatedMsgReason === "string"
    ? toInteropSimulatedMessageReason(input.simulatedMsgReason as SlateSimulatedMessageReasonValue)
    : input.simulatedMsgReason as SimulatedMsgReason
  return renderInteropSimulatedMessagePrompts({
    selectedContext: selectedContext as SelectedContextMessage,
    simulatedMsgReason,
  }).map((part) => part.text)
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
