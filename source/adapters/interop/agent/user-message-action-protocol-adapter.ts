import { isMessage, type FieldInfo, type Message } from "@bufbuild/protobuf"
import {
  AgentMode,
  ExecutePlanInfo,
  ProjectDetails,
  SimulatedMsgReason,
  UserMessage,
} from "../proto/generated/agent/v1/agent_pb.ts"
import { TodoStatus } from "../proto/generated/agent/v1/todo_tool_pb.ts"
import { RequestContext } from "../proto/generated/agent/v1/request_context_exec_pb.ts"
import {
  createRedactedConversationTokenDetails,
  fromRedactedConversationPlan,
  fromRedactedToolCall,
  fromRedactedUserMessage,
  toRedactedConversationPlan,
  toRedactedInteractionUpdate,
  toRedactedToolCall,
  toRedactedUserMessage,
} from "../redacted-protos/generated/agent/v1/agent_redacted.ts"
import {
  fromRedactedTodoItem,
  toRedactedTodoItem,
} from "../redacted-protos/generated/agent/v1/todo_tool_redacted.ts"
import { fromRedactedMcpToolDefinition } from "../redacted-protos/generated/agent/v1/mcp_redacted.ts"
import { fromRedactedRequestContext } from "../redacted-protos/generated/agent/v1/request_context_exec_redacted.ts"
import { PrivacyCapability } from "../../../packages/redaction/classification.ts"
import {
  fromInteropHookContextMessages,
  toInteropHookContextMessages,
} from "./hook-context-adapter.ts"
import { fromInteropAgentMode, toInteropAgentMode } from "./mode-processing-adapter.ts"
import {
  customModeIntentFromInterop,
  customModeIntentToInterop,
  simulationDetailsFromInterop,
  simulationDetailsToInterop,
  triggeringActorFromInterop,
  triggeringActorToInterop,
} from "./user-message-metadata-adapter.ts"
import {
  cloneSlateUserMessage,
  SlateSimulatedMessageReason,
  type SlateSimulatedMessageReason as SlateSimulatedMessageReasonValue,
  type SlateUserMessage,
  type SlatePlanExecutionIntent,
} from "../../../packages/agent/user-message-state.ts"
import { SlateMode } from "../../../packages/agent/mode-processing.ts"
import { fromHex } from "../../../packages/agent-kv/serde.ts"
import { PrivacyMode as PrivacyModes } from "../../../packages/redaction/privacy-mode.ts"
import { RedactedString } from "../../../packages/redaction/redacted-values.ts"
import type {
  SlateCheckpointUnknownField,
  SlateCheckpointUnknownFieldPathStep,
} from "../../../packages/agent/conversation-checkpoint-state.ts"

export const AgentModeInterop = AgentMode
export type AgentModeInterop = AgentMode
export const TodoStatusInterop = TodoStatus
export type RequestContextInterop = RequestContext
export type UserMessageInterop = UserMessage

export const createRedactedConversationTokenDetailsInterop = createRedactedConversationTokenDetails
export const fromRedactedConversationPlanInterop = fromRedactedConversationPlan
export const fromRedactedToolCallInterop = fromRedactedToolCall
export const fromRedactedUserMessageInterop = fromRedactedUserMessage
export const toRedactedConversationPlanInterop = toRedactedConversationPlan
export const toRedactedInteractionUpdateInterop = toRedactedInteractionUpdate
export const toRedactedToolCallInterop = toRedactedToolCall
export const fromRedactedTodoItemInterop = fromRedactedTodoItem
export const toRedactedTodoItemInterop = toRedactedTodoItem
export const fromRedactedMcpToolDefinitionInterop = fromRedactedMcpToolDefinition
export const fromRedactedRequestContextInterop = fromRedactedRequestContext

export function createSyntheticUserMessageInterop(input: {
  readonly text: string
  readonly messageId: string
  readonly isSimulatedMsg: boolean
}): UserMessageInterop {
  return new UserMessage(input)
}

export function cloneUserMessageInterop(message: UserMessageInterop): UserMessageInterop {
  return new UserMessage({ ...message })
}

export function hookContextsFromUserMessageInterop(
  message: UserMessageInterop,
): ReturnType<typeof fromInteropHookContextMessages> {
  return Array.isArray(message.hookAdditionalContexts)
    ? fromInteropHookContextMessages(message.hookAdditionalContexts)
    : []
}

function protoFieldValue(message: Message, field: FieldInfo): unknown {
  const record = message as unknown as Record<string, unknown>
  if (field.oneof == null) return record[field.localName]
  const selection = record[field.oneof.localName]
  if (selection == null || typeof selection !== "object") return undefined
  const selected = selection as { readonly case?: unknown; readonly value?: unknown }
  return selected.case === field.localName ? selected.value : undefined
}

function collectLegacyUnknownFields(root: Message): SlateCheckpointUnknownField[] {
  const fields: SlateCheckpointUnknownField[] = []
  function visit(message: Message, path: readonly SlateCheckpointUnknownFieldPathStep[]): void {
    for (const field of message.getType().runtime.bin.listUnknownFields(message)) {
      fields.push({
        path,
        number: field.no,
        wireType: field.wireType,
        dataHex: Buffer.from(field.data).toString("hex"),
      })
    }
    for (const field of message.getType().fields.list()) {
      const value = protoFieldValue(message, field)
      if (value == null) continue
      if (field.kind === "message") {
        if (field.repeated && Array.isArray(value)) {
          value.forEach((child, index) => {
            if (isMessage(child)) visit(child, [...path, { field: field.localName }, { index }])
          })
        } else if (!field.repeated && isMessage(value)) {
          visit(value, [...path, { field: field.localName }])
        }
      } else if (field.kind === "map" && field.V.kind === "message" && typeof value === "object") {
        const entries = value instanceof Map ? [...value.entries()] : Object.entries(value)
        for (const [key, child] of entries) {
          if (typeof key === "string" && isMessage(child)) {
            visit(child, [...path, { field: field.localName }, { key }])
          }
        }
      }
    }
  }
  visit(root, [])
  return fields
}

function messageAtLegacyUnknownFieldPath(
  root: Message,
  path: readonly SlateCheckpointUnknownFieldPathStep[],
): Message {
  let current: unknown = root
  for (const step of path) {
    if ("field" in step) {
      if (!isMessage(current)) throw new TypeError("User-message legacy-field parent is invalid")
      const field = current.getType().fields.list().find(candidate => candidate.localName === step.field)
      if (field === undefined) throw new TypeError("User-message legacy-field path is not in this runtime")
      current = protoFieldValue(current, field)
    } else if ("index" in step) {
      current = Array.isArray(current) ? current[step.index] : undefined
    } else if (current instanceof Map) {
      current = current.get(step.key)
    } else {
      current = current != null && typeof current === "object"
        ? (current as Record<string, unknown>)[step.key]
        : undefined
    }
  }
  if (!isMessage(current)) throw new TypeError("User-message legacy-field target is missing")
  return current
}

function restoreLegacyUnknownFields(
  message: UserMessageInterop,
  fields: readonly SlateCheckpointUnknownField[] | undefined,
): void {
  for (const field of fields ?? []) {
    const target = messageAtLegacyUnknownFieldPath(message, field.path)
    target.getType().runtime.bin.onUnknownField(
      target,
      field.number,
      field.wireType as Parameters<typeof UserMessage.runtime.bin.onUnknownField>[2],
      fromHex(field.dataHex),
    )
  }
}

export function attachSelectedContextToUserMessageInterop(input: {
  readonly message: UserMessageInterop
  readonly selectedContext: unknown
  readonly promptReferenceId?: string
}): UserMessageInterop {
  return new UserMessage({
    ...input.message,
    ...(input.promptReferenceId === undefined ? {} : { promptReferenceId: input.promptReferenceId }),
    selectedContext: input.selectedContext as never,
  })
}

const INTEROP_TO_SLATE_SIMULATED_REASON = new Map<number, SlateSimulatedMessageReasonValue>([
  [SimulatedMsgReason.UNSPECIFIED, SlateSimulatedMessageReason.UNSPECIFIED],
  [SimulatedMsgReason.PLAN_EXECUTION, SlateSimulatedMessageReason.PLAN_EXECUTION],
  [SimulatedMsgReason.COMMIT_REMINDER, SlateSimulatedMessageReason.COMMIT_REMINDER],
  [SimulatedMsgReason.BACKGROUND_TASK_COMPLETION, SlateSimulatedMessageReason.BACKGROUND_TASK_COMPLETION],
  [SimulatedMsgReason.DIFF_TAB_COMMIT, SlateSimulatedMessageReason.DIFF_TAB_COMMIT],
  [SimulatedMsgReason.DIFF_TAB_COMMIT_AND_PUSH, SlateSimulatedMessageReason.DIFF_TAB_COMMIT_AND_PUSH],
  [SimulatedMsgReason.DIFF_TAB_PUSH, SlateSimulatedMessageReason.DIFF_TAB_PUSH],
  [SimulatedMsgReason.DIFF_TAB_CREATE_PR, SlateSimulatedMessageReason.DIFF_TAB_CREATE_PR],
  [SimulatedMsgReason.DIFF_TAB_FIX_MERGE_CONFLICTS, SlateSimulatedMessageReason.DIFF_TAB_FIX_MERGE_CONFLICTS],
  [SimulatedMsgReason.USER_SENT_TO_SUBAGENT, SlateSimulatedMessageReason.USER_SENT_TO_SUBAGENT],
  [SimulatedMsgReason.USER_INTERRUPTED_SUBAGENT, SlateSimulatedMessageReason.USER_INTERRUPTED_SUBAGENT],
  [SimulatedMsgReason.USER_QUEUED_TO_SUBAGENT, SlateSimulatedMessageReason.USER_QUEUED_TO_SUBAGENT],
  [SimulatedMsgReason.BABYSIT_PR_IN_CLOUD, SlateSimulatedMessageReason.BABYSIT_PR_IN_CLOUD],
  [SimulatedMsgReason.CI_PANEL_INVESTIGATE_FAILURE, SlateSimulatedMessageReason.CI_PANEL_INVESTIGATE_FAILURE],
  [SimulatedMsgReason.MULTITASK, SlateSimulatedMessageReason.MULTITASK],
  [SimulatedMsgReason.BUILD_IN_PARALLEL, SlateSimulatedMessageReason.BUILD_IN_PARALLEL],
  [SimulatedMsgReason.MULTITASK_SPLIT_PRS, SlateSimulatedMessageReason.MULTITASK_SPLIT_PRS],
  [SimulatedMsgReason.APPLY_LOCALLY, SlateSimulatedMessageReason.APPLY_LOCALLY],
  [SimulatedMsgReason.CHECKOUT_BRANCH, SlateSimulatedMessageReason.CHECKOUT_BRANCH],
  [SimulatedMsgReason.DIFF_TAB_UPDATE_BRANCH, SlateSimulatedMessageReason.DIFF_TAB_UPDATE_BRANCH],
  [SimulatedMsgReason.PR_TAB_BUGBOT_FIX, SlateSimulatedMessageReason.PR_TAB_AUTOMATED_REVIEW_FIX],
  [SimulatedMsgReason.RUN_BUGBOT_REVIEW, SlateSimulatedMessageReason.RUN_AUTOMATED_REVIEW],
  [SimulatedMsgReason.RUN_SECURITY_REVIEW, SlateSimulatedMessageReason.RUN_SECURITY_REVIEW],
  [SimulatedMsgReason.FSD_APPLY_FINDING, SlateSimulatedMessageReason.FSD_APPLY_FINDING],
  [SimulatedMsgReason.FSD_UNDO_FINDING, SlateSimulatedMessageReason.FSD_UNDO_FINDING],
  [SimulatedMsgReason.FSD_START, SlateSimulatedMessageReason.FSD_START],
  [SimulatedMsgReason.FSD_PR_INTERRUPT, SlateSimulatedMessageReason.FSD_PR_INTERRUPT],
  [SimulatedMsgReason.SUBSCRIPTION, SlateSimulatedMessageReason.SUBSCRIPTION],
  [SimulatedMsgReason.DIFF_TAB_CREATE_BRANCH, SlateSimulatedMessageReason.DIFF_TAB_CREATE_BRANCH],
  [SimulatedMsgReason.AGENT_STORE_CONFLICT, SlateSimulatedMessageReason.AGENT_STORE_CONFLICT],
  [SimulatedMsgReason.GOAL_CONTINUATION, SlateSimulatedMessageReason.GOAL_CONTINUATION],
  [SimulatedMsgReason.PROJECT_KICKOFF, SlateSimulatedMessageReason.PROJECT_KICKOFF],
])

const SLATE_TO_INTEROP_SIMULATED_REASON = new Map<SlateSimulatedMessageReasonValue, SimulatedMsgReason>(
  [...INTEROP_TO_SLATE_SIMULATED_REASON].map(([code, reason]) => [reason, code]),
)

export function fromInteropSimulatedMessageReason(
  reason: SimulatedMsgReason | undefined,
): SlateSimulatedMessageReasonValue | undefined {
  if (reason === undefined) return undefined
  return INTEROP_TO_SLATE_SIMULATED_REASON.get(reason) ?? `unknown-${reason}`
}

function planExecutionFromInterop(value: ExecutePlanInfo | undefined): SlatePlanExecutionIntent | undefined {
  return value === undefined ? undefined : { id: value.planId, title: value.planTitle }
}

export function toInteropSimulatedMessageReason(
  reason: SlateSimulatedMessageReasonValue | undefined,
): SimulatedMsgReason {
  if (reason === undefined) return SimulatedMsgReason.UNSPECIFIED
  const known = SLATE_TO_INTEROP_SIMULATED_REASON.get(reason)
  if (known !== undefined) return known
  const unknown = /^unknown-(-?\d+)$/.exec(reason)
  return unknown === null ? SimulatedMsgReason.UNSPECIFIED : Number(unknown[1]) as SimulatedMsgReason
}

/** Projects the generated message into the record consumed by Slate's turn policy. */
export function fromInteropUserMessage(message: UserMessageInterop): SlateUserMessage {
  const mode = fromInteropAgentMode(message.mode) ?? SlateMode.UNSPECIFIED
  const legacyModeCode = toInteropAgentMode(mode) === message.mode ? undefined : message.mode
  const simulatedMsgReason = message.simulatedMsgReason === undefined
    ? undefined
    : fromInteropSimulatedMessageReason(message.simulatedMsgReason)
  const triggeringActor = triggeringActorFromInterop(message.triggeringUserInfo)
  const planExecution = planExecutionFromInterop(message.executePlanInfo)
  const simulation = simulationDetailsFromInterop(message.simulatedMessageMetadata)
  const modeIntent = customModeIntentFromInterop(message.customModeIntent)
  const legacyUnknownFields = isMessage(message) ? collectLegacyUnknownFields(message) : []
  const compatibility = legacyModeCode === undefined && legacyUnknownFields.length === 0
    ? undefined
    : {
        ...(legacyModeCode === undefined ? {} : { legacyModeCode }),
        ...(legacyUnknownFields.length === 0 ? {} : { legacyUnknownFields }),
      }
  return {
    text: message.text as never,
    messageId: message.messageId,
    ...(message.selectedContext === undefined ? {} : { selectedContext: message.selectedContext }),
    mode,
    ...(message.isSimulatedMsg === undefined ? {} : { isSimulatedMsg: message.isSimulatedMsg }),
    ...(message.bestOfNGroupId === undefined ? {} : { bestOfNGroupId: message.bestOfNGroupId }),
    ...(message.tryUseBestOfNPromotion === undefined
      ? {}
      : { tryUseBestOfNPromotion: message.tryUseBestOfNPromotion }),
    ...(message.richText === undefined ? {} : { richText: message.richText as never }),
    ...(simulatedMsgReason === undefined ? {} : { simulatedMsgReason }),
    conversationStateBlobId: new Uint8Array(message.conversationStateBlobId),
    ...(message.subagentSystemReminder === undefined
      ? {}
      : { subagentSystemReminder: message.subagentSystemReminder }),
    ...(triggeringActor === undefined ? {} : { triggeringActor }),
    ...(planExecution === undefined ? {} : { planExecution }),
    ...(simulation === undefined ? {} : { simulation }),
    ...(message.promptReferenceId === undefined ? {} : { promptReferenceId: message.promptReferenceId }),
    ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
    ...(message.textBlobId === undefined ? {} : { textBlobId: new Uint8Array(message.textBlobId) }),
    ...(message.richTextBlobId === undefined
      ? {}
      : { richTextBlobId: new Uint8Array(message.richTextBlobId) }),
    hookContexts: fromInteropHookContextMessages(message.hookAdditionalContexts),
    ...(modeIntent === undefined ? {} : { modeIntent }),
    ...(message.projectDetails === undefined
      ? {}
      : {
          projectDetails: {
            ...(message.projectDetails.name === undefined ? {} : { name: message.projectDetails.name }),
            ...(message.projectDetails.subagent === undefined
              ? {}
              : {
                  subagent: {
                    ...(message.projectDetails.subagent.storeDir === undefined
                      ? {}
                      : { storeDir: message.projectDetails.subagent.storeDir }),
                  },
                }),
            ...(message.projectDetails.sideChat === undefined
              ? {}
              : {
                  sideChat: {
                    ...(message.projectDetails.sideChat.storeDir === undefined
                      ? {}
                      : { storeDir: message.projectDetails.sideChat.storeDir }),
                  },
                }),
          },
        }),
    ...(compatibility === undefined ? {} : { compatibility }),
  }
}

/** Reconstructs the persisted message only after Slate's turn policy has finished. */
export function toInteropUserMessage(message: SlateUserMessage): UserMessageInterop {
  const triggeringUserInfo = triggeringActorToInterop(message.triggeringActor)
  const simulatedMessageMetadata = simulationDetailsToInterop(message.simulation)
  const customModeIntent = customModeIntentToInterop(message.modeIntent)
  const interop = new UserMessage({
    text: message.text as never,
    messageId: message.messageId,
    ...(message.selectedContext === undefined ? {} : { selectedContext: message.selectedContext as never }),
    mode: message.compatibility?.legacyModeCode === undefined
      ? toInteropAgentMode(message.mode)
      : message.compatibility.legacyModeCode as AgentMode,
    ...(message.isSimulatedMsg === undefined ? {} : { isSimulatedMsg: message.isSimulatedMsg }),
    ...(message.bestOfNGroupId === undefined ? {} : { bestOfNGroupId: message.bestOfNGroupId }),
    ...(message.tryUseBestOfNPromotion === undefined
      ? {}
      : { tryUseBestOfNPromotion: message.tryUseBestOfNPromotion }),
    ...(message.richText === undefined ? {} : { richText: message.richText as never }),
    ...(message.simulatedMsgReason === undefined
      ? {}
      : { simulatedMsgReason: toInteropSimulatedMessageReason(message.simulatedMsgReason) }),
    conversationStateBlobId: new Uint8Array(message.conversationStateBlobId),
    ...(message.subagentSystemReminder === undefined
      ? {}
      : { subagentSystemReminder: message.subagentSystemReminder as never }),
    ...(triggeringUserInfo === undefined ? {} : { triggeringUserInfo }),
    ...(message.planExecution === undefined
      ? {}
      : {
          executePlanInfo: new ExecutePlanInfo({
            planId: message.planExecution.id as never,
            planTitle: message.planExecution.title as never,
          }),
        }),
    ...(simulatedMessageMetadata === undefined ? {} : { simulatedMessageMetadata }),
    ...(message.promptReferenceId === undefined ? {} : { promptReferenceId: message.promptReferenceId }),
    ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
    ...(message.textBlobId === undefined ? {} : { textBlobId: new Uint8Array(message.textBlobId) }),
    ...(message.richTextBlobId === undefined
      ? {}
      : { richTextBlobId: new Uint8Array(message.richTextBlobId) }),
    hookAdditionalContexts: toInteropHookContextMessages(message.hookContexts.map(context => ({
      event: context.event,
      text: context.text as never,
    }))),
    ...(customModeIntent === undefined ? {} : { customModeIntent }),
    ...(message.projectDetails === undefined
      ? {}
      : {
          projectDetails: new ProjectDetails({
            ...(message.projectDetails.name === undefined ? {} : { name: message.projectDetails.name as never }),
            ...(message.projectDetails.subagent === undefined
              ? {}
              : { subagent: message.projectDetails.subagent as never }),
            ...(message.projectDetails.sideChat === undefined
              ? {}
              : { sideChat: message.projectDetails.sideChat as never }),
          }),
        }),
  })
  restoreLegacyUnknownFields(interop, message.compatibility?.legacyUnknownFields)
  return interop
}

/** Projects a Slate turn record into the plain message view required by legacy runtime readers. */
export function toPlainInteropUserMessage(message: SlateUserMessage): UserMessageInterop {
  const projected = toInteropUserMessage(message)
  const projectedText: unknown = (projected as unknown as { readonly text: unknown }).text
  const redacted = projectedText instanceof RedactedString
    ? projected
    : toRedactedUserMessage(projected, PrivacyModes.UNSPECIFIED)
  const plain = fromRedactedUserMessage(
    redacted as never,
    PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
    undefined,
  )
  restoreLegacyUnknownFields(plain, message.compatibility?.legacyUnknownFields)
  return plain
}

/** Applies privacy policy while keeping the stored and returned turn record Slate-owned. */
export function redactSlateUserMessage(
  message: SlateUserMessage,
  privacyMode: import("../../../packages/redaction/privacy-mode.ts").PrivacyMode,
): SlateUserMessage {
  const redacted = fromInteropUserMessage(
    toRedactedUserMessage(toInteropUserMessage(message), privacyMode) as unknown as UserMessageInterop,
  )
  return cloneSlateUserMessage({
    ...redacted,
    ...(message.compatibility === undefined ? {} : { compatibility: message.compatibility }),
  })
}

export function createEmptyRequestContextInterop(): RequestContextInterop {
  return new RequestContext()
}
