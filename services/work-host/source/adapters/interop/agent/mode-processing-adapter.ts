/** Converts the counterpart's persisted mode enum at the boundary of Slate's mode policy. */
import { AgentMode, SimulatedMsgReason } from "../proto/generated/agent/v1/agent_pb.ts"
import { getTaskToolName, type TaskToolModelInfo } from "../../../packages/agent/tools/task-tool-name.ts"
import { slateModelCapabilitiesFromInterop } from "./model-capabilities-adapter.ts"
import { usesPersistenceInstructions } from "../../../packages/agent/prompts/persistence-instructions.ts"
import { adaptPersistenceModelInfo, type InteropPersistenceModelInfo } from "./model-persistence-guidance-adapter.ts"
import {
  processModeSystemReminder,
  resolveCurrentStepMode,
  resolveCurrentTurnMode,
  SlateMode,
  type ModeProcessingConfig,
  type ModeProcessingRequestContext,
  type SlateMode as SlateModeValue,
} from "../../../packages/agent/mode-processing.ts"
import {
  renderMultitaskModeEnterUserReminder,
  type MultitaskReminderPolicy,
} from "../../../packages/agent/prompts/multitask-mode-reminders.ts"

export interface InteropModeModelInfo extends TaskToolModelInfo, InteropPersistenceModelInfo {
  readonly isLegacyAgentModel2?: boolean | undefined
  readonly isLegacyAgentMatterhorn?: boolean | undefined
  readonly isRawTrainingSlug?: boolean | undefined
}

export interface InteropModeProcessingConfig extends ModeProcessingConfig {
  readonly modelInfo?: InteropModeModelInfo | undefined
}

export { AgentMode as AgentModeInterop, SimulatedMsgReason as SimulatedMsgReasonInterop }

function reminderPolicy(modelInfo: InteropModeModelInfo | undefined): MultitaskReminderPolicy {
  const capabilities = slateModelCapabilitiesFromInterop(modelInfo)
  return {
    strictDelegation: capabilities?.isLegacyAgentModel2 === true ||
      (capabilities?.isLegacyAgentMatterhorn === true && capabilities.isRawTrainingSlug !== true),
    ignoreTurnPersistenceInstructions: usesPersistenceInstructions(adaptPersistenceModelInfo(modelInfo)),
  }
}

function slateModeConfig(config: InteropModeProcessingConfig): ModeProcessingConfig {
  const { modelInfo, ...owned } = config
  const capabilities = slateModelCapabilitiesFromInterop(modelInfo)
  return {
    ...owned,
    multitaskReminder: {
      ...owned.multitaskReminder,
      subagentToolName: owned.multitaskReminder?.subagentToolName ??
        (capabilities === undefined ? "Task" : getTaskToolName(capabilities)),
      policy: {
        ...reminderPolicy(modelInfo),
        ...owned.multitaskReminder?.policy,
      },
    },
  }
}

export function fromInteropAgentMode(mode: number | undefined): SlateModeValue | undefined {
  if (mode === undefined) return undefined
  switch (mode) {
    case AgentMode.AGENT: return SlateMode.AGENT
    case AgentMode.ASK: return SlateMode.CHAT
    case AgentMode.PLAN: return SlateMode.PLAN
    case AgentMode.DEBUG: return SlateMode.DEBUG
    case AgentMode.TRIAGE: return SlateMode.TRIAGE
    case AgentMode.PROJECT: return SlateMode.PROJECT
    case AgentMode.MULTITASK: return SlateMode.MULTITASK
    case AgentMode.CUSTOM: return SlateMode.CUSTOM
    case AgentMode.UNSPECIFIED: return SlateMode.UNSPECIFIED
    default: return SlateMode.UNSPECIFIED
  }
}

export function toInteropAgentMode(mode: SlateModeValue): AgentMode {
  switch (mode) {
    case SlateMode.AGENT: return AgentMode.AGENT
    case SlateMode.CHAT: return AgentMode.ASK
    case SlateMode.PLAN: return AgentMode.PLAN
    case SlateMode.DEBUG: return AgentMode.DEBUG
    case SlateMode.TRIAGE: return AgentMode.TRIAGE
    case SlateMode.PROJECT: return AgentMode.PROJECT
    case SlateMode.MULTITASK: return AgentMode.MULTITASK
    case SlateMode.CUSTOM: return AgentMode.CUSTOM
    case SlateMode.UNSPECIFIED: return AgentMode.UNSPECIFIED
  }
}

export function resolveCurrentTurnModeFromInterop(
  persistedMode: AgentMode | undefined,
  userMessageMode: AgentMode | undefined,
): AgentMode {
  return toInteropAgentMode(resolveCurrentTurnMode(
    fromInteropAgentMode(persistedMode),
    fromInteropAgentMode(userMessageMode),
  ))
}

export function resolveCurrentStepModeFromInterop(
  persistedMode: AgentMode | undefined,
  userMessageMode: AgentMode | undefined,
): AgentMode {
  return toInteropAgentMode(resolveCurrentStepMode(
    fromInteropAgentMode(persistedMode),
    fromInteropAgentMode(userMessageMode),
  ))
}

export function processModeSystemReminderFromInterop(
  mode: AgentMode,
  config: InteropModeProcessingConfig,
  requestContext: ModeProcessingRequestContext,
  previousMode?: AgentMode,
  options?: { readonly isUserTurn?: boolean | undefined },
): string {
  return processModeSystemReminderWithInteropConfig(
    fromInteropAgentMode(mode) ?? SlateMode.AGENT,
    config,
    requestContext,
    fromInteropAgentMode(previousMode),
    options,
  )
}

/**
 * Applies Slate's mode policy while translating only the model metadata used by that policy.
 * Callers that already hold a Slate mode do not need to round-trip it through the external enum.
 */
export function processModeSystemReminderWithInteropConfig(
  mode: SlateModeValue,
  config: InteropModeProcessingConfig,
  requestContext: ModeProcessingRequestContext,
  previousMode?: SlateModeValue,
  options?: { readonly isUserTurn?: boolean | undefined },
): string {
  return processModeSystemReminder(
    mode,
    slateModeConfig(config),
    requestContext,
    previousMode,
    options,
  )
}

export function renderInteropMultitaskModeEnterUserReminder(
  modelInfo: InteropModeModelInfo | undefined,
  options: { readonly hideAsyncSubagentTaskNotifications?: boolean | undefined } = {},
): string {
  const policy = reminderPolicy(modelInfo)
  const capabilities = slateModelCapabilitiesFromInterop(modelInfo)
  const subagentToolName = capabilities === undefined ? "Task" : getTaskToolName(capabilities)
  return renderMultitaskModeEnterUserReminder(subagentToolName, {
    policy,
    hideAsyncSubagentTaskNotifications: options.hideAsyncSubagentTaskNotifications,
  })
}
